/* Remaining material in work coordinates. Both renderers depth-test the same closed mesh. */
(function () {
  'use strict';
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const unit = v => {const n=Math.hypot(...v)||1; return v.map(a=>a/n);};
  const lamp = unit([-.52,-.56,.76]), fill = unit([.60,.56,.59]);
  const basis = (yaw, elevation) => {
    const c=Math.cos(yaw),s=Math.sin(yaw),ce=Math.cos(elevation),se=Math.sin(elevation);
    return {right:[c,s,0], up:[-s*se,c*se,ce], eye:[s*ce,-c*ce,se]};
  };
  const NEUTRAL = {x:0,y:0,z:-1,l:1,w:1,h:1};
  const clock = t => {
    const s=Math.floor(Math.max(0,t)), h=Math.floor(s/3600),m=Math.floor(s/60)%60;
    return (h?h+':':'')+(h?String(m).padStart(2,'0'):m)+':'+String(s%60).padStart(2,'0');
  };

  function supportedProgram(gl,version2) {
    const prefix=version2?'#version 300 es\n':'';
    const attr=version2?'in':'attribute', vo=version2?'out':'varying', fi=version2?'in':'varying';
    const vert=prefix+'precision highp float;\n'+attr+' vec3 aPosition; '+attr+' vec3 aNormal;\n'+
      vo+' vec3 world; '+vo+' vec3 normal;\n'+
      'uniform vec3 center, rowX, rowY, rowZ; uniform vec2 pan;\n'+
      'void main(){world=aPosition;normal=aNormal;vec3 v=aPosition-center;gl_Position=vec4(dot(v,rowX)+pan.x,dot(v,rowY)+pan.y,dot(v,rowZ),1.0);}';
    const sample=version2?'texture':'texture2D';
    const frag=prefix+'precision highp float;\n'+fi+' vec3 world; '+fi+' vec3 normal;\n'+
      (version2?'out vec4 outColor;\n':'')+
      'uniform vec3 eye, light1, light2; uniform vec4 crop, stockRect; uniform vec2 bottomHeight; uniform float relief; uniform sampler2D field;\n'+
      'float heightAt(vec2 xy){ if(any(lessThan(xy,stockRect.xy))||any(greaterThan(xy,stockRect.zw)))return bottomHeight.x;'+
      'vec2 uv=(xy-crop.xy)/crop.zw; if(any(lessThan(uv,vec2(0.)))||any(greaterThan(uv,vec2(1.))))return bottomHeight.x+bottomHeight.y;'+
      'return bottomHeight.x+bottomHeight.y*(1.-'+sample+'(field,uv).r);}\n'+
      'float blocker(vec2 shift,float reach){return clamp((heightAt(world.xy+shift)-world.z)/reach,0.,1.);}\n'+
      'void main(){vec3 n=normalize(normal);float high=clamp((world.z-bottomHeight.x)/bottomHeight.y,0.,1.);'+
      'float reach=clamp(bottomHeight.y*.13,.20,1.10);vec2 a=vec2(reach,0.),b=a.yx;'+
      'float ao=relief*(blocker(a,reach)+blocker(-a,reach)+blocker(b,reach)+blocker(-b,reach))*.25;'+
      'float key=max(dot(n,light1),0.),soft=max(dot(n,light2),0.);'+
      'float gloss=pow(max(dot(n,normalize(light1+eye)),0.),32.)*.24+pow(max(dot(n,normalize(light2+eye)),0.),63.)*.10;'+
      'float lit=(.43+.51*key+.17*soft+.045*max(n.z,0.))*(.88+.12*high)*(1.-.34*ao);'+
      'vec3 metal=vec3(.86,.535,.355)*lit+vec3(.98,.79,.60)*gloss;'+
      (version2?'outColor':'gl_FragColor')+'=vec4(metal,1.);}';
    const program=gl.createProgram(), attached=[];
    try {
      for(const [type,code] of [[gl.VERTEX_SHADER,vert],[gl.FRAGMENT_SHADER,frag]]) {
        const shader=gl.createShader(type);attached.push(shader);gl.shaderSource(shader,code);gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));
        gl.attachShader(program,shader);
      }
      gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
      return program;
    } catch(e) {gl.deleteProgram(program);throw e;} finally {for(const s of attached)gl.deleteShader(s);}
  }

  function gpu(canvas) {
    const options={alpha:true,depth:true,antialias:true,premultipliedAlpha:false};
    let gl=canvas.getContext('webgl2',options);
    const version2=!!gl;
    if(!gl)gl=canvas.getContext('webgl',options);
    if(!gl||(!version2&&!gl.getExtension('OES_element_index_uint')))return null;
    const pg=supportedProgram(gl,version2), buffers=[gl.createBuffer(),gl.createBuffer(),gl.createBuffer()];
    const tex=gl.createTexture(), A=['aPosition','aNormal'].map(n=>gl.getAttribLocation(pg,n)), u={};
    for (const name of ['center','rowX','rowY','rowZ','pan','eye','light1','light2','crop','stockRect','bottomHeight','relief','field'])
      u[name]=gl.getUniformLocation(pg,name);
    gl.useProgram(pg);gl.clearColor(0,0,0,0);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D,tex);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    let uploaded, tint=new Uint8Array(1);
    function draw(frame,cam,stock) {
      gl.viewport(0,0,canvas.width,canvas.height);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      if(!frame?.mesh)return;
      const {mesh,meta,depths}=frame;
      gl.useProgram(pg);
      if(uploaded!==frame) {
        for(const [i,arr] of [mesh.positions,mesh.normals].entries()){
          gl.bindBuffer(gl.ARRAY_BUFFER,buffers[i]);gl.bufferData(gl.ARRAY_BUFFER,arr,gl.DYNAMIC_DRAW);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,buffers[2]);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,mesh.indices,gl.DYNAMIC_DRAW);
        const has=!!(meta&&depths&&depths.length===meta.nx*meta.ny);
        if(has){if(tint.length!==depths.length)tint=new Uint8Array(depths.length);
          for(let i=0;i<tint.length;i++)tint[i]=Math.round(depths[i]/257);}
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex);
        gl.texImage2D(gl.TEXTURE_2D,0,version2?gl.R8:gl.LUMINANCE,has?meta.nx:1,has?meta.ny:1,0,
          version2?gl.RED:gl.LUMINANCE,gl.UNSIGNED_BYTE,has?tint:new Uint8Array(1));
        gl.uniform1f(u.relief,has?1:0);gl.uniform1i(u.field,0);
        gl.uniform4f(u.crop,has?meta.xmin:stock.x,has?meta.ymin:stock.y,has?meta.xmax-meta.xmin:stock.l,has?meta.ymax-meta.ymin:stock.w);
        uploaded=frame;
      }
      for(let i=0;i<2;i++){gl.bindBuffer(gl.ARRAY_BUFFER,buffers[i]);gl.enableVertexAttribArray(A[i]);gl.vertexAttribPointer(A[i],3,gl.FLOAT,false,0,0);}
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,buffers[2]);
      const {right,up,eye}=cam;
      gl.uniform3fv(u.center,cam.center);gl.uniform3fv(u.rowX,right.map(v=>v*2*cam.scale/cam.w));
      gl.uniform3fv(u.rowY,up.map(v=>v*2*cam.scale/cam.h));gl.uniform3fv(u.rowZ,eye.map(v=>-v/cam.range));
      gl.uniform2f(u.pan,2*cam.pan[0]/cam.w,-2*cam.pan[1]/cam.h);
      gl.uniform3fv(u.eye,eye);gl.uniform3fv(u.light1,lamp);gl.uniform3fv(u.light2,fill);
      gl.uniform4f(u.stockRect,stock.x,stock.y,stock.x+stock.l,stock.y+stock.w);gl.uniform2f(u.bottomHeight,stock.z,stock.h);
      gl.drawElements(gl.TRIANGLES,mesh.indices.length,gl.UNSIGNED_INT,0);
    }
    return {draw,release:()=>{uploaded=undefined;},destroy:()=>{buffers.forEach(b=>gl.deleteBuffer(b));gl.deleteTexture(tex);gl.deleteProgram(pg);}};
  }

  /* Painter sorting incorrectly fills through-holes in a tilted bar. The software fallback
     rasterizes front-facing triangles with per-pixel depth, including the exposed underside. */
  function rasterize(frame, cam, stock, image, zbuffer, reusable={}) {
    const {width:w,height:h,data:rgba}=image;
    const pixels=new Uint32Array(rgba.buffer,rgba.byteOffset,rgba.length/4);
    pixels.fill(0);zbuffer.fill(-Infinity);
    if(!frame?.mesh)return;
    const {positions:p,normals:n,indices}=frame.mesh;
    if(!indices.length)return;
    if(!reusable.s||reusable.s.length!==p.length){reusable.s=new Float32Array(p.length);reusable.light=new Float32Array(p.length);}
    const sv=reusable.s,colors=reusable.light, H1=unit(lamp.map((v,i)=>v+cam.eye[i])),H2=unit(fill.map((v,i)=>v+cam.eye[i]));
    const sx=cam.scale*w/cam.w, sy=cam.scale*h/cam.h, ox=(.5+cam.pan[0]/cam.w)*w,oy=(.5+cam.pan[1]/cam.h)*h;
    const {right,up,eye,center}=cam;
    const {meta,depths}=frame, reach=clamp(stock.h*.13,.2,1.1);
    function sampledZ(x,y){
      if(x<stock.x||x>stock.x+stock.l||y<stock.y||y>stock.y+stock.w)return stock.z;
      if(x<meta.xmin||y<meta.ymin||x>=meta.xmax||y>=meta.ymax)return stock.z+stock.h;
      const ix=Math.min(meta.nx-1,Math.floor((x-meta.xmin)/meta.sx)),iy=Math.min(meta.ny-1,Math.floor((y-meta.ymin)/meta.sy));
      return stock.z+(1-depths[iy*meta.nx+ix]/65535)*stock.h;
    }
    for(let k=0;k<p.length;k+=3) {
      const x=p[k]-center[0],y=p[k+1]-center[1],z=p[k+2]-center[2];
      sv[k]=ox+(x*right[0]+y*right[1])*sx;sv[k+1]=oy-(x*up[0]+y*up[1]+z*up[2])*sy;
      sv[k+2]=x*eye[0]+y*eye[1]+z*eye[2];
      const a=n[k],b=n[k+1],c=n[k+2];
      const key=Math.max(0,a*lamp[0]+b*lamp[1]+c*lamp[2]),soft=Math.max(0,a*fill[0]+b*fill[1]+c*fill[2]);
      let ao=0;
      if(depths&&meta&&p[k+2]<stock.z+stock.h-.002){
        const u=p[k],v=p[k+1],e=p[k+2];
        ao=(clamp((sampledZ(u+reach,v)-e)/reach,0,1)+clamp((sampledZ(u-reach,v)-e)/reach,0,1)+
          clamp((sampledZ(u,v+reach)-e)/reach,0,1)+clamp((sampledZ(u,v-reach)-e)/reach,0,1))*.25;
      }
      const gloss=Math.pow(Math.max(0,a*H1[0]+b*H1[1]+c*H1[2]),32)*.24+Math.pow(Math.max(0,a*H2[0]+b*H2[1]+c*H2[2]),63)*.10;
      const bright=(.43+.51*key+.17*soft+.045*Math.max(c,0))*(.88+.12*clamp((p[k+2]-stock.z)/stock.h,0,1))*(1-.34*ao);
      colors[k]=255*clamp(.86*bright+.98*gloss,0,1);colors[k+1]=255*clamp(.535*bright+.79*gloss,0,1);colors[k+2]=255*clamp(.355*bright+.60*gloss,0,1);
    }
    for(let j=0;j<indices.length;j+=3){
      const a=3*indices[j],b=3*indices[j+1],c=3*indices[j+2];
      const ax=sv[a],ay=sv[a+1],bx=sv[b],by=sv[b+1],cx=sv[c],cy=sv[c+1];
      const dx1=bx-ax,dy1=by-ay,dx2=cx-ax,dy2=cy-ay,area=dx1*dy2-dy1*dx2;
      if(area>=-1e-9)continue;
      const x0=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5)),x1=Math.min(w-1,Math.floor(Math.max(ax,bx,cx)-.5));
      const y0=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5)),y1=Math.min(h-1,Math.floor(Math.max(ay,by,cy)-.5));
      if(x1<x0||y1<y0)continue;
      const inv=1/area, uStep=dy2*inv, vStep=-dy1*inv;
      const dz1=sv[b+2]-sv[a+2],dz2=sv[c+2]-sv[a+2];
      const r0=colors[a],g0=colors[a+1],blue0=colors[a+2];
      const dr1=colors[b]-r0,dr2=colors[c]-r0,dg1=colors[b+1]-g0,dg2=colors[c+1]-g0,db1=colors[b+2]-blue0,db2=colors[c+2]-blue0;
      for(let iy=y0;iy<=y1;iy++){
        const dy=iy+.5-ay,xstart=x0+.5-ax;
        let u=(xstart*dy2-dy*dx2)*inv,v=(dy*dx1-xstart*dy1)*inv,at=iy*w+x0;
        for(let ix=x0;ix<=x1;ix++,at++,u+=uStep,v+=vStep){
          if(u<-1e-6||v<-1e-6||u+v>1.000001)continue;
          const depth=sv[a+2]+u*dz1+v*dz2;if(depth<zbuffer[at])continue;
          zbuffer[at]=depth;
          const red=(r0+u*dr1+v*dr2+.5)|0,green=(g0+u*dg1+v*dg2+.5)|0,blue=(blue0+u*db1+v*db2+.5)|0;
          pixels[at]=(255<<24)|(blue<<16)|(green<<8)|red;
        }
      }
    }
  }

  function software(canvas){
    const ctx=canvas.getContext('2d');if(!ctx)return null;
    let image,depth,cache={};
    return {draw(frame,cam,stock){
      if(!image||image.width!==canvas.width||image.height!==canvas.height){
        image=ctx.createImageData(canvas.width,canvas.height);depth=new Float32Array(canvas.width*canvas.height);
      }
      rasterize(frame,cam,stock,image,depth,cache);ctx.putImageData(image,0,0);
    },release(){cache={};},destroy(){image=depth=null;cache={};}};
  }

  class NCSolidRenderer {
    constructor(host,{onStatus}={}){
      this.host=host;this.onStatus=onStatus;
      this.stock={...NEUTRAL};this.frame=null;this.meta=null;this.requested=0;this.active=false;
      this.mode='path';this.focus=null;this.pan=[0,0];this.factor=1;
      this.yaw=-.52;this.elevation=.65;this.fitAxes=basis(this.yaw,this.elevation);this.activeJob=null;this.notice='';
      host.style.background='radial-gradient(ellipse at 45% 30%, #293843 0%, #1c2b35 47%, #111d25 100%)';
      this.blank={mesh:null,t:0};
      const createCanvas=()=>{
        const c=document.createElement('canvas');
        c.style.cssText='display:block;width:100%;height:100%;touch-action:none;cursor:grab';
        c.setAttribute('aria-label','Rotatable three-dimensional model of the remaining stock');return c;
      };
      this.canvas=createCanvas();this.usingCPU=false;
      try{this.output=gpu(this.canvas);}catch(e){this.output=null;}
      if(!this.output){this.canvas=createCanvas();this.output=software(this.canvas);this.usingCPU=true;}
      host.append(this.canvas);this.available=!!this.output;this.bindInput();
      this.canvas.addEventListener('webglcontextlost',e=>{
        e.preventDefault();
        const next=createCanvas();this.canvas.replaceWith(next);this.canvas=next;this.usingCPU=true;this.output=software(next);this.available=!!this.output;
        this.bindInput();this.schedule();
      });
      this.hud=document.createElement('div');
      this.hud.style.cssText='position:absolute;bottom:12px;left:12px;max-width:calc(100% - 93px);font:11px/1.4 system-ui,sans-serif;letter-spacing:.01em;color:#e8eeef;padding:6px 9px;border:1px solid #47545d;border-radius:5px;pointer-events:none;background:rgba(17,29,37,.92);white-space:normal;';
      this.hint=document.createElement('div');this.hint.style.cssText='font:10px/1.4 system-ui,sans-serif;color:#b6c3ca;';
      this.hint.textContent='Drag to orbit · Shift-drag to pan · Scroll to zoom';
      this.status=document.createElement('div');this.hud.append(this.status,this.hint);host.append(this.hud);
      this.axes=document.createElement('canvas');this.axes.style.cssText='position:absolute;bottom:7px;right:8px;width:69px;height:59px;pointer-events:none;';
      this.axes.setAttribute('aria-hidden','true');host.append(this.axes);
      this.observer=new ResizeObserver(()=>this.schedule());this.observer.observe(host);
      this.setStock(this.stock);
    }
    setStock(stock){
      if(this.blank.mesh&&['x','y','z','l','w','h'].every(k=>this.stock[k]===stock[k]))return;
      this.stock={...stock};this.blank={mesh:globalThis.buildSolidMesh(this.stock,null,null),t:0};
      this.reset();this.focus=null;this.schedule();
    }
    setJob(job){this.activeJob=job;this.reset();this.requested=0;this.fit('path');}
    reset(){this.frame=null;this.meta=null;this.notice='';this.output?.release();this.schedule();}
    setFrame(frame){
      if(!frame){this.reset();return;}if(!frame.mesh)return;
      this.frame=frame;this.setMeta(frame.meta);
      this.schedule();
    }
    setMeta(meta){this.meta=meta;this.schedule();}
    setStatus(message){const next=String(message||'');if(next===this.notice)return;this.notice=next;this.updateHud();}
    setTime(time){const previous=this.requested;this.requested=Math.max(0,Number(time)||0);
      if(this.requested===0||previous===0)this.schedule();else if(this.active)this.updateHud();}
    setActive(yes){this.active=!!yes;if(this.active)this.schedule();}
    fit(mode){this.mode=mode==='stock'?'stock':'path';this.focus=null;this.factor=1;this.pan=[0,0];this.fitAxes=basis(this.yaw,this.elevation);this.schedule();}
    zoom(factor,px=0,py=0){
      if(!Number.isFinite(factor)||factor<=0)return;
      const f=clamp(this.factor*factor,.035,100),r=f/this.factor;
      this.pan=[px+(this.pan[0]-px)*r,py+(this.pan[1]-py)*r];
      this.factor=f;this.schedule();
    }
    fitBounds(){
      const s=this.stock,m=this.meta,b=this.activeJob?.bounds;
      let x=s.x,y=s.y,x1=s.x+s.l,y1=s.y+s.w;
      if(this.mode==='path'){
        if(m?.activeMoves){x=m.xmin;y=m.ymin;x1=m.xmax;y1=m.ymax;}
        else if(!m&&b){const ix=Math.max(x,b.min[0]),iy=Math.max(y,b.min[1]),ix1=Math.min(x1,b.max[0]),iy1=Math.min(y1,b.max[1]);
          if(ix1>ix&&iy1>iy){x=ix;y=iy;x1=ix1;y1=iy1;}}
      }
      return [x,y,s.z,x1,y1,s.z+s.h];
    }
    camera(){
      const b=this.focus||this.fitBounds(),w=this.host.clientWidth||1,h=this.host.clientHeight||1;
      const cam=basis(this.yaw,this.elevation),size=[b[3]-b[0],b[4]-b[1],b[5]-b[2]];
      // Measure the exact silhouette in the fit orientation, then keep scale stable while orbiting.
      const extent=axis=>Math.max(.001,size[0]*Math.abs(axis[0])+size[1]*Math.abs(axis[1])+size[2]*Math.abs(axis[2]));
      const scale=Math.max(.001,Math.min(Math.max(16,w-76)/extent(this.fitAxes.right),
        Math.max(16,h-108)/extent(this.fitAxes.up)))*this.factor;
      const s=this.stock;cam.center=size.map((d,i)=>b[i]+d*.5);cam.range=Math.hypot(s.l,s.w,s.h)*1.5+1;
      return Object.assign(cam,{w,h,scale,pan:this.pan});
    }
    updateHud(){
      if(!this.status||!this.active)return;
      const f=this.requested===0?this.blank:(this.frame||this.blank), shown=f.t??0,m=this.meta;
      let msg;
      if(!this.available)msg='3D rendering unavailable. Choose Cut depth.';
      else if(this.notice&&/fail|unavail|could not|error/i.test(this.notice))msg=this.notice;
      else {
        const done=!!this.frame||this.requested===0;
        msg=done?(shown===0?'Uncut stock':'Remaining stock at '+clock(shown)):'Showing uncut stock';
        if(!done||Math.abs(shown-this.requested)>.18)msg+=' · updating to '+clock(this.requested);
        if(m&&!m.activeMoves&&!(m.unknown||[]).length&&!this.notice)msg+=' · no cutting contact';
        if(m?.unknown?.length&&!this.notice)msg+=' · unmodeled '+m.unknown.map(t=>t?'T'+t:'tool').join(', ');
        if(this.frame&&shown===this.frame.t&&!this.frame.mesh.indices.length)msg+=' · all material removed';
        if(this.notice&&!/prepar|cache|updat|ready/i.test(this.notice))msg+=' · '+this.notice;
      }
      if(this.status.textContent!==msg){this.status.textContent=msg;this.onStatus?.(msg);}
    }
    drawAxes(cam){
      const c=this.axes, d=Math.min(2,window.devicePixelRatio||1),ctx=c.getContext('2d');
      if(!ctx)return;if(c.width!==Math.round(69*d)||c.height!==Math.round(59*d)){c.width=Math.round(69*d);c.height=Math.round(59*d);}
      ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,69,59);ctx.font='600 10px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineWidth=1.6;
      const ox=32,oy=29;
      for(const [i,letter,color] of [[0,'X','#eaa393'],[1,'Y','#a1d4ae'],[2,'Z','#a2c6eb']]){
        const x=cam.right[i],y=-cam.up[i];if(x*x+y*y<.015)continue;
        ctx.strokeStyle=ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(ox,oy);ctx.lineTo(ox+17*x,oy+17*y);ctx.stroke();
        ctx.fillText(letter,ox+24*x,oy+24*y);
      }
    }
    draw(){
      if(!this.active)return;
      const cam=this.camera();if(cam.w<=1||cam.h<=1)return;
      const dpr=window.devicePixelRatio||1;
      const d=this.usingCPU?Math.min(dpr,1.1,Math.sqrt(680000/(cam.w*cam.h))):Math.min(dpr,2);
      const w=Math.max(1,Math.round(cam.w*d)),h=Math.max(1,Math.round(cam.h*d));
      if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
      const frame=this.requested===0?this.blank:(this.frame||this.blank);
      this.output?.draw(frame,cam,this.stock);this.drawAxes(cam);this.updateHud();
    }
    schedule(){if(this.active&&!this.raf)this.raf=requestAnimationFrame(()=>{this.raf=0;this.draw();});}
    bindInput(){
      const c=this.canvas,pointers=new Map();let drag=null,pinch=null;
      c.addEventListener('contextmenu',e=>e.preventDefault());
      c.addEventListener('pointerdown',e=>{
        if(e.button>2)return;c.setPointerCapture(e.pointerId);pointers.set(e.pointerId,[e.clientX,e.clientY]);
        drag={id:e.pointerId,x:e.clientX,y:e.clientY,pan:e.shiftKey||e.button!==0};c.style.cursor='grabbing';
        if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={x:(a[0]+b[0])*.5,y:(a[1]+b[1])*.5,d:Math.hypot(a[0]-b[0],a[1]-b[1])};}
      });
      c.addEventListener('pointermove',e=>{
        if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,[e.clientX,e.clientY]);
        if(!this.focus)this.focus=this.fitBounds();
        if(pinch&&pointers.size===2){
          const [a,b]=[...pointers.values()],x=(a[0]+b[0])*.5,y=(a[1]+b[1])*.5,d=Math.hypot(a[0]-b[0],a[1]-b[1]),r=c.getBoundingClientRect();
          if(d>1&&pinch.d>1)this.zoom(d/pinch.d,pinch.x-r.left-r.width/2,pinch.y-r.top-r.height/2);
          this.pan[0]+=x-pinch.x;this.pan[1]+=y-pinch.y;pinch={x,y,d};
        }else if(drag&&drag.id===e.pointerId){
          const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;
          if(drag.pan){this.pan[0]+=dx;this.pan[1]+=dy;}else{this.yaw-=dx*.008;this.elevation=clamp(this.elevation+dy*.008,-Math.PI/2,Math.PI/2);}
        }this.schedule();
      });
      const end=e=>{if(!pointers.delete(e.pointerId))return;pinch=null;drag=null;if(pointers.size===1){const [id,p]=[...pointers][0];drag={id,x:p[0],y:p[1],pan:false};}else c.style.cursor='grab';};
      for(const event of ['pointercancel','pointerup','lostpointercapture'])c.addEventListener(event,end);
      c.addEventListener('wheel',e=>{e.preventDefault();if(!this.focus)this.focus=this.fitBounds();const r=c.getBoundingClientRect();
        this.zoom(Math.exp(-clamp(e.deltaY*(e.deltaMode===1?16:1),-300,300)*.002),e.clientX-r.left-r.width/2,e.clientY-r.top-r.height/2);
      },{passive:false});
      c.addEventListener('dblclick',()=>this.fit('path'));
    }
    destroy(){this.observer.disconnect();if(this.raf)cancelAnimationFrame(this.raf);this.output?.destroy();this.hud.remove();this.axes.remove();this.canvas.remove();}
  }
  globalThis.NCSolidRenderer=NCSolidRenderer;
  if(typeof module!=='undefined'&&module.exports)module.exports={NCSolidRenderer,rasterize,basis};
})();
