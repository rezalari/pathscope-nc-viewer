/* Top-down stock removal. Z values denote cutter-tip height, in work millimetres. */
(function () {
  "use strict";

  function buildStockEngine(job, stock, definitions) {
    const {xyz, kind, spindle, tool, count, endTime} = job;
    const {x, y, z, l, w, h} = stock;
    const top = z + h;
    const tools = Object.create(null);
    for (const [key, definition] of Object.entries(definitions)) {
      const radius = Number(definition.d) / 2;
      if (!Number.isFinite(radius) || radius <= 0) continue;
      const shape = (definition.shape || "flat").toLowerCase();
      const chamfer = shape === "chamfer";
      const angle = chamfer ? Number(definition.angle) : Math.max(1, Math.min(179, Number(definition.angle) || 118));
      if (!(angle > 0 && angle < 180)) continue;
      const slope = 1 / Math.tan(angle * Math.PI / 360);
      const ball = shape.includes("ball"), cone = /drill|cone|engrave|chamfer|v-bit/.test(shape);
      const tipRadius = chamfer ? Number(definition.tip) / 2 : 0;
      if (!Number.isFinite(tipRadius) || tipRadius < 0 || tipRadius > radius) continue;
      tools[key] = {radius, tipRadius, ball, cone, slope, angle,
        shape: ball ? "ball" : chamfer ? "chamfer" : cone ? "drill" : "flat"};
    }

    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    const unknown = new Set();
    let activeMoves = 0;
    for (let i = 0; i < count; i++) {
      if (kind[i] !== 1 || !spindle[i]) continue;
      const p = 6 * i;
      if (Math.min(xyz[p + 2], xyz[p + 5]) >= top) continue;
      const tip = tools[tool[i]];
      if (!tip) { unknown.add(tool[i]); continue; }
      const r = tip.radius;
      const x0 = xyz[p], y0 = xyz[p + 1], x1 = xyz[p + 3], y1 = xyz[p + 4];
      const left = Math.max(x, Math.min(x0, x1) - r);
      const right = Math.min(x + l, Math.max(x0, x1) + r);
      const front = Math.max(y, Math.min(y0, y1) - r);
      const back = Math.min(y + w, Math.max(y0, y1) + r);
      if (left >= right || front >= back) continue;
      xmin = Math.min(xmin, left); ymin = Math.min(ymin, front);
      xmax = Math.max(xmax, right); ymax = Math.max(ymax, back);
      activeMoves++;
    }
    if (!activeMoves) { xmin = x; ymin = y; xmax = x + l; ymax = y + w; }
    const width = xmax - xmin, height = ymax - ymin;
    // Sample only the region that a cutting tool can touch. Untouched bar is drawn separately.
    const pitch = Math.max(0.10, width / 600, height / 600, Math.sqrt(width * height / 75000));
    const nx = Math.max(1, Math.ceil(width / pitch)), ny = Math.max(1, Math.ceil(height / pitch));
    const sx = width / nx, sy = height / ny;
    const factor = 65535 / h;
    const meta = {xmin, ymin, xmax, ymax, nx, ny, sx, sy, unknown: Array.from(unknown), activeMoves};
    const blank = () => new Uint16Array(nx * ny);
    const clamp = (t, a, b) => Math.max(a, Math.min(b, t));

    function sweep(pixels, i, fraction = 1, from = 0) {
      if (kind[i] !== 1 || !spindle[i] || fraction <= from) return 0;
      const tip = tools[tool[i]];
      if (!tip) return 0;
      const p = i * 6;
      const vx = xyz[p + 3] - xyz[p], vy = xyz[p + 4] - xyz[p + 1], vz = xyz[p + 5] - xyz[p + 2];
      const ax = xyz[p] + vx * from, ay = xyz[p + 1] + vy * from, az = xyz[p + 2] + vz * from;
      const span = fraction - from, dx = vx * span, dy = vy * span, dz = vz * span;
      const lowest = Math.min(az, az + dz);
      if (lowest >= top) return 0;
      const r = tip.radius, r2 = r * r;
      const limit = lowest <= z ? 65535 : Math.min(65534, Math.round((top - lowest) * factor));
      const startX = Math.max(0, Math.ceil((Math.min(ax, ax + dx) - r - xmin) / sx - 0.5));
      const endX = Math.min(nx - 1, Math.floor((Math.max(ax, ax + dx) + r - xmin) / sx - 0.5));
      const startY = Math.max(0, Math.ceil((Math.min(ay, ay + dy) - r - ymin) / sy - 0.5));
      const endY = Math.min(ny - 1, Math.floor((Math.max(ay, ay + dy) + r - ymin) / sy - 0.5));
      if (startX > endX || startY > endY) return 0;
      const len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
      const m = len > 0 ? dz / len : 0;
      const slopeFactor = tip.ball ? m / Math.sqrt(1 + m * m) :
        tip.cone && Math.abs(m) < tip.slope ? m / Math.sqrt(tip.slope * tip.slope - m * m) : 0;
      const firstU = xmin + (startX + 0.5) * sx - ax;
      let added = 0;
      for (let j = startY; j <= endY; j++) {
        const v = ymin + (j + 0.5) * sy - ay;
        let idx = j * nx + startX;
        let u = firstU;
        for (let k = startX; k <= endX; k++, idx++, u += sx) {
          if (pixels[idx] >= limit) continue;
          let baseZ = lowest, distance2;
          if (len2 < 1e-16) {
            distance2 = u * u + v * v;
          } else {
            const t0 = (u * dx + v * dy) / len2;
            let t = clamp(t0, 0, 1);
            if (Math.abs(dz) > 1e-8) {
              const cross = u * dy - v * dx;
              const perp2 = cross * cross / len2;
              if (perp2 > r2) continue;
              const half = Math.sqrt(Math.max(0, r2 - perp2)) / len;
              const tmin = Math.max(0, t0 - half), tmax = Math.min(1, t0 + half);
              if (tmin > tmax) continue;
              if (tip.ball) t = clamp(t0 - slopeFactor * half, tmin, tmax);
              else if (tip.cone && Math.abs(m) < tip.slope) {
                let shift = slopeFactor * Math.sqrt(perp2);
                // If the pointed cone's optimum falls on the tip flat, its
                // downhill edge gives the deepest contact on a ramp.
                if (tip.tipRadius && perp2 < tip.tipRadius * tip.tipRadius) {
                  const edge = Math.sqrt(tip.tipRadius * tip.tipRadius - perp2);
                  shift = Math.sign(m) * Math.max(Math.abs(shift), edge);
                }
                t = clamp(t0 - shift / len, tmin, tmax);
              }
              else t = dz >= 0 ? tmin : tmax;
            }
            const du = u - dx * t, dv = v - dy * t;
            distance2 = du * du + dv * dv;
            baseZ = az + dz * t;
          }
          if (distance2 > r2 + 1e-9) continue;
          if (tip.ball) baseZ += r - Math.sqrt(Math.max(0, r2 - distance2));
          else if (tip.cone) baseZ += Math.max(0, Math.sqrt(distance2) - tip.tipRadius) * tip.slope;
          // Reserve 65535 for an actual breakthrough. Quantizing a very thin floor must leave it solid.
          const removed = baseZ <= z ? 65535 : Math.min(65534, Math.round((top - baseZ) * factor));
          if (removed > pixels[idx]) {
            added += removed - pixels[idx];
            pixels[idx] = removed;
          }
        }
      }
      return added;
    }
    // Accumulate estimated air-feed time only for moves for which removal can
    // be simulated. Fixed intervals along a move keep results repeatable when
    // seeking; a lone long feed may enter and exit stock or a previously cut slot.
    function advance(pixels, i, fraction = 1, measurement) {
      const tip = tools[tool[i]];
      if (kind[i] !== 1 || !spindle[i] || !tip || fraction <= 0) return 0;
      const dt = endTime[i] - (i ? endTime[i-1] : 0), p = i * 6;
      const ax = xyz[p], ay = xyz[p+1], az = xyz[p+2];
      const dx = xyz[p+3]-ax, dy = xyz[p+4]-ay, dz = xyz[p+5]-az;
      const r = tip.radius;
      if (Math.min(az, az+dz) >= top || Math.max(ax, ax+dx)+r <= x ||
          Math.min(ax, ax+dx)-r >= x+l || Math.max(ay, ay+dy)+r <= y ||
          Math.min(ay, ay+dy)-r >= y+w) return dt * fraction;
      const travel = Math.hypot(dx, dy, dz), resolution = Math.max(sx, sy);
      const interval = Math.max(2 * resolution, r / 2);
      const steps = Math.max(1, Math.min(256, Math.ceil(travel / interval)));
      const sampleStart = measurement && travel ? Math.max(0, fraction - 2 * resolution / travel) : 0;
      let air = 0, start = 0;
      for (let j = 1; j <= Math.ceil(steps * fraction); j++) {
        const end = Math.min(fraction, j / steps);
        let units;
        if (measurement && start < sampleStart && sampleStart < end) {
          const before = sweep(pixels, i, sampleStart, start);
          const recent = sweep(pixels, i, end, sampleStart);
          units = before + recent;
          measurement.recent += recent;
        } else {
          units = sweep(pixels, i, end, start);
          if (measurement && start >= sampleStart) measurement.recent += units;
        }
        if (measurement) measurement.move += units;
        if (!units) {
          // Classify an incomplete interval the same way as the completed one
          // so the cumulative clock cannot run backward at first contact.
          const wholeEnd = j / steps;
          if (end >= wholeEnd || !sweep(pixels.slice(), i, wholeEnd, end)) air += end - start;
        }
        start = end;
      }
      return air * dt;
    }
    function cursorAt(seconds) {
      let lo = 0, hi = count;
      while (lo < hi) {
        const mid = (hi + lo) >>> 1;
        if (endTime[mid] <= seconds) lo = mid + 1; else hi = mid;
      }
      const t0 = lo > 0 ? endTime[lo - 1] : 0;
      const dt = lo < count ? endTime[lo] - t0 : 0;
      return {i: lo, fraction: dt > 0 ? clamp((seconds - t0) / dt, 0, 1) : 0};
    }
    // The caller supplies stock at the beginning of the segment. Sampling a
    // short trailing interval distinguishes cutting now from cutting earlier
    // in a long move that has since left the work or entered a cleared pocket.
    function inspectFrame(image, i, fraction, priorAirSeconds = 0) {
      const ended = i === count, move = ended ? count - 1 : i;
      const units = {move:0,recent:0};
      let cutter = null, airFeedSeconds = priorAirSeconds;
      if (move >= 0) {
        const p = 6 * move, f = ended ? 1 : fraction;
        const dx = xyz[p + 3] - xyz[p], dy = xyz[p + 4] - xyz[p + 1], dz = xyz[p + 5] - xyz[p + 2];
        const slot = tool[move], tip = tools[slot];
        let state;
        if (ended) state = "complete";
        else if (kind[move] === 0) state = "rapid";
        else if (kind[move] === 2) state = "dwell";
        else if (!spindle[move]) state = "spindle-off";
        else if (!tip) state = "unknown";
        else if (!fraction) state = "ready";
        else {
          airFeedSeconds += advance(image, i, fraction, units);
          state = units.recent > 0 ? "cutting" : "air";
        }
        cutter = {x:xyz[p] + f * dx, y:xyz[p + 1] + f * dy, z:xyz[p + 2] + f * dz,
          tool:slot, d:tip ? 2 * tip.radius : 0, shape:tip?.shape || "", angle:tip?.angle || 0, state, move};
        if (tip?.shape === "chamfer") cutter.tip = 2 * tip.tipRadius;
      }
      let totalUnits = 0;
      for (let j = 0; j < image.length; j++) totalUnits += image[j];
      const unitVolume = sx * sy * h / 65535;
      return {cutter, removal:{totalMM3:totalUnits * unitVolume, moveMM3:units.move * unitVolume,
        recentMM3:units.recent * unitVolume, airFeedSeconds}};
    }
    return {blank, sweep, advance, meta, cursorAt, inspectFrame};
  }

  function stockWorker(buildEngine, buildMesh) {
    let job, engine, stock, pixels, checkpoints, stride, built, mode, timer, request;
    let airSeconds, checkpointAir;
    let lastSolidDepths, meshError, removedError, removedVisible = false, hasRemovedMesh = false;
    let key = 0, lastProgress = 0;

    function report() { self.postMessage({key, type:"progress", progress: job.count ? built / job.count : 1}); }
    function display() {
      if (!request || !engine || !mode) return;
      const {i, fraction} = engine.cursorAt(request.t);
      if (built < i) return;
      const checkpoint = Math.floor(i / stride);
      const image = built === i ? pixels.slice() : checkpoints[checkpoint].slice();
      let frameAir = built === i ? airSeconds : checkpointAir[checkpoint];
      if (built !== i) {
        for (let j = checkpoint * stride; j < i; j++) frameAir += engine.advance(image, j);
      }
      const frame = {key, type:"image", mode, t:request.t, image, ...engine.inspectFrame(image, i, fraction, frameAir)};
      const buffers = [image.buffer];
      function transferMesh(mesh) { buffers.push(mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer); }
      if (mode === "solid") {
        // A motion above the surface can change the requested time without changing the mesh.
        // The main thread keeps the most recent mesh for this configuration during view switches.
        let changed = !lastSolidDepths;
        if (!changed) {
          for (let j = 0; j < image.length && !changed; j++) changed = image[j] !== lastSolidDepths[j];
        }
        if (changed) hasRemovedMesh = false;
        if (changed && !meshError) {
          try {
            frame.mesh = buildMesh(stock, engine.meta, image);
            transferMesh(frame.mesh);
            lastSolidDepths = image.slice();
          } catch (err) {
            meshError = "Could not build the stock surface: " + (err.message || err);
          }
        }
        if (meshError) frame.error = meshError;
        frame.removedVisible = removedVisible;
        if (removedVisible && !hasRemovedMesh && !meshError && !removedError) {
          try {
            frame.removedMesh = buildMesh(stock, engine.meta, image, true);
            transferMesh(frame.removedMesh);
            hasRemovedMesh = true;
          } catch (err) {
            removedError = "Could not build the removed volume: " + (err.message || err);
          }
        }
        if (removedError && removedVisible) frame.removedError = removedError;
      }
      self.postMessage(frame, Array.from(new Set(buffers)));
      request = null;
    }
    function pump() {
      timer = undefined;
      if (!mode) return;
      display();
      const deadline = performance.now() + 16;
      while (built < job.count && performance.now() < deadline) {
        const stop = Math.min(built + 64, job.count);
        for (; built < stop;) {
          airSeconds += engine.advance(pixels, built++);
          if (built % stride === 0) { checkpoints.push(pixels.slice()); checkpointAir.push(airSeconds); }
        }
      }
      const now = performance.now();
      if (built === job.count || now - lastProgress > 240) { report(); lastProgress = now; }
      display();
      if (built < job.count) timer = setTimeout(pump, 0);
    }
    self.onmessage = ({data}) => {
      if (data.type === "job") job = data.job;
      if (data.type === "configure") {
        clearTimeout(timer); timer = undefined; key = data.key;request = null;
        stock = data.stock; lastSolidDepths = null; meshError = removedError = ""; hasRemovedMesh = false;
        engine = buildEngine(job, stock, data.tools);
        pixels = engine.blank(); checkpoints = [pixels.slice()];built = 0;
        airSeconds = 0; checkpointAir = [0];
        const maxFrames = Math.max(2, Math.min(120, Math.floor(16 * 1024 * 1024 / pixels.byteLength)));
        stride = Math.max(1, Math.ceil(job.count / maxFrames));
        self.postMessage({key,type:"meta",meta:engine.meta});
      }
      if (data.type === "active") {
        mode = data.active === true ? "depth" : data.active;
        request = null;
      }
      if (data.type === "removed" && removedVisible !== data.visible) {
        removedVisible = data.visible; hasRemovedMesh = false; removedError = "";
      }
      if (data.type === "seek") request = {t:data.t};
      if (engine && mode && timer === undefined) timer = setTimeout(pump, 0);
    };
  }
  function NCCutMap(container, {onStatus, onFrame} = {}) {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;cursor:grab";
    canvas.setAttribute("aria-label","Top view of simulated stock removal");
    container.append(canvas);
    const ctx = canvas.getContext("2d", {alpha:false});
    const texture = document.createElement("canvas");
    const textureCtx = texture.getContext("2d");
    let job, stock = {x:0,y:0,z:-1,l:1,w:1,h:1}, tools = {};
    let meta, worker, workerUrl, activeView = false, configureTimer, seekTimer;
    let sourceChanged = true, configDirty = true, progress = 0, requested = 0;
    let imageTime = -1, textureValid = false, key = 0, error = "", solidError = "", removedError = "";
    let removedVisible = false;
    let lastDepths = null, solidFrame = null, lastStatus = "", sentTime = -1;
    let zoomFactor = 1, cx = 0, cy = 0, mode = "path", customCamera = false;
    let width = 0, height = 0, scale = 1, lastSeek = 0, frame;
    let cursorX, cursorY;
    const observer = new ResizeObserver(() => schedulePaint()); observer.observe(container);

    function viewRect(which) {
      if (which === "path" && meta && meta.activeMoves)
        return [meta.xmin, meta.ymin, meta.xmax, meta.ymax];
      return [stock.x, stock.y, stock.x + stock.l, stock.y + stock.w];
    }
    function fit(which) {
      mode = which === "stock" ? "stock" : "path"; customCamera = false;
      const b = viewRect(mode);
      cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2; zoomFactor = 1;
      schedulePaint();
    }
    function zoom(factor, ox = width / 2, oy = height / 2) {
      if (!Number.isFinite(factor) || factor <= 0 || !scale) return;
      customCamera = true;
      const newZoom = Math.max(.08, Math.min(80, zoomFactor * factor));
      const r = newZoom / zoomFactor;
      cx += (ox - width / 2) / scale * (1 - 1 / r);
      cy -= (oy - height / 2) / scale * (1 - 1 / r);
      zoomFactor = newZoom; schedulePaint();
    }
    function sendSeek() {
      clearTimeout(seekTimer);seekTimer = undefined;
      if (!worker || !job || !activeView || configDirty || sentTime === requested) return;
      worker.postMessage({type:"seek", t:requested});
      sentTime = requested;
      lastSeek = performance.now();
    }
    function seek(seconds) {
      requested = Math.max(0, Math.min(job ? job.duration : 0, Number(seconds) || 0));
      if (!activeView || !worker || requested === sentTime) return;
      if (seekTimer === undefined) seekTimer = setTimeout(sendSeek, Math.max(0, 90 - performance.now() + lastSeek));
      schedulePaint();
    }
    function startWorker() {
      if (worker) return;
      const meshSource = globalThis.buildSolidMesh?.toString() || "null";
      const code = "(" + stockWorker.toString() + ")(" + buildStockEngine.toString() + "," + meshSource + ");";
      workerUrl = URL.createObjectURL(new Blob([code], {type:"text/javascript"}));
      worker = new Worker(workerUrl);
      worker.onmessage = ({data}) => {
        if (data.key !== key) return;
        if (data.type === "meta") {
          meta = data.meta;textureValid = false;
          if (!customCamera) fit(mode);
        }
        if (data.type === "progress") progress = data.progress;
        if (data.type === "image" && meta) {
          imageTime = data.t;lastDepths = data.image;textureValid = false;
          if (activeView === "depth") { colorize(lastDepths); textureValid = true; }
          if (data.mode === "solid") {
            // Keep the worker's mesh even if the user switched views while it was in flight.
            // That lets an unchanged future frame arrive with only the new time and depths.
            solidError = data.error || "";
            removedError = removedVisible ? (data.removedError || "") : "";
            const mesh = data.mesh || solidFrame?.mesh;
            const removedMesh = removedVisible && data.removedVisible
              ? data.removedMesh || (!data.mesh && solidFrame?.removedMesh) || null : null;
            if (mesh && !solidError) solidFrame = {stock,meta,t:data.t,mesh,removedMesh,depths:data.image,
              cutter:data.cutter,removal:data.removal};
            if (onFrame && activeView === "solid") onFrame(solidError ? null : solidFrame);
          }
        }
        reportStatus();
        schedulePaint();
      };
      worker.onerror = event => {
        error = "Depth preview unavailable" + (event.message ? " · " + event.message : "");
        reportStatus();schedulePaint();
      };
    }
    function configure() {
      clearTimeout(configureTimer);configureTimer = undefined;
      if (!job || !stock || !activeView || !configDirty) return;
      try {
        startWorker();
        if (sourceChanged) {
          const {count,xyz,kind,tool,spindle,endTime} = job;
          worker.postMessage({type:"job", job:{count,xyz,kind,tool,spindle,endTime}});
          sourceChanged = false;
        }
        worker.postMessage({type:"configure",key,stock,tools});
        worker.postMessage({type:"removed",visible:removedVisible});
        configDirty = false;progress = 0;meta = undefined;error = "";sentTime = -1;
        worker.postMessage({type:"active",active:activeView});sendSeek();
      } catch (e) {
        error = "Could not start depth preview · " + e.message;
        reportStatus();schedulePaint();
      }
    }
    function dirty() {
      key++;configDirty = true;textureValid = false;imageTime = -1;meta = undefined;progress = 0;
      lastDepths = null;solidFrame = null;solidError = removedError = "";error = "";sentTime = -1;
      if (onFrame) onFrame(null);
      reportStatus();
      clearTimeout(configureTimer);configureTimer = setTimeout(configure, 35);
      schedulePaint();
    }
    function reportStatus() {
      if (!onStatus) return;
      let status = error;
      if (!status && activeView === "solid") {
        if (solidError) status = solidError;
        else if (removedError) status = removedError;
        else if (!meta) status = "Preparing stock simulation…";
        else if (meta.unknown.length) status = "Missing cutter diameter for " + meta.unknown.map(i => "T" + i).join(", ") + ". Those cuts are omitted.";
        else if (!meta.activeMoves) status = "No spindle-on feed intersects the stock.";
        else if (!solidFrame) status = "Building stock surface… " + Math.round(progress * 100) + "%";
      }
      if (status !== lastStatus) { lastStatus = status; onStatus(status); }
    }
    const imageTexture = {img:null};
    function colorize(depths) {
      const {nx,ny,sx,sy} = meta;
      if (texture.width !== nx || texture.height !== ny || !imageTexture.img) {
        texture.width = nx;texture.height = ny;imageTexture.img = textureCtx.createImageData(nx,ny);
      }
      const raw = imageTexture.img.data;
      for (let j = 0; j < ny; j++) {
        let dst = (ny - 1 - j) * nx * 4;
        for (let i = 0; i < nx; i++, dst += 4) {
          const k = nx * j + i, d = depths[k], t = d / 65535;
          if (d === 65535) {
            raw[dst]=27;raw[dst+1]=39;raw[dst+2]=47;raw[dst+3]=255;continue;
          }
          const ddx = (depths[(i + 1 < nx) ? k + 1 : k] - depths[(i > 0) ? k - 1 : k]) * stock.h / (131070 * sx);
          const ddy = (depths[(j + 1 < ny) ? k + nx : k] - depths[(j > 0) ? k - nx : k]) * stock.h / (131070 * sy);
          const shade = 1 + .43 * (-.72 * ddx + .69 * ddy) / Math.sqrt(1 + ddx*ddx + ddy*ddy);
          raw[dst] = (210 - 117*t)*shade; raw[dst+1] = (151 - 96*t)*shade;
          raw[dst+2] = (108 - 63*t)*shade; raw[dst+3] = 255;
        }
      }
      textureCtx.putImageData(imageTexture.img,0,0);
    }
    function schedulePaint() {
      if (activeView !== "depth" || frame !== undefined) return;
      frame = requestAnimationFrame(() => { frame = undefined; paint(); });
    }
    function stamp(t) {
      const value = Math.max(0,Math.floor(t||0));
      return String(Math.floor(value/3600)).padStart(2,"0")+":"+
        String(Math.floor(value/60)%60).padStart(2,"0")+":"+String(value%60).padStart(2,"0");
    }
    function paint() {
      if (activeView !== "depth") return;
      width = container.clientWidth; height = container.clientHeight;
      if (!width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1,2);
      const bw = Math.round(width*dpr),bh = Math.round(height*dpr);
      if(canvas.width!==bw||canvas.height!==bh){canvas.width=bw;canvas.height=bh;}
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.fillStyle = "#112029";ctx.fillRect(0,0,width,height);
      const rect = viewRect(mode),dx = rect[2] - rect[0], dy = rect[3] - rect[1];
      scale = Math.max(.001,Math.min(Math.max(40,width-100)/Math.max(.001,dx),Math.max(40,height-97)/Math.max(.001,dy))) * zoomFactor;
      const px = x => width/2 + (x-cx)*scale, py = y => height/2 - (y-cy)*scale;
      const gridNom = 70/scale;
      const pow = Math.pow(10,Math.floor(Math.log10(gridNom)));
      const grid = [1,2,5,10].find(s=>s>=gridNom/pow)*pow;
      const left = cx-width/2/scale, right=cx+width/2/scale;
      const front = cy-height/2/scale, back=cy+height/2/scale;
      ctx.lineWidth = 1;ctx.strokeStyle="#25333c";ctx.beginPath();
      for(let x = Math.ceil(left/grid)*grid;x<=right;x+=grid){ctx.moveTo(px(x),0);ctx.lineTo(px(x),height);}
      for(let y = Math.ceil(front/grid)*grid;y<=back;y+=grid){ctx.moveTo(0,py(y));ctx.lineTo(width,py(y));}
      ctx.stroke();
      const sl = px(stock.x), st = py(stock.y+stock.w),sw=stock.l*scale,sh=stock.w*scale;
      ctx.fillStyle="rgb(210,151,108)";ctx.fillRect(sl,st,sw,sh);
      if (textureValid && meta) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(texture,px(meta.xmin),py(meta.ymax),(meta.xmax-meta.xmin)*scale,(meta.ymax-meta.ymin)*scale);
      }
      ctx.strokeStyle="#e4b58e";ctx.strokeRect(sl,st,sw,sh);
      if (textureValid && imageTime >= 0 && job.count) {
        let first=0, end=job.count;
        while(first<end){const mid=(first+end)>>>1;if(job.endTime[mid]<=imageTime)first=mid+1;else end=mid;}
        const i=Math.min(job.count-1,first),ta=i?job.endTime[i-1]:0,tb=job.endTime[i];
        const t=tb>ta?Math.max(0,Math.min(1,(imageTime-ta)/(tb-ta))):1;
        const off=i*6, coords=job.xyz;
        const tx=px(coords[off]+(coords[off+3]-coords[off])*t);
        const ty=py(coords[off+1]+(coords[off+4]-coords[off+1])*t);
        const diameter=Number(tools[job.tool[i]]?.d)||0;
        const radius=Math.max(2.5,diameter*scale/2);
        ctx.save();ctx.strokeStyle=job.kind[i]===0?"#e7e5ce":"#f8fff7";ctx.lineWidth=1.4;
        if(job.kind[i]===0)ctx.setLineDash([3,3]);
        ctx.beginPath();ctx.arc(tx,ty,radius,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
        ctx.beginPath();ctx.moveTo(tx-3,ty);ctx.lineTo(tx+3,ty);ctx.moveTo(tx,ty-3);ctx.lineTo(tx,ty+3);ctx.stroke();ctx.restore();
      }
      const ox=px(0),oy=py(0);
      ctx.strokeStyle="#a5ebd7";ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(ox-7,oy);ctx.lineTo(ox+13,oy);ctx.moveTo(ox,oy+7);ctx.lineTo(ox,oy-13);ctx.stroke();
      ctx.font="11px system-ui,sans-serif";ctx.fillStyle="#e3fff2";
      if (ox>=0 && ox<width-48 && oy>=12 && oy<height-36) ctx.fillText("X0 Y0",ox+7,oy+16);
      const legendX=13,legendY=height-44;ctx.fillStyle="rgba(10,22,30,.91)";
      ctx.fillRect(legendX,legendY,Math.min(width-26,354),34);ctx.font="11px system-ui,sans-serif";
      ctx.fillStyle="#d2976c";ctx.fillRect(legendX+8,legendY+9,9,8);
      ctx.fillStyle="#e6eef0";ctx.fillText("Stock top",legendX+22,legendY+18);
      const ramp=ctx.createLinearGradient(legendX+88,0,legendX+141,0);
      ramp.addColorStop(0,"rgb(210,151,108)");ramp.addColorStop(1,"rgb(93,55,45)");
      ctx.fillStyle=ramp;ctx.fillRect(legendX+88,legendY+9,51,8);
      ctx.fillStyle="#e6eef0";ctx.fillText(stock.h.toFixed(2)+" mm deep",legendX+144,legendY+18);
      if (width>350) {ctx.fillStyle="#1b272f";ctx.fillRect(legendX+232,legendY+9,9,8);ctx.strokeStyle="#8b9a9e";ctx.strokeRect(legendX+232,legendY+9,9,8);ctx.fillStyle="#e6eef0";ctx.fillText("Through",legendX+249,legendY+18);}
      const status = error || (!meta ? "Preparing depth preview…" :
        !meta.activeMoves ? (meta.unknown.length?"No modelled cutter contacts the stock":"No spindle-on feed intersects the stock"):
        (imageTime < 0 ? "Preparing stock surface" : "Cut depth at "+stamp(imageTime)) +
        (progress<1?" · caching "+Math.floor(progress*100)+"%":"")+
        (meta.unknown.length?" · skipped tools "+meta.unknown.map(i=>"T"+i).join(", "):""));
      ctx.font="12px system-ui,sans-serif";
      const statusWidth=Math.min(width-26,ctx.measureText(status).width+16);
      ctx.fillStyle="rgba(10,22,30,.91)";ctx.fillRect(13,12,statusWidth,22);
      ctx.fillStyle="#d8e5e7";ctx.fillText(status,21,27);
      if(meta){
        const small="Top view · "+Math.max(meta.sx,meta.sy).toFixed(2)+" mm grid";
        ctx.font="10px system-ui,sans-serif";ctx.fillStyle="#c2cfd3";
        ctx.fillText(small,21,height-16);
      }
    }
    canvas.addEventListener("pointerdown",e=>{
      cursorX=e.clientX;cursorY=e.clientY;canvas.setPointerCapture(e.pointerId);canvas.style.cursor="grabbing";
    });
    canvas.addEventListener("pointermove",e=>{
      if(cursorX==null)return;
      customCamera=true;cx-=(e.clientX-cursorX)/scale;cy+=(e.clientY-cursorY)/scale;
      cursorX=e.clientX;cursorY=e.clientY;schedulePaint();
    });
    ["lostpointercapture","pointercancel","pointerup"].forEach(name=>canvas.addEventListener(name,()=>{cursorX=null;cursorY=null;canvas.style.cursor="grab";}));
    canvas.addEventListener("wheel",e=>{e.preventDefault();const b=canvas.getBoundingClientRect();
      zoom(Math.exp(-Math.max(-180,Math.min(180,e.deltaY))*.003),e.clientX-b.left,e.clientY-b.top);
    },{passive:false});
    canvas.addEventListener("dblclick",()=>fit("path"));
    return {
      setJob(next) {
        if(job===next)return;job=next;sourceChanged=true;requested=0;customCamera=false;dirty();
      },
      setStock(next) {
        const converted={};
        for(const prop of ["x","y","z","l","w","h"])converted[prop]=Number(next[prop]);
        if(!Object.values(converted).every(Number.isFinite)||[converted.l,converted.w,converted.h].some(s=>s<=0))return;
        if(JSON.stringify(stock)===JSON.stringify(converted))return;stock=converted;dirty();
      },
      setTools(next) {if(JSON.stringify(tools)===JSON.stringify(next))return;tools=JSON.parse(JSON.stringify(next));dirty();},
      setRemovedVisible(value) {
        const next = Boolean(value);
        if (next === removedVisible) return;
        removedVisible = next; removedError = "";
        if (!next && solidFrame?.removedMesh) {
          solidFrame = {...solidFrame, removedMesh:null};
          if (activeView === "solid" && onFrame) onFrame(solidFrame);
        }
        if (worker) worker.postMessage({type:"removed",visible:next});
        if (activeView === "solid") { sentTime = -1; sendSeek(); }
        reportStatus();
      },
      setTime:seek,
      setActive(view) {
        const next = view === "solid" ? "solid" : (view ? "depth" : false);
        if (next === activeView) return;
        activeView = next;sentTime = -1;
        if (next) {
          if (next === "depth" && lastDepths && !textureValid) {colorize(lastDepths);textureValid=true;}
          if (next === "solid" && onFrame) onFrame(solidFrame);
          if(configDirty)configure();else if(worker){worker.postMessage({type:"active",active:next});sendSeek();}
          schedulePaint();
        } else if(worker)worker.postMessage({type:"active",active:false});
        reportStatus();
      },
      fit,zoom,
      destroy() {
        observer.disconnect();clearTimeout(configureTimer);clearTimeout(seekTimer);cancelAnimationFrame(frame);
        if(worker)worker.terminate();if(workerUrl)URL.revokeObjectURL(workerUrl);canvas.remove();
      }
    };
  }
  globalThis.NCCutMap = NCCutMap;
  if (typeof module !== "undefined" && module.exports) module.exports = {buildStockEngine, stockWorker};
})();
