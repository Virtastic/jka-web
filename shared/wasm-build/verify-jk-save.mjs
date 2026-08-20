// JK2/JKA savegame round-trip, including survival of a full page reload.
//
// Savegames are the highest-risk 1:1 area a port has: a big binary blob written through the
// engine's own FS, so struct packing, pointer size, endianness and async-filesystem bugs all
// land here at once. And in a browser there is a second failure mode desktop does not have --
// the file can be written correctly and then simply not persist, because IDBFS only reaches
// IndexedDB when something calls FS.syncfs.
//
// Proof, in two halves:
//   1. `save <name>` in a running map produces a file under the gamedir's saves/.
//   2. RELOAD the page, and the file is still there and `load <name>` reaches CA_ACTIVE again.
// Half 2 is the one that matters: without a working syncfs, half 1 passes and the player still
// loses every save the moment they close the tab.
//
//   node verify-jk-save.mjs <game> <httpPort> "<+args>" [secPerPhase]
import { CHROME, tmpProfile, guardChrome } from './chrome.mjs';
// idTech3-web: the profile directory name must be unique per run. It used to be a fixed
// 'idt3-save-<game>', and a single crashed or killed run leaves a SingletonLock behind that makes
// every later Chrome exit immediately -- the harness then dies on a null webSocketDebuggerUrl,
// which reads as an engine failure rather than a stale lock. Every other harness here already
// keys the directory by pid.
import { execFile } from 'node:child_process';
import http from 'node:http';

const GAME = process.argv[2], PORT = process.argv[3], ARGS = process.argv[4] || '';
const PHASE = parseInt(process.argv[5] || '90', 10);
if (!GAME || !PORT) { console.error('usage: verify-jk-save.mjs <game> <httpPort> "+args" [secPerPhase]'); process.exit(2); }

const SAVENAME = 'idt3probe';
const CDP = 9100 + (process.pid % 90);
const CA_ACTIVE = 7;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-save-' + GAME + '-' + process.pid)}`, 'about:blank']);
guardChrome(chrome, 'verify-jk-save.mjs');
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => {
  let d = ''; r.on('data', x => d += x); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r));
await S('Runtime.enable', {}); await S('Page.enable', {});

const evalv = async expr => { try { const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true }); return r && r.result ? r.result.value : undefined; } catch { return undefined; } };
const exec = async l => { await evalv(`(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(l)}]);return 1;}catch(e){return 0;}})()`); await sleep(600); };
const state = async () => { const v = await evalv(`(function(){try{return Module.ccall('idt3_client_state','number',[],[]);}catch(e){return -1;}})()`); return typeof v === 'number' ? v : -1; };
// Look in every plausible gamedir; which one is live depends on demo vs retail staging.
const listSaves = async () => await evalv(`(function(){
  var out = [];
  for (const d of ['/${GAME}/base/saves', '/${GAME}/demo/saves']) {
    try { for (const f of FS.readdir(d)) { if (f === '.' || f === '..') continue;
      var st = FS.stat(d + '/' + f); out.push(d + '/' + f + ':' + st.size); } } catch (e) {}
  }
  return out.join('|');
})()`);
const waitActive = async (secs) => {
  for (let i = 0; i < secs; i++) { await sleep(1000); if ((await state() & 0xff) === CA_ACTIVE) return true; }
  return false;
};

const boot = async () => {
  await S('Page.navigate', { url: `http://localhost:${PORT}/index.html?args=` + encodeURIComponent(ARGS) });
  const ok = await waitActive(PHASE);
  for (const t of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type: t, x: 640, y: 360, button: 'left', clickCount: 1, buttons: 1 });
  return ok;
};

console.log(`--- phase 1: boot ${GAME} and save ---`);
if (!await boot()) { console.log('FAIL: never reached CA_ACTIVE on first boot'); ws.close(); (globalThis.__idt3_done = true, chrome.kill()); process.exit(1); }
await sleep(4000);                       // let the map settle before snapshotting it
console.log('before save: ' + ((await listSaves()) || '(none)'));
// Wait for the frame to settle as well as CA_ACTIVE: SV_SaveGame_f refuses outright while an
// in-game cinematic is running (SG_GameAllowedToSaveHere -- "this prevents people saving via
// quick-save now during cinematics"), and CA_ACTIVE is true throughout those. Without this the
// probe reported a bare "save file written: NO" for a perfectly working save system.
const ringAll = async () => String(await evalv('String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : "")') || '').split('\n');
for (let i = 0; i < 40; i++) {
  const a = (await S('Page.captureScreenshot', { format: 'png' })).data;
  await sleep(1200);
  const b = (await S('Page.captureScreenshot', { format: 'png' })).data;
  if (a === b) break;                       // identical frames == no camera moving the view
}
// Retry the save across a window instead of firing once.
//
// A single attempt tests "was saving permitted at this exact instant", not "does saving work".
// Both refusal paths are reachable on a healthy engine and both used to be reported as a failed
// save system: SV_SaveGame_f prints "Can't savegame while dead!" if the player has been killed
// while the probe idled (kejim_post drops you into a firefight), and SG_GameAllowedToSaveHere
// refuses SILENTLY while an in-game cinematic is running -- valley produced no engine output at
// all, just no file. The settle-on-identical-frames heuristic above cannot separate "camera is
// holding a static shot" from "safe to save", so it does not catch either case.
// The window has to outlast the map intro, not just a pause in it: kejim_post holds the
// camera for ~97s and refuses (correctly, and silently) for that whole time. 24 x ~8s
// covers it with margin; valley needed 12.
let wrote = false, attempts = 0, lastSaid = [];
const SAVE_TRIES = parseInt(process.env.SAVE_TRIES || '24', 10);
for (; attempts < SAVE_TRIES && !wrote; attempts++) {
  const beforeLines = (await ringAll()).length;
  await exec(`save ${SAVENAME}`);
  await sleep(3000);
  // Whatever the engine said about it -- refusal reasons are printed in red.
  lastSaid = (await ringAll()).slice(beforeLines).filter(l => l.trim())
                .map(l => l.replace(/\^[0-9]/g, '').trim());
  wrote = ((await listSaves()) || '').includes(SAVENAME);
  if (!wrote && attempts < SAVE_TRIES - 1) await sleep(5000);
}
for (const l of lastSaid) console.log('   engine: ' + l);
const after = (await listSaves()) || '';
console.log('after  save: ' + (after || '(none)'));
console.log(`save file written: ${wrote ? 'YES' : 'NO'} (attempt ${attempts} of ${SAVE_TRIES})`);
if (!wrote && !lastSaid.length)
  console.log('   NOTE: refused with no message -- SG_GameAllowedToSaveHere gate (cinematic/in_camera)');

// Give the page's IDBFS sync a chance to run, then reload from scratch.
await evalv('(function(){try{FS.syncfs(false,function(){});return 1;}catch(e){return 0;}})()');
await sleep(3000);

console.log(`--- phase 2: reload the page, then load the save ---`);
if (!await boot()) { console.log('FAIL: never reached CA_ACTIVE on second boot'); ws.close(); (globalThis.__idt3_done = true, chrome.kill()); process.exit(1); }
const persisted = ((await listSaves()) || '');
console.log('after reload: ' + (persisted || '(none)'));
const survived = persisted.includes(SAVENAME);
console.log(`save survived reload: ${survived ? 'YES' : 'NO'}`);

let loaded = false;
if (survived) { await exec(`load ${SAVENAME}`); loaded = await waitActive(PHASE); }
console.log(`load reached gameplay: ${loaded ? 'YES' : 'NO'}`);

const pass = wrote && survived && loaded;
console.log(`\n===== ${GAME} savegame round-trip: ${pass ? 'PASS' : 'FAIL'} =====`);
ws.close(); (globalThis.__idt3_done = true, chrome.kill()); process.exit(pass ? 0 : 1);
