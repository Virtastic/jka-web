// JK2/JKA movement proof, console-free. In single-player the console PAUSES the
// game and eats keystrokes, so measuring position through it is impossible. Instead
// this holds W with no console open and proves the camera translated by luma-diffing
// two composited frames. A held-forward walk shifts most of the frame; an idle scene
// (NPC breathing) shifts a few percent. We report the changed-pixel fraction.
//   node verify-jk-move.mjs <game> <httpPort> "<+args>"
import { execFile } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
const GAME = process.argv[2], HTTP = process.argv[3], ARGS = process.argv[4] || '';
if (!GAME || !HTTP) { console.error('usage: verify-jk-move.mjs <game> <httpPort> "+args"'); process.exit(2); }
const CDP = 9500 + (parseInt(HTTP, 10) % 100);
const c = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  `--user-data-dir=/tmp/idt3-${GAME}-move`, 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r)); await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.addScriptToEvaluateOnNewDocument', { source: "window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));" });
await S('Page.navigate', { url: `http://localhost:${HTTP}/index.html?args=` + encodeURIComponent(ARGS) });
const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
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
let ctrl = false, lastPress = -99;
for (let i = 0; i < 30; i++) {
  const a = await shot(); await sleep(1000); const b = await shot();
  const settle = diffFrac(a, b), lum = meanLuma(b);
  console.log(`t wait+${i}: settle ${(settle * 100).toFixed(1)}%  luma ${lum.toFixed(1)}`);
  if (settle < 0.04 && lum > 22) { ctrl = true; break; }
  if (i - lastPress >= 4) { await tkey('e', 'KeyE', 69); lastPress = i; }  // (re)start skip
  await sleep(1200);
}
if (!ctrl) console.log('WARN: never confirmed player control');

// Standing-still baseline (no key), then the same window holding W.
const idle0 = await shot(); await sleep(2500); const idle1 = await shot();
const idleFrac = diffFrac(idle0, idle1);
const before = await shot();
fs.writeFileSync(`/tmp/${GAME}-move-before.png`, before);
await hold('w', 'KeyW', 87, 2500);
const after = await shot();
fs.writeFileSync(`/tmp/${GAME}-move-after.png`, after);
const moveFrac = diffFrac(before, after);

// A low idle already means the player is in control and standing still (a running
// cutscene keeps the whole frame moving, so idle would be high). W-held >> idle then
// proves the player translated. The HUD-corner luma is only an advisory here.
const inControl = idleFrac < 0.10;
console.log(`IDLE  (no key): ${(idleFrac * 100).toFixed(1)}%   periphery ${inControl ? '(in control, standing still)' : '(scene still moving)'}`);
console.log(`W-HELD change : ${(moveFrac * 100).toFixed(1)}%   periphery`);
console.log(`MOVED: ${inControl && moveFrac > 0.15 && moveFrac > idleFrac * 3 ? 'YES' : 'NO/UNCLEAR'}`);
console.log(`SHOTS: /tmp/${GAME}-move-before.png  /tmp/${GAME}-move-after.png`);
ws.close(); c.kill(); process.exit(0);
