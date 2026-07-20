// idTech3-web — profile WebGL call volume per frame. Hooks the WebGL context before the
// engine grabs it and tallies method calls, then samples over a window and divides by the
// frame count (drawArrays+drawElements pairs bracket frames via the RAF the engine drives).
// Usage: node gl-profile.mjs <port> "<+args>" <label> [loadWaitSec] [sampleSec]
import { execFile } from 'node:child_process';
import http from 'node:http';
const PORT = process.argv[2], ARGS = process.argv[3] || '', LABEL = process.argv[4] || PORT;
const WAIT = parseInt(process.argv[5] || '70', 10), SAMPLE = parseInt(process.argv[6] || '6', 10);
const CDP = 9700 + (parseInt(PORT,10) % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const udir = `/tmp/idt3-glp-${PORT}`; execFile('rm', ['-rf', udir]);
const chrome = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1280,720',
  `--user-data-dir=${udir}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
let pg=null; for (let i=0;i<25 && !pg;i++){ await sleep(1000); try { pg=(await get('/json')).find(x=>x.type==='page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id=0;
const S = (m,p) => new Promise(r => { const i=++id, h=x=>{ const j=JSON.parse(x); if(j.id===i){ ws.off('message',h); r(j.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const logs=[]; await new Promise(r=>ws.on('open',r));
await S('Runtime.enable', {}); await S('Page.enable', {});
ws.on('message', x => { const j=JSON.parse(x); if (j.method==='Runtime.consoleAPICalled') logs.push((j.params.args||[]).map(a=>a.value!==undefined?a.value:'').join(' ')); });
// Hook every WebGL method + the RAF frame counter, BEFORE the engine creates its context.
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  (function(){
    window.__glp = { counts:{}, calls:0, verts:0 };
    function wrap(proto){
      for (const k of Object.getOwnPropertyNames(proto)) {
        let fn; try { fn = proto[k]; } catch(e){ continue; }
        if (typeof fn !== 'function') continue;
        proto[k] = function(){
          var g=window.__glp; g.counts[k]=(g.counts[k]||0)+1; g.calls++;
          if (k==='drawElements') g.verts += arguments[1]||0;
          else if (k==='drawArrays') g.verts += arguments[2]||0;
          return fn.apply(this, arguments);
        };
      }
    }
    if (window.WebGLRenderingContext) wrap(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) wrap(WebGL2RenderingContext.prototype);
    // frame counter via RAF
    window.__glp.frames = 0;
    var _raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function(cb){ return _raf(function(t){ window.__glp.frames++; return cb(t); }); };
  })();
`});
const url = 'http://localhost:'+PORT+'/index.html' + (ARGS ? '?args='+encodeURIComponent(ARGS) : '');
await S('Page.navigate', { url });
for (let i=0;i<WAIT;i++){ await sleep(1000); if (logs.some(l=>/CL_InitCGame|Com_TouchMemory/i.test(l))) break; }
await sleep(4000); // settle into the scene
// snapshot, sample window, snapshot
const snap = async () => JSON.parse((await S('Runtime.evaluate',{returnByValue:true,expression:'JSON.stringify(window.__glp)'})).result.value||'{}');
const a = await snap(); await sleep(SAMPLE*1000); const b = await snap();
const df = Math.max(1, b.frames - a.frames);
const perFrame = {};
for (const k of Object.keys(b.counts)) { const d=(b.counts[k]||0)-(a.counts[k]||0); if (d>0) perFrame[k]=+(d/df).toFixed(1); }
const top = Object.entries(perFrame).sort((x,y)=>y[1]-x[1]);
console.log(`\n===== ${LABEL} — GL calls/frame (${df} frames over ${SAMPLE}s = ${(df/SAMPLE).toFixed(1)} fps) =====`);
console.log(`total GL calls/frame: ${((b.calls-a.calls)/df).toFixed(0)}   verts/frame: ${((b.verts-a.verts)/df).toFixed(0)}`);
for (const [k,v] of top.slice(0,18)) console.log(`  ${k.padEnd(28)} ${v}`);
ws.close(); chrome.kill(); process.exit(0);
