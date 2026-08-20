// Frozen-frame cvar A/B harness.
//
// Why this exists: comparing one screenshot from run X against one from run Y is useless
// here. Every run lands at a slightly different moment of the scene, so the camera never
// frames identically, and the resulting pixel differences swamp whatever you were trying
// to measure. Measured directly: two runs with IDENTICAL settings differed by 23 vs 17
// columns on the same metric — larger than any effect being chased.
//
// So: boot once, reach the scene, then `timescale 0` to freeze the world, and toggle cvars
// live at the console within that single frozen frame. Same camera, same animation pose,
// same everything — any pixel that changes is caused by the cvar and nothing else.
//
//   GPU=1 node cvar-ab.mjs <port> "<+bootargs>" <outDir> <settleSec> "cvar:test:default|..."
// e.g.
//   GPU=1 node cvar-ab.mjs 8794 "+devmap yavin1" C:/dev/shots/ab 130 \
//        "r_drawentities:0:1|r_flares:0:1|cg_shadows:0:1|cg_g2Marks:0:1|r_dynamiclight:0:1"
//
// Cheat-protected cvars (r_drawentities, r_showtris, timescale) need +devmap, not +map.
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.argv[2] || '8794';
const ARGS = process.argv[3] || '+devmap yavin1';
const OUTDIR = process.argv[4] || 'C:/dev/shots/ab';
const SETTLE = parseInt(process.argv[5] || '130', 10);
const SPECS = (process.argv[6] || 'r_drawentities:0:1').split('|').filter(Boolean);
const RUNID = process.pid;
const CDP = 9300 + (RUNID % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUTDIR, { recursive: true });

const gpuFlags = process.env.GPU === '1'
  ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--enable-unsafe-swiftshader'];
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', ...gpuFlags,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--hide-scrollbars',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile(`idt3-ab-${RUNID}`)}`, 'about:blank']);

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
await S('Page.navigate', { url: `http://localhost:${PORT}/index.html?args=` + encodeURIComponent(ARGS) });

const ring = async () => (await S('Runtime.evaluate', { expression: 'String(window.__idt3_dumpLog?window.__idt3_dumpLog():"")', returnByValue: true })).result.value || '';
for (let i = 0; i < 150; i++) { await sleep(1000); if (/loaded \d+ faces/i.test(await ring())) break; }
console.log('map loaded; settling ' + SETTLE + 's to reach the scene…');
await sleep(SETTLE * 1000);

// --- command channel ------------------------------------------------------------
// Commands go straight into the engine's command buffer via the exported idt3_exec_cmd.
// The previous approach (synthesising console keystrokes) was unusable: SP pauses while
// the console is open, so a missed closing toggle stopped frame production entirely and
// every later capture came back byte-identical — indistinguishable from "the cvar did
// nothing". Two bisection runs were silently invalidated that way before this existed.
const exec = async (line) => {
  const r = await S('Runtime.evaluate', { returnByValue: true, expression:
    `(function(){ try { Module.ccall('idt3_exec_cmd', null, ['string'], [${JSON.stringify(line)}]); return 'ok'; }
                  catch(e){ return 'ERR: ' + e; } })()` });
  const v = r.result && r.result.value;
  if (v !== 'ok') throw new Error('exec("' + line + '") failed: ' + v);
  await sleep(450);
};

const shot = async (name) => {
  const b = Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  fs.writeFileSync(path.join(OUTDIR, name), b);
  return b;
};

// Freeze the world so every later capture shares one camera + animation pose.
// timescale 0 does NOT work here: it stops the engine producing frames at all, so the
// canvas keeps showing the last composed frame and no later cvar change can ever appear
// (observed: five different cvars all yielding byte-identical captures, including
// r_drawworld 0 which would blank the level). Crawl time instead — the render loop keeps
// running while the camera advances ~20ms over a whole test, which is visually static.
console.log('slowing scene to a crawl (timescale 0.01)…');
await exec('timescale 0.01');
await sleep(800);

// Confirm the freeze actually took: two captures a second apart must be identical.
const f1 = await shot('_freeze_check_a.png');
await sleep(1200);
const f2 = await shot('_freeze_check_b.png');
console.log('freeze check: captures ' + (Buffer.compare(f1, f2) === 0
  ? 'byte-identical (engine may have stopped rendering — verify cvars actually take effect)'
  : 'differ slightly (expected: rendering live, camera crawling)'));

await shot('00-baseline.png');
console.log('baseline captured');

for (let i = 0; i < SPECS.length; i++) {
  const [cvar, testVal, defVal] = SPECS[i].split(':');
  await exec(`${cvar} ${testVal}`);
  await sleep(500);
  // Sanitise: the value goes into a FILENAME, and values like `/` or `*` (perfectly legal
  // cvar contents, and exactly what a shader-name bisect needs) produced an unopenable
  // path and killed the run mid-sweep.
  const safe = String(testVal).replace(/[^A-Za-z0-9._-]+/g, '_') || 'x';
  await shot(`${String(i + 1).padStart(2, '0')}-${cvar}_${safe}.png`);
  await exec(`${cvar} ${defVal}`);              // restore before the next test
  await sleep(400);
  console.log(`tested ${cvar} ${testVal}`);
}

console.log('done ->', OUTDIR);
ws.close(); chrome.kill(); process.exit(0);
