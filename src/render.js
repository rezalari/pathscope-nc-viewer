/* NC viewer orthographic plotter; all coordinates and cutter sizes are millimetres. */
(function () {
  "use strict";
  const bg = "#101820";
  const palette = ["#a9bdcf","#42c7b1","#c89bff","#dac96e","#f0aa68","#69acff","#ee8e9d","#87c3a3"];
  const rapidColor = "#a7bacd";
  const toolColor = n => palette[n % palette.length] || palette[0];
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const rgb = str => [parseInt(str.slice(1,3),16),parseInt(str.slice(3,5),16),parseInt(str.slice(5,7),16)];
  const finitePoint = p => p && p.length >= 3 && p.every(Number.isFinite);
  function boxCorners(lo,hi) {
    return [lo[2],hi[2]].flatMap(z => [[lo[0],lo[1],z],[hi[0],lo[1],z],[hi[0],hi[1],z],[lo[0],hi[1],z]]);
  }
  function makeLayer(host) {
    const canvas=document.createElement("canvas");
    Object.assign(canvas.style,{position:"absolute",inset:"0",width:"100%",height:"100%",display:"block",pointerEvents:"none"});
    host.append(canvas);
    return canvas;
  }
  function findMove(times,time) {
    let lo=0,hi=times.length;
    while(lo<hi) { const mid=lo+Math.floor((hi-lo)/2); if(times[mid]<=time) lo=mid+1; else hi=mid; }
    return lo;
  }
  class NCRenderer {
    constructor(host,{onViewChange}={}) {
      this.host=host;this.onViewChange=onViewChange;this.stock=null;this.part=null;this.tools={};
      this.markers={};this.opt={rapid:true,future:true,stock:true,grid:true,part:true,tool:true,markers:true};
      if(getComputedStyle(host).position==="static")host.style.position="relative";
      Object.assign(host.style,{overflow:"hidden",touchAction:"none",background:bg});
      this.back=makeLayer(host);this.paths=makeLayer(host);this.front=makeLayer(host);
      this.back.setAttribute("aria-hidden","true");this.paths.setAttribute("aria-hidden","true");
      this.front.setAttribute("aria-label","Orthographic NC toolpath preview");this.front.style.pointerEvents="auto";
      this.front.style.cursor="grab";this.b=this.back.getContext("2d");this.f=this.front.getContext("2d");
      this.yaw=.44;this.elev=.72;this.view="iso";this.center=[0,0,0];this.scale=9;this.pan=[0,0];this.fitMode="path";
      this.width=1;this.height=1;this.ratio=1;this.time=0;this.dirty=true;this.pending=false;
      this._initPathLayer();this._listen();
      this.obs=new ResizeObserver(()=>this._resize());this.obs.observe(host);this._resize();
    }
    _initPathLayer() {
      try {
        const gl=this.paths.getContext("webgl",{antialias:true,alpha:true,depth:false,stencil:false,premultipliedAlpha:false,preserveDrawingBuffer:false});
        if(!gl)throw Error("no WebGL");
        const compile=(type,src)=>{
          const shader=gl.createShader(type);gl.shaderSource(shader,src);gl.compileShader(shader);
          if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;
        };
        const vs=compile(gl.VERTEX_SHADER,`
          attribute vec3 p; attribute vec4 attr;
          uniform vec3 hAxis,vAxis,center; uniform vec2 scale,pan;
          varying lowp vec4 tint;
          void main() { vec3 q=p-center; gl_Position=vec4(vec2(dot(q,hAxis),dot(q,vAxis))*scale+pan,0.,1.); tint=attr; }`);
        const fs=compile(gl.FRAGMENT_SHADER,`
          precision mediump float; varying lowp vec4 tint;
          uniform bool rapidOn; uniform bool ghost;
          void main() {
            bool rapid=tint.a>.5;
            if(rapid && !rapidOn)discard;
            vec3 c=tint.rgb;
            if(ghost) c=mix(vec3(.055,.090,.116),c, rapid?.14:.43);
            else if(rapid)c=mix(vec3(.055,.090,.116),c,.60);
            gl_FragColor=vec4(c,1.);
          }`);
        const program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
        gl.deleteShader(vs);gl.deleteShader(fs);
        this.gl=gl;this.prog=program;this.coords=gl.createBuffer();this.colors=gl.createBuffer();
        this.uniforms={};["hAxis","vAxis","center","scale","pan","rapidOn","ghost"].forEach(k=>this.uniforms[k]=gl.getUniformLocation(program,k));
        this.locP=gl.getAttribLocation(program,"p");this.locC=gl.getAttribLocation(program,"attr");gl.clearColor(0,0,0,0);
        this.paths.addEventListener("webglcontextlost",e=>{e.preventDefault();this._fallback();this._invalidate();});
      }catch(e){this._fallback();}
    }
    _fallback() {
      this.gl=null;
      const c=this.paths.cloneNode(false);this.paths.replaceWith(c);this.paths=c;this.p=c.getContext("2d");
      this.futureCache=document.createElement("canvas");this.pastCache=document.createElement("canvas");
      this.cpuKey="";this.pastCount=0;
    }
    _upload() {
      if(!this.gl||!this.job)return;
      const gl=this.gl,j=this.job,colors=new Uint8Array(j.count*8),byTool=palette.map(rgb),rap=rgb(rapidColor);
      for(let i=0;i<j.count;i++) {
        const rapid=j.kind[i]===0,c=rapid?rap:byTool[j.tool[i]%palette.length],k=i*8;
        colors[k]=colors[k+4]=c[0];colors[k+1]=colors[k+5]=c[1];colors[k+2]=colors[k+6]=c[2];colors[k+3]=colors[k+7]=rapid?255:0;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER,this.coords);gl.bufferData(gl.ARRAY_BUFFER,j.xyz,gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.colors);gl.bufferData(gl.ARRAY_BUFFER,colors,gl.STATIC_DRAW);
    }
    _resize() {
      const w=Math.max(1,this.host.clientWidth),h=Math.max(1,this.host.clientHeight),r=clamp(window.devicePixelRatio||1,1,2);
      if(w===this.width&&h===this.height&&r===this.ratio)return;
      this.width=w;this.height=h;this.ratio=r;
      for(const c of [this.back,this.paths,this.front]) {c.width=Math.round(w*r);c.height=Math.round(h*r);}
      if(this.fitMode)this.fit(this.fitMode);else this._invalidate();
    }
    setJob(job) {this.job=job;this.time=0;this.markers={};this._upload();this.fit("path");}
    setStock(s) {this.stock=s;if(this.fitMode==="stock")this.fit("stock");else this._invalidate();}
    setPart(p) {this.part=p;this._invalidate();}
    setTools(t) {this.tools=t||{};this._invalidate();}
    setOptions(o) {Object.assign(this.opt,o);this._invalidate();}
    setMarkers(m) {this.markers=m||{};this._invalidate();}
    setTime(seconds) {this.time=clamp(Number(seconds)||0,0,this.job?.duration||0);this._queue();}
    _queue() {if(!this.pending){this.pending=true;requestAnimationFrame(()=>{this.pending=false;this._draw();});}}
    _invalidate() {this.dirty=true;this.cpuKey="";this._queue();}
    _basis() {
      const [a,e]=[this.yaw,this.elev],ca=Math.cos(a),sa=Math.sin(a),ce=Math.cos(e),se=Math.sin(e);
      this.u=[ca,sa,0];this.v=[-sa*se,ca*se,ce];
    }
    project(p) {
      const q=[p[0]-this.center[0],p[1]-this.center[1],p[2]-this.center[2]];
      return [this.width/2+this.pan[0]+dot(q,this.u)*this.scale,this.height/2+this.pan[1]-dot(q,this.v)*this.scale];
    }
    _stockBox() {
      const s=this.stock;
      if(!s||![s.x,s.y,s.z,s.l,s.w,s.h].every(Number.isFinite))return null;
      return [[s.x,s.y,s.z],[s.x+s.l,s.y+s.w,s.z+s.h]];
    }
    fit(mode="path") {
      this.fitMode=mode;this._basis();
      let bb=this.job?.bounds;let lo=bb?.min,hi=bb?.max;
      if(!finitePoint(lo)||!finitePoint(hi)){lo=[0,0,0];hi=[1,1,1];}
      if(mode==="stock"&&this._stockBox()){const b=this._stockBox();lo=b[0].map((v,i)=>Math.min(v,lo[i]));hi=b[1].map((v,i)=>Math.max(v,hi[i]));}
      this.center=lo.map((v,i)=>(v+hi[i])/2);this.pan=[0,0];
      const all=boxCorners(lo,hi),uu=all.map(p=>dot(p,this.u)),vv=all.map(p=>dot(p,this.v));
      const availW=Math.max(10,this.width-72),availH=Math.max(10,this.height-90);
      this.scale=clamp(Math.min(availW/Math.max(.2,Math.max(...uu)-Math.min(...uu)),availH/Math.max(.2,Math.max(...vv)-Math.min(...vv))),.0001,5000);
      this._invalidate();
    }
    setView(name) {
      const angles={iso:[.44,.72],top:[0,Math.PI/2],front:[0,0],right:[Math.PI/2,0]};
      if(!angles[name])return;
      this.view=name;[this.yaw,this.elev]=angles[name];this.fit(this.fitMode||"path");this.onViewChange?.(name);
    }
    zoom(factor,anchor=[this.width/2,this.height/2]) {
      const scale=clamp(this.scale*factor,.0001,5000),k=scale/this.scale;
      this.pan=[0,1].map(i=>(this.pan[i]-(anchor[i]-(i?this.height:this.width)/2))*k+(anchor[i]-(i?this.height:this.width)/2));
      this.scale=scale;this.fitMode=null;this._invalidate();
    }
    _listen() {
      const c=this.front;let drag=null;
      c.addEventListener("pointerdown",e=>{if(drag)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,pan:e.button!==0||e.shiftKey};c.setPointerCapture(e.pointerId);c.style.cursor="grabbing";});
      c.addEventListener("pointermove",e=>{
        if(!drag||drag.id!==e.pointerId)return;
        const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;
        if(!dx&&!dy)return;this.fitMode=null;
        if(drag.pan){this.pan[0]+=dx;this.pan[1]+=dy;}
        else{this.yaw-=dx*.007;this.elev=clamp(this.elev+dy*.007,-1.52,Math.PI/2);if(this.view!=="orbit"){this.view="orbit";this.onViewChange?.("orbit");}}
        this._invalidate();
      });
      const end=e=>{if(!drag||drag.id!==e.pointerId)return;drag=null;c.style.cursor="grab";};
      c.addEventListener("lostpointercapture",end);c.addEventListener("pointerup",end);c.addEventListener("pointercancel",end);
      c.addEventListener("contextmenu",e=>e.preventDefault());
      c.addEventListener("wheel",e=>{e.preventDefault();const r=c.getBoundingClientRect();this.zoom(Math.exp(-clamp(e.deltaY*(e.deltaMode===1?16:1),-260,260)*.0016),[e.clientX-r.left,e.clientY-r.top]);},{passive:false});
      c.addEventListener("dblclick",()=>this.fit("path"));
    }
    _poly(ctx,pts,fill,stroke,close=true) {
      if(!pts.length)return;ctx.beginPath();const a=this.project(pts[0]);ctx.moveTo(...a);
      for(let i=1;i<pts.length;i++)ctx.lineTo(...this.project(pts[i]));if(close)ctx.closePath();
      if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.stroke();}
    }
    _drawGrid(ctx) {
      const s=this.stock,base=s?.z||0,sc=this.scale;
      const stepGoal=55/sc;
      const decade=10**Math.floor(Math.log10(stepGoal)),ratio=stepGoal/decade;
      const step=(ratio<1.5?1:ratio<3.5?2:ratio<7?5:10)*decade;
      const cx=this.width/2,cy=this.height/2;
      // Center the grid on the currently visible plane even when panned.
      const du=-this.pan[0]/sc;
      const sv=Math.max(.12,Math.abs(Math.sin(this.elev)))*Math.sign(Math.sin(this.elev)||1);
      const dv=(this.pan[1]/sc-(base-this.center[2])*this.v[2])/sv;
      const gx=this.center[0]+du*this.u[0]-dv*this.u[1],gy=this.center[1]+du*this.u[1]+dv*this.u[0];
      const rad=(cx+cy)/sc/Math.max(.15,Math.abs(sv));
      const span=Math.min(90*step,rad+2*step),ax=Math.floor((gx-span)/step)*step,ay=Math.floor((gy-span)/step)*step;
      ctx.lineWidth=.65;
      for(let x=ax;x<=gx+span;x+=step)this._poly(ctx,[[x,gy-span,base],[x,gy+span,base]],null,"#23313d",false);
      for(let y=ay;y<=gy+span;y+=step)this._poly(ctx,[[gx-span,y,base],[gx+span,y,base]],null,"#23313d",false);
    }
    _roundedPart(ctx) {
      const p=this.part;if(!p||!this.opt.part)return;
      const r=clamp(p.r||0,0,Math.min(p.l,p.w)*.5),x=p.x,y=p.y,z=p.z;
      const corners=[[x+p.l-r,y+r,-90],[x+p.l-r,y+p.w-r,0],[x+r,y+p.w-r,90],[x+r,y+r,180]];
      const pts=[];
      for(const [cx,cy,start] of corners)for(let i=0;i<=12;i++){const a=(start+i*7.5)*Math.PI/180;pts.push([cx+r*Math.cos(a),cy+r*Math.sin(a),z]);}
      ctx.save();ctx.lineWidth=1.2;ctx.setLineDash([5,4]);this._poly(ctx,pts,null,"#e8d8b8");ctx.restore();
    }
    _static() {
      const c=this.b;c.setTransform(this.ratio,0,0,this.ratio,0,0);c.fillStyle=bg;c.fillRect(0,0,this.width,this.height);
      if(this.opt.grid)this._drawGrid(c);
      const box=this._stockBox();if(box&&this.opt.stock) {
        const ps=boxCorners(...box),s=this.elev;
        const sides=[[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
        const normal=[Math.sin(this.yaw)*Math.cos(s),-Math.cos(this.yaw)*Math.cos(s),Math.sin(s)];
        sides.sort((a,b)=>a.reduce((n,i)=>n+dot(ps[i],normal),0)-b.reduce((n,i)=>n+dot(ps[i],normal),0));
        c.lineWidth=1;
        if(s<0)this._poly(c,[ps[4],ps[5],ps[6],ps[7]],"#443328","#9c7053");
        for(const side of sides)this._poly(c,side.map(i=>ps[i]),"#342c29","#765a47");
        if(s>=0)this._poly(c,[ps[4],ps[5],ps[6],ps[7]],"#45372e","#bc8d65");
        if(s<0)this._poly(c,ps.slice(0,4),"#302c2b","#846854");
      }
      this._roundedPart(c);
      this.dirty=false;
    }
    _drawGL(done) {
      const g=this.gl,u=this.uniforms,j=this.job;g.viewport(0,0,this.paths.width,this.paths.height);g.clear(g.COLOR_BUFFER_BIT);
      if(!j||!j.count)return;g.useProgram(this.prog);g.bindBuffer(g.ARRAY_BUFFER,this.coords);g.enableVertexAttribArray(this.locP);g.vertexAttribPointer(this.locP,3,g.FLOAT,false,0,0);
      g.bindBuffer(g.ARRAY_BUFFER,this.colors);g.enableVertexAttribArray(this.locC);g.vertexAttribPointer(this.locC,4,g.UNSIGNED_BYTE,true,0,0);
      g.uniform3fv(u.hAxis,this.u);g.uniform3fv(u.vAxis,this.v);g.uniform3fv(u.center,this.center);
      g.uniform2f(u.scale,2*this.scale/this.width,2*this.scale/this.height);g.uniform2f(u.pan,2*this.pan[0]/this.width,-2*this.pan[1]/this.height);
      g.uniform1i(u.rapidOn,+this.opt.rapid);
      if(this.opt.future&&done<j.count){g.uniform1i(u.ghost,1);g.drawArrays(g.LINES,done*2,(j.count-done)*2);}
      if(done){g.uniform1i(u.ghost,0);g.drawArrays(g.LINES,0,done*2);}
    }
    _cpuSegments(c,from,to,ghost) {
      const j=this.job;if(!j||from>=to)return;
      const ax=this.u[0]*this.scale,ay=this.u[1]*this.scale,bx=-this.v[0]*this.scale,by=-this.v[1]*this.scale,bz=-this.v[2]*this.scale;
      const tx=this.width/2+this.pan[0]-this.center[0]*ax-this.center[1]*ay;
      const ty=this.height/2+this.pan[1]-this.center[0]*bx-this.center[1]*by-this.center[2]*bz;
      const s=j.xyz;let lastStyle=-1,lines=0;
      c.lineWidth=.9;c.setTransform(this.ratio,0,0,this.ratio,0,0);c.beginPath();
      const styles=palette.concat(rapidColor).map(k=>{if(!ghost)return k;const col=rgb(k),base=rgb(bg),v=k===rapidColor?.16:.42;return "rgb("+col.map((t,i)=>Math.round(t*v+base[i]*(1-v))).join(",")+")";});
      // Preserve endpoint order; avoid millions of subpixel Canvas strokes deep inside dense programs.
      for(let i=from,n=i*6;i<to;i++,n+=6) {
        const rapid=j.kind[i]===0;if(rapid&&!this.opt.rapid||j.kind[i]===2)continue;
        const style=rapid?palette.length:j.tool[i]%palette.length;
        const x0=tx+ax*s[n]+ay*s[n+1],y0=ty+bx*s[n]+by*s[n+1]+bz*s[n+2],x1=tx+ax*s[n+3]+ay*s[n+4],y1=ty+bx*s[n+3]+by*s[n+4]+bz*s[n+5];
        if((x0<0&&x1<0)||(x0>this.width&&x1>this.width)||(y0<0&&y1<0)||(y0>this.height&&y1>this.height))continue;
        if(style!==lastStyle||lines>3000){c.stroke();c.beginPath();c.strokeStyle=styles[style];lastStyle=style;lines=0;}
        c.moveTo(x0,y0);c.lineTo(x1,y1);lines++;
      }
      c.stroke();
    }
    _drawCPU(done) {
      const j=this.job,p=this.p,W=this.paths.width,H=this.paths.height;
      if(!this.cpuKey) {
        for(const c of [this.futureCache,this.pastCache]){c.width=W;c.height=H;}
        if(this.opt.future&&j)this._cpuSegments(this.futureCache.getContext("2d"),0,j.count,true);
        this.pastCount=0;this.cpuKey="ready";
      }
      p.setTransform(1,0,0,1,0,0);p.clearRect(0,0,W,H);
      if(this.opt.future)p.drawImage(this.futureCache,0,0);
      const cache=this.pastCache.getContext("2d");
      if(done<this.pastCount){cache.setTransform(1,0,0,1,0,0);cache.clearRect(0,0,W,H);this.pastCount=0;}
      if(done>this.pastCount)this._cpuSegments(cache,this.pastCount,done,false);
      this.pastCount=done;p.drawImage(this.pastCache,0,0);
    }
    _gizmo(c) {
      const ox=36,oy=this.height-39,len=21;
      c.save();c.font="600 10px Segoe UI, sans-serif";c.textAlign="center";c.textBaseline="middle";
      const axes=[[0,"X","#f09c87"],[1,"Y","#81d2ac"],[2,"Z","#92b9ff"]];
      for(const [i,text,color] of axes){const dx=this.u[i],dy=-this.v[i];if(dx*dx+dy*dy<.01)continue;c.strokeStyle=color;c.fillStyle=color;c.lineWidth=1.65;c.beginPath();c.moveTo(ox,oy);c.lineTo(ox+dx*len,oy+dy*len);c.stroke();c.fillText(text,ox+dx*(len+6),oy+dy*(len+6));}
      c.beginPath();c.arc(ox,oy,2.2,0,2*Math.PI);c.fillStyle="#e3e9ed";c.fill();c.restore();
    }
    _label(c,x,y,text,color) {
      if(x>this.width-38)x-=48;
      c.save();c.font="600 10px Segoe UI, sans-serif";c.textAlign="left";c.textBaseline="middle";c.lineWidth=3;c.strokeStyle="#111a20";c.strokeText(text,x,y);c.fillStyle=color;c.fillText(text,x,y);c.restore();
    }
    _marks(c) {
      const o=this.project([0,0,0]);c.strokeStyle="#f2f4f5";c.lineWidth=1.3;
      c.beginPath();c.moveTo(o[0]-5,o[1]);c.lineTo(o[0]+5,o[1]);c.moveTo(o[0],o[1]-5);c.lineTo(o[0],o[1]+5);c.stroke();this._label(c,o[0]+8,o[1]+13,"Origin","#ebf0f1");
      for(const [p,label,col,delta] of [[this.markers.entry,"Entry","#ffc78f",-12],[this.markers.contact,"Contact","#81e2c9",14]]) {
        if(!finitePoint(p))continue;
        const [x,y]=this.project(p);c.strokeStyle=col;c.lineWidth=1.6;c.beginPath();c.moveTo(x,y-4.4);c.lineTo(x+4.4,y+(label==="Entry"?3:0));if(label!=="Entry")c.lineTo(x,y+4.4);c.lineTo(x-4.4,y+(label==="Entry"?3:0));c.closePath();c.stroke();this._label(c,x+8,y+delta,label,col);
      }
    }
    _tool(c,point,toolNo) {
      const opt=this.tools instanceof Map?this.tools.get(toolNo):this.tools?.[toolNo];
      const d=Number(opt?.d??opt?.diameter??1.5),shape=String(opt?.shape||"flat").toLowerCase();
      const rad=Math.max(.03,Math.abs(d)/2);
      const length=Math.min(Math.max(44/this.scale,rad*2.6),Math.max(rad*6,90/this.scale));
      const [x,y,z]=point;
      const centerZ=shape.includes("ball")?rad:shape.includes("drill")?rad*.6:0;
      // Rotate the circular tool through the view basis so the two side strokes are its silhouette.
      const w=this.u,t=toolColor(toolNo);
      const ring=(dz,r)=>Array.from({length:33},(_,i)=>{const a=i*Math.PI/16;return [x+r*Math.cos(a),y+r*Math.sin(a),z+dz];});
      c.lineWidth=1.2;const outline=[];
      if(centerZ>0){for(let i=-16;i<=16;i++){
        const v=i/16,dz=shape.includes("ball")?rad*(1-Math.sqrt(Math.max(0,1-v*v))):centerZ*Math.abs(v);
        outline.push([x+w[0]*v*rad,y+w[1]*v*rad,z+dz]);}}
      else outline.push([x-w[0]*rad,y-w[1]*rad,z],[x+w[0]*rad,y+w[1]*rad,z]);
      outline.push([x+w[0]*rad,y+w[1]*rad,z+length],[x-w[0]*rad,y-w[1]*rad,z+length]);
      this._poly(c,outline,"rgba(241,247,247,.16)","#e8f2f2");
      this._poly(c,ring(length,rad),"rgba(238,244,245,.28)","#eff5f6");
      this._poly(c,ring(centerZ,rad),null,t);
      const tip=this.project(point);c.fillStyle="#fff";c.strokeStyle="#17242a";c.lineWidth=1;c.beginPath();c.arc(...tip,2.1,0,2*Math.PI);c.fill();c.stroke();
    }
    _draw() {
      this._basis();if(this.dirty)this._static();
      const j=this.job,done=j?findMove(j.endTime,this.time):0;
      if(this.gl)this._drawGL(done);else this._drawCPU(done);
      const c=this.f;c.setTransform(this.ratio,0,0,this.ratio,0,0);c.clearRect(0,0,this.width,this.height);
      if(this.opt.markers)this._marks(c);
      if(j?.count){const i=Math.min(done,j.count-1),k=i*6,start=i?j.endTime[i-1]:0,delta=j.endTime[i]-start;
        const frac=delta?clamp((this.time-start)/delta,0,1):1;
        const a=Array.from(j.xyz.subarray(k,k+3)),b=a.map((v,t)=>v+(j.xyz[k+t+3]-v)*frac);
        if(j.kind[i]!==2&&(j.kind[i]!==0||this.opt.rapid)){c.lineWidth=2.3;this._poly(c,[a,b],null,j.kind[i]===0?rapidColor:toolColor(j.tool[i]),false);}
        if(this.opt.tool)this._tool(c,b,j.tool[i]);
      }
      this._gizmo(c);
    }
  }
  globalThis.NCRenderer=NCRenderer;
})();
