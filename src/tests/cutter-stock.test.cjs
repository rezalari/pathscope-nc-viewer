const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {buildCutterMesh} = require('../solid-cutter.js');
const {buildStockEngine, stockWorker} = require('../viewer-stock.js');
const {buildSolidMesh} = require('../solid-mesh.js');

const stock = {x:0, y:0, z:-3, l:10, w:2, h:3};
const definitions = {1:{shape:'flat', d:2}};
// The flat mill crosses both stock edges, retraces the slot, then retracts.
const job = {
  count: 6, xyz: Float32Array.of(-4,1,-1,14,1,-1, 14,1,-1,-4,1,-1, -4,1,-1,-4,1,3,
    -4,1,3,1,1,-2, 1,1,-2,1,1,-2, 1,1,-2,2,1,-2),
  kind: Uint8Array.of(1,1,0,1,2,1), tool: Uint16Array.of(1,1,1,1,1,5),
  spindle: Uint8Array.of(1,1,1,0,0,1), endTime: Float64Array.of(18,36,40,45,46,47)
};

test('local cutter surfaces are outward-facing and share the simulated tip geometry', () => {
  assert.equal(buildCutterMesh({d:0}), null);
  for (const shape of ['flat','ball','drill']) {
    const mesh = buildCutterMesh({d:2, shape, angle:90});
    const {positions:p, normals:n, indices} = mesh;
    let baseRadius = 0, maxRadius = 0, fullDiameterStart = Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const radius = Math.hypot(p[i], p[i+1]), z = p[i+2];
      maxRadius = Math.max(maxRadius, radius);
      if (Math.abs(radius-1) < 1e-6) fullDiameterStart = Math.min(fullDiameterStart,z);
      assert.ok(z >= 0 && z <= mesh.bounds.max[2]);
      assert.ok(Math.abs(Math.hypot(n[i], n[i+1], n[i+2])-1) < 1e-6);
      if (z === 0) baseRadius = Math.max(baseRadius, radius);
      if (z > 0 && z < 1) {
        const expected = shape === 'ball' ? Math.sqrt(z*(2-z)) : z;
        assert.ok(Math.abs(radius-expected) < 1e-6);
      }
    }
    assert.ok(Math.abs(baseRadius - (shape === 'flat' ? 1 : 0)) < 1e-6);
    assert.ok(Math.abs(maxRadius - 1) < 1e-6);
    assert.ok(Math.abs(fullDiameterStart - (shape === 'flat' ? 0 : 1)) < 1e-6);
    for (let t = 0; t < indices.length; t += 3) {
      const [a,b,c] = Array.from(indices.subarray(t,t+3), v => v*3);
      const ux=p[b]-p[a], uy=p[b+1]-p[a+1], uz=p[b+2]-p[a+2];
      const vx=p[c]-p[a], vy=p[c+1]-p[a+1], vz=p[c+2]-p[a+2];
      const dot = (uy*vz-uz*vy)*n[a] + (uz*vx-ux*vz)*n[a+1] + (ux*vy-uy*vx)*n[a+2];
      assert.ok(dot > 0, 'triangle orientation must agree with its outward normal');
    }
  }
});

test('subdividing a sloped cut for the air estimate retains flat, ball and drill stock profiles', () => {
  const slope = {...job, count:1, xyz:Float32Array.of(0,1,1,10,1,-2)};
  for (const shape of ['flat','ball','drill']) {
    const engine = buildStockEngine(slope, stock, {1:{shape,d:2}});
    const whole = engine.blank(), sampled = engine.blank(), paused = engine.blank();
    engine.sweep(whole,0);
    engine.advance(sampled,0);
    const frame = engine.inspectFrame(paused,0,.73);
    const direct = engine.blank();
    engine.sweep(direct,0,.73);
    for (let i=0; i<whole.length; i++) {
      assert.ok(Math.abs(whole[i]-sampled[i]) <= 1, 'completed sweep');
      assert.ok(Math.abs(direct[i]-paused[i]) <= 1, 'paused sweep');
    }
    assert.equal(frame.cutter.state,'cutting');
  }
});

test('engagement follows the current tip, including air on either side of the same feed', () => {
  const engine = buildStockEngine(job, stock, definitions);
  function at(t) {
    const {i, fraction} = engine.cursorAt(t), image = engine.blank();
    let air = 0;
    for (let j = 0; j < i; j++) air += engine.advance(image, j);
    return engine.inspectFrame(image, i, fraction, air);
  }
  assert.equal(at(0).cutter.state, 'ready');
  const before = at(1), inside = at(7), past = at(17), retrace = at(27);
  assert.equal(before.cutter.state, 'air');
  assert.equal(before.removal.totalMM3, 0);
  assert.equal(inside.cutter.state, 'cutting');
  assert.equal(inside.cutter.x, 3);
  assert.ok(inside.removal.recentMM3 > 0 && inside.removal.moveMM3 < 20);
  assert.equal(past.cutter.state, 'air');
  assert.equal(past.removal.recentMM3, 0);
  assert.ok(Math.abs(past.removal.moveMM3 - 20) < 1e-9);
  assert.equal(retrace.cutter.state, 'air');
  assert.equal(retrace.removal.moveMM3, 0);
  assert.equal(retrace.removal.totalMM3, past.removal.totalMM3);
  assert.equal(before.removal.airFeedSeconds, 1);
  assert.ok(past.removal.airFeedSeconds > inside.removal.airFeedSeconds);
  // Nine seconds spent retracing the already-cleared slot are entirely air.
  assert.ok(Math.abs(retrace.removal.airFeedSeconds - at(18).removal.airFeedSeconds - 9) < 1e-9);
  const lastAir = at(36).removal.airFeedSeconds;
  assert.ok(lastAir > 24 && lastAir < 27);
  // Rapid, spindle-off feed, dwell and unknown tools do not contribute.
  assert.equal(at(47).removal.airFeedSeconds, lastAir);
  let previousAir = 0;
  for (let n = 0; n <= 90; n++) {
    const air = at(n/5).removal.airFeedSeconds;
    assert.ok(air >= previousAir - 1e-9, 'partial-interval air estimates must remain monotonic');
    previousAir = air;
  }
  assert.equal(at(38).cutter.state, 'rapid');
  assert.equal(at(42).cutter.state, 'spindle-off');
  assert.equal(at(45.5).cutter.state, 'dwell');
  assert.equal(at(46.5).cutter.state, 'unknown');
  assert.equal(at(47).cutter.state, 'complete');
  assert.ok(Math.abs(at(47).removal.totalMM3-20) < 1e-9);
});

test('worker replays arbitrary seeks and generates the removed mesh lazily at a paused frame', () => {
  let nextId = 0;
  const timers = new Map(), messages = [];
  const worker = {self:{postMessage:frame=>messages.push(frame)},
    performance:{now:()=>0}, setTimeout:fn=>{timers.set(++nextId, fn); return nextId;}, clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(`(${stockWorker.toString()})(${buildStockEngine.toString()},${buildSolidMesh.toString()})`, worker);
  function post(data) {worker.self.onmessage({data});}
  function seek(t) {
    messages.length = 0;
    post({type:'seek',t});
    while (timers.size) {
      const [id, run] = timers.entries().next().value;
      timers.delete(id);
      run();
    }
    const frame = messages.find(v=>v.type==='image');
    assert.ok(frame && !frame.error && !frame.removedError);
    return frame;
  }
  post({type:'job',job}); post({type:'configure',key:1,stock,tools:definitions});
  post({type:'active',active:'solid'});
  const cut = seek(7);
  assert.equal(cut.cutter.state, 'cutting');
  assert.ok(cut.mesh && !cut.removedMesh);
  post({type:'removed',visible:true});
  const added = seek(7);
  assert.ok(added.removedMesh.indices.length && !added.mesh);
  assert.equal(added.removal.totalMM3, cut.removal.totalMM3);
  const same = seek(7);
  assert.ok(same.removedVisible && !same.removedMesh && !same.mesh);
  const end = seek(47);
  assert.ok(end.removal.totalMM3 > cut.removal.totalMM3 && end.removedMesh);
  const rewind = seek(1);
  assert.equal(rewind.removal.totalMM3, 0);
  assert.equal(rewind.removal.airFeedSeconds, 1);
  assert.equal(rewind.removedMesh.indices.length, 0);
  const replay = seek(7);
  assert.equal(replay.removal.totalMM3, cut.removal.totalMM3);
  assert.equal(replay.removal.airFeedSeconds, cut.removal.airFeedSeconds);
  assert.deepEqual(replay.image, cut.image);
  post({type:'removed',visible:false});
  assert.equal(seek(7).removedVisible,false);
  post({type:'removed',visible:true});
  assert.ok(seek(7).removedMesh.indices.length);
});
