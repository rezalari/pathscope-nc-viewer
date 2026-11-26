const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert');
// Run against the built, self-contained HTML file; no browser packages are needed.
let loaded=[];const pathClicks=[],cutClicks=[],solidClicks=[],elements=new Map();
class Node {
 constructor(tag='div',id='',text=''){this.tag=tag;this._id=id;this.textContent=text;this.hidden=false;this.options=[];this.children=[];this.value='';this.events={};this.style={setProperty:(k,v)=>this.style[k]=v};this.attrs={};this.dataset={};
 this.classList={set:new Set,add:k=>this.classList.set.add(k),remove:k=>this.classList.set.delete(k),toggle:(k,v)=>v?this.classList.set.add(k):this.classList.set.delete(k)};if(id)elements.set(id,this);}
 set id(v){this._id=v;elements.set(v,this)} get id(){return this._id}
 append(...c){this.children.push(...c);this.firstElementChild=this.children[0];}
 replaceChildren(...c){this.children=c;this.firstElementChild=this.children[0];}
 setAttribute(k,v){this.attrs[k]=v} addEventListener(k,fn){this.events[k]=fn} click(){this.events.click?.({target:this});this.onclick?.({target:this});}
 focus(){} showModal(){this.open=true} close(){this.open=false} get valueAsNumber(){return parseFloat(this.value)} closest(){return false}
}
const html=fs.readFileSync(process.argv[2]||'index.html','utf8');
const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
const [demo,parser]=scripts;
const tbody=html.slice(0,html.indexOf('<script type="application/octet-stream"'));
for(const m of tbody.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g))new Node(m[1],m[2]);
const dm=new Node('script','demo',demo),pScript=new Node('script','',parser);elements.get('busy').append(new Node);
function by(id){assert(elements.has(id),id);return elements.get(id)}
const views=['solid','path','depth'].map(v=>{const b=new Node('button');b.dataset.view=v;return b;});
const doc={getElementById:by,querySelectorAll:()=>views,querySelector:()=>pScript,createElement:t=>new Node(t),createTextNode:s=>new Node('text','',s),addEventListener:()=>{}};
let materialCallbacks;
function stubAPI(list){return class {constructor(element,callbacks){if(list===cutClicks)materialCallbacks=callbacks;return new Proxy({}, {get:(o,name)=>name==='available'?!process.argv.includes('--no-solid'):(...args)=>{list.push([name,...args]);if(name==='setJob'&&list===pathClicks)loaded.push(args[0]);if(name==='findToolCut')return ()=>list.push(['cancelFind']);}});}}}
const fixture={document:doc,window:null,URL,Blob,Response,Worker:undefined,TextDecoder,setTimeout,clearTimeout,console,atob,structuredClone,performance,requestAnimationFrame:f=>setTimeout(()=>f(performance.now()),8),Option:class extends Node{constructor(name,value){super('option','',name);this.value=value}},NCRenderer:stubAPI(pathClicks),NCCutMap:stubAPI(cutClicks),addEventListener:()=>{}};
fixture.NCSolidRenderer=stubAPI(solidClicks);
fixture.window=fixture;const cx=vm.createContext(fixture); vm.runInContext(parser,cx);
vm.runInContext(scripts.at(-2),cx);
const app=html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>'));
vm.runInContext(app,cx);
const ev=(id,t)=>by(id).events[t]?.({target:by(id)});
const wait=async pred=>{for(let i=0;i<150;i++){await new Promise(r=>setTimeout(r,35));if(pred())return}throw Error('timeout '+by('msgtext').textContent);};
(async()=>{
 await wait(()=>by('filename').textContent.includes('demo.nc'));
 assert(by('busy').hidden);
 assert.deepEqual(loaded[0].tools,[1,2,3,6]);
 assert.equal(by('operations').children.length,5);
 assert.equal(by('hole-select').children.length,5);
 assert.equal(by('stock-l').value,'72');
 assert.equal(by('dia-1').value,'6');
 assert.equal(by('shape-3').value,'drill');
 assert(by('configure-tools').hidden);
 assert.equal(by('progress').value,'1000000');
 const solidAvailable=!process.argv.includes('--no-solid');
 assert.equal(by('solid-inspect').hidden,!solidAvailable);
 if(solidAvailable){
   assert(by('show-removed').checked && by('show-cutter').checked);
   by('show-removed').checked=false;ev('show-removed','change');
   for(const calls of [solidClicks,cutClicks])assert.deepEqual(calls.filter(c=>c[0]==='setRemovedVisible').at(-1),['setRemovedVisible',false]);
   by('show-cutter').checked=false;ev('show-cutter','change');
   assert.deepEqual(solidClicks.filter(c=>c[0]==='setCutterVisible').at(-1),['setCutterVisible',false]);
   materialCallbacks.onFrame({t:loaded[0].duration,cutter:{tool:6,state:'complete'},removal:{totalMM3:55,airFeedSeconds:90}});
   assert.equal(by('solid-engagement').textContent,'T6 Chamfer mill · Finished');
   assert.equal(by('solid-removed-volume').textContent,'55 mm³');
   assert.equal(by('solid-air-time').textContent,'01:30');
   materialCallbacks.onFrame({t:0,cutter:{tool:1,state:'cutting'},removal:{totalMM3:11,airFeedSeconds:6}});
   assert.equal(by('solid-engagement').textContent,'T6 Chamfer mill · Updating stock');
   materialCallbacks.onFrame(null);
   assert.equal(by('solid-removed-volume').textContent,'—');
 }
 assert.equal(by(solidAvailable?'solid-surface':'depth-surface').hidden,false);
 const demoJob=loaded[0],cutMove=demoJob.tool.findIndex((slot,i)=>slot===6 && demoJob.kind[i]===1);
 const cuttingTime=(demoJob.endTime[cutMove-1]+demoJob.endTime[cutMove])/2;
 assert.equal(by('inspect-tool').value,'6');assert.match(by('tool-dimensions').textContent,/90° included/);
 by('show-tool-cut').click();const stale=cutClicks.filter(c=>c[0]==='findToolCut').at(-1);
 by('inspect-tool').value='2';ev('inspect-tool','change');assert(cutClicks.some(c=>c[0]==='cancelFind'));
 stale[2]({tool:6,t:cuttingTime,move:cutMove,x:8,y:8,z:-2});assert.equal(by('progress').value,'1000000','canceled lookup must not seek');
 by('inspect-tool').value='6';ev('inspect-tool','change');by('show-tool-cut').click();
 const lookup=cutClicks.filter(c=>c[0]==='findToolCut').at(-1);assert.equal(lookup[1],6);lookup[2]({tool:6,t:cuttingTime,move:cutMove,x:8,y:8,z:-2});
 assert.match(by('tool-result').textContent,/Cutting on line/);assert(by('show-cutter').checked);
 assert.equal(by('play-text').textContent,'Play');assert.equal(by(solidAvailable?'solid-surface':'depth-surface').hidden,false);
 if(solidAvailable){const focus=solidClicks.filter(c=>c[0]==='focusCutter').at(-1)[1];assert.equal(focus.shape,'chamfer');assert.equal(focus.x,8);}
 by('show-tool-cut').click();cutClicks.filter(c=>c[0]==='findToolCut').at(-1)[2](null);
 assert.match(by('tool-result').textContent,/No sampled material removal/);
 by('progress').value='420000';
 ev('progress','input');
 const position=(solidAvailable?solidClicks:cutClicks).filter(v=>v[0]==='setTime').at(-1)[1];
 assert(Math.abs(position-.42*loaded[0].duration)<.0001);
 by('stage-select').value='1';ev('stage-select','change');by('to-stage-end').click();
 assert(Number(by('progress').value)>0 && Number(by('progress').value)<1e6);
 by('to-finished').click();
 assert.equal(by('progress').value,'1000000');
 const send=async(name,source)=>{
   by('file').files=[{name,text:async()=>source}];
   ev('file','change');await wait(()=>by('filename').textContent===name);
 };
 const code='G21 G90\rM3 S9000\rG0 X0 Y0 Z2\rG1 Z-1 F50\rG1 X8\rM30\r';
 await send('example.ngc',code);
 assert.equal(by('progress').value,'0');
 assert.equal(by('configure-tools').hidden,false);
 assert.equal(by('path-surface').hidden,false);
 assert.equal(by('dia-0').value,'0');
 for(const control of [views[0],views[2],by('to-finished')]){
   by('job-tab').click();assert(by('setup-panel').hidden);
   control.click();assert.equal(by('setup-panel').hidden,false,'A material view needs a cutter diameter');
 }
 by('progress').value='0';ev('progress','input');
 by('configure-tools').click();assert.equal(by('setup-panel').hidden,false);
 by('dia-0').value='2';by('apply').click();
 assert.equal(by('progress').value,'1000000','First diameter at the start must reveal the machined result');
 assert.equal(by('configure-tools').hidden,true);
 assert.equal(by(solidAvailable?'solid-surface':'depth-surface').hidden,false);
 assert.equal(by('to-contact').disabled,false);
 const named='(STOCK X-2..20 Y-3..10 Z-4..0 mm)\n(TOOL T7 D1.25 BALL)\nT7 M6\n'+code;
 await send('custom.toolpath',named);
 assert.equal(by('stock-x').value,'-2');assert.equal(by('stock-w').value,'13');
 assert.equal(by('shape-7').value,'ball');assert.equal(by('dia-7').value,'1.25');
 assert.equal(by('configure-tools').hidden,true);
 assert.equal(by('progress').value,'1000000','Recognized cutting files should show the finished shape on open');
 by('play').click();assert.equal(by('progress').value,'0','Playback should restart from the beginning');
 by('play').click();

 // CAM declarations can precede the units block, or appear many lines later at tool changes.
 const padding='(Contour pass)\n'.repeat(1300);
 const profile=[
   '(T3 D=0.25 CR=0. - flat end mill)','N10G20G90','T3 M6','M3 S9000',
   'G0 X0 Y0 Z0.1','G1 Z-0.02 F10','X1',padding,
   '; T9 D2.4 mm x 10 ball nose','T9 M6','G1 Y1',
   'G21','(T6 D=1.8 twist drill)','T6 M6','G1 X3','M30'
 ].join('\n');
 await send('CAM-summary.nc',profile);
 for(const [t,diameter,shape] of [[3,'6.35','flat'],[9,'2.4','ball'],[6,'1.8','drill']]){
   assert.equal(by('dia-'+t).value,diameter);
   assert.equal(by('shape-'+t).value,shape);
 }
 assert(by('configure-tools').hidden);
 assert.equal(by('progress').value,'1000000');
 const ambiguous=[
   '(T3 D=2.0 flat end mill)','(T3 D=3.0 flat end mill)',
   '(T8 D=2.0 tapered ball nose)','G21 G90','T3 M6','M3 S9000',
   'G0 X0 Y0 Z2','G1 Z-1 F50','T8 M6','G1 X5','M30'
 ].join('\n');
 await send('ambiguous-tools.nc',ambiguous);
 assert.equal(by('dia-3').value,'0','Conflicting diameters require manual setup');
 assert.equal(by('dia-8').value,'0','Unsupported geometry requires manual setup');
 assert.equal(by('configure-tools').hidden,false);

 const chamfer=['(STOCK X0..6 Y0..6 Z-2..0 mm)','G20','(TOOL T8 D2 CHAMFER A90 TIP0.4)',
   'G21 G90','T8 M6','M3 S9000','G0 X-0.5 Y2 Z1','(approach)','G1 Z-1 F60','G1 Y3','M30','(footer)'];
 await send('chamfer.nc',chamfer.slice(0,5).join('\r\n')+'\r'+chamfer.slice(5).join('\n'));
 assert.equal(by('source-line').max,'12');assert.equal(by('shape-8').value,'chamfer');
 assert.equal(by('dia-8').value,'2');assert.equal(by('angle-8').value,'90');assert.equal(by('tip-8').value,'0.4');
 assert.match(by('to-contact').title,/-0\.300 mm/,'contact uses flat tip and included angle');
 by('play').click();by('source-line').value='8';by('source-go').click();
 assert.equal(by('play-text').textContent,'Play','line selection pauses playback');
 assert.equal(by('progress').value,'0');assert.match(by('source-note').textContent,/line 9/);
 by('source-line').value='10';by('source-go').click();
 assert.match(by('lineinfo').textContent,/Line 10 \/ 12/);assert.equal(by('source-note').textContent,'');
 assert.ok(Number(by('progress').value)>0 && Number(by('progress').value)<1e6);
 by('source-line').value='12';by('source-go').click();assert.equal(by('progress').value,'1000000');
 assert.match(by('source-note').textContent,/End of program/);
 by('tip-8').value='0.6';by('apply').click();
 assert.match(by('to-contact').title,/-0\.200 mm/);
 assert.deepEqual(cutClicks.filter(c=>c[0]==='setTools').at(-1)[1][8],{d:2,shape:'chamfer',angle:90,tip:.6});
 by('tip-8').value='2.1';by('apply').click();assert.match(by('setup-msg').textContent,/flat tip diameter/);
 await send('incomplete.nc',chamfer.join('\n').replace('CHAMFER A90 TIP0.4','CHAMFER A90'));
 assert.equal(by('dia-8').value,'0');assert.equal(by('shape-8').value,'chamfer');
 await send('unsupported.nc','G65 P1234\nM30');
 assert(by('msg').open);assert(!by('warnings').hidden);assert.equal(by('progress').value,'0');
 console.log('Viewer smoke tests passed for sample, timeline, fallback, unsupported file and user-defined cutters.');
})().catch(e=>{console.error(e);process.exitCode=1;});
