// Verify model loading and entity rendering — the Ghoul2 character path in particular.
//
// This replaces verify-character.mjs (deleted): that wrote three screenshots, asserted nothing and
// exited 0 regardless, so "do characters render" was never actually answered; it also used the old
// map detection that reports NOT-DETECTED on a healthy boot. This asks the engine instead.
//
// Two independent questions, because they fail separately:
//
//  1. Did every model LOAD? `modellist` (R_Modellist_f, tr_model.cpp) walks tr.models and prints
//     one line per model, labelling failures explicitly as "MOD_BAD : <name>". Ghoul2 characters
//     are identifiable by extension: .glm is the mesh (MOD_MDXM) and .gla the skeleton/animation
//     (MOD_MDXA). A map full of NPCs with zero .glm loaded means the character pipeline is dead
//     no matter what the screen looks like.
//
//  2. Are they actually DRAWN? Loading is not rasterising. So freeze the world (timescale 0) and
//     toggle r_drawentities within that single frozen frame — same camera, same pose, same
//     everything — and measure how much of the picture the entities were responsible for. This is
//     the cvar-ab.mjs technique; comparing two separate runs is useless here because the camera
//     never lands identically twice.
//
// Sampling is done on Page.captureScreenshot, not drawImage(canvas): anything that could be a
// compositor stage (the r_gamma LUT is one) is invisible to the canvas backing store.
//
//   node verify-models.mjs <httpPort> <map> [thirdPerson]
//     e.g. node verify-models.mjs 8794 t1_sour
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2] || '8794';
const MAP  = process.argv[3] || 't1_sour';
const TP   = process.argv[4] === undefined ? '1' : process.argv[4];
// CDP 9090-9099 band: 9000-9089 is verify-cinematic, everything else starts at 9100.
const CDP  = 9090 + (process.pid % 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-mdl-' + process.pid)}`, 'about:blank']);
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
// Count RAF ticks and GL draw calls from before the engine boots -- the same hook soak.mjs uses.
// This is the instrument for "are entities drawn", after two others failed:
//   * a frozen-frame pixel A/B: the scene would not hold still (t1_sour 80.3% effect vs 79.8%
//     noise; yavin1 22.2% vs 29.7%), and timescale 0.01 still drifted 23.8% between idle captures.
//   * r_speeds 1: every line, once per frame, read "1/1 shdrs/srfs 0 leafs 4 vrts 2/2 tris" -- a
//     single quad. R_PerformanceCounters (tr_cmds.cpp:107) prints and THEN memsets, immediately
//     before RB_ExecuteRenderCommands, so when the 3D batch has already been flushed by
//     R_SyncRenderThread earlier in the frame, the print only ever covers the trailing 2D flush.
// Draw calls at the WebGL boundary have neither problem: they are exact, per-frame, and cannot be
// imitated by ambient animation.
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

// 32x32 luma signature of the COMPOSITED page.
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
        for (var i = 0; i < d.length; i += 4) a.push(Math.round((d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114)));
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

let ok = true;
for (let i = 0; i < 180; i++) { await sleep(1000); if ((await state() & 0xff) === 7) break; }
if ((await state() & 0xff) !== 7) { console.log(`FAIL: ${MAP} never reached gameplay`); ws.close(); chrome.kill(); process.exit(1); }
for (const t of ['mousePressed', 'mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: 640, y: 360, button: 'left', clickCount: 1, buttons: 1 });

// CA_ACTIVE does NOT mean the world is on screen, and a fixed delay is not a substitute for
// checking. Measured on JKA yavin1 with soak.mjs: draws/frame sits at **2** for the first ninety
// seconds -- the opening scripted sequence, drawing essentially one quad at 125fps -- and only
// then jumps to 204. Sampling 12s after CA_ACTIVE (which is what this did) measured that blank
// window and concluded "entities are not reaching the renderer" on a perfectly healthy build.
// JK2's kejim_post has the same shape with its ~70s text crawl.
//
// So wait for the renderer to actually be drawing the world before measuring anything.
const drawRate = async () => {
  const a = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  await sleep(2000);
  const b = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  const A = JSON.parse(a || '{}'), B = JSON.parse(b || '{}');
  const f = (B.r || 0) - (A.r || 0);
  return f > 0 ? ((B.d || 0) - (A.d || 0)) / f : 0;
};
// A bare threshold is not enough either. JK2 kejim_post crossed ">20 draws/frame" at 31 while
// still inside its opening sequence -- and with entities disabled that same moment measured 2
// draws/frame, i.e. the WORLD was not being drawn at all, only a handful of entities. Wait for
// the draw rate to plateau instead: rising means the scene is still coming up.
let rendering = 0, prev = -1, stable = 0;
for (let i = 0; i < 90; i++) {
  rendering = await drawRate();
  if (rendering > 20 && prev > 20 && Math.abs(rendering - prev) <= 0.2 * Math.max(rendering, prev)) {
    if (++stable >= 2) break;
  } else {
    stable = 0;
  }
  prev = rendering;
}
console.log(`world on screen: ${rendering.toFixed(0)} draws/frame (plateaued after ${stable >= 2 ? 'settling' : 'TIMEOUT'})`);
if (rendering <= 20) {
  console.log('FAIL: the world never started rendering (still ' + rendering.toFixed(0) + ' draws/frame)');
  ws.close(); chrome.kill(); process.exit(1);
}

// --- 1. what loaded ------------------------------------------------------
await exec(`echo ###IDT3MODELS`);
await exec('modellist');
await sleep(2500);
const all = await ring();
let cut = -1;
for (let i = all.length - 1; i >= 0; i--) if (all[i].includes('###IDT3MODELS')) { cut = i; break; }
const list = cut >= 0 ? all.slice(cut) : all;
const bad  = list.filter(l => /MOD_BAD/.test(l));
const glm  = list.filter(l => /\.glm\b/i.test(l));
const gla  = list.filter(l => /\.gla\b/i.test(l));
const totalLine = list.find(l => /Total models/i.test(l)) || '(no total line)';

console.log(`\n===== ${MAP}: models =====`);
console.log(`modellist lines      : ${list.length}`);
console.log(`Ghoul2 meshes (.glm) : ${glm.length}`);
console.log(`Ghoul2 skeletons(.gla): ${gla.length}`);
console.log(`MOD_BAD (failed)     : ${bad.length}`);
for (const l of bad.slice(0, 10)) console.log('   ' + l.trim());
console.log(`total                : ${totalLine.trim()}`);
// MOD_BAD is NOT automatically a failure, and asserting on it was wrong. Every MOD_BAD seen on
// JKA t1_sour -- models/players/player/model.glm, models/weapons2/saber/saber_w_hand.md3,
// models/weapons2/noweap/noweap_w.glm -- was checked against the mounted retail pk3s and is
// present in NONE of them. The engine probes for optional assets, does not find them, and caches
// the miss as MOD_BAD; a desktop install does exactly the same. Listing them is useful (a NEW one
// appearing is worth noticing), failing on them is not.
//
// The real assertions are that the Ghoul2 pipeline produced something: a character mesh and a
// skeleton. Those cannot be "expected to be missing" on a map with NPCs in it.
if (!glm.length) { ok = false; console.log('   ^ no Ghoul2 mesh (.glm) loaded at all — the character pipeline is not running'); }
if (!gla.length) { ok = false; console.log('   ^ no Ghoul2 skeleton (.gla) loaded — nothing can be animated'); }

// --- 2. are entities actually drawn -------------------------------------
// Pixels cannot answer this. Two attempts proved it: on t1_sour the r_drawentities A/B showed an
// 80.3% "effect" against a 79.8% noise floor, and on yavin1 22.2% against 29.7% -- in both cases
// the scene drifted on its own by as much as the cvar changed it, and `timescale 0.01` did not
// hold it still either (23.8% drift between two idle captures). A pixel A/B on an animated scene
// is not a measurement.
//
// So ask the renderer for its own counters. r_speeds 1 prints, every frame,
// "%i/%i shdrs/srfs %i leafs %i vrts %i/%i tris ..." (R_PerformanceCounters, tr_cmds.cpp:23)
// straight from backEnd.pc. Entities contribute surfaces and triangles, so turning them off
// drops both counts by a large, discrete amount that ambient animation cannot imitate.
if (TP === '1') await exec('cg_thirdperson 1');
await sleep(2500);

const dpf = async label => {
  const a = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  await sleep(6000);
  const b = await evalv('JSON.stringify({r:window.__raf,d:window.__draws})');
  const A = JSON.parse(a || '{}'), B = JSON.parse(b || '{}');
  const frames = (B.r || 0) - (A.r || 0), draws = (B.d || 0) - (A.d || 0);
  return { frames, draws, per: frames > 0 ? draws / frames : 0, label };
};

await exec('r_drawentities 1'); await sleep(2000);
const on  = await dpf('entities on');
await exec('r_drawentities 0'); await sleep(2000);
const off = await dpf('entities off');
await exec('r_drawentities 1'); await sleep(2000);
const back = await dpf('entities on again');

console.log(`
draws/frame  entities on  : ${on.per.toFixed(1)}   (${on.frames} frames)`);
console.log(`draws/frame  entities off : ${off.per.toFixed(1)}   (${off.frames} frames)`);
console.log(`draws/frame  restored     : ${back.per.toFixed(1)}   (${back.frames} frames)`);
if (!on.frames || !off.frames) {
  ok = false;
  console.log('   ^ no frames were produced — cannot measure');
} else if (!(on.per > off.per + 1)) {
  ok = false;
  console.log('   ^ disabling entities did not reduce the per-frame GL draw count —');
  console.log('     entities are not reaching the renderer');
} else {
  console.log(`   entities render: ${(on.per - off.per).toFixed(1)} draw calls per frame come from entities`);
}

console.log(ok ? `
PASS: models loaded and entities reach the renderer (${MAP})`
               : `
FAIL: ${MAP}`);
ws.close(); chrome.kill(); process.exit(ok ? 0 : 1);
