const test=require('node:test');
const assert=require('node:assert/strict');
require('../render.js');

test('Toolpaths draws the chamfer tip flat and shoulder at the same dimensions as the cutting tool',()=>{
  const context={beginPath(){},arc(){},fill(){},stroke(){}};
  for(const [d,tip,angle] of [[3.175,.1,90],[2,0,15],[2,2,90],[.02,.01,45]]){
    const paths=[],point=[11,7,-.8];
    const renderer={tools:{6:{d,tip,angle,shape:'chamfer'}},scale:1000,u:[0,1,0],
      _poly:(_,path)=>paths.push(path),project:()=>[0,0]};
    globalThis.NCRenderer.prototype._tool.call(renderer,context,point,6);
    const radius=d/2, shoulder=point[2]+(radius-tip/2)/Math.tan(angle*Math.PI/360);
    assert.deepEqual(paths[0].slice(0,4),[
      [11,7-radius,shoulder],[11,7-tip/2,-.8],[11,7+tip/2,-.8],[11,7+radius,shoulder]]);
    assert(paths[1][0][2]>shoulder);
    assert(paths[2].every(p=>Math.abs(p[2]-shoulder)<1e-8));
    if(tip>0 && tip<d){
      assert(paths[3].every(p=>p[2]===point[2] && Math.abs(Math.hypot(p[0]-11,p[1]-7)-tip/2)<1e-8));
    }
  }
});
