// RTCW-SP savegame round-trip. This is the highest-risk 1:1 area that free data
// can actually exercise: savegames are a big binary blob written through
// trap_FS_FOpenFile to fs_homepath, which under wasm is IDBFS-backed /userdata.
// Endianness, struct packing, pointer-size and async-FS bugs all surface here.
//
// Proof: park at a known origin, /savegame, walk away, /loadgame, and require
// the engine to report the SAVED origin again -- not the walked-away one.
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const PORT = 9237;
const URL_ = 'http://localhost:8790/index.html?args=' + encodeURIComponent('+set com_introplayed 1 +set cg_viewsize 100 +spdevmap escape1');
const c = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  '--user-data-dir=/tmp/idt3-rtcw-save', 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r)); await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.addScriptToEvaluateOnNewDocument', { source: "window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));window.addEventListener('error',e=>window.__l.push('PAGEERR: '+e.message+'\\nSTACK:\\n'+((e.error&&e.error.stack)||'(no stack)')))" });
await S('Page.navigate', { url: URL_ });

const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
for (let i = 0; i < 60; i++) { await sleep(2000); if (/CL_InitCGame/.test((await logs()).join('\n'))) break; }
await sleep(14000);

const key = async (k, code, which) => {
  for (const t of ['keydown', 'keyup'])
    await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(t)},{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(140);
};
// A console line with no leading '/' is CHAT, not a command (con_autochat).
const consoleCmd = async (line) => {
  await key('`', 'Backquote', 192); await sleep(500);
  for (const ch of line) {
    const code = ch === ' ' ? 'Space' : ch === '/' ? 'Slash'
      : (/[0-9]/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase());
    await key(ch, code, ch === '/' ? 191 : ch.toUpperCase().charCodeAt(0));
  }
  await key('Enter', 'Enter', 13); await sleep(600);
  await key('`', 'Backquote', 192); await sleep(900);
};
const viewpos = async (tag) => {
  await consoleCmd('/viewpos');
  const l = await logs();
  const line = (l.filter(x => /\(-?\d+ -?\d+ -?\d+\)/.test(x)).slice(-1)[0] || '(none)');
  const m = /\((-?\d+) (-?\d+) (-?\d+)\)/.exec(line);
  console.log('VIEWPOS ' + tag + ': ' + line.slice(0, 60));
  return m ? [ +m[1], +m[2], +m[3] ] : null;
};
const hold = async (k, code, which, ms) => {
  await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(ms);
  await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(700);
};
// escape1 opens on the UIMENU_PREGAME mission briefing; until it is dismissed the
// player is not spawned and ps.origin reads (0 0 0) -- which looks exactly like a
// broken engine but is just a menu. pregame.menu's but2_alt carries
// `uiScript playerstart` at rect 560 420 80 60; hovering but2 reveals it.
const box = JSON.parse((await S('Runtime.evaluate', { returnByValue: true, expression: `(function(){
  var c = Module.canvas || document.getElementById('canvas');
  c.style.setProperty('width','100vw','important'); c.style.setProperty('height','100vh','important');
  c.style.setProperty('object-fit','contain','important');
  var l = document.getElementById('load'); if (l) l.remove();
  var b = c.getBoundingClientRect();
  var vw = Math.min(b.width, window.innerWidth), vh = Math.min(b.height, window.innerHeight);
  var a = c.width / c.height, w = vw, h = vw / a;
  if (h > vh) { h = vh; w = vh * a; }
  return JSON.stringify([b.left + (vw - w) / 2, b.top + (vh - h) / 2, w, h]);
})()` })).result.value);
// The UI cursor moves on SE_MOUSE *relative* deltas; movementX/Y are read-only and
// must be defined on the event (CDP's mouseMoved reports 0,0).
const uiMove = async (dx, dy) => {
  await S('Runtime.evaluate', { expression: `(function(){
    var e = new MouseEvent('mousemove', {bubbles:true});
    Object.defineProperty(e,'movementX',{value:${dx}}); Object.defineProperty(e,'movementY',{value:${dy}});
    window.dispatchEvent(e);
  })()` });
  await sleep(150);
};
const cdpClick = async (x, y) => {
  for (const t of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(1500);
};
{
  const ax = Math.round(box[0] + box[2] * (600 / 640)), ay = Math.round(box[1] + box[3] * (450 / 480));
  await uiMove(600, 450); await sleep(600);
  await cdpClick(ax, ay); await sleep(2500);
  await cdpClick(ax, ay); await sleep(9000);
}

// Walk somewhere non-trivial so the saved origin is distinctive.
await hold('w', 'KeyW', 87, 1800);
const saved = await viewpos('at save');

await consoleCmd('/savegame test1');
await sleep(3000);

// The savegame must actually exist on the emscripten FS (fs_homepath=/userdata).
const onDisk = await S('Runtime.evaluate', { returnByValue: true, expression: `(function(){
  var out = [];
  (function walk(d){
    var ents; try { ents = FS.readdir(d); } catch(e){ return; }
    ents.forEach(function(n){
      if (n === '.' || n === '..') return;
      var p = (d === '/' ? '' : d) + '/' + n, st;
      try { st = FS.stat(p); } catch(e){ return; }
      if (FS.isDir(st.mode)) walk(p);
      else if (/save/i.test(p)) out.push(p + ' (' + st.size + ' bytes)');
    });
  })('/userdata');
  return JSON.stringify(out);
})()` });
console.log('SAVE FILES:', onDisk.result && onDisk.result.value);

// Walk well away from the saved spot, then prove we get teleported back.
await hold('s', 'KeyS', 83, 2600);
const moved = await viewpos('after walking away');

await consoleCmd('/loadgame test1');
await sleep(20000);
for (let i = 0; i < 20; i++) { await sleep(2000); if (/CL_InitCGame/.test((await logs()).slice(-40).join('\n'))) break; }
await sleep(6000);
const restored = await viewpos('after load');

const near = (a, b, tol) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const walkedAway = saved && moved && !near(saved, moved, 24);
const cameBack   = near(saved, restored, 24);
console.log('\n===== RTCW-SP SAVE/LOAD =====');
console.log('saved at      : ' + JSON.stringify(saved));
console.log('walked away to: ' + JSON.stringify(moved) + (walkedAway ? '  (distinct ✓)' : '  (NOT distinct — test is inconclusive)'));
console.log('after load    : ' + JSON.stringify(restored));
console.log('VERDICT: ' + (cameBack && walkedAway ? 'PASS — load restored the saved origin'
  : !walkedAway ? 'INCONCLUSIVE — never left the save spot'
  : 'FAIL — load did not restore the saved origin'));
const all = await logs();
fs.writeFileSync('/tmp/rtcw-save.log', all.join('\n'));
console.log('save/load log lines:\n' + all.filter(x => /savegame|loadgame|gamesaved|Can't find|Error/i.test(x)).slice(-8).join('\n'));
const sh = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/rtcw-save.png', Buffer.from(sh.data, 'base64'));
ws.close(); c.kill(); process.exit(0);
