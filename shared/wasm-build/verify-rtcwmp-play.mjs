// RTCW-MP playability test on the free MP demo data (mp_beach).
// Joins Axis as a soldier, then proves movement the same way the SP/ET harnesses
// do: read the engine's own reported origin before and after holding W.
//
// Cmd_Team_f takes: team <r|b> <ptype> <weap> <pistol> <grenade> <skinnum>
// and, as in Wolf:ET, a console line WITHOUT a leading '/' is sent as CHAT.
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const PORT = 9239;
const MAP = process.env.MP_MAP || 'mp_beach';
const URL_ = 'http://localhost:8791/index.html?args=' + encodeURIComponent(`+set sv_pure 0 +set cg_viewsize 100 +devmap ${MAP}`);
const c = execFile(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  '--user-data-dir=' + tmpProfile('idt3-rtcwmp-play'), 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r)); await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.addScriptToEvaluateOnNewDocument', { source: "window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));window.addEventListener('error',e=>window.__l.push('PAGEERR: '+e.message+' '+((e.error&&e.error.stack)||'')))" });
await S('Page.navigate', { url: URL_ });

const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const l = await logs();
  if (i % 6 === 0) console.log('t+' + i * 2 + 's: ' + l.slice(-2).join(' | ').slice(0, 130));
  if (/CL_InitCGame/.test(l.join('\n'))) break;
}
await sleep(14000);

// Fill the viewport and drop the loading overlay, and work out the REAL content
// box: the canvas is 100vw x 100vh but object-fit:contain letterboxes the 4:3
// frame inside it, so getBoundingClientRect() overstates the drawn area.
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
await sleep(2000);
let s = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(tmpProfile('rtcwmp-limbo.png'), Buffer.from(s.data, 'base64'));

const key = async (k, code, which) => {
  for (const t of ['keydown', 'keyup'])
    await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(t)},{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(140);
};
const consoleCmd = async (line) => {
  await key('`', 'Backquote', 192); await sleep(600);
  for (const ch of line) {
    const code = ch === ' ' ? 'Space' : ch === '/' ? 'Slash'
      : (/[0-9]/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase());
    await key(ch, code, ch === '/' ? 191 : ch.toUpperCase().charCodeAt(0));
  }
  await key('Enter', 'Enter', 13); await sleep(800);
  await key('`', 'Backquote', 192); await sleep(1200);
  console.log('cmd:', line);
};
// Match ONLY viewpos's own format -- "(x y z) : yaw". A bare /\(x y z\)/ also
// matches map warnings like "func_timer at (3244 2212 1384) has random >= wait",
// which made before/after identical and reported a confident, wrong "MOVED: NO".
// Also anchor to lines emitted AFTER the command, not anywhere in the log.
const VIEWPOS_RE = /\((-?\d+) (-?\d+) (-?\d+)\)\s*:\s*-?\d+/;
const viewpos = async (tag) => {
  const mark = (await logs()).length;
  await consoleCmd('/viewpos');
  const fresh = (await logs()).slice(mark);
  const line = (fresh.filter(x => VIEWPOS_RE.test(x)).slice(-1)[0] || '(none)');
  const m = VIEWPOS_RE.exec(line);
  console.log('VIEWPOS ' + tag + ': ' + line.slice(0, 60));
  return m ? [ +m[1], +m[2], +m[3] ] : null;
};
const hold = async (k, code, which, ms) => {
  await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(ms);
  await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(700);
};

// Join Axis as a soldier with an MP40. A trusted click first: the browser only
// starts an AudioContext on a real user gesture (JS-synthesized ones don't count).
for (const t of ['mousePressed', 'mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: Math.round(box[0] + box[2] / 2), y: Math.round(box[1] + box[3] / 2), button: 'left', clickCount: 1, buttons: 1 });
await sleep(1500);
await consoleCmd('/team r 1 8 0 0 0');
await sleep(9000);
s = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(tmpProfile('rtcwmp-play.png'), Buffer.from(s.data, 'base64'));

const before = await viewpos('before');
await hold('w', 'KeyW', 87, 2500);
const after = await viewpos('after');
s = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(tmpProfile('rtcwmp-moved.png'), Buffer.from(s.data, 'base64'));

// WEAPON FIRE: the MP soldier spawns with an MP40. Hold +attack (K_MOUSE1) and prove
// the HUD clip-ammo digits change. Crop just the digits from the letterboxed content
// box (same method as RTCW-SP) and compare PNG bytes — identical pixels encode
// identically, so a byte difference is a pixel difference.
const ammoShot = async () => {
  const clip = { x: Math.round(box[0] + box[2] * 0.80), y: Math.round(box[1] + box[3] * 0.925),
                 width: Math.round(box[2] * 0.06), height: Math.round(box[3] * 0.06), scale: 1 };
  return (await S('Page.captureScreenshot', { format: 'png', clip })).data;
};
const cx = Math.round(box[0] + box[2] / 2), cy = Math.round(box[1] + box[3] / 2);
const ammoBefore = await ammoShot();
await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
await sleep(900);
await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 0 });
await sleep(700);
const ammoAfter = await ammoShot();
fs.writeFileSync(tmpProfile('rtcwmp-ammo-before.png'), Buffer.from(ammoBefore, 'base64'));
fs.writeFileSync(tmpProfile('rtcwmp-ammo-after.png'), Buffer.from(ammoAfter, 'base64'));
{ const f = await S('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(tmpProfile('rtcwmp-fired.png'), Buffer.from(f.data, 'base64')); }
console.log('FIRED: ' + (ammoBefore !== ammoAfter ? 'YES (ammo HUD changed)' : 'NO/UNCLEAR'));

const snd = await S('Runtime.evaluate', { returnByValue: true, expression: `(function(){
  var x = Module.__idt3_snd;
  if (!x || !x.ctx) return 'NO AUDIO CONTEXT';
  return JSON.stringify({ state: x.ctx.state, rate: x.ctx.sampleRate, peak: x.peak });
})()` });
console.log('AUDIO:', snd.result && snd.result.value);

const near = (a, b, tol) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const moved = before && after && !near(before, after, 8);
console.log('\n===== RTCW-MP (' + MAP + ') =====');
console.log('before: ' + JSON.stringify(before) + '  after: ' + JSON.stringify(after));
console.log('MOVED: ' + (moved ? 'YES' : before ? 'NO' : 'UNKNOWN — no origin readout'));
const all = await logs();
fs.writeFileSync(tmpProfile('rtcwmp-play.log'), all.join('\n'));
const crashes = all.filter(x => /PAGEERR|out of bounds|RuntimeError/i.test(x));
console.log('crashes: ' + (crashes.length ? crashes[0].slice(0, 90) : 'none'));
console.log('KEY: ' + all.filter(x => /pk3 files|CL_InitCGame|entered|Sys_LoadDll|ERROR|Couldn/i.test(x)).slice(-5).join(' | ').slice(0, 240));
console.log('SHOTS: /tmp/rtcwmp-limbo.png /tmp/rtcwmp-play.png /tmp/rtcwmp-moved.png');
ws.close(); c.kill(); process.exit(0);
