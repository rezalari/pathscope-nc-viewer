/* Offline work-coordinate NC interpreter. No machine connection or file execution. */
(function () {
  'use strict';

  const axisKeys = ['X', 'Y', 'Z'];
  const centerKeys = ['I', 'J', 'K'];
  const planes = {17: [0, 1, 2], 18: [2, 0, 1], 19: [1, 2, 0]};
  const tau = Math.PI * 2;
  function signedSweep(start, end, clockwise, fullCircle) {
    if (fullCircle) return clockwise ? -tau : tau;
    let a = (end - start) % tau;
    if (clockwise && a > 0) a -= tau;
    if (!clockwise && a < 0) a += tau;
    return a;
  }

  // Arrays grow only when the estimated input line count is exceeded (primarily arcs).
  function parseNC(source, options = {}) {
    if (!source.includes('\n') && source.includes('\r')) source = source.replaceAll('\r','\n');
    const rapidFeed = options.rapidFeed > 0 ? Number(options.rapidFeed) : 1800;
    const defaultFeed = options.defaultFeed > 0 ? Number(options.defaultFeed) : 200;
    const carvera = /\bcarvera\b/i.test(source.slice(0,1600));
    const dwellP = options.dwellPSeconds ?? (carvera ? 0.001 : 1);
    let capacity = Math.max(512, Math.min(1000000, Math.ceil(source.length / 19)));
    const types = {xyz: Float32Array, kind: Uint8Array, tool: Uint16Array, line: Uint32Array,
                   feed: Float32Array, spindle: Uint8Array, endTime: Float64Array};
    const out = {};
    for (const k in types) out[k] = new types[k](capacity * (k === 'xyz' ? 6 : 1));
    let count = 0, duration = 0, firstFeedIndex = -1, ln = 0;
    const stages = [], holes = [], warnings = [], notes = [], reported = new Set(), usedTools = new Set();
    const bounds = {min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity]};
    let p = [NaN,NaN,NaN], unit = 1, mode = null, plane = 17, absolute = true, absCenter = false;
    let pendingTool = 0, activeTool = 0, spindleOn = 0, feedRate = NaN, wcs = null, cycle = null, returnInitial = true;
    let pendingStage = null, pendingHole = null, stopped = false, omittedStart = false, implicitRange = false;

    function warn(key, message) {
      if (reported.has(key)) return;
      reported.add(key);
      if (warnings.length < 30) warnings.push('Line ' + ln + ': ' + message);
    }
    function stop(reason) {
      warn('stopped', reason + '. Preview ends before this block.');
      stopped = true;
    }
    function append(to, kind, rate, seconds) {
      if (!p.every(Number.isFinite) || !to.every(Number.isFinite)) {
        if (kind !== 2) omittedStart = true;
        p = to;
        return;
      }
      if (kind !== 2 && to[0] === p[0] && to[1] === p[1] && to[2] === p[2]) return;
      let dt = seconds;
      if (kind !== 2) {
        if (!(rate > 0)) {
          rate = defaultFeed;
          warn('missing-feed', 'Estimated feed time uses ' + defaultFeed + ' mm/min until an F word is available.');
        }
        dt = 60 * Math.hypot(to[0]-p[0], to[1]-p[1], to[2]-p[2]) / rate;
      }
      if (kind === 2 && !(dt > 0)) return;
      if (count === capacity) {
        capacity = Math.ceil(capacity * 1.45);
        for (const k in types) {
          const arr = new types[k](capacity * (k === 'xyz' ? 6 : 1));
          arr.set(out[k]); out[k] = arr;
        }
      }
      if (pendingStage || !stages.length) {
        stages.push({name: pendingStage || (activeTool ? 'Tool T' + activeTool : 'Program'), index:count, time:duration, tool:activeTool});
        pendingStage = null;
      }
      if (pendingHole) {
        const marker = typeof pendingHole === 'string' ? {name:pendingHole,x:to[0],y:to[1]} : pendingHole;
        holes.push({...marker, index:count, time:duration});
        pendingHole = null;
      }
      for (let i=0; i<3; i++) {
        out.xyz[count*6+i] = p[i]; out.xyz[count*6+3+i] = to[i];
        bounds.min[i] = Math.min(bounds.min[i], p[i], to[i]);
        bounds.max[i] = Math.max(bounds.max[i], p[i], to[i]);
      }
      if (firstFeedIndex === -1 && kind === 1) firstFeedIndex = count;
      duration += dt;
      out.kind[count]=kind; out.tool[count]=activeTool; out.line[count]=ln; out.feed[count]=rate || 0;
      out.spindle[count]=spindleOn; out.endTime[count]=duration; count++;
      if (activeTool || (kind===1 && spindleOn)) usedTools.add(activeTool);
      p = to;
    }

    function arc(end, values) {
      const [u,v,w] = planes[plane], start = p.slice(), cw = mode === 2;
      if (!start.every(Number.isFinite)) { stop('Arc begins at an unknown position'); return; }
      const dx=end[u]-start[u], dy=end[v]-start[v], chord=Math.hypot(dx,dy), full=chord<1e-7;
      let cu,cv;
      if (values.R !== undefined) {
        if (values[centerKeys[u]] !== undefined || values[centerKeys[v]] !== undefined) { stop('Arc specifies both R and center offsets'); return; }
        const radius = Math.abs(values.R)*unit;
        if (full || !radius || chord>2*radius+.002) { stop('Invalid R arc'); return; }
        const side=(cw?-1:1)*(values.R<0?-1:1);
        const height=Math.sqrt(Math.max(0,radius*radius-chord*chord/4))*side;
        cu=(start[u]+end[u])/2-dy/chord*height;
        cv=(start[v]+end[v])/2+dx/chord*height;
      } else {
        const iu=values[centerKeys[u]],iv=values[centerKeys[v]];
        if ((iu===undefined&&iv===undefined) || (absCenter&&(iu===undefined||iv===undefined))) {
          stop('Missing arc center in the selected plane'); return;
        }
        cu=(absCenter?0:start[u])+(iu||0)*unit;
        cv=(absCenter?0:start[v])+(iv||0)*unit;
      }
      const radius=Math.hypot(start[u]-cu,start[v]-cv);
      if (!(radius>0) || Math.abs(radius-Math.hypot(end[u]-cu,end[v]-cv))>Math.max(.02,radius*.001)) {
        stop('Arc endpoints disagree with the specified center');return;
      }
      const a0=Math.atan2(start[v]-cv,start[u]-cu), a1=Math.atan2(end[v]-cv,end[u]-cu);
      let sweep=signedSweep(a0,a1,cw,full);
      const turns=values.P ?? 1;
      if (!Number.isInteger(turns)||turns<1||turns>256) { stop('Unsupported arc turn count'); return; }
      sweep+=(cw?-1:1)*tau*(turns-1);
      const maxAngle=Math.min(Math.PI/18,2*Math.acos(Math.max(-1,1-.01/radius)));
      const pieces=Math.ceil(Math.abs(sweep)/Math.max(maxAngle,1e-6));
      if (pieces>100000 || count+pieces>15000000) { stop('Arc subdivision exceeds preview size'); return; }
      for (let j=1;j<=pieces;j++) {
        if (j===pieces) {append(end,1,feedRate);break;}
        const t=j/pieces, a=a0+sweep*t, vtx=[0,0,0];
        vtx[u]=cu+radius*Math.cos(a); vtx[v]=cv+radius*Math.sin(a); vtx[w]=start[w]+(end[w]-start[w])*t;
        append(vtx,1,feedRate);
      }
    }

    function drill(values, changed, end) {
      if (!absolute || plane!==17 || (values.L!==undefined && values.L!==1)) {
        stop('Only absolute G17 single-repeat G81/G82/G83 drilling is modeled');return;
      }
      if (changed || !cycle) cycle={z:NaN,r:NaN,q:NaN,p:0,initial:p[2]};
      for (const k of ['z','r','q','p']) if (values[k.toUpperCase()]!==undefined) cycle[k]=values[k.toUpperCase()]*(k==='p'?1:unit);
      const {r,z,q,initial}=cycle;
      if (!Number.isFinite(r+z+initial) || r<=z || (mode===83 && (!(q>0) || (r-z)/q>2000))) {
        stop('Missing or invalid drilling-cycle depth, retract, peck or initial Z');return;
      }
      const [x,y]=end;
      if (!Number.isFinite(x+y)) { stop('Drilling cycle has no known XY position'); return; }
      pendingHole={name:typeof pendingHole==='string'?pendingHole:('Hole '+(holes.length+1)),x,y};
      if (p[2]<r) append([p[0],p[1],r],0,rapidFeed);
      append([x,y,p[2]],0,rapidFeed); append([x,y,r],0,rapidFeed);
      if (mode===83) {
        warn('peck', 'G83 peck approach clearance is approximated at 0.1 mm.');
        let bottom=r;
        while (bottom>z) {
          if (bottom<r) append([x,y,Math.min(r,bottom+.1)],0,rapidFeed);
          bottom=Math.max(z,bottom-q);
          append([x,y,bottom],1,feedRate);
          if (bottom>z) append([x,y,r],0,rapidFeed);
        }
      } else {
        append([x,y,z],1,feedRate);
        if (mode===82 && cycle.p>0) append(p,2,0,cycle.p*dwellP);
      }
      append([x,y,returnInitial?Math.max(r,initial):r],0,rapidFeed);
    }
    function comment(text) {
      const clean=text.trim();
      const stage=/^(\d{2}[a-z]?_[a-z0-9_ .-]+)$/i.exec(clean) ||
                  /^(?:operation|op|toolpath)\s*[:=]\s*(.+)$/i.exec(clean);
      if (stage) pendingStage=stage[1].replaceAll('_',' ');
      const hole=/^hole\s+\d+\b/i.exec(clean);
      if (hole) pendingHole=hole[0];
    }

    let cursor=0;
    while (cursor<source.length && !stopped) {
      let next=source.indexOf('\n',cursor);
      if(next===-1)next=source.length;
      let block=source.slice(cursor,next).trim();cursor=next+1;ln++;
      if (!block || block==='%')continue;
      if (block.includes('(')) block=block.replace(/\(([^()]*)\)/g,(_,t)=>{comment(t);return '';});
      const sem=block.indexOf(';');
      if(sem>=0){comment(block.slice(sem+1));block=block.slice(0,sem);}
      block=block.trim().toUpperCase();if(!block)continue;
      if (/[#\[\]=]|^O\s*<|\b(?:IF|WHILE|CALL|REPEAT)\b/.test(block)) {stop('Macros and program flow are unsupported');break;}
      if (block[0]==='/') {stop('Optional block execution depends on controller state');break;}
      if (block.includes('*')) block=block.split('*')[0];
      const words=/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
      let match,last=0,garbage=false; const values={},gs=[],ms=[];
      while ((match=words.exec(block))!==null) {
        if (block.slice(last,match.index).trim()) garbage=true;
        last=words.lastIndex;
        const letter=match[1],v=Number(match[2]);
        if (!Number.isFinite(v)) {garbage=true;break;}
        if(letter==='G') gs.push(v);else if(letter==='M') ms.push(v);else values[letter]=v;
      }
      if(garbage || block.slice(last).trim()){stop('Unrecognized instruction');break;}
      if (['A','B','C','U','V','W','E'].some(k=>values[k]!==undefined)) {stop('Additional axis or extrusion is unsupported');break;}
      const hasXYZ=values.X!==undefined||values.Y!==undefined||values.Z!==undefined;
      let dwell=false,machineMove=false,cycleChanged=false,toolChanged=false;
      for (const g of gs) {
        if (g===0||g===1||g===2||g===3) {mode=g;cycle=null;}
        else if(g===81||g===82||g===83) {cycleChanged=!cycle||mode!==g;mode=g;}
        else if(g===80){mode=null;cycle=null;}
        else if(g===4)dwell=true;
        else if(g===17||g===18||g===19)plane=g;
        else if(g===20||g===21)unit=g===20?25.4:1;
        else if(g===90||g===91)absolute=g===90;
        else if(g===90.1||g===91.1)absCenter=g===90.1;
        else if(g===98||g===99)returnInitial=g===98;
        else if(g>=54&&g<=59&&Number.isInteger(g)){
          if(wcs!==null&&wcs!==g){stop('Multiple work offsets require a physical offset table');break;}
          wcs=g;
        }
        else if(g===53||g===28||g===30){machineMove=true;}
        else if([40,43,49,61,61.1,64,94,97].includes(g)){}
        else {stop('Unsupported G'+g);break;}
      }
      if(stopped)break;
      if(values.T!==undefined){
        if(!Number.isInteger(values.T)||values.T<0||values.T>65535){stop('Invalid tool number');break;}
        pendingTool=values.T;
      }
      for(const m of ms){
        if(m===6){toolChanged=activeTool!==pendingTool;activeTool=pendingTool;}
        else if(m===3||m===4)spindleOn=1;
        else if(m===5)spindleOn=0;
        else if(m===0||m===1)warn('operator-stop','Operator stop time is excluded.');
        else if(m===2||m===30){stopped=true;break;}
        else if([7,8,9,48,49,400].includes(m)){}
        else{stop('Unsupported M'+m);break;}
      }
      if(stopped)break;
      if(toolChanged&&!pendingStage)pendingStage='Tool T'+activeTool;
      if(values.F!==undefined)feedRate=values.F*unit;
      if(machineMove){p=[NaN,NaN,NaN];warn('machine-frame','Machine-coordinate or reference moves and subsequent unknown travel are omitted.');continue;}
      if(dwell) {if(!Number.isFinite(p[0]+p[1]+p[2])) {implicitRange=true;} else append(p,2,0,values.S??(values.P||0)*dwellP);continue;}
      if(!hasXYZ && !(mode===2||mode===3||mode===81||mode===82||mode===83))continue;
      const arcWords=values.R!==undefined||values.I!==undefined||values.J!==undefined||values.K!==undefined;
      if(!hasXYZ && !arcWords && !cycleChanged)continue;
      const end=axisKeys.map((k,i)=>values[k]===undefined?p[i]:((absolute?0:p[i])+values[k]*unit));
      if(mode===0||mode===1)append(end,mode,mode===0?rapidFeed:feedRate);
      else if(mode===2||mode===3)arc(end,values);
      else if(mode===81||mode===82||mode===83)drill(values,cycleChanged,end);
      else if(hasXYZ)warn('unknown-mode','Axis words before a motion mode are omitted.');
    }
    if(omittedStart || implicitRange)notes.push('Approach travel and dwell before the first known XYZ position are excluded from timing.');
    if(!count) {bounds.min=[0,0,0];bounds.max=[0,0,0];}
    for(const k in types)out[k]=out[k].subarray(0,count*(k==='xyz'?6:1));
    return {...out,count,duration,bounds,stages,holes,tools:[...usedTools],warnings,notes,firstFeedIndex,lineCount:ln};
  }
  globalThis.parseNC=parseNC;
  if (typeof module!=='undefined' && module.exports)module.exports=parseNC;
}());
