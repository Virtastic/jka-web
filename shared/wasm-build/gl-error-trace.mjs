// Boot a game headless and attribute every WebGL error to its exact call: wrap the
// suspect GL entry points, call getError() right after each, and on error record the
// arguments + a JS/wasm stack. Usage: node gl-error-trace.mjs <port> "<+args>" <label> [waitSec]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
const PORT = process.argv[2], ARGS = process.argv[3] || '', LABEL = process.argv[4] || PORT;
const WAIT = parseInt(process.argv[5] || '75', 10);
const CDP = 9700 + (parseInt(PORT,10) % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const udir = tmpProfile(`idt3-ge-${PORT}`); execFile('rm', ['-rf', udir]);
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1024,768',
  `--user-data-dir=${udir}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
let pg=null; for (let i=0;i<25 && !pg;i++){ await sleep(1000); try { pg=(await get('/json')).find(x=>x.type==='page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id=0;
const S = (m,p) => new Promise(r => { const i=++id, h=x=>{ const j=JSON.parse(x); if(j.id===i){ ws.off('message',h); r(j.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
await new Promise(r => ws.on('open', r));
await S('Runtime.enable', {}); await S('Page.enable', {});
// Inject the GL hook BEFORE any page script runs.
const hook = `
(function(){
  window.__glerr = [];
  var __GLERR_ALL = __GLERR_ALL_FLAG__;
  var GLE = { 0x500:'INVALID_ENUM',0x501:'INVALID_VALUE',0x502:'INVALID_OPERATION',0x506:'INVALID_FRAMEBUFFER_OPERATION' };
  function enumName(v){ return '0x'+(v>>>0).toString(16); }
  function rec(method, info){
    var key = method+':'+JSON.stringify(info);
    for (var i=0;i<window.__glerr.length;i++) if(window.__glerr[i].key===key){ window.__glerr[i].count++; return; }
    var st=''; try{ throw new Error(); }catch(e){ st=(e.stack||'').split('\\n').slice(2,9).join(' | '); }
    window.__glerr.push({key:key, method:method, info:info, err:GLE[info.err]||enumName(info.err), stack:st, count:1});
  }
  // GLERR_ALL=1 wraps EVERY function on the context, not just the hand-picked few. The
  // curated list is cheaper and keeps the common cases readable, but it cannot attribute an
  // error raised by a call nobody thought to list -- which is exactly the situation when
  // R_Init()'s own end-of-init glGetError() = 0x500 fires and the curated hooks report
  // "no WebGL errors captured".
  function wrapAll(proto){
    if(!proto) return;
    Object.getOwnPropertyNames(proto).forEach(function(m){
      if (m === 'getError' || m === 'constructor') return;
      var o; try { o = proto[m]; } catch(e) { return; }
      if (typeof o !== 'function') return;
      try {
        proto[m] = function(){
          var r = o.apply(this, arguments);
          var e = this.getError();
          if (e) {
            var a = [];
            for (var i=0;i<arguments.length;i++) {
              var v = arguments[i];
              a.push(typeof v === 'number' ? enumName(v) : (v && v.constructor ? v.constructor.name : String(v)));
            }
            rec(m, {args:a, err:e});
          }
          return r;
        };
      } catch(e) {}
    });
  }
  function wrap(proto){
    if(!proto) return;
    if (__GLERR_ALL) { wrapAll(proto); return; }
    // track current 2D texture binding so we can flag "no texture bound"
    var origBind = proto.bindTexture;
    proto.bindTexture = function(t, tex){ try{ this.__boundTex = this.__boundTex||{}; this.__boundTex[t]=tex; }catch(e){} return origBind.apply(this, arguments); };
    ['texParameteri','texParameterf'].forEach(function(m){
      var o = proto[m]; if(!o) return;
      proto[m] = function(target, pname, value){
        var r = o.apply(this, arguments);
        var e = this.getError();
        if(e) rec(m, {target:enumName(target), pname:enumName(pname), value:value, boundTexNull:!(this.__boundTex&&this.__boundTex[target]), err:e});
        return r;
      };
    });
    var orp = proto.readPixels;
    if(orp) proto.readPixels = function(x,y,w,h,format,type){
      var r = orp.apply(this, arguments);
      var e = this.getError();
      if(e) rec('readPixels', {format:enumName(format), type:enumName(type), err:e});
      return r;
    };
    var oti = proto.texImage2D;
    if(oti) proto.texImage2D = function(){
      var r = oti.apply(this, arguments);
      var e = this.getError();
      if(e) rec('texImage2D', {target:enumName(arguments[0]), internalformat:enumName(arguments[2]), err:e});
      return r;
    };
  }
  wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();`;
await S('Page.addScriptToEvaluateOnNewDocument', { source: hook.replace('__GLERR_ALL_FLAG__', process.env.GLERR_ALL ? 'true' : 'false') });
const url = 'http://localhost:'+PORT+'/index.html' + (ARGS ? '?args='+encodeURIComponent(ARGS) : '');
const logs = [];
ws.on('message', x => { const j = JSON.parse(x); if (j.method === 'Runtime.consoleAPICalled') logs.push((j.params.args||[]).map(a=>a.value!==undefined?a.value:'').join(' ')); });
await S('Page.navigate', { url });
for (let i=0;i<WAIT;i++){ await sleep(1000); if (logs.some(l => /CL_InitCGame|Com_TouchMemory|finished R_Init/i.test(l))) { if(i>10) break; } }
await sleep(4000);
const res = await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__glerr||[])', returnByValue: true });
console.log(`\n===== ${LABEL}: GL error attribution =====`);
const arr = JSON.parse(res.result.value || '[]');
if (!arr.length) console.log('(no WebGL errors captured on the hooked entry points' + (process.env.GLERR_ALL ? ' -- ALL entry points were hooked)' : '; try GLERR_ALL=1 to hook every one)'));
for (const e of arr) {
  console.log(`\n[${e.err}] ${e.method}(${JSON.stringify(e.info)})  x${e.count}`);
  console.log('  stack: ' + e.stack);
}
ws.close(); chrome.kill(); process.exit(0);
