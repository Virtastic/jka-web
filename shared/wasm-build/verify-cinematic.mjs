// Verify RoQ cinematic playback — the story cutscenes.
//
// JKA ships 14 .roq videos in assets0.pk3 (video/ja01..ja12, jk0101_sw, openinglogos) and JK2
// ships 15; they are the chapter intros and the opening logos, i.e. a substantial part of the
// single-player experience that no map, save or movement test touches at all. The real RoQ
// decoder (client/cl_cin.cpp, audio included) is compiled and linked — this checks that it
// actually decodes and presents frames in a browser.
//
// A cinematic can fail in ways a single screenshot will not show: it can hold one decoded frame
// forever, run its clock without ever presenting, or present pure black. So this samples a 16x16
// luma signature of the canvas over time and requires the picture to genuinely CHANGE, on top of
// requiring CA_CINEMATIC and a non-black peak.
//
// <name> may be a comma-separated list, in which case every video is played in turn in ONE
// browser session. Sweeping the whole set matters as much as sweeping the whole campaign: the
// videos differ in codec path (some carry RoQ audio chunks, some do not) and in resolution, and
// playing them back to back is also the only thing that exercises CIN_StopCinematic's teardown
// repeatedly.
//
//   node verify-cinematic.mjs <httpPort> <name[,name...]> [secondsEach]
//     e.g. node verify-cinematic.mjs 8794 ja01 25
//          node verify-cinematic.mjs 8794 ja01,ja02,openinglogos 12
import { CHROME, tmpProfile, guardChrome } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT  = process.argv[2] || '8794';
const NAMES = (process.argv[3] || 'ja01').split(',').map(s => s.trim()).filter(Boolean);
const SECS  = parseInt(process.argv[4] || '25', 10);
// CDP 9000-9089: the only band in this directory nothing else claims. 9550+90 (the first
// choice) straddled verify-jk-move/console-check at 9500-9599 AND boot-log/shot/perf-probe
// at 9600-9699, so a cinematic sweep running alongside either would have fought over a
// debugging port and failed with a null page rather than a real result.
const CDP  = 9000 + (process.pid % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-cin-' + process.pid)}`, 'about:blank']);
guardChrome(chrome, 'verify-cinematic.mjs');
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

// Downscale the WebGL canvas into a 16x16 2D canvas and return a coarse luma signature. This
// relies on preserveDrawingBuffer, which this port already sets — without it a drawImage after
// compositing hands back an empty buffer and every frame reads as black.
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__cinSample = function(){
    try {
      var c = document.getElementById('canvas');
      if (!c || !c.width) return null;
      var s = window.__cinScratch;
      if (!s) { s = window.__cinScratch = document.createElement('canvas'); s.width = 16; s.height = 16; }
      var g = s.getContext('2d', { willReadFrequently: true });
      g.drawImage(c, 0, 0, 16, 16);
      var d = g.getImageData(0, 0, 16, 16).data, sum = 0, sig = [];
      for (var i = 0; i < d.length; i += 4) {
        var l = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        sum += l; sig.push(l >> 3);
      }
      return { mean: sum / (d.length / 4), sig: sig };
    } catch (e) { return null; }
  };
`});

await S('Page.navigate', { url: `http://localhost:${PORT}/index.html?args=${encodeURIComponent('+set sv_pure 0')}` });
const evalv = async expr => { try { const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true }); return r && r.result ? r.result.value : undefined; } catch { return undefined; } };
const state = async () => { const v = await evalv(`(function(){try{return Module.ccall('idt3_client_state','number',[],[]);}catch(e){return -1;}})()`); return typeof v === 'number' ? v : -1; };
const exec = c => evalv(`(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(c)}]);return 1;}catch(e){return 0;}})()`);

// A cinematic plays from the menu, so CA_ACTIVE is not required here — only a live client.
let up = false;
for (let i = 0; i < 90; i++) { await sleep(1000); if ((await state()) >= 0) { up = true; break; } }
if (!up) { console.log('FAIL: engine never came up'); ws.close(); (globalThis.__idt3_done = true, chrome.kill()); process.exit(1); }
for (const t of ['mousePressed', 'mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: 640, y: 360, button: 'left', clickCount: 1, buttons: 1 });
await sleep(2000);

const CA_CINEMATIC = 8;
const dumpLog = () => evalv('String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : "")');

// RoQ carries its own audio chunks (ZA_SOUND_MONO / ZA_SOUND_STEREO), decoded by
// RllDecode*ToStereo straight into snd_dma's raw-sample ring -- the same ring the MP3 music
// feeds through S_RawSamples. A cinematic that renders perfectly but plays silent is still
// wrong, and nothing else in the suite covers that ring, so sample the backend's live peak.
// --mute-audio does not interfere: it mutes the output device, not the Web Audio graph.
const snd = async () => {
  const v = await evalv(`(function(){var s=Module.__idt3_snd;if(!s||!s.ctx)return null;` +
                        `return JSON.stringify({state:s.ctx.state,pos:s.pos,peak:s.peak});})()`);
  try { return v ? JSON.parse(v) : null; } catch { return null; }
};

// Per-video log attribution: the ring is capped and shifts, so slicing it by a remembered index
// re-shows old lines once it has wrapped (the same trap map-sweep.mjs hit, where map 1's output
// was reported under map 15). Echo a unique marker before each video and cut from the LAST
// occurrence of it instead.
const results = [];
for (const NAME of NAMES) {
  console.log(`playing cinematic ${NAME} for ${SECS}s…`);
  await exec(`echo ###IDT3CIN ${NAME}`);
  await exec(`cinematic ${NAME}`);

  let sawCinematic = false, changes = 0, prev = null;
  let peakAudio = 0, posStart = null, posEnd = null;
  const samples = [];
  for (let i = 0; i < SECS * 2; i++) {
    await sleep(500);
    if (((await state()) & 0xff) === CA_CINEMATIC) sawCinematic = true;
    const a = await snd();
    if (a) {
      if (typeof a.peak === 'number' && a.peak > peakAudio) peakAudio = a.peak;
      if (posStart === null) posStart = a.pos;
      posEnd = a.pos;
    }
    const raw = await evalv('JSON.stringify(window.__cinSample ? window.__cinSample() : null)');
    const o = raw ? JSON.parse(raw) : null;
    if (!o) continue;
    samples.push(o.mean);
    if (prev) {
      let diff = 0;
      for (let k = 0; k < o.sig.length; k++) diff += Math.abs(o.sig[k] - prev[k]);
      if (diff > 8) changes++;   // 256 cells of 8-level luma; >8 total steps clears dither noise
    }
    prev = o.sig;
  }

  const ring = String(await dumpLog() || '').split('\n');
  let cut = -1;
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i].includes(`###IDT3CIN ${NAME}`)) { cut = i; break; }
  const mine = cut >= 0 ? ring.slice(cut) : ring;
  const errs = mine.filter(l => /ERROR|ERR_DROP|ERR_FATAL|not found|couldn/i.test(l) && /cin|roq|video/i.test(l));
  const avg  = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  const peak = samples.length ? Math.max(...samples) : 0;
  const moving = changes >= Math.max(3, Math.floor((samples.length - 1) * 0.25));
  const lit    = peak > 8;
  // The audio play cursor must advance, or the backend has stalled and nothing can be heard
  // regardless of what the decoder produced. Peak is reported but NOT a pass condition on its
  // own: a given .roq is free to be genuinely silent, and asserting otherwise would invent a
  // requirement the content does not have. A silent one is flagged for the summary instead.
  const audioMoving = posStart !== null && posEnd !== null && posEnd > posStart;
  const ok = sawCinematic && moving && lit && audioMoving && !errs.length;
  const why = [!sawCinematic && 'never entered CA_CINEMATIC', !moving && 'picture did not change',
               !lit && 'picture was black', !audioMoving && 'audio cursor stalled',
               errs.length && 'errors logged'].filter(Boolean).join(', ');

  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${NAME.padEnd(16)} cin=${String(sawCinematic).padEnd(5)}` +
              ` changed=${changes}/${Math.max(0, samples.length - 1)}` +
              `  luma avg/peak=${avg.toFixed(1)}/${peak.toFixed(1)}` +
              `  audio peak=${peakAudio.toFixed(4)}${peakAudio === 0 ? ' (SILENT)' : ''}` +
              `${ok ? '' : '  <- ' + why}`);
  for (const l of errs.slice(0, 6)) console.log('        ' + l);
  results.push({ NAME, ok, why, peakAudio });

  // Teardown between videos is the engine's own: PlayCinematic() calls SCR_StopCinematic() before
  // starting the next one, so there is nothing to add and no "stopcinematic" command to call (one
  // does not exist -- only "cinematic" and "ingamecinematic" are registered, cl_main.cpp:1285).
  // ESC is the player's stop path (cl_keys.cpp:1352 -> SCR_StopCinematic(true)), so send it to
  // exercise that route as well; it takes bAllowRefusal, so a video is free to decline and the
  // next PlayCinematic will still clean up.
  for (const type of ['keyDown', 'keyUp'])
    await S('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await sleep(1500);
}

const bad = results.filter(r => !r.ok);
const silent = results.filter(r => r.ok && r.peakAudio === 0);
console.log(`\n===== cinematics: ${results.length - bad.length}/${results.length} =====`);
for (const b of bad) console.log(`  FAIL ${b.NAME}: ${b.why}`);
if (silent.length) console.log(`  no audible audio (check against retail): ${silent.map(r => r.NAME).join(', ')}`);
console.log(bad.length ? 'FAIL' : 'PASS: every cinematic decoded and animated');
ws.close(); (globalThis.__idt3_done = true, chrome.kill()); process.exit(bad.length ? 1 : 0);
