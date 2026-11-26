/* Virtual G-code source listing. Input text has the same normalized LF line endings as the parser. */
(function () {
  'use strict';
  const rowHeight = 22, maxHeight = 8000000, stride = 128;

  function indexSource(text) {
    const anchors = [0];
    let count = text.length ? 1 : 0;
    for (let p = text.indexOf('\n'); p >= 0 && p + 1 < text.length; p = text.indexOf('\n',p + 1)) {
      if (count % stride === 0) anchors.push(p + 1);
      count++;
    }
    function lines(first, last) {
      const block = Math.floor((first - 1) / stride), result = [];
      let offset = anchors[block];
      for (let n = block * stride + 1; n <= last && n <= count; n++) {
        const next = text.indexOf('\n', offset);
        if (n >= first) result.push(text.slice(offset, next < 0 ? text.length : next));
        offset = next + 1;
      }
      return result;
    }
    return {count, lines};
  }

  function timeForLine(job, line) {
    let lo = 0, hi = job.count;
    while (lo < hi) {
      const mid = lo + Math.floor((hi-lo)/2);
      if (job.line[mid] < line) lo = mid + 1; else hi = mid;
    }
    return lo === job.count ? job.duration : lo ? job.endTime[lo-1] : 0;
  }

  function NCSourceList({viewport, input, go, note, onSeek}) {
    const track = document.createElement('div'), rows = document.createElement('div');
    track.className = 'source-track'; rows.className = 'source-rows';
    track.append(rows); viewport.append(track);
    const pool = [];
    let source = indexSource(''), job = null, active = 0, selected = 0;
    let firstRow = 0, lastRow = 0, pending = false, wheelRemainder = 0;

    function layout() {
      const height = viewport.clientHeight || 264, logicalMax = Math.max(0, source.count*rowHeight - height);
      const nativeMax = Math.max(0, Math.min(maxHeight, source.count*rowHeight) - height);
      const scale = nativeMax ? logicalMax/nativeMax : 1;
      const nativeTop = Math.max(0, Math.min(nativeMax, viewport.scrollTop || 0));
      return {height, nativeMax, scale, nativeTop, top:nativeTop*scale};
    }
    function makeRow() {
      const node = document.createElement('div'), number = document.createElement('span'), code = document.createElement('span');
      node.className = 'source-row'; node.id = 'source-row-' + pool.length;
      node.setAttribute('role','option'); number.className = 'source-number';
      node.append(number, code); rows.append(node);
      node.addEventListener('click', () => {viewport.focus({preventScroll:true}); select(Number(node.dataset.line));});
      const row = {node, number, code}; pool.push(row); return row;
    }
    function paint() {
      pending = false;
      const {height, nativeTop, top} = layout();
      const first = Math.max(1, Math.floor(top/rowHeight) + 1 - 3);
      const last = Math.min(source.count, Math.ceil((top+height)/rowHeight) + 3);
      const changed = first !== firstRow || last !== lastRow;
      const text = changed && last >= first ? source.lines(first, last) : [];
      rows.style.top = (nativeTop + (first-1)*rowHeight - top) + 'px';
      let descendant = '';
      for (let n = first; n <= last; n++) {
        const slot = n - first, {node,number,code} = pool[slot] || makeRow();
        if (changed) {
          node.hidden = false; node.dataset.line = String(n);
          node.setAttribute('aria-posinset',String(n)); node.setAttribute('aria-setsize',String(source.count));
          number.textContent = String(n); code.textContent = text[slot];
        }
        const picked = n === selected, current = n === active;
        node.classList.toggle('now',current); node.classList.toggle('picked',picked && !current);
        node.setAttribute('aria-current',current ? 'step' : 'false'); node.setAttribute('aria-selected',String(picked));
        if (picked) descendant = node.id;
      }
      for (let i = Math.max(0,last-first+1); i < pool.length; i++) pool[i].node.hidden = true;
      viewport.setAttribute('aria-activedescendant',descendant);
      firstRow = first; lastRow = last;
    }
    function schedule() {
      if (!pending) {pending = true; requestAnimationFrame(paint);}
    }
    function reveal(n) {
      const {height, top, scale, nativeMax} = layout(), y = (n-1)*rowHeight;
      if (n && (y < top || y + rowHeight > top+height)) {
        viewport.scrollTop = Math.max(0, Math.min(nativeMax, (y-(height-rowHeight)/2)/scale));
      }
    }
    function select(n) {
      if (!job || !source.count) return;
      if (!Number.isInteger(n) || n < 1 || n > source.count) {
        note.textContent = 'Enter a line from 1 to ' + source.count.toLocaleString() + '.'; return;
      }
      input.value = String(n);
      onSeek(timeForLine(job,n), n);
    }
    function setPosition(line, chosen) {
      const next = chosen ?? line, changed = active !== line || selected !== next;
      active = line; selected = next;
      if (chosen !== undefined && chosen !== line) {
        note.textContent = !line ? 'No simulated motion.' : chosen < line ? 'Next motion is on line ' + line.toLocaleString() + '.' : 'End of program after line ' + line.toLocaleString() + '.';
      } else note.textContent = '';
      const previousTop = viewport.scrollTop;
      reveal(next);
      if (changed || viewport.scrollTop !== previousTop) paint();
    }
    viewport.addEventListener('scroll', schedule);
    // The scrollbar maps the entire file even above browsers' maximum CSS
    // layout heights. Keep wheel/trackpad deltas in normal, readable row units.
    viewport.addEventListener('wheel', e => {
      const {nativeMax, nativeTop, height, scale} = layout();
      if (scale === 1 || !e.deltaY || e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if ((nativeTop <= 0 && e.deltaY < 0) || (nativeTop >= nativeMax && e.deltaY > 0)) return;
      e.preventDefault();
      const multiplier = e.deltaMode === 1 ? rowHeight : e.deltaMode === 2 ? height : 1;
      const delta = e.deltaY*multiplier/scale + wheelRemainder;
      viewport.scrollTop = Math.max(0, Math.min(nativeMax, nativeTop+delta));
      wheelRemainder = nativeTop+delta-viewport.scrollTop;
      if (Math.abs(wheelRemainder) > 1) wheelRemainder = 0;
    }, {passive:false});
    viewport.addEventListener('keydown', e => {
      if (!source.count || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const {height, top} = layout(), first = Math.floor(top/rowHeight)+1;
      const page = Math.max(1, Math.floor(height/rowHeight));
      const base = selected >= first && selected < first + page ? selected : first;
      const targets = {ArrowUp:base-1,ArrowDown:base+1,PageUp:base-page,PageDown:base+page,
        Home:1,End:source.count,Enter:base,' ':base};
      if (!Object.hasOwn(targets,e.key)) return;
      e.preventDefault(); e.stopPropagation(); select(Math.max(1,Math.min(source.count,targets[e.key])));
    });
    go.addEventListener('click', () => select(input.valueAsNumber));
    input.addEventListener('keydown', e => {if (e.key === 'Enter') {e.preventDefault(); select(input.valueAsNumber);}});
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(viewport);
    return {
      setJob(text,nextJob) {
        source = indexSource(text); job = nextJob; active = selected = 0; firstRow = lastRow = 0; wheelRemainder = 0;
        viewport.scrollTop = viewport.scrollLeft = 0;
        track.style.height = Math.min(maxHeight,source.count*rowHeight) + 'px';
        rows.style.setProperty('--line-digits',String(String(source.count).length));
        input.value = ''; input.max = String(source.count); input.disabled = go.disabled = !source.count;
        note.textContent = ''; paint();
      },
      get count() {return source.count;}, setPosition, select
    };
  }
  globalThis.NCSourceList = NCSourceList;
  if (typeof module !== 'undefined' && module.exports) module.exports = {NCSourceList,indexSource,timeForLine};
})();
