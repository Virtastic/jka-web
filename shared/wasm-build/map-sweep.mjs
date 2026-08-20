// Load a list of maps one after another in a single browser session and report, per map,
// whether it reached gameplay and what the engine complained about.
//
// Why a sweep and not one map: content-specific faults (a missing shader, a model the loader
// chokes on, a script that never hands over control) are invisible when you only ever boot the
// same level. This drives `map <name>` through the engine's own command buffer, so there is no
// page reload between maps and the whole set costs one boot.
//
//   node map-sweep.mjs <httpPort> "<map1,map2,...>" [secPerMap] [bootArgs]
//
// Per map it prints: control state from idt3_client_state(), plus every ^1/^3-coloured or
// "couldn't/failed/not found" line the engine emitted while that map was loading.
import { CHROME, tmpProfile, guardChrome } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2] || '8794';
const MAPS = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean);
const SEC = parseInt(process.argv[4] || '45', 10);
const BOOT = process.argv[5] || '+set sv_pure 0';
if (!MAPS.length) { console.error('usage: map-sweep.mjs <httpPort> "<map1,map2,...>" [secPerMap] [bootArgs]'); process.exit(2); }

const CDP = 9200 + (process.pid % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-sweep-' + process.pid)}`, 'about:blank']);
guardChrome(chrome, 'map-sweep.mjs');
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
await S('Page.navigate', { url: `http://localhost:${PORT}/index.html?args=` + encodeURIComponent(BOOT) });

const evalv = async expr => { try { const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true }); return r && r.result ? r.result.value : undefined; } catch { return undefined; } };
const ring = async () => String(await evalv('String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : "")') || '').split('\n');
const exec = async line => { await evalv(`(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(line)}]);return 1;}catch(e){return 0;}})()`); };
// Wasm linear memory + function-table size. Each dlopen of a side module allocates data/bss
// out of the heap and appends table entries; emscripten has no true unload, so anything the
// engine reloads per map shows up here as a staircase.
const mem = async () => {
  const v = await evalv(`(function(){ try {
    var h = (typeof HEAPU8 !== 'undefined' && HEAPU8) ? HEAPU8.length : (Module.HEAPU8 ? Module.HEAPU8.length : 0);
    var t = (typeof wasmTable !== 'undefined' && wasmTable) ? wasmTable.length : 0;
    return h + ':' + t;
  } catch(e) { return '0:0'; } })()`);
  return String(v || '0:0');
};
const state = async () => { const v = await evalv(`(function(){try{return Module.ccall('idt3_client_state','number',[],[]);}catch(e){return -1;}})()`); return typeof v === 'number' ? v : -1; };

// Wait for the engine to come up at all before issuing map commands.
for (let i = 0; i < 90; i++) { await sleep(1000); if ((await ring()).some(l => /Com_Init|finished R_Init|FS_Startup/i.test(l))) break; }
// A trusted click so the AudioContext resumes, as a real player's first click would.
for (const t of ['mousePressed', 'mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: 640, y: 360, button: 'left', clickCount: 1, buttons: 1 });

const CA_ACTIVE = 7;
const NOISE = /\^1|\^3|WARNING|couldn't|could not|failed|not found|NOT PRECACHED|ERROR|RuntimeError|Aborted|undefined symbol/i;
const results = [];
// Per-map log attribution by MARKER, not by index. index.html's ring is capped at 2000 lines
// and shifts when full, so `lines.slice(indexBefore)` silently re-shows old lines once a sweep
// saturates it -- which made a diagnostic print from map 1 look like it came from map 15 and
// sent an entire investigation down the wrong path. `echo` is an engine command, so the marker
// lands in the same ring in the right order.
for (const map of MAPS) {
  const MARK = `###IDT3SWEEP ${map}`;
  await exec(`echo ${MARK}`);
  await exec(`map ${map}`);
  let active = false;
  for (let i = 0; i < SEC; i++) {
    await sleep(1000);
    const st = await state();
    if ((st & 0xff) === CA_ACTIVE) { active = true; if (i > 4) break; }
  }
  const all = await ring();
  const at = all.lastIndexOf(all.find(l => l.includes(MARK)) || '');
  const lines = at >= 0 ? all.slice(at) : all;
  const loaded = lines.some(l => /loaded \d+ faces/i.test(l));
  const noise = [...new Set(lines.filter(l => NOISE.test(l)).map(l => l.replace(/\^[0-9]/g, '').trim()))];
  // SWEEP_GREP=<regex> also echoes matching engine lines per map -- handy when chasing a
  // fault that only shows up after N map loads and you need to watch one specific print.
  if (process.env.SWEEP_GREP) {
    const re = new RegExp(process.env.SWEEP_GREP, 'i');
    for (const l of lines.filter(l => re.test(l))) console.log('      > ' + l.trim());
  }
  // A skipped affect() block is a HARD failure, not noise.
  //
  // ParseAffect fast-forwards over an affect block whose target it cannot resolve and returns
  // SEQ_OK, so script the map author wrote silently does not run. That is what shut the in-game
  // menu: a cutscene dropped its actor blocks and never reached camera( DISABLE ). Registering
  // NPCs at spawn narrows the window that causes it but does not close it - the registration
  // still lands a few frames in, not at parse time.
  //
  // THIS SWEEP DOES NOT REPRODUCE THAT RACE - measured: 0 skips here even with the fix
  // removed, because loading each map once with `map <name>` does not recreate the warm-reload
  // timing. verify-icarus-affect.mjs is the actual guard, and it is proven in both directions
  // (28 skips without the fix, 0 with it). This check is a cheap net for anywhere else it might
  // surface, not the guarantee. The engine prints the warning unconditionally
  // (icarus/Sequencer.cpp), not behind the ICARUS debug cvar, so both can rely on seeing it.
  const affectSkips = lines.filter(l => /invalid affect\(\) target/i.test(l));
  results.push({ map, loaded, active, noise, affectSkips });
  if (affectSkips.length) {
    console.log(`      !! ${affectSkips.length} SKIPPED affect() block(s) - script did not run:`);
    for (const l of affectSkips.slice(0, 4)) console.log('         ' + l.trim());
  }
  const [hb, tb] = (await mem()).split(':').map(Number);
  console.log(`${loaded && active ? 'OK  ' : 'FAIL'} ${map.padEnd(14)} loaded=${loaded} active=${active} issues=${noise.length}` + ` heap=${(hb/1048576).toFixed(1)}MB table=${tb}`);
  for (const n of noise.slice(0, 6)) console.log(`        ${n}`);
}
const bad = results.filter(r => !(r.loaded && r.active) || r.affectSkips.length);
console.log(`\n===== ${results.length} maps, ${results.length - bad.length} OK, ${bad.length} FAILED =====`);
if (bad.length) console.log('failed: ' + bad.map(r => r.map).join(', '));
const skipped = results.filter(r => r.affectSkips.length);
if (skipped.length)
  console.log('affect() blocks skipped on: ' + skipped.map(r => `${r.map} (${r.affectSkips.length})`).join(', '));
const allNoise = [...new Set(results.flatMap(r => r.noise))];
console.log(`distinct engine complaints across the sweep: ${allNoise.length}`);
for (const n of allNoise) console.log('  ' + n);
ws.close(); (globalThis.__idt3_done = true, chrome.kill()); process.exit(bad.length ? 1 : 0);
