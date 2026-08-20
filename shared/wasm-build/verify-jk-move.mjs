// JK2/JKA movement proof, console-free. In single-player the console PAUSES the
// game and eats keystrokes, so measuring position through it is impossible. Instead
// this holds W with no console open and proves the camera translated by luma-diffing
// two composited frames. A held-forward walk shifts most of the frame; an idle scene
// (NPC breathing) shifts a few percent. We report the changed-pixel fraction.
//   node verify-jk-move.mjs <game> <httpPort> "<+args>"
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
const GAME = process.argv[2], HTTP = process.argv[3], ARGS = process.argv[4] || '';
// How many ~2.2s rounds to spend waiting for player control before giving up.
// 30 is fine for JKA, but JK2's campaign start (kejim_post) opens on a ~70s Star Wars
// text crawl, so the fixed budget expired mid-crawl and the probe reported
// "never confirmed player control / MOVED: NO" on a perfectly healthy build.
const ROUNDS = parseInt(process.argv[5] || '30', 10);
if (!GAME || !HTTP) { console.error('usage: verify-jk-move.mjs <game> <httpPort> "+args" [rounds]'); process.exit(2); }
const CDP = 9500 + (parseInt(HTTP, 10) % 100);
const c = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  `--user-data-dir=${tmpProfile(`idt3-${GAME}-move`)}`, 'about:blank']);
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
await S('Page.addScriptToEvaluateOnNewDocument', { source: "window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));" });
await S('Page.navigate', { url: `http://localhost:${HTTP}/index.html?args=` + encodeURIComponent(ARGS) });
// Engine output no longer reaches console.* — the page routes Com_Printf into a private
// ring (window.__idt3_dumpLog) to keep the devtools console clean. Reading only window.__l
// therefore saw an empty log forever and every wait loop here ran to its full timeout.
// Merge both sources.
const LOGEXPR = 'JSON.stringify((window.__l||[]).concat(String(window.__idt3_dumpLog?window.__idt3_dumpLog():"").split(String.fromCharCode(10))))';
const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: LOGEXPR, returnByValue: true })).result.value || '[]');
for (let i = 0; i < 30; i++) { await sleep(3000); if (/loaded \d+ faces/.test((await logs()).join('\n'))) break; }
await sleep(6000);   // let the player spawn
await S('Runtime.evaluate', { expression: "(function(){var c=Module.canvas||document.getElementById('canvas');c.style.setProperty('width','100vw','important');c.style.setProperty('height','100vh','important');c.style.setProperty('object-fit','contain','important');var l=document.getElementById('load');if(l)l.remove();})()" });
await sleep(1500);

// Minimal PNG -> grayscale grid decoder (RGBA/8-bit, non-interlaced), Node zlib only.
function pngLuma(buf, GX = 64, GY = 40) {
  let p = 8, w = 0, h = 0, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); }
    else if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const grid = new Float64Array(GX * GY), cnt = new Float64Array(GX * GY);
  let off = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[off++];
    for (let x = 0; x < stride; x++) {
      const rawv = raw[off + x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const cc = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (f) { case 0: v = rawv; break; case 1: v = rawv + a; break; case 2: v = rawv + b; break;
        case 3: v = rawv + ((a + b) >> 1); break;
        case 4: { const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc);
          v = rawv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc); break; }
        default: v = rawv; }
      cur[x] = v & 0xff;
    }
    off += stride;
    const gy = (y * GY / h) | 0;
    for (let x = 0; x < w; x++) {
      const r = cur[x * 4], g = cur[x * 4 + 1], bl = cur[x * 4 + 2];
      const gx = (x * GX / w) | 0, gi = gy * GX + gx;
      grid[gi] += 0.299 * r + 0.587 * g + 0.114 * bl; cnt[gi]++;
    }
    cur.copy(prev);
  }
  for (let i = 0; i < grid.length; i++) grid[i] /= (cnt[i] || 1);
  return grid;
}
const shot = async () => { const s = await S('Page.captureScreenshot', { format: 'png' }); return Buffer.from(s.data, 'base64'); };
const GX = 64, GY = 40;
// Peripheral diff: ignore the central box, where a companion NPC animates in place.
// A real player translation shifts the walls/floor at the frame edges wholesale; an
// idle NPC does not. So the periphery isolates locomotion from scene animation.
const diffFrac = (a, b, thr = 12) => {
  const ga = pngLuma(a, GX, GY), gb = pngLuma(b, GX, GY);
  let d = 0, n = 0;
  for (let y = 0; y < GY; y++) for (let x = 0; x < GX; x++) {
    const cx = x / GX, cy = y / GY;
    if (cx > 0.28 && cx < 0.72 && cy > 0.25 && cy < 0.9) continue;   // skip center (NPC + gun)
    n++; if (Math.abs(ga[y * GX + x] - gb[y * GX + x]) > thr) d++;
  }
  return d / n;
};

const hold = async (k, code, which, ms) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: which, nativeVirtualKeyCode: which });
  await sleep(ms);
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: which, nativeVirtualKeyCode: which });
};
// The demo story maps open on a long scripted ICARUS cutscene (letterboxed, no
// player control) that does NOT end on its own within a reasonable window. JKA's own
// skip path is the `exitview` command (g_svcmds.cpp) -> G_StartCinematicSkip() ->
// timescale 100, which blasts through it. Send it via the console (console input is
// delivered exactly like movement input, so this also re-confirms the key path).
const tkey = async (k, code, which, mods = 0) => { for (const t of ['keyDown', 'keyUp']) await S('Input.dispatchKeyEvent', { type: t, key: k, code, windowsVirtualKeyCode: which, nativeVirtualKeyCode: which, modifiers: mods, text: (t === 'keyDown' && k.length === 1) ? k : undefined }); await sleep(160); };
// HUD detector: the force/shield meters glow in the bottom CONTENT corners during
// gameplay; during the letterboxed cutscene that band is a black cinematic bar. The
// frame is pillarboxed (4:3 in 16:9), so sample inside the content, not the side bars.
const hudPresent = (buf) => {
  const g = pngLuma(buf, GX, GY); let sum = 0, n = 0;
  for (let y = 0; y < GY; y++) for (let x = 0; x < GX; x++) {
    const cx = x / GX, cy = y / GY;
    const corner = ((cx > 0.14 && cx < 0.27) || (cx > 0.73 && cx < 0.86)) && cy > 0.82 && cy < 0.97;
    if (corner) { sum += g[y * GX + x]; n++; }
  }
  return sum / n;
};
const consoleIsOpen = async (buf) => { const g = pngLuma(buf, GX, GY); let s = 0, n = 0;
  for (let y = 0; y < GY; y++) for (let x = 0; x < GX; x++) { const cy = y / GY, cx = x / GX; if (cy < 0.12 && cx > 0.14 && cx < 0.86) { s += g[y * GX + x]; n++; } }
  return s / n > 20;   // console text band at the very top is bright
};
// Open console, run a command, close it. Close with Escape (idTech3 closes an open
// console on Escape without opening the menu), then verify it's shut — the toggle
// desyncs if a keypress is dropped, and a stuck-open console pauses SP and eats W.
const consoleCmd = async (line) => {
  await tkey('`', 'Backquote', 192, 8); await sleep(500);
  for (const ch of line) { const code = /[0-9]/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase(); await tkey(ch, code, ch.toUpperCase().charCodeAt(0)); }
  await tkey('Enter', 'Enter', 13); await sleep(300);
  for (let i = 0; i < 4; i++) { await tkey('Escape', 'Escape', 27); await sleep(400); if (!(await consoleIsOpen(await shot()))) break; }
};
// Skip the intro cinematic with the USE button — JKA/JK2 both bind +use to 'e', and
// ClientCinematicThink() skips the scripted cin on a fresh BUTTON_USE press. This
// needs NO console (which pauses SP and is fiddly to open/close reliably). Tap 'e'
// each round until the frame stops moving on its own (player in control, standing).
// mean luma of the content (skip pillarbox) — distinguishes a lit gameplay scene from
// the black fades between cinematic shots.
const meanLuma = (buf) => { const g = pngLuma(buf, GX, GY); let s = 0, n = 0;
  for (let y = 0; y < GY; y++) for (let x = 0; x < GX; x++) { const cx = x / GX; if (cx > 0.14 && cx < 0.86) { s += g[y * GX + x]; n++; } }
  return s / n; };
// Each 'e' press TOGGLES the cin-skip, so re-press only every few rounds. "In control"
// requires the frame to be STABLE *and* BRIGHT (a lit scene while standing still) — a
// moving cinematic shot isn't stable, and the black fades between shots aren't bright.
// Ask the ENGINE whether the player is in control, instead of guessing it from pixels.
// idt3_client_state() returns cls.state | (keyCatchers << 8); CA_ACTIVE is 8 in both
// JK2 and JKA (connstate_t), and keyCatchers == 0 means neither console nor menu is
// eating input. Falls back to the old luma/steadiness guess if the export is missing
// (an engine built before it existed).
const CA_ACTIVE = 7;  // connstate_t: UNINITIALIZED,DISCONNECTED,CONNECTING,CHALLENGING,CONNECTED,LOADING,PRIMED,ACTIVE,CINEMATIC
const engineState = async () => {
  const r = await S('Runtime.evaluate', { returnByValue: true, expression:
    `(function(){ try { return Module.ccall('idt3_client_state','number',[],[]); } catch(e){ return -1; } })()` });
  const v = r && r.result ? r.result.value : -1;
  return (typeof v === 'number') ? v : -1;
};
let engineKnows = false;
let ctrl = false, lastPress = -99, stable = 0;
for (let i = 0; i < ROUNDS; i++) {
  const a = await shot(); await sleep(1000); const b = await shot();
  const settle = diffFrac(a, b), lum = meanLuma(b);
  console.log(`t wait+${i}: settle ${(settle * 100).toFixed(1)}%  luma ${lum.toFixed(1)}`);
  // Require the "in control" condition to hold TWICE in a row, and never accept it on the
  // first round. JK2's campaign start opens on the Star Wars text crawl, which drifts slowly
  // enough to read as a settled frame and is bright enough to pass the luma gate -- so this
  // used to break out at wait+0 and then report a confident MOVED: YES measured entirely on
  // scrolling title text. A false pass is the worst failure mode a verification probe has.
  // Luma gate at 8, not 22. Measured on JK2 artus_mine: its opening cinematic sits at
  // luma 1.9-4.6, while the gameplay spawn -- a dark cave, player demonstrably in control
  // (cls.state == CA_ACTIVE, keyCatchers == 0, serverTime advancing, confirmed with a
  // temporary CL_Frame probe) -- sits at 16-34. A gate at 22 called that gameplay a
  // cinematic and ran the whole budget out. 8 separates the two cleanly and still keeps
  // fade-to-black frames out.
  const st = await engineState();
  if (st >= 0) {
    engineKnows = true;
    const conn = st & 0xff, keyCatch = st >> 8;
    // CA_ACTIVE alone is NOT enough: it is also true while an in-game ICARUS cinematic
    // plays, and JKA's t2_rogue reaches it at wait+1 with the intro camera still flying
    // (idle diff 42%). Pair the engine's fact with the frame being steady, and drop the
    // brightness test entirely -- brightness was the part that mis-read JK2's unlit spawn.
    if (conn === CA_ACTIVE && keyCatch === 0 && settle < 0.04) { if (stable++) { ctrl = true; break; } }
    else stable = 0;
    if (i - lastPress >= 4 && i < 8) { await tkey('e', 'KeyE', 69); lastPress = i; }
    await sleep(1200);
    continue;
  }
  if (settle < 0.04 && lum > 8 && i > 0) { if (stable++) { ctrl = true; break; } }
  else stable = 0;
  // Only nudge the skip EARLY. Each press toggles it, and JK2's longer opening cinematics
  // were being held black for the whole budget by presses that kept flipping it back off;
  // artus_mine and bespin_streets both sat at luma < 5 for 130s here while verify-jk-play,
  // which presses nothing, reached the lit scene in ~40s. Two nudges is enough for JKA.
  if (i - lastPress >= 4 && i < 8) { await tkey('e', 'KeyE', 69); lastPress = i; }
  await sleep(1200);
}
if (!ctrl) console.log('WARN: never confirmed player control');
else console.log(`control confirmed via ${engineKnows ? 'engine (cls.state == CA_ACTIVE, no key-catcher)' : 'frame heuristic'}`);

// Standing-still baseline (no key), then the same window holding W.
const idle0 = await shot(); await sleep(2500); const idle1 = await shot();
const idleFrac = diffFrac(idle0, idle1);
const before = await shot();
fs.writeFileSync(tmpProfile(`${GAME}-move-before.png`), before);
await hold('w', 'KeyW', 87, 2500);
const after = await shot();
fs.writeFileSync(tmpProfile(`${GAME}-move-after.png`), after);
const moveFrac = diffFrac(before, after);

// A low idle already means the player is in control and standing still (a running
// cutscene keeps the whole frame moving, so idle would be high). W-held >> idle then
// proves the player translated. The HUD-corner luma is only an advisory here.
const inControl = idleFrac < 0.10;
console.log(`IDLE  (no key): ${(idleFrac * 100).toFixed(1)}%   periphery ${inControl ? '(in control, standing still)' : '(scene still moving)'}`);
console.log(`W-HELD change : ${(moveFrac * 100).toFixed(1)}%   periphery`);
// Never claim YES/NO off the diff alone. `inControl` is derived from the idle frame being
// quiet, which a BLACK frame also satisfies -- a cinematic fade gave idle 0.0% and W-held 31%
// (the fade continuing) and this line printed a confident MOVED: YES with the player not yet
// spawned. If the wait loop never established control, say so instead of guessing.
// The pixel diff cannot answer this on a busy map. Measured on JKA t1_sour: IDLE alone already
// changes 58.4% of the periphery (vines, water, foliage all animate), so `inControl` -- which is
// just "idle is quiet" -- is false and W-held 57.3% is indistinguishable from it. That is a
// limit of the metric, not a broken build; the engine had already confirmed CA_ACTIVE with no
// key-catcher on the very same run.
//
// So ask the engine where the player is, the same way this probe already asks whether the player
// is in control. `viewpos` (cg_consolecmds.cpp, registered in both engines) prints
// "<map> (x y z) : yaw" from cg.refdef.vieworg. Holding W and comparing two of those is a direct
// measurement of translation that no amount of ambient animation can fake.
const posOf = async () => {
  await S('Runtime.evaluate', { expression: `(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],['viewpos']);}catch(e){}})()` });
  await sleep(700);
  const ring = String((await S('Runtime.evaluate', { expression: 'String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : "")', returnByValue: true })).result.value || '');
  const hits = ring.split('\n').filter(l => /\(-?\d+ -?\d+ -?\d+\) : -?\d+/.test(l));
  if (!hits.length) return null;
  const m = hits[hits.length - 1].match(/\((-?\d+) (-?\d+) (-?\d+)\)/);
  return m ? [ +m[1], +m[2], +m[3] ] : null;
};
const p0 = await posOf();
await hold('w', 'KeyW', 87, 2500);
const p1 = await posOf();
let dist = null;
if (p0 && p1) dist = Math.hypot(p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]);
console.log(`viewpos before: ${p0 ? p0.join(' ') : '(unavailable)'}`);
console.log(`viewpos after : ${p1 ? p1.join(' ') : '(unavailable)'}`);
console.log(`distance moved: ${dist === null ? '(unavailable)' : dist.toFixed(1) + ' units'}`);

// Engine-reported translation decides it when available; the pixel heuristic is the fallback
// for a build too old to answer `viewpos`. 24 units is comfortably above per-frame jitter from
// view bob and well below the ~300 units 2.5s of running covers.
const verdict = !ctrl ? 'UNCONFIRMED (never reached player control -- raise [rounds])'
              : dist !== null ? (dist > 24 ? `YES (engine: moved ${dist.toFixed(1)} units)`
                                           : `NO (engine: moved only ${dist.toFixed(1)} units)`)
              : (inControl && moveFrac > 0.15 && moveFrac > idleFrac * 3) ? 'YES (pixels only)' : 'NO/UNCLEAR (pixels only)';
console.log(`MOVED: ${verdict}`);
console.log(`SHOTS: ${tmpProfile(`${GAME}-move-before.png`)}  ${tmpProfile(`${GAME}-move-after.png`)}`);
ws.close(); c.kill(); process.exit(0);
