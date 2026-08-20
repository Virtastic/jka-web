// Verify the damage / death / respawn path — the one gameplay system no other probe touches.
//
// map-sweep proves maps load, verify-jk-move proves the player translates, verify-jk-save proves
// a savegame round-trips. None of them ever applies damage, so "does the player die and come
// back" — the whole G_Damage -> player_die -> respawn/reload chain, plus the death sequence in
// cgame — has never been exercised in a browser at all.
//
// Everything here is read from the engine, not from pixels: cls.state via idt3_client_state, and
// position via `viewpos` (cg_consolecmds.cpp), which prints "<map> (x y z) : yaw" out of
// cg.refdef.vieworg. `kill` is the game module's own client command (g_cmds.cpp).
//
//   node verify-combat.mjs <httpPort> <map>
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2] || '8794';
const MAP  = process.argv[3] || 't1_sour';
const CDP  = 9070 + (process.pid % 20);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-cbt-' + process.pid)}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => {
  let d = ''; r.on('data', x => d += x); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));
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
  try { (globalThis.__idt3_done = true, chrome.kill()); } catch {} process.exit(3); });
await S('Runtime.enable', {}); await S('Page.enable', {});

// Draw-call counter: the only reliable way to know the world is actually on screen, since
// CA_ACTIVE is reached long before that on maps with an opening sequence (JKA yavin1 draws 2
// frames-worth of quad for ninety seconds first).
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__raf = 0; window.__draws = 0;
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb){ return _raf(function(t){ window.__raf++; return cb(t); }); };
  const _gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs){
    const ctx = _gc.call(this, type, attrs);
    try {
      if (ctx && !ctx.__counted && /webgl/i.test(type)) {
        ctx.__counted = true;
        for (const fn of ['drawElements','drawArrays']) {
          const o = ctx[fn].bind(ctx);
          ctx[fn] = function(){ window.__draws++; return o.apply(ctx, arguments); };
        }
      }
    } catch (e) {}
    return ctx;
  };
`});
await S('Page.navigate', { url: `http://localhost:${PORT}/index.html?args=${encodeURIComponent('+set sv_pure 0 +devmap ' + MAP)}` });

const evalv = async e => { try { const r = await S('Runtime.evaluate', { expression: e, returnByValue: true }); return r && r.result ? r.result.value : undefined; } catch { return undefined; } };
const state = async () => { const v = await evalv(`(function(){try{return Module.ccall('idt3_client_state','number',[],[]);}catch(e){return -1;}})()`); return typeof v === 'number' ? v : -1; };
const exec = c => evalv(`(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(c)}]);return 1;}catch(e){return 0;}})()`);
const ring = async () => String(await evalv('String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : "")') || '').split('\n');
const drawRate = async () => {
  const a = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  await sleep(2000);
  const b = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  const A = JSON.parse(a || '{}'), B = JSON.parse(b || '{}');
  const f = (B.r || 0) - (A.r || 0);
  return f > 0 ? ((B.d || 0) - (A.d || 0)) / f : 0;
};
const posOf = async () => {
  await exec('viewpos');
  await sleep(700);
  const hits = (await ring()).filter(l => /\(-?\d+ -?\d+ -?\d+\) : -?\d+/.test(l));
  if (!hits.length) return null;
  const m = hits[hits.length - 1].match(/\((-?\d+) (-?\d+) (-?\d+)\)/);
  return m ? [ +m[1], +m[2], +m[3] ] : null;
};

const CA_ACTIVE = 7;
const rawState = async () => { const v = await evalv(`(function(){try{return Module.ccall('idt3_client_state','number',[],[]);}catch(e){return -1;}})()`); return typeof v === 'number' ? v : -1; };
const catcher = async () => (await rawState()) >> 8;
for (let i = 0; i < 180; i++) { await sleep(1000); if ((await state() & 0xff) === CA_ACTIVE) break; }
if ((await state() & 0xff) !== CA_ACTIVE) { console.log('FAIL: never reached gameplay'); ws.close(); chrome.kill(); process.exit(1); }
for (const t of ['mousePressed', 'mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: 640, y: 360, button: 'left', clickCount: 1, buttons: 1 });

let rate = 0, prev = -1, stable = 0;
for (let i = 0; i < 90; i++) {
  rate = await drawRate();
  if (rate > 20 && prev > 20 && Math.abs(rate - prev) <= 0.2 * Math.max(rate, prev)) { if (++stable >= 2) break; }
  else stable = 0;
  prev = rate;
}
console.log(`world on screen: ${rate.toFixed(0)} draws/frame`);

// Precondition: do client commands reach the game module at all? Cmd_God_f replies through
// gi.SendServerCommand with "godmode ON"/"godmode OFF", so it is a direct, visible test of the
// whole console -> CL_ForwardCommandToServer -> ClientCommand path. Without this, a silent `kill`
// is ambiguous: broken death, or a command that never arrived. Toggled twice so it ends OFF --
// and Cmd_Kill_f clears FL_GODMODE itself anyway.
await exec('echo ###IDT3GOD');
await exec('god');
await sleep(2000);
const godLog = (await ring());
let gcut = -1;
for (let i = godLog.length - 1; i >= 0; i--) if (godLog[i].includes('###IDT3GOD')) { gcut = i; break; }
const godReply = (gcut >= 0 ? godLog.slice(gcut) : godLog).filter(l => /godmode/i.test(l));
console.log(`cheat channel        : ${godReply.length ? godReply[godReply.length-1].trim() : 'NO REPLY'}`);
await exec('god');
await sleep(1000);
if (!godReply.length) {
  console.log('FAIL: client commands are not reaching the game module (no reply to `god`),');
  console.log('      so nothing about the death path can be concluded from `kill`');
  ws.close(); chrome.kill(); process.exit(1);
}

await exec('give all');
await sleep(2000);
const before = await posOf();
const stBefore = await state() & 0xff;
const kcBefore = await catcher();
console.log(`before kill: state=${stBefore} keyCatchers=${kcBefore} pos=${before ? before.join(' ') : '(none)'}`);

// The view must be STILL before "the position changed" can mean anything. Measured on JKA
// t1_sour: with no input at all, viewpos moved **2950 units in ten seconds** -- the map's opening
// scripted camera was still flying, well after the draw rate had plateaued at 183 draws/frame.
// Any death test run in that window reads the camera, not a respawn. A settled draw rate says the
// world is being drawn; it does not say the player is in charge of the view.
let idle = null, idleDrift = 0, settled = false;
for (let round = 0; round < 24; round++) {
  const a = await posOf();
  await sleep(5000);
  const b = await posOf();
  if (!a || !b) continue;
  idleDrift = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
  idle = b;
  if (idleDrift < 32) { settled = true; break; }
}
console.log(`view settled          : ${settled} (idle drift ${idleDrift.toFixed(1)} units / 5s)`);
if (!settled) {
  console.log(`FAIL: the view never stopped moving on its own on ${MAP} — a scripted camera is still`);
  console.log('      running, so nothing here could be attributed to the death path');
  ws.close(); chrome.kill(); process.exit(1);
}

await exec('echo ###IDT3KILL');
await exec('kill');

// Watch what the engine does for the next 45s: the state machine and the position are the
// evidence. A death that reloads a save passes through a non-ACTIVE state; a death that respawns
// in place keeps CA_ACTIVE but moves the player back to a spawn point.
const seen = new Set(), kcSeen = new Set();
let leftActive = false, movedBack = false, after = null;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  const st = await state() & 0xff;
  seen.add(st);
  kcSeen.add(await catcher());
  if (st !== CA_ACTIVE) leftActive = true;
  if (st === CA_ACTIVE && i > 8) {
    after = await posOf();
    const base = idle || before;
    if (base && after) {
      const d = Math.hypot(after[0]-base[0], after[1]-base[1], after[2]-base[2]);
      // Must dwarf the measured idle drift, not merely clear a fixed number.
      if (d > Math.max(64, idleDrift * 5)) movedBack = true;
    }
  }
}
const log = await ring();
let cut = -1;
for (let i = log.length - 1; i >= 0; i--) if (log[i].includes('###IDT3KILL')) { cut = i; break; }
const mine = cut >= 0 ? log.slice(cut) : log;
const errs = mine.filter(l => /ERROR|ERR_DROP|ERR_FATAL|Hunk_Alloc failed|RE_/i.test(l));

console.log(`states seen after kill : ${[...seen].sort().join(',')}`);
console.log(`keyCatchers seen       : ${[...kcSeen].sort().join(',')}  (was ${kcBefore})`);
console.log(`left CA_ACTIVE         : ${leftActive}`);
console.log(`position changed       : ${movedBack}`);
console.log(`final state            : ${await state() & 0xff}`);
console.log(`final pos              : ${after ? after.join(' ') : '(none)'}`);
const notable = mine.filter(l => l.trim() && !/\(-?\d+ -?\d+ -?\d+\) : -?\d+/.test(l)).slice(1, 12);
if (notable.length) { console.log('engine log after kill:'); for (const l of notable) console.log('   ' + l.trim()); }
if (errs.length) { console.log('errors after kill:'); for (const l of errs.slice(0, 10)) console.log('   ' + l.trim()); }

const finalSt = await state() & 0xff;
const recovered = finalSt === CA_ACTIVE;
// Death is observable in three different ways depending on what the game does with it, and the
// games differ: JKA relocates the player (save reload / respawn point), while a game that leaves
// the corpse in place and raises a UI shows up only as a key-catcher change. Any one of them is
// proof the command took effect.
const kcChanged = [...kcSeen].some(k => k !== kcBefore);
const died = leftActive || movedBack || kcChanged;
const ok = recovered && died && !errs.length;
console.log(ok ? `\nPASS: death handled and the client recovered to gameplay (${MAP})`
               : `\nFAIL: ${[!died && 'nothing observable happened on kill',
                            !recovered && 'client did not return to gameplay',
                            errs.length && 'errors logged'].filter(Boolean).join(', ')}`);
ws.close(); chrome.kill(); process.exit(ok ? 0 : 1);
