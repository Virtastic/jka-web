import { execFile } from 'node:child_process';
import http from 'node:http';
const URL_ = 'http://localhost:8790/index.html?args=' + encodeURIComponent('+set com_introplayed 1 +spdevmap escape1');
const PORT = 9240;
const chrome = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`,'--headless=new','--use-gl=angle','--enable-unsafe-swiftshader',
  '--no-first-run','--window-size=800,600','--user-data-dir=/tmp/idt3-rtcw-gldiag','about:blank']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const get=p=>new Promise((res,rej)=>http.get({port:PORT,path:p},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej));
try{
  let page=null; for(let i=0;i<30&&!page;i++){await sleep(1000);try{page=(await get('/json')).find(x=>x.type==='page')}catch{}}
  const {default:WebSocket}=await import('ws'); const ws=new WebSocket(page.webSocketDebuggerUrl); let id=0;
  const send=(m,p)=>new Promise(res=>{const mid=++id;const h=x=>{const j=JSON.parse(x);if(j.id===mid){ws.off('message',h);res(j.result)}};ws.on('message',h);ws.send(JSON.stringify({id:mid,method:m,params:p}))});
  await new Promise(r=>ws.on('open',r)); await send('Page.enable',{}); await send('Runtime.enable',{});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__logs=[]; for(const k of ['log','warn','error']){const o=console[k].bind(console);console[k]=(...a)=>{try{window.__logs.push(a.join(' '))}catch{}o(...a)}}
    window.__gl={draws:0,clears:0,errs:{},px:null};
    var og=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(){var c=og.apply(this,arguments);
      if(c&&c.drawElements&&!c.__h){c.__h=1;
        var ge=c.getError.bind(c); window.__gl.badcalls={};
        window.__gl.vps={}; window.__gl.scis={};
        var vp0=c.viewport.bind(c); c.viewport=function(x,y,w,h){var k=[x,y,w,h].join(','); window.__gl.vps[k]=(window.__gl.vps[k]|0)+1; return vp0(x,y,w,h);};
        var sc0=c.scissor.bind(c); c.scissor=function(x,y,w,h){var k=[x,y,w,h].join(','); window.__gl.scis[k]=(window.__gl.scis[k]|0)+1; return sc0(x,y,w,h);};
        ['enable','disable','texImage2D','texParameteri','texParameterf','texEnvf','texEnvi','drawElements','drawArrays','bindTexture','clear','blendFunc','depthFunc','shadeModel','alphaFunc','activeTexture','clientActiveTexture'].forEach(function(fn){
          if(typeof c[fn]!=='function')return; var orig=c[fn].bind(c);
          c[fn]=function(){ ge(); var r=orig.apply(null,arguments); var e=ge();
            if(fn==='drawElements'||fn==='drawArrays')window.__gl.draws++;
            if(fn==='clear')window.__gl.clears++;
            if(e){window.__gl.errs[e]=(window.__gl.errs[e]|0)+1;
              var a=Array.from(arguments);
              var k = fn==='texImage2D' ? ('texImage2D L'+a[1]+' ifmt='+a[2]+' fmt='+a[6]+' type='+a[7]+' pix='+(a[8]?(a[8].length||a[8].byteLength||'obj'):'null'))
                    : fn==='texParameterf' ? ('texParameterf pname='+a[1]+' val='+a[2])
                    : (fn+'#'+e+'#'+a.slice(0,2).map(String).join(','));
              if(fn==='texImage2D'&&!window.__gl.bindAtFail){ window.__gl.bindAtFail = 'tex2Dbinding='+String(c.getParameter(c.TEXTURE_BINDING_2D))+' activeTex='+c.getParameter(c.ACTIVE_TEXTURE); }
              if(Object.keys(window.__gl.badcalls).length<50) window.__gl.badcalls[k]=(window.__gl.badcalls[k]|0)+1;}
            return r;};
        });
        window.__gl.binds=0; window.__gl.bindsNull=0; window.__gl.creates=0;
        var ob=c.bindTexture.bind(c); c.bindTexture=function(t,tex){ window.__gl.binds++; if(!tex)window.__gl.bindsNull++; if(!window.__gl.firstBind)window.__gl.firstBind='target='+t+' tex='+String(tex); return ob(t,tex); };
        if(c.createTexture){var oc=c.createTexture.bind(c); c.createTexture=function(){window.__gl.creates++; return oc();};}
        window.__glc=c;
      } return c;};`});
  await send('Page.navigate',{url:URL_});
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true});return r&&r.result?r.result.value:undefined};
  for(let i=0;i<40;i++){await sleep(1000);const j=await ev('JSON.stringify(window.__logs||[])')||'[]';if(/CL_InitCGame/.test(j))break;}
  await sleep(12000);
  await ev(`(function(){var g=window.__glc;if(!g)return;var px=new Uint8Array(4);var pts=[[400,300],[100,100],[700,500],[200,450]];window.__gl.px=[];pts.forEach(function(p){g.readPixels(p[0],p[1],1,1,g.RGBA,g.UNSIGNED_BYTE,px);window.__gl.px.push(Array.from(px))});window.__gl.canvas=g.canvas.width+'x'+g.canvas.height;window.__gl.liveErr=g.getError();})()`);
  console.log('GL DIAG:', await ev('JSON.stringify({draws:window.__gl.draws,clears:window.__gl.clears,errs:window.__gl.errs,px:window.__gl.px,canvas:window.__gl.canvas})'));
  console.log('VIEWPORTS:', await ev('JSON.stringify(window.__gl.vps)'));
  console.log('SCISSORS:', await ev('JSON.stringify(window.__gl.scis)'));
  console.log('DRAWBUF:', await ev("(function(){var g=window.__glc; return g? g.drawingBufferWidth+'x'+g.drawingBufferHeight : 'noctx';})()"));
  console.log('BINDING AT FAIL:', await ev('window.__gl.bindAtFail'));
  console.log('BINDS:', await ev('JSON.stringify({binds:window.__gl.binds,bindsNull:window.__gl.bindsNull,creates:window.__gl.creates,firstBind:window.__gl.firstBind})'));
  console.log('SAMPLE BAD CALLS:', await ev('JSON.stringify(Object.keys(window.__gl.badcalls).slice(0,6))'));
  console.log('client state:', await ev("(typeof cls!=='undefined')?cls.state:(window.Module&&'no-cls-global')"));
  console.log('log tail:', JSON.parse(await ev('JSON.stringify(window.__logs.slice(-6))')||'[]').join(' | '));
  ws.close();
}catch(e){console.log('ERR',String(e))} finally{chrome.kill()}
