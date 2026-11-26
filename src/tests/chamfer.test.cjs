const assert = require('node:assert/strict');
const test = require('node:test');
const {buildStockEngine} = require('../viewer-stock.js');
const {buildCutterMesh} = require('../solid-cutter.js');

const stock = {x:0,y:0,z:-5,l:8,w:4,h:5};
const chamfer = {shape:'chamfer',d:2,tip:0.8,angle:90};

function setup(segment, tool=chamfer) {
  const job = {count:1, kind:[1], spindle:[1], tool:[6], xyz:segment, endTime:[10]};
  return buildStockEngine(job,stock,{6:tool});
}

test('a chamfer mesh has the programmed tip flat and included angle', () => {
  for (const [diameter,tip,angle] of [[3.175,.1,15],[2,0,90],[2,.8,90],[2,2,90],[2,.5,179.8],[2,.4,.9]]) {
    const {positions:p,normals:n} = buildCutterMesh({shape:'chamfer',d:diameter,tip,angle});
    let capRadius = 0, shoulder = Infinity;
    for (let i=0;i<p.length;i+=3) {
      const r = Math.hypot(p[i],p[i+1]);
      if (p[i+2]===0 && n[i+2]===-1) capRadius = Math.max(capRadius,r);
      if (Math.abs(r-diameter/2)<1e-6) shoulder = Math.min(shoulder,p[i+2]);
    }
    assert.ok(Math.abs(capRadius-tip/2)<1e-6);
    const expected = (diameter-tip)/2/Math.tan(angle*Math.PI/360);
    assert.ok(Math.abs(shoulder-expected)<1e-6*Math.max(1,expected));
  }
  assert.equal(buildCutterMesh({...chamfer,tip:3}),null);
});

test('a stationary chamfer plunge has a flat bottom and the correct wall angle', () => {
  const tool = {shape:'chamfer',d:3.175,tip:.1,angle:15};
  const engine = setup([4,2,1,4,2,-2],tool);
  const pixels = engine.blank(), {meta} = engine;
  engine.sweep(pixels,0);
  const slope = 1/Math.tan(Math.PI*15/360);
  for (let j=0;j<meta.ny;j++) {
    for (let i=0;i<meta.nx;i++) {
      const r = Math.hypot(meta.xmin+(i+.5)*meta.sx-4,meta.ymin+(j+.5)*meta.sy-2);
      const depth = Math.max(0,2 - slope*Math.max(0,r-.05));
      assert.ok(Math.abs(depth-pixels[j*meta.nx+i]*stock.h/65535)<.00005);
    }
  }
  const {cutter} = engine.inspectFrame(engine.blank(),0,.75);
  assert.equal(cutter.shape,'chamfer');
  assert.equal(cutter.tip,.1);
  assert.equal(cutter.angle,15);
});

test('tilted chamfer sweeps agree with dense independent tool placements in both directions', () => {
  // Off-centre samples include optima on the tip flat, the tapered wall,
  // and the truncated end of the stroke. Also exercise ramps steeper than the cone.
  for (const dz of [-2.5,2.5,-5.5,5.5]) {
    const segment = [1.5,1.3,-2.5-dz/2,6.5,2.7,-2.5+dz/2];
    const engine = setup(segment), {meta} = engine, pixels = engine.blank();
    engine.sweep(pixels,0,.87,.12);
    for (let j=1;j<meta.ny;j+=3) {
      for (let i=1;i<meta.nx;i+=3) {
        const x = meta.xmin+(i+.5)*meta.sx, y = meta.ymin+(j+.5)*meta.sy;
        let expected = 0;
        for (let k=0;k<=4000;k++) {
          const t = .12+.75*k/4000;
          const r = Math.hypot(x-segment[0]-5*t,y-segment[1]-1.4*t);
          if (r<=1) expected = Math.max(expected,-segment[2]-dz*t-Math.max(0,r-.4));
        }
        expected = Math.min(stock.h,expected);
        assert.ok(Math.abs(expected-pixels[j*meta.nx+i]*stock.h/65535)<.002);
      }
    }
  }
});

test('a full-width tip cuts like a flat mill and a drill always remains pointed', () => {
  const segment = [1.5,1,-2,6.5,3,-1];
  function swept(tool) {
    const engine = setup(segment,tool), pixels = engine.blank();
    engine.sweep(pixels,0);
    return pixels;
  }
  assert.deepEqual(swept({...chamfer,tip:2}),swept({shape:'flat',d:2}));
  assert.deepEqual(swept({...chamfer,tip:0}),swept({...chamfer,shape:'drill'}));
});
