// Headless: load a map in 3rd-person so the player's own MDS skeletal body renders
// in front of the camera — the direct test of the MDS character-render fixes.
// Usage: node _thirdperson.mjs <port> <map> <prefix>
import { execFile } from 'node:child_process';
import { CHROME, tmpProfile } from './chrome.mjs';
import http from 'node:http';
import fs from 'node:fs';
// idTech3-web: this harness was macOS-only and had never run on Windows -- it hardcoded the
// /Applications Chrome path and /tmp for both the screenshot prefix and the profile dir, and
// shelled out to `rm -rf`. It now resolves Chrome and the temp dir the same way every other
// harness here does (chrome.mjs), so a failure means the engine, not the platform.
const PORT = process.argv[2] || '8790', MAP = process.argv[3] || 'escape1',
      PREFIX = process.argv[4] || tmpProfile('idt3-tp');
const CDP = 9600 + (parseInt(PORT,10) % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Key the profile by pid as well as port: a fixed name keeps a SingletonLock from any crashed
// run and then every later Chrome exits instantly, which reads as an engine failure.
const udir = tmpProfile(`idt3-tp-${PORT}-${process.pid}`);
fs.rmSync(udir, { recursive: true, force: true });
const chrome = execFile(CHROME, [
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
// devmap skips the SP briefing; force 3rd person so the player's MDS body is in view.
const args = '+set sv_cheats 1 +set cg_thirdperson 1 +set cg_thirdpersonrange 80 +set com_introplayed 1 +devmap '+MAP;
const url = 'http://localhost:'+PORT+'/index.html?args='+encodeURIComponent(args);
await S('Page.navigate', { url });
let loaded=false;
for (let i=0;i<95;i++){ await sleep(1000); if (logs.some(l=>/CL_InitCGame/i.test(l))) { loaded=true; break; } }
console.log('map', MAP, loaded?'LOADED':'NOT-DETECTED');
const shot = async (name)=>{ const s=await S('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(PREFIX+'-'+name+'.png', Buffer.from(s.data,'base64')); console.log('shot', name, fs.statSync(PREFIX+'-'+name+'.png').size); };
// optional argv[5]: seconds to settle before the first capture (e.g. wait out an
// intro cinematic like JK2's ~40s crate scene). Default 3s.
const SETTLE = parseInt(process.argv[5] || '3', 10) * 1000;
await sleep(SETTLE);
for (const t of ['mousePressed','mouseReleased']) await S('Input.dispatchMouseEvent',{type:t,x:640,y:360,button:'left',clickCount:1,buttons:1});
await sleep(2500); await shot('a');
await sleep(3500); await shot('b');
await sleep(3500); await shot('c');
console.log('recent logs:', logs.slice(-5).join(' | '));
ws.close(); chrome.kill(); process.exit(0);
