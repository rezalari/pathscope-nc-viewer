const assert = require('node:assert/strict');
const {buildSolidMesh} = require('../solid-mesh');
const {rasterize, basis, gpu} = require('../solid-render');

const stock = {x:-1,y:2,z:-4,l:5,w:4,h:4};
const meta = {xmin:0,ymin:2,xmax:2,ymax:4,nx:2,ny:2,sx:1,sy:1};
const empty = buildSolidMesh(stock,meta,new Uint16Array(4),true);
assert.equal(empty.indices.length,0);
function volume(mesh) {
  let total=0;
  for(let i=0;i<mesh.indices.length;i+=3){
    const [ia,ib,ic]=mesh.indices.subarray(i,i+3).map(v=>3*v),p=mesh.positions;
    const ax=p[ia]-stock.x,ay=p[ia+1]-stock.y,az=p[ia+2]-stock.z;
    const bx=p[ib]-p[ia],by=p[ib+1]-p[ia+1],bz=p[ib+2]-p[ia+2];
    const cx=p[ic]-p[ia],cy=p[ic+1]-p[ia+1],cz=p[ic+2]-p[ia+2];
    total+=ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx);
  }
  return total/6;
}
const rawVolume=stock.l*stock.w*stock.h;
for (const samples of [[0,0,0,0],[65535,32768,0,0],[0,873,18104,28173],[65535,65535,65535,65535]]) {
  const d=Uint16Array.from(samples);
  const removed=volume(buildSolidMesh(stock,meta,d,true)),remaining=volume(buildSolidMesh(stock,meta,d));
  assert.ok(Math.abs(remaining+removed-rawVolume)<1e-4);
  // Curved reconstructed cells interpolate their four surrounding samples.
  // Isolated cylindrical holes and flat pockets keep the exact sampled volume.
  if(!samples.includes(873))assert.ok(Math.abs(removed-samples.reduce((a,b)=>a+b,0)*stock.h/65535)<1e-4);
}
const depths=Uint16Array.from([65535,51000,0,0]);
const frame={mesh:buildSolidMesh(stock,meta,depths),removedMesh:buildSolidMesh(stock,meta,depths,true),depths,meta};
const side=150;
const cam={...basis(0,Math.PI/2),center:[1.5,4,-2],w:side,h:side,pan:[0,0],scale:20};
function draw(frame, cam, removed, cutter) {
  const image={width:side,height:side,data:new Uint8ClampedArray(side*side*4)};
  rasterize(frame,cam,stock,image,new Float32Array(side*side),{},removed,cutter);
  return image.data;
}
function rgba(image,x,y) {
  const u=Math.floor(side/2+(x-cam.center[0])*cam.scale);
  const v=Math.floor(side/2-(y-cam.center[1])*cam.scale);
  return [...image.subarray(4*(v*side+u),4*(v*side+u)+4)];
}
const solo=draw(frame,cam,false),overlay=draw(frame,cam,true);
assert.deepEqual(rgba(solo,.37,2.33),[0,0,0,0]); // through
const phantom=rgba(overlay,.37,2.33);
assert.ok(phantom[3]>50&&phantom[3]<110);assert.ok(phantom[2]>phantom[0]);
assert.deepEqual(rgba(overlay,3.4,3.58),rgba(solo,3.4,3.58)); // untouched
assert.deepEqual(rgba(overlay,.5,2.5),phantom); // shared mesh diagonal must not double alpha
assert.equal(rgba(overlay,1.4,2.33)[3],255); // blind pocket still occludes the backdrop
assert.notDeepEqual(rgba(overlay,1.4,2.33),rgba(solo,1.4,2.33));
const cutter={mesh:buildSolidMesh({x:0,y:0,z:0,l:.5,w:.5,h:1},null,null),origin:[.1,2.1,1],tint:[.85,.88,.91]};
assert.deepEqual(rgba(draw(frame,cam,true,cutter),.37,2.33),rgba(draw(frame,cam,false,cutter),.37,2.33)); // opaque cutter in front
assert.notDeepEqual(rgba(draw(frame,cam,false,cutter),.37,2.33),rgba(solo,.37,2.33));
const back={...cam,...basis(0,-Math.PI/2)};
const backSolo=draw(frame,back,false),backGhost=draw(frame,back,true);
const point=(im,x,y)=>{
  const at=4*(Math.floor(side/2+(y-back.center[1])*back.scale)*side+Math.floor(side/2+(x-back.center[0])*back.scale));
  return [...im.subarray(at,at+4)];
};
assert.deepEqual(point(backSolo,1.42,2.33),point(backGhost,1.42,2.33)); // opaque blind pocket floor hides ghost from below
console.log('Removed material matches stock volume, illuminates only cut areas, and respects stock and cutter occlusion.');

// The WebGL path must also draw a full frame after the operator hides a layer.
const drawCalls=[];
const gl=new Proxy({
  getShaderParameter:()=>true,
  getProgramParameter:()=>true,
  drawElements:(mode,count)=>drawCalls.push(count)
},{get:(target,name)=>target[name]??(typeof name==='string' && /^[A-Z0-9_]+$/.test(name)?1:()=>({}))});
const output=gpu({getContext:()=>gl,width:side,height:side});
for(const removed of [true,false,true]){
  drawCalls.length=0;
  output.draw(frame,{...cam,range:15},stock,removed,cutter);
  const counts=[frame.mesh.indices.length,cutter.mesh.indices.length];
  if(removed)counts.push(frame.removedMesh.indices.length);
  assert.deepEqual(drawCalls,counts);
}
