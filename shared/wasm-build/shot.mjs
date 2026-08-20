// idTech3-web — boot a game headless, wait for the map to render, capture a screenshot
// (real rendered frame from ANGLE/swiftshader) for artifact inspection.
// Usage: node shot.mjs <port> "<+args>" <outfile.png> [waitSec] [extraSettleSec]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const PORT = process.argv[2], ARGS = process.argv[3] || '', OUT = process.argv[4] || tmpProfile('shot.png');
const WAIT = parseInt(process.argv[5] || '75', 10), SETTLE = parseInt(process.argv[6] || '6', 10);
// Debug port and profile dir must be unique PER RUN, not per HTTP port. Deriving both from
// PORT meant a second run of the same game reused them, so if a previous Chrome had not
// fully exited it still held the port — the new run then attached to that stale browser and
// hung instead of driving its own. `rm -rf udir` could not help: the live process owns it.
const RUNID = process.pid;
const CDP = 9600 + (parseInt(PORT,10) % 100) + (RUNID % 60) * 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const udir = tmpProfile(`idt3-shot-${PORT}-${RUNID}`);
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1280,720',
  '--hide-scrollbars', `--user-data-dir=${udir}`, 'about:blank']);
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
const url = 'http://localhost:'+PORT+'/index.html' + (ARGS ? '?args='+encodeURIComponent(ARGS) : '');
await S('Page.navigate', { url });
// Engine output goes to the page's private ring (window.__idt3_dumpLog), NOT console.*,
// so Runtime.consoleAPICalled alone stays empty and this loop always burned its full
// WAIT before falling through with "map NOT DETECTED". Poll the ring as well.
const ENGLOG = 'String(window.__idt3_dumpLog?window.__idt3_dumpLog():"")';
const engineLog = async () => {
  try { return (await S('Runtime.evaluate', { expression: ENGLOG, returnByValue: true })).result.value || ''; }
  catch { return ''; }
};
let loaded=false, engText='';
for (let i=0;i<WAIT;i++){ await sleep(1000);
  engText = await engineLog();
  if (logs.concat(engText.split('\n')).some(l=>/CL_InitCGame|Com_TouchMemory|loaded \d+ faces/i.test(l))) { loaded=true; break; } }
// let it render past the loading screen / into the scene
await sleep(SETTLE*1000);
// nudge input to advance any intro camera / dismiss loading, then settle again
for (const t of ['mousePressed','mouseReleased']) await S('Input.dispatchMouseEvent',{type:t,x:640,y:360,button:'left',clickCount:1,buttons:1});
await sleep(SETTLE*1000);
const shot = await S('Page.captureScreenshot', { format:'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
const engLines = (await engineLog()).split('\n').filter(Boolean).length;
console.log(`${OUT} — map ${loaded?'LOADED':'NOT DETECTED'}, ${logs.length} console + ${engLines} engine log lines`);
ws.close(); chrome.kill(); process.exit(0);
