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
  let job=null, source='', starts=null, ticket=0, playing=false, lastTick=0, time=0, view='solid', seq=[], stageNodes=[], lastLine=0, contact=null, entry=null, stageId=-1, stock={}, cutTools={}, dragCount=0, loadState=false;
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
    onFrame:frame=>{if(hasSolid)solid.setFrame(frame);},
    onStatus:message=>{if(hasSolid)solid.setStatus(message);}
  });
  function updateViewTime(){
    if(view==='solid')solid.setTime(time);
    if(view==='path')path.setTime(time);
    else cut.setTime(time);
  }
  function setView(name) {
    view=name==='solid'&&!hasSolid?'depth':name;
    by('solid-surface').hidden=view!=='solid';
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
  function lineNumber(n){if(!starts||n<1||n>starts.length) return '';const e=n<starts.length?starts[n]-1:source.length;return source.slice(starts[n-1],Math.min(e,starts[n-1]+230)).trimEnd();}
  function indexLines(s){const positions=new Int32Array((job.lineCount||1)+1);let count=1;for(let i=s.indexOf('\n');i>=0;i=s.indexOf('\n',i+1))positions[count++]=i+1;return positions.subarray(0,count);}
  function drawSource(n){if(n===lastLine)return;lastLine=n;const pane=by('linecode');pane.replaceChildren();for(let i=Math.max(1,n-1);i<=Math.min(n+1,starts.length);i++){const row=el('div',i===n?'now':'',String(i).padStart(5,' ')+'  '+lineNumber(i));pane.append(row);} }
  function seek(value) {
    if(!job?.count){
      time=0;by('progress').value='0';by('progress').setAttribute('aria-valuetext','No motions');
      by('rail').style.setProperty('--done','0%');by('elapsed').textContent='00:00';
      for(const k of ['px','py','pz'])by(k).textContent='–';
      by('linecode').replaceChildren();by('lineinfo').textContent='';by('motion-data').textContent='';by('view-state').textContent='No motions';
      return;
    }
    time=clamp(value,0,job.duration);const ratio=job.duration?time/job.duration:0,i=inSegment(time),a=startSec(i),b=job.endTime[i],p=point(i,b>a?clamp((time-a)/(b-a),0,1):1);
    by('progress').value=String(Math.round(ratio*1000000));by('rail').style.setProperty('--done',(100*ratio)+'%');by('progress').setAttribute('aria-valuetext',clock(time)+' of '+clock(job.duration));by('elapsed').textContent=clock(time);
    for(let k=0;k<3;k++)by(['px','py','pz'][k]).textContent=fmt(p[k]);
    const t=job.tool[i],mode=['Rapid','Feed','Dwell'][job.kind[i]]||'Move';
    by('view-state').textContent=(t?'T'+t:'Tool ?')+' · '+mode;by('tool-dot').style.background=job.kind[i]===0?'#b5c3d2':color(t);
    by('motion-data').textContent=(t?'T'+t:'Unknown tool')+'  ·  '+mode+(job.kind[i]===1?'  '+job.feed[i].toFixed(0)+' mm/min':'')+'  ·  '+(job.spindle[i]?'Spindle on':'Spindle off');
    by('lineinfo').textContent='Line '+job.line[i].toLocaleString()+' / '+job.lineCount.toLocaleString();
    drawSource(job.line[i]);
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
  // Metadata is optional and always uses millimetres, regardless of motion units.
  function toolsFor(text){
    const result = {};
    for(const n of toolData(job)) result[n] = {d:0,shape:'flat'};
    const headers = text.slice(0,16384).matchAll(/(?:\(|^\s*;)\s*TOOL\s+T(\d+)\s+D(\d*\.?\d+)\s+(FLAT|BALL|DRILL)\s*(?=\)|$)/gim);
    for(const [,number,diameter,shape] of headers){
      const n=Number(number), d=Number(diameter);
      if(Object.hasOwn(result,n) && Number.isFinite(d) && d>0) result[n]={d,shape:shape.toLowerCase()};
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
      for(const v of ['flat','ball','drill'])sel.append(option({flat:'Flat end',ball:'Ball nose',drill:'Twist drill'}[v],v));sel.value=info.shape;
      const num=el('input');num.type='number';num.step='any';num.min='0';num.value=String(info.d);num.id='dia-'+ns;num.setAttribute('aria-label','T'+n+' diameter in millimetres');
      r.append(t,sel,num);f.append(r);
    }
  }
  function controls(){const conf=stockFor(source);stock=conf.v;cutTools=toolsFor(source);
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
    const nt={};for(const key of Object.keys(cutTools)){const inp=by('dia-'+key),d=inp.valueAsNumber;if(!Number.isFinite(d)||d<0){by('setup-msg').textContent='Enter a diameter in millimetres or 0 for an unknown cutter.';inp.focus();return;}nt[key]={d,shape:by('shape-'+key).value};}
    stock=next;cutTools=nt;path.setStock(stock);path.setTools(nt);
    if(hasSolid)solid.setStock(stock);
    cut.setStock(stock);cut.setTools(nt);updateMarkers();
    by('configure-tools').hidden=Object.values(nt).every(tool=>tool.d>0);
    by('setup-msg').textContent='Applied to this preview.';
    if(entry && Object.values(nt).some(tool=>tool.d>0)) setView('solid');
    seek(time);
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
    const shape=cutTools[job.tool[i]].shape;
    const clearance=t=>{const p=point(i,t),x=p[0],y=p[1],dz=Math.max(0,zmax-p[2]);let rho=radius;if(shape==='drill')rho=Math.min(radius,dz*Math.tan(59*Math.PI/180));if(shape==='ball'&&dz<radius)rho=Math.sqrt(Math.max(0,dz*(2*radius-dz)));return Math.hypot(Math.max(xmin-x,0,x-xmax),Math.max(ymin-y,0,y-ymax))-rho;};
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
    job=parsed;source=text;starts=indexLines(text);
    by('filename').textContent=isDemo?'Arc pocket plate · demo.nc':name;by('filename').title=name;document.title=name+' · Pathscope';by('duration').textContent=clock(job.duration);
    const warnings=by('warnings');warnings.hidden=!job.warnings.length;warnings.open=!!job.warnings.length;
    by('warning-title').textContent='Preview notices ('+job.warnings.length+')';by('warning-items').replaceChildren(...job.warnings.map(w=>el('li','',w)));
    by('job-note').textContent='Estimated time includes programmed feed, dwell and modeled rapids at 1,800 mm/min.';
    lastLine=0;time=0;cut.setActive(false);
    if(hasSolid){solid.setActive(false);solid.setJob(job);}
    path.setJob(job);cut.setJob(job);controls();path.setView('iso');
    const canCut=Boolean(entry)&&Object.values(cutTools).some(tool=>tool.d>0);
    setView(canCut?'solid':'path');
    buildStages();setTab(false);seek(isDemo?job.duration:0);
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
  makeFields(); on('close-msg','click',()=>by('msg').close());on('open-btn','click',()=>by('file').click());on('file','change',e=>{loadFile(e.target.files[0]);e.target.value='';});on('demo-btn','click',sample);on('job-tab','click',()=>setTab(false));on('setup-tab','click',()=>setTab(true));on('configure-tools','click',()=>setTab(true));
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
