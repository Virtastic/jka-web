// Verify the menu / UI layer — the first thing a player ever sees, and the last subsystem with
// no coverage at all.
//
// Nothing else in the suite touches it: every other probe boots straight into a map with
// +devmap and treats the menu as something to get past. So "does the main menu come up, does ESC
// open the in-game menu, does ESC close it again" was simply never asked.
//
// All of it is read from the engine. idt3_client_state returns cls.state | (cls.keyCatchers << 8),
// and KEYCATCH_UI is bit 1 (q_shared.h:1436) — so the key-catcher says authoritatively whether the
// UI owns input, with no guessing from pixels. `uimenu` (CL_GenericMenu_f, cl_ui.cpp:320) drives
// UI_SetActiveMenu("ingame", ...) which sets cl_paused and takes the catcher; ESC is the player's
// own route to the same place.
//
//   node verify-menu.mjs <httpPort> <map>
import { CHROME, tmpProfile, guardChrome } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2] || '8794';
const MAP  = process.argv[3] || 't1_sour';
const CDP  = 9040 + (process.pid % 25);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-menu-' + process.pid)}`, 'about:blank']);
guardChrome(chrome, 'verify-menu.mjs');
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
// Capture uncaught page exceptions and console errors. A wasm trap in the game module surfaces
// here, NOT through Module.printErr -- and the failing same-map reload ends its engine output
// mid-script with no abort text, which is exactly what an uncaught trap looks like from inside.
const pageErrors = [];
ws.on('message', x => {
  try {
    const j = JSON.parse(x);
    if (j.method === 'Runtime.exceptionThrown') {
      const d = j.params && j.params.exceptionDetails;
      pageErrors.push('EXCEPTION: ' + ((d && (d.exception && (d.exception.description || d.exception.value))) || (d && d.text) || 'unknown'));
    } else if (j.method === 'Runtime.consoleAPICalled' && j.params && j.params.type === 'error') {
      pageErrors.push('CONSOLE.ERROR: ' + (j.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || '')).join(' '));
    }
  } catch (e) {}
});
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
// Boot with NO map: this is the real launch path a player takes, straight to the main menu.
const DIRECT = !!process.env.DIRECT_MAP;
// Uncapped log capture -- index.html's ring caps at 2000 lines and shifts, which hid the cause of
// the transition defect twice. Keep every line so the second load's script trace survives.
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__allLog = [];
  (function hook(){
    try {
      if (typeof Module === 'object' && Module && !Module.__idt3Hooked) {
        for (const k of ['print','printErr']) {
          const orig = Module[k];
          if (typeof orig === 'function') Module[k] = function(t){ try { window.__allLog.push(String(t)); } catch(e){} return orig.apply(this, arguments); };
        }
        Module.__idt3Hooked = true; return;
      }
    } catch (e) {}
    setTimeout(hook, 10);
  })();
`});
await S('Page.navigate', { url: `http://localhost:${PORT}/index.html?args=${encodeURIComponent('+set sv_pure 0' + (process.env.EXTRA_ARGS ? ' ' + process.env.EXTRA_ARGS : '') + (DIRECT ? ' +devmap ' + MAP : ''))}` });

const evalv = async e => { try { const r = await S('Runtime.evaluate', { expression: e, returnByValue: true }); return r && r.result ? r.result.value : undefined; } catch { return undefined; } };
const raw = async () => { const v = await evalv(`(function(){try{return Module.ccall('idt3_client_state','number',[],[]);}catch(e){return -1;}})()`); return typeof v === 'number' ? v : -1; };
const st  = async () => (await raw()) & 0xff;
const kc  = async () => (await raw()) >> 8;
const exec = c => evalv(`(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(c)}]);return 1;}catch(e){return 0;}})()`);
const esc = async () => { for (const type of ['keyDown', 'keyUp'])
  await S('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: 'Escape', code: 'Escape' }); };
const sig = async () => {
  const r = await S('Page.captureScreenshot', { format: 'png' });
  if (!r || !r.data) return null;
  const res = await S('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `
    new Promise(function(resolve){
      var im = new Image();
      im.onload = function(){
        var t = document.createElement('canvas'); t.width = 32; t.height = 32;
        var g = t.getContext('2d', { willReadFrequently: true });
        g.drawImage(im, 0, 0, 32, 32);
        var d = g.getImageData(0,0,32,32).data, a = [];
        for (var i = 0; i < d.length; i += 4) a.push(Math.round(d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114));
        resolve(a);
      };
      im.onerror = function(){ resolve(null); };
      im.src = 'data:image/png;base64,${r.data}';
    })` });
  return res && res.result ? res.result.value : null;
};
const diffPct = (a, b) => {
  if (!a || !b) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 6) n++;
  return 100 * n / a.length;
};
const meanOf = a => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const KEYCATCH_UI = 2;
let ok = true;
const fail = m => { ok = false; console.log('   FAIL: ' + m); };

// --- 1. the main menu at boot -------------------------------------------
// NB the -1 trap: idt3_client_state returns -1 while the module is still coming up, and
// (-1 & KEYCATCH_UI) is non-zero, so the naive check broke out immediately and reported
// "keyCatchers=-1 state=8" as a main menu. Require a valid reading first. state 8 is
// CA_CINEMATIC: both games boot into video/openinglogos before the menu, so this also has to
// wait that out rather than sample during it.
let bootKc = -1, bootSt = -1;
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const r = await raw();
  if (r < 0) continue;
  bootKc = r >> 8; bootSt = r & 0xff;
  if ((bootKc & KEYCATCH_UI) && bootSt !== 8) break;
}
// A user gesture is needed before audio, and a real player clicks the page anyway.
for (const t of ['mousePressed', 'mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: 640, y: 360, button: 'left', clickCount: 1, buttons: 1 });
await sleep(4000);
const menuSig = await sig();
console.log(`\n===== ${MAP}: menu / UI =====`);
console.log(`main menu at boot    : keyCatchers=${bootKc} state=${bootSt} luma=${meanOf(menuSig).toFixed(1)}`);
if (!DIRECT) {
  if (bootKc < 0 || !(bootKc & KEYCATCH_UI)) fail('the main menu never took the key catcher — no UI is up at boot');
  if (bootSt === 8) fail('still in the opening cinematic — never reached the main menu');
  if (meanOf(menuSig) < 3) fail('the main menu frame is black');
}

// --- 2. into gameplay ----------------------------------------------------
if (!DIRECT) await exec(`devmap ${MAP}`);
const CA_ACTIVE = 7;
for (let i = 0; i < 180; i++) { await sleep(1000); if ((await st()) === CA_ACTIVE) break; }
if ((await st()) !== CA_ACTIVE) { console.log('FAIL: devmap from the menu never reached gameplay'); ws.close(); (globalThis.__idt3_done = true, chrome.kill()); process.exit(1); }
// Wait for the world to actually be drawn: CA_ACTIVE happens long before that on maps with an
// opening sequence (JKA yavin1 draws one quad per frame for ninety seconds first).
const drawRate = async () => {
  const a = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  await sleep(2000);
  const b = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  const A = JSON.parse(a || '{}'), B = JSON.parse(b || '{}');
  const f = (B.r || 0) - (A.r || 0);
  return f > 0 ? ((B.d || 0) - (A.d || 0)) / f : 0;
};
let rate = 0, prev = -1, stable = 0;
for (let i = 0; i < 90; i++) {
  rate = await drawRate();
  if (rate > 20 && prev > 20 && Math.abs(rate - prev) <= 0.2 * Math.max(rate, prev)) { if (++stable >= 2) break; }
  else stable = 0;
  prev = rate;
}
// The in-game menu is REFUSED while a scripted camera is running, and that is shipped behaviour,
// not a defect: UI_SetActiveMenu (ui_atoms.cpp) opens with
//     if (cls.state != CA_DISCONNECTED && !ui.SG_GameAllowedToSaveHere(qtrue)) return;
// whose argument means "only check incamera". Retail refuses ESC during a cutscene the same way.
// Both ESC and the `uimenu` console command funnel through that function, which is why they
// failed together on t1_sour while F1 bindings still fired -- input was fine, the menu was
// legitimately declining to open.
//
// So wait for the camera to hand control back, using the same measure as verify-combat: viewpos
// standing still. On t1_sour the view drifts ~2950 units per 10s while the opening camera flies.
const ring = async () => String(await evalv("String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : '')") || '').split('\n');

// Which map is the engine actually on? `viewpos` prints the bsp name - the same line
// verify-transition.mjs reads. Needed because some maps do not stay put: yavin1 auto-advances
// to yavin1b partway through, and several checks below are only meaningful while the level the
// test started on is still loaded.
const mapOf = async () => {
  await exec('viewpos');
  await sleep(900);
  const hits = (await ring()).filter(l => /maps\/.*\.bsp .*\(/.test(l));
  if (!hits.length) return null;
  const m = hits[hits.length - 1].match(/maps\/([A-Za-z0-9_]+)\.bsp/);
  return m ? m[1] : null;
};
const startMap = await mapOf();
// True once the engine has moved off the level this run started on. A check that depends on
// level state is then reported SKIPPED rather than FAILED: it would be measuring a level the
// test was not aiming at, which is a property of the map, not a defect in the engine.
let autoAdvanced = false;
const checkAdvanced = async () => {
  if (autoAdvanced || !startMap) return autoAdvanced;
  const now = await mapOf();
  if (now && now !== startMap) {
    autoAdvanced = true;
    console.log(`   NOTE: the engine left ${startMap} for ${now} on its own (this map auto-advances).`);
    console.log('         Level-dependent checks below are reported SKIPPED, not FAILED.');
  }
  return autoAdvanced;
};
const posOf = async () => {
  await exec('viewpos');
  await sleep(700);
  const hits = (await ring()).filter(l => /\(-?\d+ -?\d+ -?\d+\) : -?\d+/.test(l));
  if (!hits.length) return null;
  const m = hits[hits.length - 1].match(/\((-?\d+) (-?\d+) (-?\d+)\)/);
  return m ? [ +m[1], +m[2], +m[3] ] : null;
};
let settled = false, drift = 0;
for (let round = 0; round < 24; round++) {
  const a = await posOf(); await sleep(5000); const b = await posOf();
  if (!a || !b) continue;
  drift = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
  if (drift < 32) { settled = true; break; }
}
console.log(`camera released      : ${settled} (view drift ${drift.toFixed(1)} units / 5s)`);
if (!settled) {
  console.log(`FAIL: the scripted camera never released on ${MAP}; the engine correctly refuses the`);
  console.log('      in-game menu while it runs, so menu behaviour cannot be judged here');
  ws.close(); (globalThis.__idt3_done = true, chrome.kill()); process.exit(1);
}

const playKc = await kc();
const playSig = await sig();
console.log(`in gameplay          : keyCatchers=${playKc} draws/frame=${rate.toFixed(0)}`);
if (playKc & KEYCATCH_UI) fail('the UI still owns input during gameplay — the menu never closed');

// Precondition: do CDP key events reach the engine's key system at all in this harness? Bind an
// unrelated key to an echo and press it. ESC itself cannot be used for this -- CL_KeyEvent
// handles A_ESCAPE specially and returns before bindings are consulted -- so a silent ESC would
// otherwise be ambiguous between "the key never arrived" and "the menu did not open".
const key = async (code, vk) => { for (const type of ['keyDown', 'keyUp'])
  await S('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key: code === 'F1' ? 'F1' : code, code }); };
await exec('bind F1 "echo ###IDT3KEYOK"');
await sleep(1000);
await key('F1', 112);
await sleep(2000);
const kl = (await evalv("String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : '')") || '');
const keyArrives = kl.includes('###IDT3KEYOK');
console.log(`key events reach engine: ${keyArrives}`);
if (!keyArrives) fail('CDP key events are not reaching the engine key system at all');

// --- 3. ESC opens the in-game menu ---------------------------------------
// RETRY, do not judge on a single press. The engine refuses the in-game menu whenever a
// scripted camera is running -- UI_SetActiveMenu returns early on
// !ui.SG_GameAllowedToSaveHere(qtrue), which ends in GameAllowedToSaveHere() ==
// (!in_camera && !killPlayerTimer). That is shipped behaviour, and JKA t1_sour runs its opening
// script in SEGMENTS, so the view can be perfectly still (0.0 units drift over 5s) while a
// camera is still logically active. A single ESC at an arbitrary moment therefore gives a
// flaky answer -- measured: the same build, same flags, failed one run and passed the next.
// A real player just presses ESC again, so the probe does too, and only a menu that never
// opens across the whole window is a failure.
let escKc = 0, escSig = null, escChanged = 0, escTries = 0;
const ESC_TRIES = parseInt(process.env.ESC_TRIES || '24', 10);
for (escTries = 1; escTries <= ESC_TRIES; escTries++) {
  await esc();
  await sleep(2500);
  escKc = await kc();
  if (escKc & KEYCATCH_UI) break;
  await sleep(2500);
}
escSig = await sig();
escChanged = diffPct(playSig, escSig);
console.log(`after ESC            : keyCatchers=${escKc} after ${escTries} press(es), screen changed ${escChanged.toFixed(1)}%`);
if (!(escKc & KEYCATCH_UI)) {
  fail(`ESC never opened the in-game menu in ${ESC_TRIES} attempts`);
  // Same predicate, different caller: if a save succeeds here, in_camera is NOT what is
  // blocking the menu and the fault is on the UI side instead.
  await exec("echo ###IDT3SAVE");
  await exec("save idt3menuprobe");
  await sleep(4000);
  const sl = (await evalv("String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : '')") || "");
  const scut = sl.lastIndexOf("###IDT3SAVE");
  console.log(`   save at the same moment: ${(scut >= 0 ? sl.slice(scut) : sl).split('\n').slice(1, 4).map(x => x.trim()).filter(Boolean).join(" | ") || "(no output)"}`);
} else if (!(escChanged > 5)) {
  fail(`ESC took the key catcher but changed the picture by only ${escChanged.toFixed(1)}% — the menu is not being drawn`);
}

// --- 3b. the camera contract, tested deterministically --------------------
// The engine refuses the in-game menu whenever a camera is active: UI_SetActiveMenu returns early
// on !SG_GameAllowedToSaveHere(qtrue), which ends in GameAllowedToSaveHere() ==
// (!in_camera && !killPlayerTimer). cam_enable / cam_disable (cg_consolecmds.cpp:192-193) drive
// that flag directly, so the contract can be verified without waiting on a script.
//
// This matters because the intermittent second-load failure measures `in_camera=1` at the point
// of refusal. Proving the flag alone is sufficient to block the menu -- and that clearing it is
// sufficient to restore it -- pins the mechanism down even on runs where the race does not fire.
if (!process.env.SKIP_CONTRACT) {
  await esc();                       // close the menu first
  await sleep(2500);
  await exec('cam_enable');
  await sleep(2000);
  let blocked = 0;
  for (let a = 0; a < 4; a++) { await esc(); await sleep(2000); blocked = await kc(); if (blocked & KEYCATCH_UI) break; }
  console.log(`camera on  -> ESC     : keyCatchers=${blocked} ${(blocked & KEYCATCH_UI) ? '(menu opened -- contract NOT as expected)' : '(menu refused, as the engine intends)'}`);
  if (blocked & KEYCATCH_UI) {
    if (await checkAdvanced()) console.log('   SKIP: camera/save contract - the map changed under the test');
    else fail('a menu opened while a camera was active — the save/camera contract does not hold');
  }
  await exec('cam_disable');
  await sleep(2000);
  let freed = 0;
  for (let a = 0; a < 6; a++) { await esc(); await sleep(2500); freed = await kc(); if (freed & KEYCATCH_UI) break; }
  console.log(`camera off -> ESC     : keyCatchers=${freed} ${(freed & KEYCATCH_UI) ? '(menu restored)' : '(STILL refused)'}`);
  if (!(freed & KEYCATCH_UI)) fail('clearing the camera did not restore the menu — something else blocks it too');
  // NB leave the menu OPEN: section 4 below is the "ESC closes it again" test and expects it up.
  // Closing it here made that section re-open it and then report the menu as stuck — a fault in
  // this harness, not in the engine.
}

// --- 4. ESC closes it again ----------------------------------------------
await esc();
await sleep(3500);
const backKc = await kc();
console.log(`after ESC again      : keyCatchers=${backKc}`);
if (backKc & KEYCATCH_UI) {
  if (await checkAdvanced()) console.log('   SKIP: ESC-closes-menu - the map changed under the test');
  else fail('ESC did not close the in-game menu — input is stuck in the UI');
}

// --- 5. uimenu drives it too ---------------------------------------------
// Diagnostics: cl_paused is set by UI_SetActiveMenu's "ingame" branch before it ever reaches
// UI_InGameMenu, so it separates "the command never ran" from "the menu failed to activate".
// UI_InGameMenu then calls ui.Key_SetCatcher(KEYCATCH_UI) unconditionally, so a catcher that
// stays 0 means the command did not take effect at all.
const cvar = async n => {
  await exec(`echo ###CV ${n} $${n}`);
  await sleep(600);
  const l = (await evalv('String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : "")') || '').split('\n');
  const hit = l.filter(x => x.includes('###CV ' + n)).pop();
  return hit ? hit.split(' ').slice(2).join(' ') : '(none)';
};
console.log(`cl_paused before     : ${await cvar('cl_paused')}`);
await exec('uimenu');
await sleep(3500);
const uiKc = await kc();
console.log(`after "uimenu"       : keyCatchers=${uiKc}  cl_paused=${await cvar('cl_paused')}`);
await exec('uimenu ingameMainMenu');
await sleep(3500);
console.log(`after "uimenu ingameMainMenu": keyCatchers=${await kc()}  cl_paused=${await cvar('cl_paused')}`);
if (!(uiKc & KEYCATCH_UI)) fail('the uimenu command did not open a menu');
await esc();
await sleep(3000);
console.log(`after ESC (cleanup)  : keyCatchers=${await kc()}`);

// --- 6. does the menu survive a SECOND map load? -------------------------
// This is the discriminator for the real-world failure. Booting straight into a map the in-game
// menu works; reaching the same map through the main menu (devmap from the UI) it never opens.
// The difference is how many times the game module has been instantiated. If a second `devmap`
// in the same session also kills the menu, the fault follows module re-instantiation -- `ge`
// ends up pointing at an instance whose in_camera/killPlayerTimer statics are not the ones
// gameplay is updating (the flat-namespace duplicate documented in sys_jk.cpp).
if (process.env.SECOND_MAP) {
  console.log("\n--- reloading the map in the same session ---");
  // SECOND_MAP_NAME lets the second load be a DIFFERENT map, to separate 'any second load'
  // from 'reloading the same map'.
  const MAP2 = process.env.SECOND_MAP_NAME || MAP;
  console.log(`(second load: ${MAP2})`);
  await exec(`devmap ${MAP2}`);
  for (let i = 0; i < 180; i++) { await sleep(1000); if ((await st()) === CA_ACTIVE) break; }
  let r2 = 0, p2 = -1, s2 = 0;
  for (let i = 0; i < 90; i++) {
    r2 = await drawRate();
    if (r2 > 20 && p2 > 20 && Math.abs(r2 - p2) <= 0.2 * Math.max(r2, p2)) { if (++s2 >= 2) break; }
    else s2 = 0;
    p2 = r2;
  }
  for (let round = 0; round < 24; round++) {
    const a = await posOf(); await sleep(5000); const b = await posOf();
    if (a && b && Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]) < 32) break;
  }
  // same retry rule as the first-load test: a camera may legitimately be running
  let kc2 = 0;
  for (let a = 0; a < ESC_TRIES; a++) {
    await esc();
    await sleep(2500);
    kc2 = await kc();
    if (kc2 & KEYCATCH_UI) break;
    await sleep(2500);
  }
  console.log(`after 2nd load, ESC  : keyCatchers=${kc2}`);

  {
    await exec('echo ###IDT3NOOP');
    await sleep(1200);
    const all = await S('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify(window.__allLog||[])' });
    let arr = []; try { arr = JSON.parse(all.result.value || '[]'); } catch {}
    const g2 = arr.filter(l => /IDT3MOVE/.test(String(l))).map(l => String(l).trim());
    const _unused = 0;
    console.log(`   ids: ${g2.length ? g2.join(' :: ') : '(no reply)'}`);

  }
  {
    // Dump the camera ring recorded without I/O on the failing path.
    await exec('idt3camdump');
    await sleep(1500);
    const all = await S('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify(window.__allLog||[])' });
    let arr = []; try { arr = JSON.parse(all.result.value || '[]'); } catch {}
    const ring = arr.filter(l => String(l).includes('IDT3RING')).map(l => String(l).trim());
    console.log(`   camera ring (${ring.length}): ${ring.join(' | ')}`);
  }
  console.log(`   page exceptions/console errors: ${pageErrors.length}`);
  for (const e of pageErrors.slice(0, 6)) console.log('     ' + String(e).slice(0, 300));
  {
    const all = await S('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify(window.__allLog||[])' });
    let arr = []; try { arr = JSON.parse(all.result.value || '[]'); } catch {}
    const fsmod = await import('node:fs');
    if (process.env.LOGFILE) fsmod.writeFileSync(process.env.LOGFILE, arr.join(String.fromCharCode(10)));
    const cam = arr.filter(l => /camera\(|Server:|ShutdownGame/i.test(l));
    console.log(`   log lines=${arr.length}; camera/level events:`);
    for (const l of cam.slice(-18)) console.log('     ' + String(l).trim());
  }
  if (!(kc2 & KEYCATCH_UI)) {
    // NB only meaningful with the menu CLOSED. Run with the menu open, W is consumed by the UI
    // and this reports 0.0 units on a perfectly responsive player -- which it did once before
    // this guard was added.
    // SEVERITY CHECK: a camera that never releases would normally lock the player out of
    // control. Ask the engine whether the player can still move -- viewpos before/after holding
    // W. This distinguishes "the pause menu is unavailable" from "the campaign is unplayable
    // after level 1", which are very different bugs.
    const p0 = await posOf();
    for (const type of ["keyDown", "keyUp"]) {
      await S("Input.dispatchKeyEvent", { type, windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, key: "w", code: "KeyW", text: type === "keyDown" ? "w" : undefined });
      if (type === "keyDown") await sleep(2500);
    }
    await sleep(500);
    const p1 = await posOf();
    const d = (p0 && p1) ? Math.hypot(p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]) : -1;
    console.log(`    player movable after 2nd load: ${d < 0 ? "(unknown)" : d.toFixed(1) + " units"}` +
      (d > 24 ? "  <- still in control" : "  <- NOT moving; player may be locked in the camera"));
  }
  if (!(kc2 & KEYCATCH_UI)) {
    // Confirmation test. cam_disable (cg_consolecmds.cpp:192 -> CMD_CGCam_Disable) clears
    // in_camera through the engine own path. If ESC then opens the menu, the refusal really was
    // the stuck camera flag and nothing else -- and the camera was merely FLAGGED, not mid-
    // sequence, since a running cutscene would re-assert it.
    await exec("cam_disable");
    await sleep(2000);
    let after = 0;
    for (let a = 0; a < 6; a++) {
      await esc();
      await sleep(2500);
      after = await kc();
      if (after & KEYCATCH_UI) break;
    }
    console.log(`    after cam_disable    : keyCatchers=${after}` +
      ((after & KEYCATCH_UI) ? "  <- the stuck camera flag WAS the blocker" : "  <- something else too"));
  }
  {  // TEMPORARY: split the two halves of GameAllowedToSaveHere()
    await exec("idt3dbg");
    await sleep(1500);
    const dt = (await evalv("String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : '')") || "");
    const hit = dt.split('\n').filter(x => x.includes("IDT3DBG")).pop();
    console.log("    predicate: " + (hit ? hit.trim() : "(no reply)"));
  }
  // Dump the tail of the engine log either way, so a failing second load can be diffed against
  // a passing one. This is the technique that located the navigator use-after-free.
  {
    const rt = (await evalv("String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : '')") || "");
    const lines = rt.split('\n').map(x => x.trim()).filter(Boolean);
    console.log(`--- engine log tail after 2nd load (${(kc2 & KEYCATCH_UI) ? "PASS" : "FAIL"}) ---`);
    const cam = lines.filter(l => l.includes("IDT3CAM"));
    console.log("    camera events: " + (cam.length ? cam.join("  |  ") : "(none)"));
  }
  if (!(kc2 & KEYCATCH_UI)) fail("the in-game menu stopped working after a second map load");
  if (!(kc2 & KEYCATCH_UI)) {
    // Same predicate, different caller. `save` goes SG_WriteSavegame -> SG_GameAllowedToSaveHere
    // (full check) -> ge->GameAllowedToSaveHere() == (!in_camera && !killPlayerTimer). If a save
    // SUCCEEDS while the menu is refused, that predicate is TRUE and the blockage is somewhere
    // in the UI layer instead -- which would rule out the camera explanation entirely.
    await exec("echo ###IDT3SAVE2");
    await exec("save idt3menuprobe2");
    await sleep(4000);
    const sl2 = (await evalv("String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : '')") || "");
    const c2 = sl2.lastIndexOf("###IDT3SAVE2");
    const out2 = (c2 >= 0 ? sl2.slice(c2) : sl2).split('\n').slice(1, 5).map(x => x.trim()).filter(Boolean).join(" | ");
    console.log(`   save at that moment  : ${out2 || "(no output)"}`);
  }
  await esc(); await sleep(2000);
}

console.log(ok ? `\nPASS: menus display and respond (${MAP})` : `\nFAIL: ${MAP}`);
ws.close(); (globalThis.__idt3_done = true, chrome.kill()); process.exit(ok ? 0 : 1);
