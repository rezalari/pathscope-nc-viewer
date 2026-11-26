/* Nominal cutter envelope. Its origin is the programmed tool tip, in millimetres. */
(function () {
  "use strict";

  function buildCutterMesh(cutter) {
    const radius = Number(cutter?.d) / 2;
    if (!(radius > 0) || !Number.isFinite(radius)) return null;
    const sides = 32;
    const positions = [], normals = [], indices = [];

    // A ring is [radius, height, radial normal, vertical normal]. Separate
    // bands preserve a flat cutter's sharp lower edge and a drill's shoulder.
    function band(lower, upper) {
      const base = positions.length / 3;
      for (const ring of [lower, upper]) {
        for (let i = 0; i < sides; i++) {
          const angle = i * 2 * Math.PI / sides;
          const c = Math.cos(angle), s = Math.sin(angle);
          positions.push(ring[0] * c, ring[0] * s, ring[1]);
          normals.push(ring[2] * c, ring[2] * s, ring[3]);
        }
      }
      for (let i = 0; i < sides; i++) {
        const a = base + i, b = base + (i + 1) % sides;
        if (lower[0] > 0) indices.push(a, b, b + sides);
        if (upper[0] > 0) indices.push(a, b + sides, a + sides);
      }
    }

    let shoulder = 0;
    if (cutter.shape === "ball") {
      let previous = [0, 0, 0, -1];
      for (let i = 1; i <= 12; i++) {
        const a = i * Math.PI / 24, nr = Math.sin(a), nz = -Math.cos(a);
        const next = [radius * nr, radius * (1 + nz), nr, nz];
        band(previous, next);
        previous = next;
      }
      shoulder = radius;
    } else if (cutter.shape === "drill" || cutter.shape === "chamfer") {
      const chamfer = cutter.shape === "chamfer";
      const angle = chamfer ? Number(cutter.angle) : Math.max(1, Math.min(179, Number(cutter.angle) || 118));
      if (!(angle > 0 && angle < 180)) return null;
      const half = angle * Math.PI / 360;
      const tipRadius = chamfer ? Number(cutter.tip) / 2 : 0;
      if (!Number.isFinite(tipRadius) || tipRadius < 0 || tipRadius > radius) return null;
      if (tipRadius) band([0, 0, 0, -1], [tipRadius, 0, 0, -1]);
      if (tipRadius < radius) {
        shoulder = (radius - tipRadius) / Math.tan(half);
        const nr = Math.cos(half), nz = -Math.sin(half);
        band([tipRadius, 0, nr, nz], [radius, shoulder, nr, nz]);
      }
    } else {
      band([0, 0, 0, -1], [radius, 0, 0, -1]);
    }
    // NC files ordinarily describe the tip, not the stick-out or holder.
    const height = shoulder + 6 * radius;
    band([radius, shoulder, 1, 0], [radius, height, 1, 0]);
    band([radius, height, 0, 1], [0, height, 0, 1]);

    return {positions: new Float32Array(positions), normals: new Float32Array(normals),
      indices: new Uint32Array(indices), bounds: {min: [-radius, -radius, 0], max: [radius, radius, height]}};
  }

  globalThis.buildCutterMesh = buildCutterMesh;
  if (typeof module !== "undefined" && module.exports) module.exports = {buildCutterMesh};
})();
