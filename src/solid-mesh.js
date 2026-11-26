/* A boundary mesh of the material below a three-axis milling height field.
   The function is self-contained so it can be installed in the simulation worker. */
function buildSolidMesh(stock, meta, depths, removed, selection) {
  "use strict";
  const {x, y, z, l, w, h} = stock;
  const bounds = {min: [x, y, z], max: [x + l, y + w, z + h]};
  const top = z + h, through = 65535, unit = h / through;
  let positions = new Float32Array(3 * 2048);
  let normals = new Float32Array(positions.length);
  let indices = new Uint32Array(6 * 1024);
  let vertexCount = 0, indexCount = 0;

  function quadSpace() {
    if ((vertexCount + 4) * 3 > positions.length) {
      const p = new Float32Array(2 * positions.length), n = new Float32Array(p.length);
      p.set(positions); n.set(normals); positions = p; normals = n;
    }
    if (indexCount + 6 > indices.length) {
      const next = new Uint32Array(2 * indices.length);
      next.set(indices); indices = next;
    }
    return vertexCount;
  }
  function vertex(px, py, pz, vx, vy, vz) {
    const i = vertexCount++ * 3;
    positions[i] = px; positions[i + 1] = py; positions[i + 2] = pz;
    normals[i] = vx; normals[i + 1] = vy; normals[i + 2] = vz;
  }
  function quadIndices(i, first = true, second = true) {
    if (first) { indices[indexCount++] = i; indices[indexCount++] = i + 1; indices[indexCount++] = i + 2; }
    if (second) { indices[indexCount++] = i; indices[indexCount++] = i + 2; indices[indexCount++] = i + 3; }
  }
  function plane(x0, y0, x1, y1, pz, underside) {
    const i = quadSpace(), nz = underside ? -1 : 1;
    vertex(x0, y0, pz, 0, 0, nz);
    vertex(underside ? x0 : x1, underside ? y1 : y0, pz, 0, 0, nz);
    vertex(x1, y1, pz, 0, 0, nz);
    vertex(underside ? x1 : x0, underside ? y0 : y1, pz, 0, 0, nz);
    quadIndices(i);
  }
  function wall(x0, y0, x1, y1, low0, low1, high0, high1, vx, vy) {
    const i = quadSpace();
    vertex(x0, y0, low0, vx, vy, 0); vertex(x1, y1, low1, vx, vy, 0);
    vertex(x1, y1, high1, vx, vy, 0); vertex(x0, y0, high0, vx, vy, 0);
    quadIndices(i, high1 > low1, high0 > low0);
  }
  function result() {
    return {positions: positions.slice(0, vertexCount * 3), normals: normals.slice(0, vertexCount * 3),
      indices: indices.slice(0, indexCount), bounds};
  }
  let disturbed = false;
  if (meta && depths) {
    if (depths.length !== meta.nx * meta.ny) throw Error("Stock grid and depth frame sizes differ.");
    for (let i = 0; i < depths.length; i++) if (depths[i]) { disturbed = true; break; }
  }
  if (!disturbed) {
    if (removed || selection) return result();
    plane(x, y, x + l, y + w, top, false); plane(x, y, x + l, y + w, z, true);
    wall(x, y, x + l, y, z, z, top, top, 0, -1);
    wall(x + l, y, x + l, y + w, z, z, top, top, 1, 0);
    wall(x + l, y + w, x, y + w, z, z, top, top, 0, 1);
    wall(x, y + w, x, y, z, z, top, top, -1, 0);
    return result();
  }

  // The worker only samples the reachable portion. Include the untouched
  // strips as coarse cells, so fitting the full stock still shows its real length.
  function axis(min, max, lo, hi, slices) {
    const leading = lo > min + (max - min) * 1e-10;
    const trailing = hi < max - (max - min) * 1e-10;
    const points = new Float64Array(slices + 1 + Number(leading) + Number(trailing));
    for (let i = 0; i <= slices; i++) points[Number(leading) + i] = lo + (hi - lo) * i / slices;
    points[0] = min; points[points.length - 1] = max;
    return {points, offset: Number(leading)};
  }
  const ax = axis(x, x + l, meta.xmin, meta.xmax, meta.nx);
  const ay = axis(y, y + w, meta.ymin, meta.ymax, meta.ny);
  const xx = ax.points, yy = ay.points, nx = xx.length - 1, ny = yy.length - 1;
  const count = nx * ny, values = new Uint16Array(count);
  const sampled = new Uint8Array(count);
  // Selected-tool faces use precisely the same interpolated heights and
  // topology as the remaining stock. A newly exposed wall can begin partway
  // down an existing pocket; before[] bounds the portion created by this tool.
  const selected = selection && new Uint8Array(count);
  const before = selection && new Uint16Array(count);
  for (let j = 0; j < meta.ny; j++) {
    const k = (j + ay.offset) * nx + ax.offset, i = j * meta.nx;
    values.set(depths.subarray(i, i + meta.nx), k);
    sampled.fill(1, k, k + meta.nx);
    if (selection) {
      selected.set(selection.mask.subarray(i, i + meta.nx), k);
      before.set(selection.before.subarray(i, i + meta.nx), k);
    }
  }

  // Join nearby samples into a continuous surface across shallow slopes,
  // preserving steep shoulders and keeping empty cells genuinely open. The
  // four heights at a cell are stored CCW from its south-west corner.
  const corners = new Float32Array(count * 4);
  const adjacent = new Int32Array(4), root = new Int32Array(4);
  const sums = new Float64Array(4), sizes = new Uint8Array(4);
  const cellCorner = [2, 3, 0, 1];
  function connect(a, b, limit) {
    const ia = adjacent[a], ib = adjacent[b];
    if (ia < 0 || ib < 0 || values[ia] === through || values[ib] === through) return;
    const gap = Math.abs(values[ia] - values[ib]);
    if (gap && (gap > limit || !sampled[ia] || !sampled[ib])) return;
    while (root[a] !== a) a = root[a];
    while (root[b] !== b) b = root[b];
    root[b] = a;
  }
  const lipX = 1.75 * meta.sx / unit, lipY = 1.75 * meta.sy / unit;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const k = j * nx + i;
    adjacent[0] = i && j ? k - nx - 1 : -1;
    adjacent[1] = j && i < nx ? k - nx : -1;
    adjacent[2] = j < ny && i < nx ? k : -1;
    adjacent[3] = j < ny && i ? k - 1 : -1;
    for (let s = 0; s < 4; s++) { root[s] = s; sums[s] = 0; sizes[s] = 0; }
    connect(0, 1, lipX); connect(1, 2, lipY); connect(2, 3, lipX); connect(3, 0, lipY);
    for (let s = 0; s < 4; s++) if (adjacent[s] >= 0) {
      let leader = root[s]; while (leader !== root[leader]) leader = root[leader];
      root[s] = leader; sums[leader] += values[adjacent[s]]; sizes[leader]++;
    }
    for (let s = 0; s < 4; s++) if (adjacent[s] >= 0) {
      corners[4 * adjacent[s] + cellCorner[s]] = sums[root[s]] / sizes[root[s]];
    }
  }

  // Use the very same reconstructed interface for both volumes. The ordinary
  // mesher fills from the stock floor upwards. Invert the quantized field
  // here and reflect its output in Z to fill downwards from the stock top.
  if (removed) {
    for (let i = 0; i < values.length; i++) values[i] = through - values[i];
    for (let i = 0; i < corners.length; i++) corners[i] = through - corners[i];
  }

  function height(depth) { return top - depth * unit; }
  const flat = new Int32Array(count), bottom = new Int32Array(count);
  flat.fill(-1);
  function slopeVertex(px, py, pz, dx, dy) {
    const inv = 1 / Math.sqrt(1 + dx * dx + dy * dy);
    vertex(px, py, pz, -dx * inv, -dy * inv, inv);
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cell = j * nx + i, k = cell * 4;
    if (selected && !selected[cell]) continue;
    // Along a smooth cut entry, the interpolated surface can slope toward
    // the first cut cell from a sample that was exactly at stock top.
    if (values[cell] === through && corners[k] === through && corners[k+1] === through &&
        corners[k+2] === through && corners[k+3] === through) { bottom[cell] = -1; continue; }
    if (corners[k] === values[cell] && corners[k + 1] === values[cell] &&
        corners[k + 2] === values[cell] && corners[k + 3] === values[cell]) {
      flat[cell] = values[cell]; continue;
    }
    const z0 = height(corners[k]), z1 = height(corners[k + 1]);
    const z2 = height(corners[k + 2]), z3 = height(corners[k + 3]);
    const x0 = xx[i], x1 = xx[i + 1], y0 = yy[j], y1 = yy[j + 1];
    const dx0 = (z1 - z0) / (x1 - x0), dx1 = (z2 - z3) / (x1 - x0);
    const dy0 = (z3 - z0) / (y1 - y0), dy1 = (z2 - z1) / (y1 - y0);
    const base = quadSpace();
    slopeVertex(x0, y0, z0, dx0, dy0); slopeVertex(x1, y0, z1, dx0, dy1);
    slopeVertex(x1, y1, z2, dx1, dy1); slopeVertex(x0, y1, z3, dx1, dy0);
    quadIndices(base);
  }
  // Greedy rectangles make the flat face and underside inexpensive to render.
  function mergePlanes(keys, underside) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const key = keys[j * nx + i]; if (key < 0) continue;
      let endX = i + 1, endY = j + 1;
      while (endX < nx && keys[j * nx + endX] === key) endX++;
      rows: while (endY < ny) {
        for (let n = i; n < endX; n++) if (keys[endY * nx + n] !== key) break rows;
        endY++;
      }
      for (let n = j; n < endY; n++) keys.fill(-1, n * nx + i, n * nx + endX);
      plane(xx[i], yy[j], xx[endX], yy[endY], underside ? z : height(key), underside);
    }
  }
  mergePlanes(flat, false);
  if (!selected) mergePlanes(bottom, true);

  // Connect the two top edges at sharp changes, holes and outer boundaries.
  // If two piecewise heights cross, split at the crossing before orienting.
  function seam(x0, y0, x1, y1, a, b, c, d, vx, vy, cellA, cellC) {
    const da = c - a, db = d - b;
    if (!da && !db) return;
    if (da * db < 0) {
      const t = da / (da - db), mid = a + (b - a) * t;
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      seam(x0, y0, px, py, a, mid, c, mid, vx, vy, cellA, cellC);
      seam(px, py, x1, y1, mid, b, mid, d, vx, vy, cellA, cellC);
    } else if (da > 0 || db > 0) {
      exposedWall(x0, y0, x1, y1, height(c), height(d), height(a), height(b), vx, vy, cellC);
    } else {
      exposedWall(x1, y1, x0, y0, height(b), height(a), height(d), height(c), -vx, -vy, cellA);
    }
  }
  function exposedWall(x0, y0, x1, y1, low0, low1, high0, high1, vx, vy, deeper) {
    if (!selected) { wall(x0,y0,x1,y1,low0,low1,high0,high1,vx,vy); return; }
    if (!selected[deeper]) return;
    const ceiling = height(before[deeper]);
    const breaks = [0, 1];
    for (const [a,b] of [[low0,low1],[high0,high1]]) {
      if ((a-ceiling)*(b-ceiling)<0) breaks.push((ceiling-a)/(b-a));
    }
    breaks.sort((a,b)=>a-b);
    for (let i=1; i<breaks.length; i++) {
      const a=breaks[i-1], b=breaks[i], l0=low0+a*(low1-low0), l1=low0+b*(low1-low0);
      if (a===b || (l0+l1)/2>=ceiling) continue;
      wall(x0+a*(x1-x0),y0+a*(y1-y0),x0+b*(x1-x0),y0+b*(y1-y0),
        l0,l1,Math.max(l0,Math.min(ceiling,high0+a*(high1-high0))),
        Math.max(l1,Math.min(ceiling,high0+b*(high1-high0))),vx,vy);
    }
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i <= nx; i++) {
    const left = 4 * (j * nx + i - 1), right = left + 4;
    seam(xx[i], yy[j], xx[i], yy[j + 1], i ? corners[left + 1] : through,
      i ? corners[left + 2] : through, i < nx ? corners[right] : through,
      i < nx ? corners[right + 3] : through, 1, 0, i ? left/4 : -1, i < nx ? right/4 : -1);
  }
  for (let j = 0; j <= ny; j++) for (let i = 0; i < nx; i++) {
    const north = 4 * (j * nx + i), south = north - 4 * nx;
    seam(xx[i + 1], yy[j], xx[i], yy[j], j ? corners[south + 2] : through,
      j ? corners[south + 3] : through, j < ny ? corners[north + 1] : through,
      j < ny ? corners[north] : through, 0, 1, j ? south/4 : -1, j < ny ? north/4 : -1);
  }
  if (removed) {
    const mirror = z + top;
    for (let i = 2; i < 3 * vertexCount; i += 3) {
      positions[i] = mirror - positions[i]; normals[i] = -normals[i];
    }
    for (let i = 0; i < indexCount; i += 3) {
      const swap = indices[i+1]; indices[i+1] = indices[i+2]; indices[i+2] = swap;
    }
  }
  return result();
}
globalThis.buildSolidMesh = buildSolidMesh;
if (typeof module !== "undefined" && module.exports) module.exports = {buildSolidMesh};
