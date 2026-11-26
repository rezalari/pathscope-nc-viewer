const test = require('node:test');
const assert = require('node:assert/strict');
const {indexSource,timeForLine,NCSourceList} = require('../source-list.js');

test('source rows preserve blanks, complete text, terminal comments and physical line numbers', () => {
  assert.equal(indexSource('').count,0);
  const long = '(note ' + 'x'.repeat(500) + ')';
  const s = indexSource(['', 'N120 G1 X1', '', 'M30', long, '', ''].join('\n'));
  assert.equal(s.count,6);
  assert.deepEqual(s.lines(1,6),['','N120 G1 X1','','M30',long,'']);
  assert.deepEqual(indexSource('one').lines(1,1),['one']);
  assert.deepEqual(indexSource('one\n').lines(1,1),['one']);
});

test('a line seeks to the first matching segment, the next motion, or the end', () => {
  const job = {count:4,line:[3,7,7,12],endTime:[2,4,7,14],duration:14};
  for (const [n,t] of [[1,0],[3,0],[6,2],[7,2],[8,7],[12,7],[13,14]]) assert.equal(timeForLine(job,n),t);
  assert.equal(timeForLine({count:0,duration:0},99),0);
});

class Element {
  constructor() {
    this.children=[]; this.dataset={}; this.events={}; this.attrs={}; this.scrollTop=0; this.clientHeight=264;
    this.style={setProperty:(k,v)=>this.style[k]=v}; this.classList={toggle:()=>{}};
  }
  append(...children){this.children.push(...children);}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(name,listener){this.events[name]=listener;}
  focus(){}
  get valueAsNumber(){return this.value===''?NaN:Number(this.value);}
}

test('million-line navigation keeps a bounded row pool and exposes both ends of the scroll track', t => {
  globalThis.document={createElement:()=>new Element()}; globalThis.requestAnimationFrame=fn=>fn();
  t.after(()=>{delete globalThis.document;delete globalThis.requestAnimationFrame;});
  const count=1600003, viewport=new Element(),input=new Element(),go=new Element(),note=new Element();
  const job={count:2,line:[3,count-1],endTime:[2,4],duration:4}, calls=[];
  const list=NCSourceList({viewport,input,go,note,onSeek:(time,n)=>{calls.push([time,n]);list.setPosition(time<2?3:count-1,n);}});
  list.setJob('(line)\n'.repeat(count-2)+'G1 X10\n(end)',job);
  const track=viewport.children[0],rows=track.children[0];
  const visible=()=>rows.children.filter(r=>!r.hidden);
  assert.equal(list.count,count);
  assert.equal(input.max,String(count));
  assert.ok(parseInt(track.style.height)<17000000);
  assert.ok(visible().length>=12 && visible().length<=20);
  list.setPosition(3);
  viewport.scrollTop=(parseInt(track.style.height)-viewport.clientHeight)/2;viewport.events.scroll();
  const middle=visible()[5];
  assert.ok(Math.abs(Number(middle.dataset.line)-count/2)<20);
  middle.events.click();
  assert.equal(calls.at(-1)[0],2);
  assert.match(note.textContent,/Next motion/);
  assert.ok(visible().some(r=>r.dataset.line===input.value && r.attrs['aria-selected']==='true'));
  viewport.scrollTop=parseInt(track.style.height)-viewport.clientHeight;viewport.events.scroll();
  assert.equal(visible().at(-1).children[1].textContent,'(end)');
  input.value=String(count);go.events.click();assert.deepEqual(calls.at(-1),[4,count]);
  const key={key:'Home',preventDefault(){},stopPropagation(){}};viewport.events.keydown(key);
  assert.deepEqual(calls.at(-1),[0,1]);assert.equal(viewport.scrollTop,0);
  input.value=String(count+1);input.events.keydown({...key,key:'Enter'});assert.match(note.textContent,/Enter a line/);
  list.setPosition(count-1);
  assert.ok(visible().some(r=>r.attrs['aria-current']==='step' && r.dataset.line===String(count-1)));
  assert.ok(rows.children.length<=20);
  list.setJob('G0 Z5\n',job);assert.equal(visible().length,1);assert.equal(visible()[0].children[1].textContent,'G0 Z5');
});
