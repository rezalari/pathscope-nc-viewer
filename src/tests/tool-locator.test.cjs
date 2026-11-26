const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {buildStockEngine,stockWorker}=require('../viewer-stock.js');

const stock={x:0,y:0,z:-3,l:10,w:2,h:3};
const tools={4:{d:2,shape:'flat'},6:{d:2,shape:'chamfer',angle:90,tip:.1},8:{d:2,shape:'flat'}};
// T4 clears a slot. T6's first two feeds respectively cross cleared stock
// and travel above the top. Its third feed enters the stock on a long move.
const segments=[
  [-2,1,-1,4,1,-1], [0,1,-.8,2,1,-.8], [0,1,2,10,1,2],
  [-90,1,-.8,100,1,-.8], [0,1,-.7,2,1,-.7], [2,1,-.7,8,1,-.7]
];
const job={count:segments.length, xyz:segments.flat(),kind:[1,1,1,1,1,0],
  spindle:[1,1,1,1,1,1],tool:[4,6,6,6,8,8],endTime:[6,8,18,208,210,216]};

function controller(){
  const messages=[],timers=new Map();let seq=0;
  const scope={self:{postMessage:m=>messages.push(m)},performance:{now:()=>0},
    setTimeout:f=>{timers.set(++seq,f);return seq;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext('('+stockWorker.toString()+')('+buildStockEngine.toString()+',null)',scope);
  function send(data){scope.self.onmessage({data});}
  function pump(){while(timers.size){const [id,fn]=timers.entries().next().value;timers.delete(id);fn();}}
  send({type:'job',job});
  send({type:'configure',key:1,tools,stock});
  return {messages,send,pump};
}

test('locate actual first stock removal across previous tools, even in toolpath-only mode',()=>{
  const sim=controller();
  sim.send({type:'find-cut',key:1,id:1,tool:6});sim.pump();
  const result=sim.messages.find(m=>m.type==='tool-cut');
  assert.equal(result.cut.tool,6);assert.equal(result.cut.move,3);
  assert.ok(result.cut.x>4 && result.cut.x<6);assert.equal(result.cut.y,1);
  sim.send({type:'active',active:'depth'});
  sim.send({type:'seek',t:result.cut.t});sim.pump();
  const frame=sim.messages.find(m=>m.type==='image');
  assert.equal(frame.cutter.state,'cutting');assert.equal(frame.cutter.tool,6);
  assert.equal(frame.cutter.x,result.cut.x);assert.ok(frame.removal.recentMM3>0);
  sim.send({type:'find-cut',key:1,id:2,tool:6});
  assert.deepEqual(sim.messages.at(-1).cut,result.cut,'archived result');
  for(const tool of [8,9]){
    sim.send({type:'find-cut',key:1,id:tool,tool});sim.pump();
    assert.equal(sim.messages.find(m=>m.type==='tool-cut'&&m.id===tool).cut,null);
  }
});

test('cancelled searches and stale job keys do not resolve after configuration changes',()=>{
  const sim=controller();
  sim.send({type:'find-cut',key:1,id:1,tool:6});
  sim.send({type:'cancel-find',key:1,id:1});
  sim.pump();assert(!sim.messages.some(m=>m.type==='tool-cut'));
  sim.send({type:'find-cut',key:1,id:2,tool:4});
  sim.send({type:'configure',key:2,tools:{4:tools[4]},stock});
  sim.send({type:'find-cut',key:1,id:3,tool:4});
  sim.send({type:'find-cut',key:2,id:4,tool:6});sim.pump();
  const results=sim.messages.filter(m=>m.type==='tool-cut');
  assert.equal(results.length,1);assert.equal(results[0].id,4);assert.equal(results[0].cut,null);
});

test('a newer tool selection replaces an earlier pending request while switching displays',()=>{
  const sim=controller();
  sim.send({type:'find-cut',key:1,id:1,tool:8});
  sim.send({type:'active',active:'depth'});
  sim.send({type:'find-cut',key:1,id:2,tool:6});
  sim.send({type:'active',active:false});
  sim.pump();
  const results=sim.messages.filter(m=>m.type==='tool-cut');
  assert.equal(results.length,1);
  assert.equal(results[0].id,2);assert.equal(results[0].cut.tool,6);
  assert(!sim.messages.some(m=>m.type==='image'));
});
