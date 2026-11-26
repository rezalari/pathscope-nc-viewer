(() => {
  'use strict';
  const by = id => document.getElementById(id);
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const palette = ['#a9bdcf','#42c7b1','#c89bff','#dac96e','#f0aa68','#69acff','#ee8e9d','#87c3a3'];
  const color = t => palette[t % palette.length];
  const colors = t => { const x = el('i','dot'); x.style.background = color(t); return x; };
  const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
  const fmt = n => Number.isFinite(n) ? (Math.abs(n)<.0005?0:n).toFixed(3) : '—';
  const clock = value => { const sec=Math.floor(Math.max(0,value)); return (sec>=3600?Math.floor(sec/3600)+':':'')+String(Math.floor(sec/60)%60).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'); };
  const option = (name,value) => new Option(name,String(value));
  const on = (id,event,fn) => by(id).addEventListener(event,fn);
  const stockKeys=['l','w','h','x','y','z'];
  const flags={rapid:true,future:true,stock:true,grid:true,markers:true,tool:true};
  const flagNames={rapid:'Rapids',future:'Future paths',stock:'Stock',grid:'Grid',markers:'Entry markers',tool:'Cutter'};
  let job=null, source='', ticket=0, playing=false, lastTick=0, time=0, view='solid', seq=[], stageNodes=[], contact=null, entry=null, stageId=-1, stock={}, cutTools={}, dragCount=0, loadState=false;
  let stockFrame=null, activeSlot=null, stopLookup=null, lookupId=0, inspectedTime=null;
  const sourceList=NCSourceList({viewport:by('linecode'),input:by('source-line'),go:by('source-go'),note:by('source-note'),
    onSeek:(seconds,line)=>{pause();seek(seconds,line);}});
  function notice(title,msg) { by('msgtitle').textContent=title; by('msgtext').textContent=msg; by('msg').showModal(); }
  function busy(text) { by('busy').hidden=!text; if(text) by('busy').firstElementChild.textContent=text; }
  const path=new NCRenderer(by('path-surface'),{onViewChange:name=>{
    by('path-angle').value=name==='orbit'?'iso':name;
  }});
  let solid;
  try { solid=new NCSolidRenderer(by('solid-surface')); }
  catch (error) { console.warn('Solid preview unavailable',error); }
  const hasSolid=Boolean(solid && solid.available!==false);
  const cut=new NCCutMap(by('depth-surface'),{
    onFrame:frame=>{
      stockFrame=frame;
      if(hasSolid)solid.setFrame(frame);
      updateMaterialReadout();
    },
    onStatus:message=>{if(hasSolid)solid.setStatus(message);}
  });
  const engagementLabels={
    cutting:'Cutting material',air:'Feeding in air',rapid:'Rapid travel',dwell:'Dwell',
    'spindle-off':'Spindle off',unknown:'Tool size unknown',ready:'Ready',complete:'Finished'
  };
  function toolName(slot){
    const def=cutTools[slot], name=slot?'T'+slot:'Unnumbered tool';
    const shape=def?.d>0 || def?.shape==='chamfer' ? {flat:'Flat end mill',ball:'Ball nose',drill:'Twist drill',chamfer:'Chamfer mill'}[def.shape] : '';
    return shape?name+' '+shape:name;
  }
  function updateMaterialReadout(){
    const frame=stockFrame, t=frame?.t;
    const current=activeSlot!==null && frame?.cutter?.tool===activeSlot && (playing || Math.abs(t-time)<1e-5);
    const state=frame?.cutter?.state;
    const engagement=by('solid-engagement');
    engagement.dataset.state=current?state:'';
    engagement.textContent=activeSlot===null?'':toolName(activeSlot)+' · '+(current?engagementLabels[state]:'Updating stock');
    const volume=current?frame.removal?.totalMM3:null;
    const air=current?frame.removal?.airFeedSeconds:null;
    by('solid-removed-volume').textContent=Number.isFinite(volume)?volume.toLocaleString(undefined,{maximumFractionDigits:1})+' mm³':'—';
    by('solid-air-time').textContent=Number.isFinite(air)?clock(air):'—';
  }
  const showRemoved=by('show-removed'), showCutter=by('show-cutter');
  function updateLayers(){
    if(!hasSolid)return;
    solid.setCutterVisible(showCutter.checked);
    solid.setRemovedVisible(showRemoved.checked);
    cut.setRemovedVisible(showRemoved.checked);
  }
  showRemoved.checked=showCutter.checked=true;
  on('show-removed','change',updateLayers);
  on('show-cutter','change',updateLayers);
  updateLayers();
  function updateViewTime(){
    if(view==='solid')solid.setTime(time,activeSlot,playing);
    if(view==='path')path.setTime(time);
    else cut.setTime(time);
  }
  function hasSizedTool() { return Object.values(cutTools).some(tool=>tool.d>0); }
  function configureMissingTools() {
    const missing=Object.keys(cutTools).filter(key=>cutTools[key].d===0);
    setTab(true);
    if(!missing.length)return;
    const names=missing.map(key=>key==='0'?'the unnumbered tool':'T'+key).join(', ');
    by('setup-msg').textContent='Enter the cutter shape and diameter in mm for '+names+', then choose Apply stock & tools to see the material removed.';
    by('dia-'+missing[0]).focus();
  }
  function setView(name) {
    if(stopLookup)cancelToolLookup();
    if(name!=='path' && entry && !hasSizedTool()){
      configureMissingTools();
      return;
    }
    view=name==='solid'&&!hasSolid?'depth':name;
    by('solid-surface').hidden=view!=='solid';
    by('solid-inspect').hidden=view!=='solid';
    by('depth-surface').hidden=view!=='depth';
    by('path-surface').hidden=view!=='path';
    by('view-tag').hidden=view!=='path';
    by('path-angle').hidden=view!=='path';
    by('solid-fallback').hidden=hasSolid||view!=='depth';
    if(hasSolid)solid.setActive(view==='solid');
    updateViewTime();
    cut.setActive(view==='path'?false:view);
    document.querySelectorAll('[data-view]').forEach(button=>{
      const active=button.dataset.view===view;
      button.classList.toggle('on',active);
      button.setAttribute('aria-pressed',String(active));
    });
  }
  function activeRenderer(){return view==='solid'?solid:(view==='depth'?cut:path);}
  function setTab(setup) { by('job-panel').hidden=setup;by('setup-panel').hidden=!setup;by('job-tab').classList.toggle('on',!setup);by('setup-tab').classList.toggle('on',setup); }
  function inSegment(t) { let a=0,b=job.count;while(a<b){const m=(a+b)>>>1;if(job.endTime[m]<=t)a=m+1;else b=m;}return Math.min(job.count-1,a); }
  function nearestStage(items,t) {let lo=0,hi=items.length;while(lo<hi){const m=(lo+hi)>>>1;if(items[m].time<=t)lo=m+1;else hi=m;}return Math.max(0,lo-1);}
  function startSec(i){return i>0?job.endTime[i-1]:0;}
  function point(i,f){const p=6*i;return [0,1,2].map(k=>job.xyz[p+k]+(job.xyz[p+k+3]-job.xyz[p+k])*f);}
  function toolData(j){const t=j.tool;return j.tools.length?j.tools:(t.length?[t[0]]:[]);}
  function cancelToolLookup(){
    lookupId++;stopLookup?.();stopLookup=null;inspectedTime=null;
    by('tool-result').textContent='';by('show-tool-cut').disabled=by('inspect-tool').disabled;
  }
  function drawToolProfile(def){
    const canvas=by('tool-profile'),ctx=canvas.getContext?.('2d');
    if(!ctx)return;
    const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);
    const mesh=globalThis.buildCutterMesh?.(def);
    if(!mesh)return;
    // Draw the side silhouette of the same tip envelope used by the 3D renderer.
    const radii=new Map(),r=def.d/2;
    for(let i=0;i<mesh.positions.length;i+=3){
      const p=mesh.positions,z=p[i+2];radii.set(z,Math.max(radii.get(z)||0,Math.hypot(p[i],p[i+1])));
    }
    const rings=Array.from(radii).sort((a,b)=>a[0]-b[0]);
    const shoulder=rings.find(v=>v[1]>=r*(1-1e-5))?.[0]??0;
    const top=shoulder+1.3*r,profile=rings.filter(v=>v[0]<top);profile.push([top,r]);
    const scale=Math.min((w-22)/def.d,(h-12)/top),x=w/2,y=h-6;
    ctx.beginPath();ctx.moveTo(x-r*scale,y-top*scale);
    for(let i=profile.length-1;i>=0;i--)ctx.lineTo(x-profile[i][1]*scale,y-profile[i][0]*scale);
    for(const [z,radius] of profile)ctx.lineTo(x+radius*scale,y-z*scale);
    ctx.closePath();ctx.fillStyle='#598d92';ctx.fill();ctx.strokeStyle='#c7f3e7';ctx.lineWidth=1.5;ctx.stroke();
  }
  function showProfile(slot){
    const def=cutTools[slot];by('inspect-tool').value=String(slot);
    const details=def?.d>0?['Ø'+def.d+' mm']:['Cutter dimensions needed'];
    if(def?.shape==='chamfer' && def.d>0)details.push(def.angle+'° included','Ø'+def.tip+' mm tip');
    if(def?.shape==='drill' && def.d>0)details.push('118° included');
    by('tool-dimensions').textContent=details.join(' · ');
    by('show-tool-cut').textContent=def?.d>0?'Show cut':'Set dimensions';
    drawToolProfile(def);
  }
  function setToolInspector(){
    cancelToolLookup();
    const selector=by('inspect-tool'),slots=toolData(job);
    selector.replaceChildren(...slots.map(n=>option(toolName(n),n)));
    selector.disabled=by('show-tool-cut').disabled=!slots.length;by('tool-inspector').hidden=!slots.length;
    if(slots.length)showProfile(slots.includes(activeSlot)?activeSlot:slots[0]);
  }
  function inspectCut(){
    if(!job?.count)return;
    pause();cancelToolLookup();
    const slot=Number(by('inspect-tool').value),def=cutTools[slot];
    if(!(def?.d>0)){setTab(true);by('dia-'+slot).focus();return;}
    const id=lookupId;
    by('show-tool-cut').disabled=true;
    by('tool-result').textContent='Finding material removed by '+toolName(slot)+'…';
    stopLookup=cut.findToolCut(slot,result=>{
      if(id!==lookupId)return;
      stopLookup=null;by('show-tool-cut').disabled=false;
      if(!result){by('tool-result').textContent='No sampled material removal for '+toolName(slot)+' with this stock and cutter.';return;}
      showCutter.checked=true;updateLayers();
      seek(result.t);setView('solid');inspectedTime=result.t;
      if(hasSolid)solid.focusCutter({...def,x:result.x,y:result.y,z:result.z});
      by('tool-result').textContent='Cutting on line '+job.line[result.move].toLocaleString()+' at '+clock(result.t)+'.';
    });
  }
  function seek(value,chosenLine) {
    if(stopLookup || (inspectedTime!==null && value!==inspectedTime))cancelToolLookup();
    if(!job?.count){
      time=0;by('progress').value='0';by('progress').setAttribute('aria-valuetext','No motions');
      by('rail').style.setProperty('--done','0%');by('elapsed').textContent='00:00';
      for(const k of ['px','py','pz'])by(k).textContent='–';
      sourceList.setPosition(0,chosenLine);by('lineinfo').textContent='';by('motion-data').textContent='';by('view-state').textContent='No motions';
      return;
    }
    time=clamp(value,0,job.duration);const ratio=job.duration?time/job.duration:0,i=inSegment(time),a=startSec(i),b=job.endTime[i],p=point(i,b>a?clamp((time-a)/(b-a),0,1):1);
    by('progress').value=String(Math.round(ratio*1000000));by('rail').style.setProperty('--done',(100*ratio)+'%');by('progress').setAttribute('aria-valuetext',clock(time)+' of '+clock(job.duration));by('elapsed').textContent=clock(time);
    for(let k=0;k<3;k++)by(['px','py','pz'][k]).textContent=fmt(p[k]);
    const t=job.tool[i],mode=['Rapid','Feed','Dwell'][job.kind[i]]||'Move';
    if(activeSlot!==t || Number(by('inspect-tool').value)!==t){activeSlot=t;if(cutTools[t])showProfile(t);}
    updateMaterialReadout();
    by('view-state').textContent=(t?'T'+t:'Tool ?')+' · '+mode;by('tool-dot').style.background=job.kind[i]===0?'#b5c3d2':color(t);
    by('motion-data').textContent=(t?'T'+t:'Unknown tool')+'  ·  '+mode+(job.kind[i]===1?'  '+job.feed[i].toFixed(0)+' mm/min':'')+'  ·  '+(job.spindle[i]?'Spindle on':'Spindle off');
    by('lineinfo').textContent='Line '+job.line[i].toLocaleString()+' / '+sourceList.count.toLocaleString();
    sourceList.setPosition(job.line[i],chosenLine);
    const active=nearestStage(seq,time);if(stageId!==active){if(stageId>=0&&stageNodes[stageId])stageNodes[stageId].classList.remove('active');stageNodes[active]?.classList.add('active');stageId=active;}
    const n=nearestStage(job.stages,time);by('stage-select').value=String(n);
    const h=job.holes.length?nearestStage(job.holes,time):-1;
    by('hole-select').value=(h>=0&&job.holes[h].time<=time&&n===nearestStage(job.stages,job.holes[h].time))?String(h):'';
    updateViewTime();
  }
  function pause(){playing=false;lastTick=0;by('play-text').textContent='Play';by('play-icon').textContent='▶';by('play').setAttribute('aria-label','Play simulation');}
  function tick(ts){if(!playing)return;const dt=lastTick?Math.min(.25,(ts-lastTick)/1000):0;lastTick=ts;seek(time+dt*Number(by('speed').value));if(time>=job.duration)pause();else requestAnimationFrame(tick);}
  function play(){if(!job?.count||loadState)return;if(playing)return pause();if(time>=job.duration)seek(0);playing=true;by('play-text').textContent='Pause';by('play-icon').textContent='Ⅱ';by('play').setAttribute('aria-label','Pause simulation');requestAnimationFrame(tick);}
  function jump(t){pause();if(Number.isFinite(t))seek(t);}
  function step(forward){if(!job?.count)return;pause();const i=inSegment(time);if(forward)seek(job.endTime[i]);else{const s=startSec(i);seek(time-s>1e-7?s:startSec(Math.max(0,i-1)));}}
  function makeFields(){
    const sizes=['Length X','Width Y','Height Z'],positions=['Min X','Min Y','Min Z'];
    stockKeys.forEach((k,i)=>{const label=el('label','',(i<3?sizes[i]:positions[i-3])+' (mm)');const inp=el('input');inp.type='number';inp.id='stock-'+k;inp.step='any';if(i<3)inp.min='.001';label.append(inp);by(i<3?'stock-size':'stock-pos').append(label);});
    for(const [key,value] of Object.entries(flags)){const label=el('label');const inp=el('input');inp.type='checkbox';inp.checked=value;inp.id='flag-'+key;inp.addEventListener('change',()=>{flags[key]=inp.checked;path.setOptions(flags);});label.append(inp,document.createTextNode(flagNames[key]));by('flags').append(label);}
  }
  function toolsFor(text){
    const result = {};
    for(const n of toolData(job)) result[n] = {d:0,shape:'flat'};

    // Tool summaries can also appear next to a tool change far into a program.
    // Read comments and unit changes together so text inside comments is never
    // interpreted as a G20/G21 command. A leading CAM summary uses the first units.
    const tokens = /\(([^()\r\n]*)\)|;([^\r\n]*)|G0?(20|21)(?![\d.])/gi;
    const header = /^\s*(?:(TOOL)\s+)?T\s*(\d+)\s*(?:[-:,]\s*)?(?:D(?:IA(?:METER)?)?\s*[=:]?\s*|[Ø⌀]\s*)((?:\d+(?:\.\d*)?|\.\d+))(?:\s*(mm\b|in(?:ch(?:es)?)?\b|"))?(?=$|[\s,:-]|[x×]\s*\d)(.*)$/i;
    const declarations = [];
    let motionUnits, firstUnits;
    for(const token of text.matchAll(tokens)){
      if(token[3]){
        motionUnits = token[3]==='20' ? 25.4 : 1;
        firstUnits ??= motionUnits;
        continue;
      }
      const declaration = header.exec(token[1] ?? token[2]);
      if(!declaration) continue;
      const [,keyword,number,diameter,unit,description] = declaration;
      const n = Number(number);
      if(!Object.hasOwn(result,n)) continue;

      if(keyword && /^\s*chamfer\b/i.test(description)){
        const geometry=/^\s*chamfer\s+A(\d+(?:\.\d*)?|\.\d+)\s+TIP(\d+(?:\.\d*)?|\.\d+)\s*$/i.exec(description);
        const angle=Number(geometry?.[1]),tip=Number(geometry?.[2]),d=Number(diameter);
        const valid=(!unit || /^mm$/i.test(unit)) && d>0 && angle>0 && angle<180 && tip>=0 && tip<=d;
        declarations.push({n,diameter:d,scale:1,shape:'chamfer',angle,tip,invalid:!valid});
        continue;
      }

      // The solid engine models flat, spherical and conical ends. Names such as
      // "tapered ball" or "bull nose" need an explicit choice in Setup.
      if(/\b(?:taper(?:ed)?|bull[ -]?nose|chamfer|engraver|countersink|counterbore|spot[ -]?drill|cent(?:er|re)[ -]?drill|lollipop|dovetail)\b/i.test(description)) continue;
      const ball = /\bball(?:nose)?\b/i.test(description);
      const drill = /\bdrill\b/i.test(description);
      const flat = /\b(?:flat|square)\b/i.test(description);
      if(Number(ball)+Number(drill)+Number(flat)!==1) continue;
      if(flat && Number(description.match(/\bCR\s*=\s*(\d*\.?\d+)/i)?.[1])>0) continue;

      // The documented "(TOOL Tn Dn SHAPE)" form uses mm regardless of G20/G21.
      const usesMetadataUnits = keyword && /^\s*(?:flat|ball|drill)\s*$/i.test(description);
      const scale = unit ? (/^mm$/i.test(unit) ? 1 : 25.4) : (usesMetadataUnits ? 1 : motionUnits);
      declarations.push({n,diameter:Number(diameter),scale,shape:ball?'ball':drill?'drill':'flat'});
    }
    const ambiguous = new Set();
    for(const {n,diameter,scale,shape,angle,tip,invalid} of declarations){
      const d = diameter * (scale ?? firstUnits ?? 1);
      if(invalid){result[n]={d:0,shape};ambiguous.add(n);continue;}
      if(!Number.isFinite(d) || d<=0 || ambiguous.has(n)) continue;
      const prior=result[n];
      if(prior.d && (Math.abs(d-prior.d)>1e-5 || prior.shape!==shape || prior.angle!==angle || prior.tip!==tip)){
        ambiguous.add(n);
        result[n]={d:0,shape:'flat'};
      }else result[n]=shape==='chamfer'?{d,shape,angle,tip}:{d,shape};
    }
    return result;
  }
  function stockFor(s){
    const head=s.slice(0,16384);
    const range=head.match(/\bSTOCK\s+X(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)\s+Y(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)\s+Z(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)/i);
    if(range){const [x,x1,y,y1,z,z1]=range.slice(1).map(Number);if(x1>x&&y1>y&&z1>z)return {v:{x,y,z,l:x1-x,w:y1-y,h:z1-z},hint:'Work coordinates · stock limits from the NC header.'};}
    const mn=job.bounds.min,mx=job.bounds.max,top=0;
    const x=Math.floor(mn[0]),y=Math.floor(mn[1]),z=Math.min(-1,Math.floor(mn[2]));
    return {v:{x,y,z,l:Math.max(1,Math.ceil(mx[0])-x),w:Math.max(1,Math.ceil(mx[1])-y),h:top-z},hint:'Assumed from path bounds with the stock top at Z0. Enter measured stock limits and cutter diameters before interpreting contact or cut depth.'};
  }
  function setToolFields(){
    const f=by('tool-fields');f.replaceChildren();
    for(const [ns,info] of Object.entries(cutTools)){
      const n=Number(ns),r=el('div','tool-field'),t=el('span','fl');t.append(colors(n),el('b','',n?'T'+n:'T?'));const sel=el('select');sel.id='shape-'+ns;sel.setAttribute('aria-label','T'+n+' cutter shape');
      for(const [v,label] of Object.entries({flat:'Flat end',ball:'Ball nose',drill:'Twist drill',chamfer:'Chamfer mill'}))sel.append(option(label,v));sel.value=info.shape;
      const num=el('input');num.type='number';num.step='any';num.min='0';num.value=String(info.d);num.id='dia-'+ns;num.setAttribute('aria-label','T'+n+' diameter in millimetres');
      r.append(t,sel,num);f.append(r);
      const extra=el('div','chamfer-fields');extra.hidden=sel.value!=='chamfer';
      for(const [prop,name] of [['angle','Included angle (°)'],['tip','Flat tip Ø (mm)']]){
        const label=el('label','',name), field=el('input');field.type='number';field.step='any';field.min='0';
        field.id=prop+'-'+ns;field.setAttribute('aria-label','T'+ns+' '+name);field.value=String(info[prop]??'');
        label.append(field);extra.append(label);
      }
      sel.addEventListener('change',()=>{extra.hidden=sel.value!=='chamfer';});f.append(extra);
    }
  }
  function controls(){const conf=stockFor(source);stock=conf.v;cutTools=toolsFor(source);
    setToolInspector();
    for(const k of stockKeys)by('stock-'+k).value=String(stock[k]);by('stock-hint').textContent=conf.hint;
    setToolFields();
    by('setup-msg').textContent='Enter the cutting diameter for each tool. A diameter of zero omits its cut from the stock simulation. Drills use a 118° included angle.';
    by('configure-tools').hidden=Object.values(cutTools).every(tool=>tool.d>0);
    by('parser-notes').textContent=job.notes.join(' ');
    path.setStock(stock);path.setTools(cutTools);path.setOptions(flags);
    if(hasSolid)solid.setStock(stock);
    cut.setStock(stock);cut.setTools(cutTools);updateMarkers();
  }
  function applyConfig(){
    if(!job)return;
    const next={};for(const k of stockKeys){const input=by('stock-'+k),v=input.valueAsNumber;if(!Number.isFinite(v)||(stockKeys.indexOf(k)<3&&!(v>0))){by('setup-msg').textContent='Enter a finite coordinate and a positive number for each stock dimension.';input.focus();return;}next[k]=v;}
    const nt={};
    for(const key of Object.keys(cutTools)){
      const inp=by('dia-'+key),d=inp.valueAsNumber,shape=by('shape-'+key).value;
      if(!Number.isFinite(d)||d<0){by('setup-msg').textContent='Enter a diameter in millimetres or 0 for an unknown cutter.';inp.focus();return;}
      const def={d,shape};
      if(shape==='chamfer' && d>0){
        const a=by('angle-'+key),t=by('tip-'+key);def.angle=a.valueAsNumber;def.tip=t.valueAsNumber;
        if(!(def.angle>0 && def.angle<180)){by('setup-msg').textContent='Enter a chamfer included angle greater than 0° and below 180°.';a.focus();return;}
        if(!(def.tip>=0 && def.tip<=d)){by('setup-msg').textContent='Enter a flat tip diameter from 0 to the cutter diameter.';t.focus();return;}
      }
      nt[key]=def;
    }
    const previouslySized=hasSizedTool();
    stock=next;cutTools=nt;path.setStock(stock);path.setTools(nt);
    setToolInspector();
    if(hasSolid)solid.setStock(stock);
    cut.setStock(stock);cut.setTools(nt);updateMarkers();
    by('configure-tools').hidden=Object.values(nt).every(tool=>tool.d>0);
    by('setup-msg').textContent='Applied to this preview.';
    if(entry && hasSizedTool()){
      setView('solid');
      seek(!previouslySized && time===0 ? job.duration : time);
    }else{
      setView('path');
      seek(time);
      if(entry)configureMissingTools();
    }
  }
  function firstTouch(i){
    const k=6*i, a=job.xyz, radius=cutTools[job.tool[i]]?.d/2||0;
    if(!(radius>0))return null;
    const xmin=stock.x,xmax=xmin+stock.l,ymin=stock.y,ymax=ymin+stock.w,zmax=stock.z+stock.h;
    let t0=0,t1=1;
    // Clip cheaply against the cutter-expanded bounds, then refine the circular footprint.
    for(const [n,min,max] of [[0,xmin-radius,xmax+radius],[1,ymin-radius,ymax+radius],[2,-Infinity,zmax]]){
      const v=a[k+n],dv=a[k+n+3]-v;if(Math.abs(dv)<1e-14){if(v<min||v>max)return null;}else{let ta=(min-v)/dv,tb=(max-v)/dv;if(ta>tb)[ta,tb]=[tb,ta];t0=Math.max(t0,ta);t1=Math.min(t1,tb);if(t1<t0-1e-10)return null;}
    }
    const cutter=cutTools[job.tool[i]],shape=cutter.shape;
    const tipRadius=shape==='chamfer'?cutter.tip/2:0;
    const coneScale=shape==='chamfer'?Math.tan(cutter.angle*Math.PI/360):Math.tan(59*Math.PI/180);
    const clearance=t=>{const p=point(i,t),x=p[0],y=p[1],dz=Math.max(0,zmax-p[2]);let rho=radius;if(shape==='drill'||shape==='chamfer')rho=Math.min(radius,tipRadius+dz*coneScale);if(shape==='ball'&&dz<radius)rho=Math.sqrt(Math.max(0,dz*(2*radius-dz)));return Math.hypot(Math.max(xmin-x,0,x-xmax),Math.max(ymin-y,0,y-ymax))-rho;};
    if(clearance(t0)<=1e-7)return t0;
    let lo=t0,hi=t1;for(let j=0;j<24;j++){const m=(hi-lo)/3,l=lo+m,r=hi-m;if(clearance(l)<clearance(r))hi=r;else lo=l;}
    let tm=(lo+hi)*.5;if(clearance(t1)<clearance(tm))tm=t1;if(clearance(tm)>1e-6)return null;
    lo=t0;hi=tm;for(let j=0;j<24;j++){const mid=(lo+hi)/2;if(clearance(mid)>1e-7)lo=mid;else hi=mid;}return hi;
  }
  function updateMarkers(){
    contact=null;entry=null;
    for(let i=0;i<job.count;i++){if(job.kind[i]!==1||!job.spindle[i])continue;
      if(!entry)entry={p:point(i,1),t:job.endTime[i]};
      const f=firstTouch(i);if(f!==null){contact={p:point(i,f),t:startSec(i)+(job.endTime[i]-startSec(i))*f};break;}
    }
    path.setMarkers({entry:entry?.p,contact:contact?.p});
    by('to-entry').disabled=!entry;by('to-contact').disabled=!contact;
    by('to-entry').title=entry?'First spindle-on feed endpoint: '+entry.p.map(fmt).join(', ')+' mm':'No spindle-on feed in the preview';
    by('to-contact').title=contact?'Estimated first stock contact, tool tip: '+contact.p.map(fmt).join(', ')+' mm':'No modeled contact. Confirm tool diameters and stock limits in Setup.';
  }
  function buildStages(){
    seq=[];stageNodes=[];stageId=-1;
    for(const stage of job.stages){
      const previous=seq.at(-1);
      if(!previous || previous.name!==stage.name || previous.tool!==stage.tool) seq.push(stage);
    }
    const op=by('operations');op.replaceChildren();
    for(const s of seq){const btn=el('button','op');btn.append(colors(s.tool),el('span','',s.name),el('small','',s.tool?'T'+s.tool:'—'));btn.title=s.name+' · '+clock(s.time);btn.onclick=()=>jump(s.time);op.append(btn);stageNodes.push(btn);}
    by('op-count').textContent=seq.length+' total';
    const stage=by('stage-select'); stage.replaceChildren(...job.stages.map((s,i)=>option(s.name,i)));
    const hs=by('hole-select');hs.replaceChildren(option('Select a hole…',''));for(let i=0;i<job.holes.length;i++){const h=job.holes[i];hs.append(option(h.name+'   X '+Number(h.x).toFixed(2)+'   Y '+Number(h.y).toFixed(2),i));}by('hole-block').hidden=!job.holes.length;
    const rail=by('rail');rail.replaceChildren();for(const s of seq.slice(1)){const tick=el('i');tick.style.left=(100*s.time/job.duration)+'%';rail.append(tick);}
    const key=by('tool-key');key.replaceChildren();for(const n of toolData(job)){const item=el('span','keyitem');item.append(colors(n),document.createTextNode(n?'T'+n:'T?'));key.append(item);}
    const rapid=el('span','keyitem');const dot=el('i','dot');dot.style.background='#a7bacd';rapid.append(dot,document.createTextNode('Rapid'));key.append(rapid);
  }
  function openJob(text,name,parsed,isDemo){
    cancelToolLookup();activeSlot=null;stockFrame=null;
    job=parsed;source=text;sourceList.setJob(text,job);
    by('filename').textContent=isDemo?'Arc pocket plate · demo.nc':name;by('filename').title=name;document.title=name+' · Pathscope';by('duration').textContent=clock(job.duration);
    const warnings=by('warnings');warnings.hidden=!job.warnings.length;warnings.open=!!job.warnings.length;
    by('warning-title').textContent='Preview notices ('+job.warnings.length+')';by('warning-items').replaceChildren(...job.warnings.map(w=>el('li','',w)));
    by('job-note').textContent='Estimated time includes programmed feed, dwell and modeled rapids at 1,800 mm/min.';
    time=0;cut.setActive(false);
    if(hasSolid){solid.setActive(false);solid.setJob(job);}
    path.setJob(job);cut.setJob(job);controls();path.setView('iso');
    const canCut=Boolean(entry)&&hasSizedTool();
    setView(canCut?'solid':'path');
    buildStages();setTab(false);seek(canCut?job.duration:0);
    path.fit('path');if(hasSolid)solid.fit('path');
    busy('');
    if(!job.count)notice('No moves to display',job.warnings[0]||'The file contained no supported moves with a known starting position.');
  }
  const parserSource=document.querySelector('#demo + script').textContent;
  const workerSource=parserSource+'\nself.onmessage=e=>{try{const j=parseNC(e.data);const b=[...new Set(Object.values(j).filter(v=>ArrayBuffer.isView(v)).map(v=>v.buffer))];self.postMessage({j},b);}catch(err){self.postMessage({error:String(err.message||err)});}}';
  let cancelParse=null;
  async function parseJob(text,id){
    if(typeof Worker==='undefined') return parseNC(text);
    const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
    let active;
    try{
      try { active=new Worker(url); } catch { return parseNC(text); }
      return await new Promise((resolve,reject)=>{
        cancelParse=()=>reject(new Error('A newer file was selected.'));
        active.onmessage=({data})=>data.error?reject(new Error(data.error)):resolve(data.j);
        active.onerror=event=>reject(new Error(event.message || 'Parser worker failed.'));
        active.postMessage(text);
      });
    }finally{
      active?.terminate();
      URL.revokeObjectURL(url);
      if(id===ticket)cancelParse=null;
    }
  }
  async function load(loader,name,isDemo=false){
    const id=++ticket;
    cancelToolLookup();
    if(cancelParse){cancelParse();cancelParse=null;}
    pause();loadState=true;busy('Reading '+name+'…');
    try{
      const raw=await loader();
      if(id!==ticket)return;
      const text=raw.includes('\r')?raw.replace(/\r\n?/g,'\n'):raw;
      busy('Building toolpaths…');
      const parsed=await parseJob(text,id);
      if(id===ticket)openJob(text,name,parsed,isDemo);
    }
    catch(error){if(id===ticket){busy('');notice('Could not preview the file',String(error.message||error));}}
    finally{if(id===ticket)loadState=false;}
  }
  function sample(){
    load(()=>{
      const bytes=Uint8Array.from(atob(by('demo').textContent.trim()),c=>c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    },'demo.nc',true);
  }
  function loadFile(f){if(f)load(()=>f.text(),f.name);}
  on('inspect-tool','change',()=>{pause();cancelToolLookup();showProfile(Number(by('inspect-tool').value));});
  on('show-tool-cut','click',inspectCut);
  makeFields(); on('close-msg','click',()=>by('msg').close());on('open-btn','click',()=>by('file').click());on('file','change',e=>{loadFile(e.target.files[0]);e.target.value='';});on('demo-btn','click',sample);on('job-tab','click',()=>setTab(false));on('setup-tab','click',()=>setTab(true));on('configure-tools','click',configureMissingTools);
  on('play','click',play);on('prev-step','click',()=>step(false));on('next-step','click',()=>step(true));on('progress','input',()=>{if(job)jump(job.duration*Number(by('progress').value)/1000000);});on('apply','click',applyConfig);
  function jumpInView(target,seconds){jump(seconds);if(view!==target)setView(target);}
  on('to-contact','click',()=>{if(contact)jumpInView('path',contact.t);});
  on('to-entry','click',()=>{if(entry)jumpInView('path',entry.t);});
  on('to-finished','click',()=>{if(job?.count)jumpInView('solid',job.duration);});
  on('to-stage-end','click',()=>{
    if(!job?.count)return;
    const next=job.stages[Number(by('stage-select').value)+1];
    const t=next?Math.max(0,next.time-0.000001):job.duration;
    jumpInView('solid',t);
  });
  on('stage-select','change',()=>jump(job.stages[Number(by('stage-select').value)].time));on('hole-select','change',()=>{const v=by('hole-select').value;if(v!=='')jump(job.holes[Number(v)].time);});
  for(const btn of document.querySelectorAll('[data-view]'))btn.onclick=()=>setView(btn.dataset.view);
  on('path-angle','change',()=>path.setView(by('path-angle').value));
  on('fit','change',()=>{const f=by('fit').value;if(f)activeRenderer().fit(f);by('fit').value='';});on('zoom-in','click',()=>activeRenderer().zoom(1.25));on('zoom-out','click',()=>activeRenderer().zoom(.8));
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  document.addEventListener('keydown',e=>{if(e.target.closest('input,select,textarea,button,dialog')||e.ctrlKey||e.metaKey||e.altKey)return;if(e.code==='Space'){e.preventDefault();play();}if(e.key==='ArrowRight'){e.preventDefault();step(true);}if(e.key==='ArrowLeft'){e.preventDefault();step(false);}});
  window.addEventListener('dragenter',e=>{if(!e.dataTransfer.types.includes('Files'))return;e.preventDefault();dragCount++;by('viewport').classList.add('dragover');});
  window.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
  window.addEventListener('dragleave',()=>{dragCount=Math.max(0,dragCount-1);if(!dragCount)by('viewport').classList.remove('dragover');});
  window.addEventListener('drop',e=>{e.preventDefault();dragCount=0;by('viewport').classList.remove('dragover');loadFile(e.dataTransfer.files[0]);});
  sample();
})();
