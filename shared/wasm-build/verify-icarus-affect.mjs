// Regression guard for the ICARUS affect() registration race.
//
// WHAT IT CATCHES
// ICARUS_InitEnt() registers an entity's script_targetname in the map that affect("<name>") resolves
// through. For NPCs that call lives in NPC_Spawn_Go/NPC_Begin, a few frames after the entity string
// is parsed. The level scriptrunner is fired by the player's spawn-point targets, so its timing
// follows how fast the client finishes loading - and on a warm reload it can beat NPC registration.
//
// CSequencer::ParseAffect() does not fail when the lookup misses. It fast-forwards over the WHOLE
// affect block and returns SEQ_OK, so the script "succeeds" with a chunk silently missing. That is
// how a cutscene ran its own camera commands, dropped every actor block, and finished without ever
// reaching camera( DISABLE ) - leaving in_camera set, which makes GameAllowedToSaveHere() false and
// UI_SetActiveMenu return at its first line, so ESC stops opening the in-game menu.
//
// WHY THIS EXISTS AS ITS OWN TEST
// Two other candidates were tried and rejected, both for measured reasons:
//   * map-sweep.mjs - loads each map once with `map <name>`; measured 0 skips even with the fix
//     removed, so it does not exercise the race at all.
//   * verify-menu.mjs - its same-map reload DID fail 4/4 when the bug was live, but re-measured
//     later it passed with the fix removed. Timing drifted; a race is not a reliable oracle.
// This probe reproduces it deterministically: with the fix removed the JK2 port reports 28 skipped blocks on
// kejim_post with the fix removed, and 0 with it restored. No JKA map has been observed to trigger
// it, so here this is a guard against regression rather than a reproduction of a seen failure.
//
// DO NOT judge this by the menu symptom. Measured without the fix, the menu sometimes still opens
// while 28 blocks were dropped - the skipping is reliable, the symptom is not. Count the blocks.
//
// The engine prints the warning unconditionally (icarus/Sequencer.cpp). It is deliberately NOT gated
// behind g_ICARUSDebug, which defaults to 0 and suppresses every ICARUS error and warning - that
// silence is what hid this bug in the first place, and this test depends on it staying unsilenced.
//
//   node verify-icarus-affect.mjs <httpPort> [map]
import { CHROME, tmpProfile, guardChrome } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2] || '8794';
const MAP  = process.argv[3] || 't1_sour';
const CDP  = 9400 + (process.pid % 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-affect-' + process.pid)}`, 'about:blank']);
guardChrome(chrome, 'verify-icarus-affect.mjs');

const get = (p) => new Promise((res, rej) => http.get({ port: CDP, path: p }, (r) => {
  let d = ''; r.on('data', (x) => (d += x)); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));

let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find((x) => x.type === 'page'); } catch {} }
if (!pg) { console.log('FAIL: no debuggable page'); process.exit(1); }

const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise((r) => {
  const i = ++id, h = (x) => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } };
  ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p }));
});
await new Promise((r) => ws.on('open', r));
await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.navigate', { url: `http://localhost:${PORT}/index.html?args=` + encodeURIComponent('+set sv_pure 0 +devmap ' + MAP) });

const ev = async (e) => { try { const r = await S('Runtime.evaluate', { expression: e, returnByValue: true }); return r && r.result ? r.result.value : undefined; } catch { return undefined; } };
const state = async () => { const v = await ev(`(function(){try{return Module.ccall('idt3_client_state','number',[],[]);}catch(e){return -1;}})()`); return typeof v === 'number' ? v : -1; };
const exec = (c) => ev(`(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(c)}]);return 1;}catch(e){return 0;}})()`);
const ring = async () => String((await ev('String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : "")')) || '').split('\n');
const skipsIn = (lines) => lines.filter((l) => /invalid affect\(\) target/i.test(l));

const CA_ACTIVE = 7;
const settle = async (label) => {
  for (let i = 0; i < 120; i++) { await sleep(1000); if (((await state()) & 0xff) === CA_ACTIVE) return true; }
  console.log(`FAIL: never reached gameplay (${label})`);
  return false;
};

if (!await settle('first load')) { (globalThis.__idt3_done = true, chrome.kill()); process.exit(1); }
await sleep(6000);
const cold = skipsIn(await ring());
console.log(`first load          : ${cold.length} skipped affect block(s)`);

// The warm reload is the trigger: the client is already connected, so the scriptrunner fires earlier
// in level time relative to NPC registration.
await exec(`devmap ${MAP}`);
if (!await settle('reload')) { (globalThis.__idt3_done = true, chrome.kill()); process.exit(1); }
await sleep(10000);
const warm = skipsIn(await ring());
console.log(`after warm reload   : ${warm.length} skipped affect block(s) (cumulative)`);
for (const l of warm.slice(0, 6)) console.log('   ' + l.replace(/\^[0-9]/g, '').trim());

const bad = warm.length > 0;
console.log(bad
  ? `\nFAIL: ${warm.length} affect() block(s) skipped - ICARUS script silently did not run`
  : '\nPASS: no affect() block was skipped on a warm reload');
ws.close(); (globalThis.__idt3_done = true, chrome.kill());
process.exit(bad ? 1 : 0);
