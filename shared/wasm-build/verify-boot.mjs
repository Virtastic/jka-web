// Generic data-free boot test: how far does <game> get with an empty install?
//
//   node shared/wasm-build/verify-boot.mjs <game> <port>
//
// Retail-data games (rtcwmp, jk2, jka) cannot be gameplay-tested here. What this
// DOES prove without any data is everything up to the data wall: the engine
// links, the wasm instantiates, Com_Init/FS_Startup run, and the failure that
// follows is the engine's own "missing install" path rather than a port bug.
// Any abort, trap, or PAGEERR *before* that wall is a real defect.
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const GAME = process.argv[2], PORT_HTTP = process.argv[3];
if (!GAME || !PORT_HTTP) { console.error('usage: verify-boot.mjs <game> <httpPort>'); process.exit(2); }
const CDP = 9300 + (parseInt(PORT_HTTP, 10) % 100);
const c = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  `--user-data-dir=${tmpProfile(`idt3-${GAME}-boot`)}`, 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
// __idt3_attach_guard: bail out loudly instead of hanging.
// Measured: a run sat wedged for 33 minutes having printed nothing, because Chrome came up but
// the debug socket never opened - and the await below has no timeout. guardChrome() only
// catches Chrome EXITING, not Chrome hanging, so it could not help.
if (!pg) { console.log('FAIL: no debuggable page appeared'); try { (globalThis.__idt3_done = true, chrome.kill()); } catch {} process.exit(3); }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error('CDP socket never opened')), 30000);
  ws.on('open', () => { clearTimeout(to); res(); });
  ws.on('error', (e) => { clearTimeout(to); rej(e); });
}).catch((e) => { console.log('FAIL: ' + e.message);
  try { (globalThis.__idt3_done = true, chrome.kill()); } catch {} process.exit(3); }); await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.addScriptToEvaluateOnNewDocument', { source: "window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));window.addEventListener('error',e=>window.__l.push('PAGEERR: '+e.message+' | STACK: '+((e.error&&e.error.stack)||'(none)')))" });
await S('Page.navigate', { url: `http://localhost:${PORT_HTTP}/index.html` });

const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
for (let i = 0; i < 35; i++) {
  await sleep(2000);
  const l = await logs();
  if (/Sys_Error|FS_Startup|Com_Init|PAGEERR|abort/i.test(l.join('\n'))) break;
  if (i % 5 === 0) console.log('t+' + i * 2 + 's: ' + l.slice(-2).join(' | ').slice(0, 140));
}
const all = await logs();
fs.writeFileSync(tmpProfile(`${GAME}-boot.log`), all.join('\n'));
const sh = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(tmpProfile(`${GAME}-boot.png`), Buffer.from(sh.data, 'base64'));
const pick = re => all.filter(x => re.test(x));

// The expected, CORRECT data wall: FS finds no paks and the engine bails out.
const reachedFS = pick(/FS_Startup|files in pk3/i).length > 0;
const dataWall = pick(/missing essential files|Couldn't load default\.cfg|no pak files|0 files in pk3/i).length > 0;
// Anything that is NOT the data wall: wasm traps, JS exceptions, unreachable, etc.
// NB: match WebAssembly only in an error context — the engine prints a perfectly
// benign "CPU: WebAssembly" banner line, which a bare /WebAssembly/ flagged as a bug.
const realBugs = pick(/PAGEERR|RuntimeError|unreachable|Aborted|abort\(|table index|null function|LinkError|WebAssembly\.(instantiate|compile)|WebAssembly (Error|Exception)/i);

console.log(`\n===== ${GAME} =====`);
console.log('lines captured : ' + all.length);
console.log('reached FS     : ' + reachedFS);
console.log('hit data wall  : ' + dataWall);
console.log('--- first lines ---\n' + all.slice(0, 6).join('\n'));
console.log('--- fs ---\n' + pick(/FS_Startup|pk3|fs_|Couldn/i).slice(0, 6).join('\n'));
console.log('--- NON-data-wall problems ---\n' + (realBugs.length ? realBugs.slice(0, 8).join('\n') : '(none)'));
console.log(`VERDICT: ${realBugs.length ? 'REAL BUG before/at the wall' : dataWall ? 'clean boot, stopped at the data wall (correct)' : reachedFS ? 'reached FS, no wall yet' : 'DID NOT REACH FS -- investigate'}`);
console.log(`SHOT: /tmp/${GAME}-boot.png  LOG: /tmp/${GAME}-boot.log`);
ws.close(); c.kill(); process.exit(0);
