// Boot a game headless, load a map, and report the wasm heap size (and whether it grew past
// INITIAL_MEMORY, which forces an ArrayBuffer realloc+copy = a stall). Usage:
//   node heap-probe.mjs <port> "<+args>" <label> [waitSec]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
const PORT = process.argv[2], ARGS = process.argv[3] || '', LABEL = process.argv[4] || PORT;
const WAIT = parseInt(process.argv[5] || '80', 10);
const CDP = 9800 + (parseInt(PORT,10) % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const udir = tmpProfile(`idt3-heap-${PORT}`); execFile('rm', ['-rf', udir]);
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1024,768',
  `--user-data-dir=${udir}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
let pg=null; for (let i=0;i<25 && !pg;i++){ await sleep(1000); try { pg=(await get('/json')).find(x=>x.type==='page'); } catch {} }
// __idt3_attach_guard: bail out loudly instead of hanging.
// Measured: a run sat wedged for 33 minutes having printed nothing, because Chrome came up but
// the debug socket never opened - and the await below has no timeout. guardChrome() only
// catches Chrome EXITING, not Chrome hanging, so it could not help.
if (!pg) { console.log('FAIL: no debuggable page appeared'); try { (globalThis.__idt3_done = true, chrome.kill()); } catch {} process.exit(3); }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id=0;
const S = (m,p) => new Promise(r => { const i=++id, h=x=>{ const j=JSON.parse(x); if(j.id===i){ ws.off('message',h); r(j.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const logs=[]; await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error('CDP socket never opened')), 30000);
  ws.on('open', () => { clearTimeout(to); res(); });
  ws.on('error', (e) => { clearTimeout(to); rej(e); });
}).catch((e) => { console.log('FAIL: ' + e.message);
  try { (globalThis.__idt3_done = true, chrome.kill()); } catch {} process.exit(3); });
await S('Runtime.enable', {}); await S('Page.enable', {});
ws.on('message', x => { const j=JSON.parse(x); if (j.method==='Runtime.consoleAPICalled') logs.push((j.params.args||[]).map(a=>a.value!==undefined?a.value:'').join(' ')); });
const heap = async () => {
  const r = await S('Runtime.evaluate', { returnByValue:true, expression:
    `(function(){ try { var b = (typeof wasmMemory!=='undefined'&&wasmMemory.buffer)||(Module.HEAPU8&&Module.HEAPU8.buffer); return b?b.byteLength:-1; } catch(e){ return -2; } })()` });
  return r.result && r.result.value;
};
const url = 'http://localhost:'+PORT+'/index.html' + (ARGS ? '?args='+encodeURIComponent(ARGS) : '');
await S('Page.navigate', { url });
let loaded=false, peak=0;
for (let i=0;i<WAIT;i++){ await sleep(1000);
  const h = await heap(); if (h>peak) peak=h;
  if (logs.some(l=>/CL_InitCGame|Com_TouchMemory|finished R_Init/i.test(l))) { loaded=true; if (i>12) break; } }
await sleep(4000); { const h = await heap(); if (h>peak) peak=h; }
const MB = 1048576;
console.log(`${LABEL}: peak wasm heap = ${(peak/MB).toFixed(1)} MB  (INITIAL_MEMORY=256 MB → ${peak>256*MB?'GREW (+realloc stall)':'no growth'}), map ${loaded?'LOADED':'?'}`);
ws.close(); chrome.kill(); process.exit(0);
