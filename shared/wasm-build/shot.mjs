// idTech3-web — boot a game headless, wait for the map to render, capture a screenshot
// (real rendered frame from ANGLE/swiftshader) for artifact inspection.
// Usage: node shot.mjs <port> "<+args>" <outfile.png> [waitSec] [extraSettleSec]
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const PORT = process.argv[2], ARGS = process.argv[3] || '', OUT = process.argv[4] || '/tmp/shot.png';
const WAIT = parseInt(process.argv[5] || '75', 10), SETTLE = parseInt(process.argv[6] || '6', 10);
const CDP = 9600 + (parseInt(PORT,10) % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const udir = `/tmp/idt3-shot-${PORT}`; execFile('rm', ['-rf', udir]);
const chrome = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1280,720',
  '--hide-scrollbars', `--user-data-dir=${udir}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
let pg=null; for (let i=0;i<25 && !pg;i++){ await sleep(1000); try { pg=(await get('/json')).find(x=>x.type==='page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id=0;
const S = (m,p) => new Promise(r => { const i=++id, h=x=>{ const j=JSON.parse(x); if(j.id===i){ ws.off('message',h); r(j.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const logs=[]; await new Promise(r=>ws.on('open',r));
await S('Runtime.enable', {}); await S('Page.enable', {});
ws.on('message', x => { const j=JSON.parse(x); if (j.method==='Runtime.consoleAPICalled') logs.push((j.params.args||[]).map(a=>a.value!==undefined?a.value:'').join(' ')); });
const url = 'http://localhost:'+PORT+'/index.html' + (ARGS ? '?args='+encodeURIComponent(ARGS) : '');
await S('Page.navigate', { url });
let loaded=false;
for (let i=0;i<WAIT;i++){ await sleep(1000);
  if (logs.some(l=>/CL_InitCGame|Com_TouchMemory/i.test(l))) { loaded=true; break; } }
// let it render past the loading screen / into the scene
await sleep(SETTLE*1000);
// nudge input to advance any intro camera / dismiss loading, then settle again
for (const t of ['mousePressed','mouseReleased']) await S('Input.dispatchMouseEvent',{type:t,x:640,y:360,button:'left',clickCount:1,buttons:1});
await sleep(SETTLE*1000);
const shot = await S('Page.captureScreenshot', { format:'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`${OUT} — map ${loaded?'LOADED':'NOT DETECTED'}, ${logs.length} log lines`);
ws.close(); chrome.kill(); process.exit(0);
