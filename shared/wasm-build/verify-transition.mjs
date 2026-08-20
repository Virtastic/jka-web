// Verify scripted level transitions — how the campaign actually moves between maps, and the one
// path that carries the player forward.
//
// map-sweep.mjs loads maps back to back with `map`, which is NOT this: SV_Map_f explicitly does
// `Cvar_Set(sCVARNAME_PLAYERSAVE, "")` precisely so that typing `map` does not preserve weapons
// and ammo from a level you never really exited. The real campaign path is a target_level_change
// entity -> G_ChangeMap() (g_utils.cpp) -> the `maptransition` / `loadtransition` console
// commands -> SV_MapTransition_f, which calls SV_Player_EndOfLevelSave() first. So sweeping maps
// proved they load; it never once exercised the transition machinery or the state hand-off.
//
// Everything asserted here is engine-reported:
//   * which map is loaded — `viewpos` prints "maps/<name>.bsp (x y z) : yaw" from cg.refdef
//   * whether player state was carried — SV_Player_EndOfLevelSave serialises the player into the
//     `playersave` and `playerammo` cvars, and `cvarlist <name>` prints them back as
//     `<flags> <name> "<value>"`
//   * the contrast — after a plain `map` the player must spawn WITHOUT the carried inventory.
//     (Not "playersave is empty": SV_Map_f does clear it, but the engine repopulates it during
//     the new level, so by the time the map has settled it is non-empty again. The content is
//     what differs — measured 16383 weapons carried by a transition vs 3 on a plain map.)
//
//   node verify-transition.mjs <httpPort> <mapA> <mapB> <mapC>
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2] || '8794';
const MAP_A = process.argv[3] || 't1_sour';
const MAP_B = process.argv[4] || 't1_danger';
const MAP_C = process.argv[5] || 't1_fatal';
const CDP = 9020 + (process.pid % 18);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-trans-' + process.pid)}`, 'about:blank']);
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
await S('Page.navigate', { url: `http://localhost:${PORT}/index.html?args=${encodeURIComponent('+set sv_pure 0' + (process.env.EXTRA_ARGS ? ' ' + process.env.EXTRA_ARGS : '') + ' +devmap ' + MAP_A)}` });

const evalv = async e => { try { const r = await S('Runtime.evaluate', { expression: e, returnByValue: true }); return r && r.result ? r.result.value : undefined; } catch { return undefined; } };
const st = async () => { const v = await evalv(`(function(){try{return Module.ccall('idt3_client_state','number',[],[]);}catch(e){return -1;}})()`); return typeof v === 'number' ? v & 0xff : -1; };
const exec = c => evalv(`(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(c)}]);return 1;}catch(e){return 0;}})()`);
const ringText = async () => String(await evalv("String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : '')") || '');
const CA_ACTIVE = 7;

const drawRate = async () => {
  const a = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  await sleep(2000);
  const b = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  const A = JSON.parse(a || '{}'), B = JSON.parse(b || '{}');
  const f = (B.r || 0) - (A.r || 0);
  return f > 0 ? ((B.d || 0) - (A.d || 0)) / f : 0;
};
// Which map does the ENGINE think it is running? viewpos prints the bsp name, so this is not
// inferred from what we asked for — it is what the client is actually rendering.
const mapOf = async () => {
  await exec('viewpos');
  await sleep(900);
  const hits = (await ringText()).split('\n').filter(l => /maps\/.*\.bsp .*\(/.test(l));
  if (!hits.length) return null;
  const m = hits[hits.length - 1].match(/maps\/([A-Za-z0-9_]+)\.bsp/);
  return m ? m[1] : null;
};
// Coordinates out of the same viewpos line mapOf() reads.
const posOf = async () => {
  await exec('viewpos');
  await sleep(900);
  const hits = (await ringText()).split('\n').filter(l => /maps\/.*\.bsp .*\(/.test(l));
  if (!hits.length) return null;
  const m = hits[hits.length - 1].match(/\((-?\d+) (-?\d+) (-?\d+)\)/);
  return m ? [ +m[1], +m[2], +m[3] ] : null;
};
const cvar = async name => {
  await exec('echo ###IDT3CV ' + name);
  await exec('cvarlist ' + name);
  await sleep(1200);
  const txt = await ringText();
  const cut = txt.lastIndexOf('###IDT3CV ' + name);
  const seg = cut >= 0 ? txt.slice(cut) : txt;
  for (const line of seg.split('\n')) {
    const m = line.match(new RegExp('\\s' + name + '\\s+"(.*)"\\s*$', 'i'));
    if (m) return m[1];
  }
  return null;   // cvar does not exist yet
};
const settle = async label => {
  for (let i = 0; i < 200; i++) { await sleep(1000); if ((await st()) === CA_ACTIVE) break; }
  if ((await st()) !== CA_ACTIVE) return false;
  // Wait for the draw rate to plateau, then accept whatever it plateaus AT. A ">20 draws/frame"
  // floor was wrong here: JK2's kejim_base settles at 14 and kejim_post at 31, because those
  // opening views are almost entirely culled -- the transition to kejim_base was reported as
  // "never reached playable gameplay" while the engine was reporting the right map and the
  // carried inventory was sitting right there in playersave. The floor that IS justified is 2:
  // a client drawing nothing at all measures exactly 2 draws/frame (one screen quad), measured
  // on JKA yavin1 during its ninety-second opening sequence.
  let rate = 0, prev = -1, stable = 0;
  for (let i = 0; i < 90; i++) {
    rate = await drawRate();
    if (rate > 2 && prev > 2 && Math.abs(rate - prev) <= 0.2 * Math.max(rate, prev)) { if (++stable >= 2) break; }
    else stable = 0;
    prev = rate;
  }
  console.log(`  ${label}: gameplay reached, ${rate.toFixed(0)} draws/frame`);
  return rate > 2;
};

let ok = true;
const fail = m => { ok = false; console.log('   FAIL: ' + m); };

console.log(`\n===== scripted level transition: ${MAP_A} -> ${MAP_B} (maptransition), then ${MAP_C} (map) =====`);
if (!await settle(MAP_A)) { console.log(`FAIL: ${MAP_A} never reached playable gameplay`); ws.close(); chrome.kill(); process.exit(1); }
for (const t of ['mousePressed', 'mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: 640, y: 360, button: 'left', clickCount: 1, buttons: 1 });

const mapA = await mapOf();
console.log(`  engine reports map   : ${mapA}`);
if (mapA !== MAP_A) fail(`expected to be on ${MAP_A}, engine says ${mapA}`);

// Give the player a distinctive inventory so "state was carried" has something to carry.
await exec('give all');
await sleep(2500);

// --- the transition itself ----------------------------------------------
await exec('echo ###IDT3TRANS');
await exec(`maptransition ${MAP_B}`);
if (!await settle(MAP_B)) fail(`maptransition to ${MAP_B} never reached playable gameplay`);
const mapB = await mapOf();
console.log(`  engine reports map   : ${mapB}`);
if (mapB !== MAP_B) fail(`maptransition did not land on ${MAP_B} (engine says ${mapB})`);

// Can the player actually PLAY the map we transitioned into? Carrying inventory is worthless if
// the player arrives locked in a cutscene. Measured separately on a same-map reload: the opening
// camera is enabled and never disabled, and the player moves 0.0 units -- so this is checked here
// too, on a real level-to-level transition, to establish whether the campaign is affected or only
// same-map reloads are.
{
  // Arriving at a new level, the opening cutscene plays and the player is LEGITIMATELY locked --
  // a plateaued draw rate says the world is being drawn, not that the player is in charge. Testing
  // movement before that released reported 0.0 units on three consecutive healthy transitions.
  // Wait for the view to stop moving on its own first, the same gate verify-combat.mjs uses.
  // The player must be PLACED before "still" means anything. With g_ICARUSDebug on, the trace
  // showed viewpos reading `(0 0 6)` -- the world origin -- for eight consecutive samples after
  // arrival, while the level's intro script was still running; the player only appeared at
  // (416 792 60) once `scripts/kejim_base/start` had done its work. A player sitting at the origin
  // is perfectly still, so the settle gate passed and the movement test ran before anyone existed
  // to move. That is what produced the earlier "the campaign strands the player" reading.
  const atOrigin = p => !p || (Math.abs(p[0]) < 8 && Math.abs(p[1]) < 8 && Math.abs(p[2]) < 32);
  let placed = null;
  for (let round = 0; round < 60; round++) {
    placed = await posOf();
    if (!atOrigin(placed)) break;
    await sleep(2000);
  }
  console.log(`  player placed at      : ${placed ? placed.join(' ') : '(none)'}${atOrigin(placed) ? '  <- STILL AT ORIGIN' : ''}`);
  let settled = false, drift = 0;
  for (let round = 0; round < 30; round++) {
    const a = await posOf(); await sleep(5000); const b = await posOf();
    if (!a || !b || atOrigin(a) || atOrigin(b)) continue;
    drift = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
    if (drift < 32) { settled = true; break; }
  }
  console.log(`  view settled after transition: ${settled} (drift ${drift.toFixed(1)} units / 5s)`);
  // Try several directions, not just W. `viewpos` cannot distinguish "the player is locked" from
  // "the player is facing a wall", and an arrival spawn can easily be nose-first into geometry --
  // which would report 0.0 units on a perfectly responsive player. Movement in ANY direction
  // proves control.
  const press = async (vk, code, ch) => {
    for (const type of ['keyDown', 'keyUp']) {
      await S('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key: ch, code, text: type === 'keyDown' ? ch : undefined });
      if (type === 'keyDown') await sleep(2200);
    }
    await sleep(400);
  };
  const q0 = await posOf();
  let dd = 0, tried = [];
  for (const [vk, code, ch] of [[87,'KeyW','w'], [83,'KeyS','s'], [65,'KeyA','a'], [68,'KeyD','d']]) {
    await press(vk, code, ch);
    const qn = await posOf();
    const d = (q0 && qn) ? Math.hypot(qn[0]-q0[0], qn[1]-q0[1], qn[2]-q0[2]) : -1;
    tried.push(`${ch}=${d < 0 ? '?' : d.toFixed(0)}`);
    if (d > dd) dd = d;
    if (dd > 24) break;
  }
  console.log(`  movement by direction : ${tried.join(' ')}`);
  console.log(`  movable after transition: ${dd < 0 ? '(unknown)' : dd.toFixed(1) + ' units'}` +
    (dd > 24 ? '  <- in control' : '  <- NOT moving'));
  if (!(dd > 24)) {
    // Same confirmation used for the same-map case: cam_disable clears in_camera AND player_locked
    // (CMD_CGCam_Disable, cg_camera.cpp). If the player moves afterwards, this is the same stuck
    // cutscene, now reached through the campaign's own transition path.
    await exec('cam_disable');
    await sleep(2000);
    const r0 = await posOf();
    await press(87, 'KeyW', 'w');
    const r1 = await posOf();
    const rd = (r0 && r1) ? Math.hypot(r1[0]-r0[0], r1[1]-r0[1], r1[2]-r0[2]) : -1;
    console.log(`  after cam_disable     : ${rd < 0 ? '(unknown)' : rd.toFixed(1) + ' units'}` +
      (rd > 24 ? '  <- freed: SAME stuck-camera defect, via the campaign path' : '  <- still stuck: a different cause'));
    // With g_ICARUSDebug on, dump the script trace so the command the sequence is sitting on is
    // visible rather than inferred.
    if (process.env.EXTRA_ARGS) {
      const tl = (await ringText()).split('\n').map(x => x.trim()).filter(Boolean);
      console.log('  --- last 30 engine lines ---');
      for (const l of tl.slice(-30)) console.log('    ' + l);
    }
  }
  if (!(dd > 24)) fail('the player cannot move after the transition — arrived locked (camera?)');
}

const save1 = await cvar('playersave');
const ammo1 = await cvar('playerammo');
console.log(`  playersave           : ${save1 === null ? '(cvar absent)' : (save1 === '' ? '(empty)' : save1.slice(0, 60) + (save1.length > 60 ? '…' : ''))}`);
console.log(`  playerammo           : ${ammo1 === null ? '(cvar absent)' : (ammo1 === '' ? '(empty)' : ammo1.trim().slice(0, 60))}`);
// Field 2 of playersave is pState->stats[STAT_WEAPONS] (sv_ccmds.cpp): health, armor, WEAPONS,
// items, ... After `give all` that bitmask is every weapon; on a fresh spawn it is the default
// two or three. That number is the whole point of a transition, so it is what gets asserted.
const weaponsOf = v => { const f = (v || '').trim().split(/\s+/); return f.length > 2 ? parseInt(f[2], 10) : NaN; };
const wTrans = weaponsOf(save1);
console.log(`  weapons carried      : ${wTrans} (bitmask)`);
if (!save1) fail('playersave is empty after maptransition — no player state was carried forward');
if (!ammo1 || !/[1-9]/.test(ammo1)) fail('playerammo carried no ammo across the transition');

// --- the contrast: a plain `map` must NOT carry state --------------------
// SV_Map_f clears sCVARNAME_PLAYERSAVE on purpose. If this did not come back empty, the
// assertion above would be meaningless — it would pass whether or not transitions did anything.
await exec(`map ${MAP_C}`);
if (!await settle(MAP_C)) fail(`plain map ${MAP_C} never reached playable gameplay`);
const mapC = await mapOf();
console.log(`  engine reports map   : ${mapC}`);
if (mapC !== MAP_C) fail(`plain map did not land on ${MAP_C} (engine says ${mapC})`);
const save2 = await cvar('playersave');
const wPlain = weaponsOf(save2);
console.log(`  weapons after plain map: ${wPlain} (bitmask)`);
// NB emptiness is the WRONG test here, and asserting it was a mistake: SV_Map_f does clear
// playersave, but the engine repopulates it during the new level, so by the time the map has
// settled it is non-empty again (measured: "100 100 3 ..."). The meaningful difference is the
// CONTENT -- 16383 (everything, carried) versus 3 (a default spawn, carried nothing).
if (!(wTrans > wPlain)) {
  fail(`a plain map spawned with the same weapons (${wPlain}) as the transition carried (${wTrans}) —`
     + ' either the transition carried nothing, or `map` is wrongly preserving state');
}

const txt = await ringText();
const cut = txt.lastIndexOf('###IDT3TRANS');
const errs = (cut >= 0 ? txt.slice(cut) : txt).split('\n')
  .filter(l => /ERROR|ERR_DROP|ERR_FATAL|Hunk_Alloc failed|couldn't load/i.test(l));
if (errs.length) { ok = false; console.log('  errors during transitions:'); for (const l of errs.slice(0, 8)) console.log('    ' + l.trim()); }

console.log(ok ? `\nPASS: scripted transition carried the player ${MAP_A} -> ${MAP_B}, and plain map cleared it`
               : `\nFAIL: ${MAP_A} -> ${MAP_B}`);
ws.close(); chrome.kill(); process.exit(ok ? 0 : 1);
