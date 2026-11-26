const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {stockWorker, buildStockEngine} = require('../viewer-stock.js');
const {buildSolidMesh} = require('../solid-mesh.js');

const stock={x:0,y:0,z:-3,l:10,w:6,h:3};
const tools={4:{d:3,shape:'flat'},6:{d:2,shape:'flat'},8:{d:.9,shape:'flat'}};
function simulation(segments) {
  const job={count:segments.length,xyz:segments.flatMap(s=>s.slice(1)),
    tool:segments.map(s=>s[0]),kind:segments.map(()=>1),spindle:segments.map(()=>1),
    endTime:segments.map((_s,i)=>i+1)};
  const timers=new Map(), messages=[]; let id=0;
  const ctx={self:{postMessage:m=>messages.push(m)},performance:{now:()=>0},
    setTimeout:fn=>{timers.set(++id,fn);return id;}, clearTimeout:n=>timers.delete(n)};
  vm.runInNewContext('('+stockWorker+')('+buildStockEngine+','+buildSolidMesh+')',ctx);
  const send=data=>ctx.self.onmessage({data});
  function pump(){while(timers.size){const [n,fn]=timers.entries().next().value;timers.delete(n);fn();}}
  send({type:'job',job});send({type:'configure',key:1,stock,tools});
  return {send,pump,messages,compare(){
    send({type:'find-removal',key:1,id:7,tool:6});pump();
    const m=messages.find(m=>m.type==='tool-removal');
    assert.equal(m.error,undefined);return m.result;
  }};
}

test('a tool deepening an existing pocket highlights its new floor and wall band only',()=>{
  const c=simulation([[4,1,3,-1,9,3,-1],[6,2,3,-1.2,8,3,-1.2],
    [6,2,3,-1.2,8,3,-1.2]]).compare();
  assert.equal(c.tool,6);assert.equal(c.lastTime,3);assert.ok(c.count>0);
  assert.equal(c.firstTime,1);
  const expectedBefore=buildStockEngine({count:1,xyz:[1,3,-1,9,3,-1],tool:[4],kind:[1],spindle:[1],endTime:[1]},stock,tools,true);
  // This first tool covers the full reachable area, so both grids coincide.
  const reference=expectedBefore.blank();expectedBefore.sweep(reference,0);
  assert.equal(c.beforeDepths.length,reference.length);
  assert.deepEqual(Array.from(c.beforeDepths),Array.from(reference));
  assert.ok(c.sx<=.06 && c.sy<=.06);
  assert.ok(c.volumeMM3>2.8 && c.volumeMM3<3.3);
  const {positions,normals}=c.mesh;
  let wallVertices=0;
  for(let i=0;i<positions.length;i+=3){
    assert.ok(positions[i+2]>=-1.201 && positions[i+2]<=-.999,'old sidewalls and underside excluded');
    assert.ok(normals[i+2]>=0);
    if(normals[i+2]===0)wallVertices++;
  }
  assert.ok(wallVertices>0);
  assert.ok(c.stockMesh.indices.length>c.mesh.indices.length);
});

test('intervening cuts erase the visible footprint but retain historical selected-tool volume',()=>{
  const c=simulation([[6,2,3,-.5,8,3,-.5],[4,1,3,-1,9,3,-1],
    [6,2,3,-.4,8,3,-.4]]).compare();
  assert.ok(c.volumeMM3>0);
  assert.equal(c.count,0);assert.equal(c.mesh.indices.length,0);
  assert.equal(c.beforeDepths,null);
  assert.equal(c.bounds,null);assert.equal(c.firstCut,null);
});

test('through cuts expose the bore wall without painting a cap over the hole',()=>{
  const c=simulation([[4,1,3,-1,9,3,-1],[6,5,3,1,5,3,-4]]).compare();
  assert.ok(c.volumeMM3>6 && c.volumeMM3<6.6);
  for(let i=2;i<c.mesh.positions.length;i+=3){
    assert.equal(c.mesh.normals[i],0,'open bore has side faces only');
    assert.ok(c.mesh.positions[i]>=-3 && c.mesh.positions[i]<=-.999);
  }
  assert.ok(c.mesh.indices.length>0);
});

test('comparison rejects air cuts, cancelled and superseded requests, and stale configurations',()=>{
  const sim=simulation([[6,1,1,2,3,1,2],[4,1,3,-1,9,3,-1]]);
  sim.send({type:'find-removal',key:1,tool:4,id:1});
  sim.send({type:'find-removal',key:1,tool:6,id:2});
  sim.send({type:'cancel-removal',key:1,id:2});
  sim.pump();assert.ok(!sim.messages.some(m=>m.type==='tool-removal'));
  sim.send({type:'find-removal',key:1,tool:4,id:3});
  sim.send({type:'configure',key:2,stock,tools});
  sim.send({type:'find-removal',key:1,tool:4,id:4});
  sim.send({type:'find-removal',key:2,tool:6,id:5});sim.pump();
  const found=sim.messages.filter(m=>m.type==='tool-removal');
  assert.equal(found.length,1);assert.equal(found[0].id,5);assert.equal(found[0].result,null);
  assert.deepEqual(sim.messages.filter(m=>m.type==='removal-progress').map(m=>[m.id,m.progress]),[[5,1]]);
});
