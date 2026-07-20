// RTCW-SP playability test: loads the demo pk3, spdevmaps escape1, screenshots.
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const PORT = 9235;
const URL_ = 'http://localhost:8790/index.html?args=' + encodeURIComponent('+set com_introplayed 1 +set cg_viewsize 100 +spdevmap escape1');
const c = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  '--user-data-dir=/tmp/idt3-rtcw-play', 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws').catch(() => ({ default: null }));
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r)); await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.addScriptToEvaluateOnNewDocument', { source: "window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));window.addEventListener('error',e=>window.__l.push('PAGEERR: '+e.message))" });
await S('Page.navigate', { url: URL_ });
let ok = false;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const r = await S('Runtime.evaluate', { expression: 'JSON.stringify((window.__l||[]).slice(-4))', returnByValue: true });
  const l = JSON.parse(r.result.value || '[]');
  if (i % 5 === 0) console.log('t+' + i*2 + 's: ' + l.join(' | ').slice(0, 150));
  const joined = l.join('\n');
  if (/files in pk3 files/.test(joined) && !/0 files in pk3/.test(joined)) ok = true;
  if (/Loading|escape1|CM_LoadMap|R_LoadWorldMap|Com_TouchMemory|finished R_Init/.test(joined)) ok = true;
  if (/CL_InitCGame|entered|SPAWN/i.test(joined)) { ok = true; break; }
}
await sleep(14000);
// Force the canvas to fill the viewport (emscripten pins a small CSS size on it)
// and report what it actually ended up as.
const dim = await S('Runtime.evaluate', { returnByValue: true, expression: `(function(){
  var c = Module.canvas || document.getElementById('canvas');
  c.style.setProperty('width','100vw','important');
  c.style.setProperty('height','100vh','important');
  c.style.setProperty('object-fit','contain','important');
  var l = document.getElementById('load'); if (l) l.remove();
  var r = c.getBoundingClientRect();
  return JSON.stringify({internal: c.width+'x'+c.height, css: Math.round(r.width)+'x'+Math.round(r.height)});
})()` });
console.log('CANVAS:', dim.result && dim.result.value);
await sleep(4000);
const shot = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/rtcw-play.png', Buffer.from(shot.data, 'base64'));
// Dismiss the mission briefing (Escape/Enter/Space) to drop into the 3D level.
const key = async (k, code, which) => {
  for (const t of ['keydown','keyup'])
    await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(t)},{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(600);
};
await S('Runtime.evaluate', { expression: "(Module.canvas||document.getElementById('canvas')).focus()" });
// The briefing's "continue" is the arrow at the bottom-right of the canvas.
const click = async (x, y) => {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const t of ['mousePressed','mouseReleased'])
    await S('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(900);
};
const r = JSON.parse((await S('Runtime.evaluate', { returnByValue: true, expression:
  "(function(){var c=Module.canvas||document.getElementById('canvas');var b=c.getBoundingClientRect();return JSON.stringify([b.left,b.top,b.width,b.height]);})()" })).result.value);
// The engine's menu cursor is driven by SE_MOUSE *relative* deltas (movementX/Y).
// CDP's Input.dispatchMouseEvent doesn't set those, so dispatch DOM MouseEvents
// with movementX/Y to walk the cursor from screen-centre onto the continue arrow.
// NB: movementX/Y are read-only and NOT settable via MouseEventInit — they must be
// defined on the event object, or emscripten reads 0 and the cursor never moves.
const nudge = async (dx, dy) => {
  await S('Runtime.evaluate', { expression: `(function(){
    var c = Module.canvas || document.getElementById('canvas');
    var e = new MouseEvent('mousemove', {bubbles:true});
    Object.defineProperty(e, 'movementX', {value:${dx}});
    Object.defineProperty(e, 'movementY', {value:${dy}});
    c.dispatchEvent(e);
  })()` });
  await sleep(120);
};
const press = async () => {
  // trusted CDP button events at the arrow's on-screen position
  const ax = Math.round(r[0] + r[2] * 0.85), ay = Math.round(r[1] + r[3] * 0.97);
  for (const t of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type: t, x: ax, y: ay, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(1000);
};
// RTCW-SP's briefing runs as UIMENU_PREGAME, which "eats all keys except mouse
// click" (cl_keys.c:1804) — only K_MOUSE1 dismisses it. Dispatch a real mousedown
// on the canvas so emscripten's handler queues SE_KEY/K_MOUSE1.
// The UI hit-tests against its OWN accumulated cursor (moved by SE_MOUSE relative
// deltas), not the event coords — so walk the cursor onto the arrow first.
const nudge2 = async (dx, dy) => {
  await S('Runtime.evaluate', { expression: `(function(){
    var c = Module.canvas || document.getElementById('canvas');
    var e = new MouseEvent('mousemove', {bubbles:true});
    Object.defineProperty(e, 'movementX', {value:${dx}});
    Object.defineProperty(e, 'movementY', {value:${dy}});
    c.dispatchEvent(e);
  })()` });
  await sleep(80);
};
const mouse1 = async () => {
  await S('Runtime.evaluate', { expression: `(function(){
    var c = Module.canvas || document.getElementById('canvas');
    ['mousedown','mouseup'].forEach(function(t){
      c.dispatchEvent(new MouseEvent(t, {bubbles:true, button:0, buttons:1}));
    });
  })()` });
  await sleep(1500);
};
// Use CDP mouse events: Chrome synthesizes TRUSTED events with real movementX/Y,
// which drives both the UI cursor (SE_MOUSE) and the click (SE_KEY/K_MOUSE1).
const cdpMove = async (x, y) => { await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(120); };
const cdpClick = async (x, y) => {
  for (const t of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(1500);
};
// CDP's mouseMoved carries no movementX/Y (verified mv=0,0), so the UI cursor never
// moves. Dispatch a window MouseEvent with movementX/Y defined, then click via CDP.
const uiMove = async (dx, dy) => {
  await S('Runtime.evaluate', { expression: `(function(){
    var e = new MouseEvent('mousemove', {bubbles:true});
    Object.defineProperty(e, 'movementX', {value:${dx}});
    Object.defineProperty(e, 'movementY', {value:${dy}});
    window.dispatchEvent(e);
  })()` });
  await sleep(150);
};
// pregame.menu: but2_alt has `action { uiScript playerstart }` at rect 560 420 80 60.
// Hovering it (mouseEnter on but2) reveals but2_alt; clicking it starts the level.
// Cursor starts at 0,0 -> move to the rect centre (600,450), let mouseEnter run, click.
const ax = Math.round(r[0] + r[2] * (600 / 640)), ay = Math.round(r[1] + r[3] * (450 / 480));
await uiMove(600, 450);
await sleep(600);            // let mouseEnter swap in but2_alt
await cdpClick(ax, ay);
await sleep(2500);
await cdpClick(ax, ay);      // second click in case the first only armed the hover
await sleep(9000);
const shot2 = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/rtcw-ingame.png', Buffer.from(shot2.data, 'base64'));
console.log('INGAME SHOT: /tmp/rtcw-ingame.png');
// Audio: is the context running, and is the engine actually mixing non-silence?
const snd = await S('Runtime.evaluate', { returnByValue: true, expression: `(function(){
  var s = Module.__idt3_snd;
  if (!s || !s.ctx) return 'NO AUDIO CONTEXT';
  return JSON.stringify({ state: s.ctx.state, rate: s.ctx.sampleRate, playCursor: s.pos, peak: s.peak });
})()` });
console.log('AUDIO:', snd.result && snd.result.value);

// MOVEMENT: hold W and prove the engine's own reported origin changes.
const readLogs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
const consoleCmd = async (line) => {
  await key('`', 'Backquote', 192);
  await sleep(500);
  for (const ch of line) {
    const code = ch === ' ' ? 'Space' : ch === '/' ? 'Slash'
      : (/[0-9]/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase());
    const which = ch === '/' ? 191 : ch.toUpperCase().charCodeAt(0);
    await key(ch, code, which);
  }
  await key('Enter', 'Enter', 13);
  await sleep(600);
  await key('`', 'Backquote', 192);
  await sleep(900);
};
// NB: a bare console line without a leading '/' is sent as CHAT (cl_console
// autochat), so the game never sees it as a command — 'where' arrived as
// "WolfPlayer: viewpos". The slash forces command interpretation.
// (NB: the game-side 'where' cmd is useless here — it prints ent->s.origin,
//  which BG_PlayerStateToEntityState never fills for players. That is an
//  original id bug, faithfully reproduced. cgame's 'viewpos' reads ps.origin.)
const viewpos = async (tag) => {
  await consoleCmd('/viewpos');
  const l = await readLogs();
  const line = l.filter(x => /\(-?\d+ -?\d+ -?\d+\)/.test(x)).slice(-1)[0] || '(none)';
  console.log('VIEWPOS ' + tag + ': ' + line.slice(0, 80));
  return line;
};
const hold = async (k, code, which, ms) => {
  await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(ms);
  await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(600);
};
const posBefore = await viewpos('before');
await hold('w', 'KeyW', 87, 2500);
const posAfter = await viewpos('after');
console.log('MOVED:', (posBefore !== posAfter && !/none/.test(posAfter)) ? 'YES' : 'NO/UNKNOWN');
{ const m = await S('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/rtcw-moved.png', Buffer.from(m.data, 'base64')); }

// WEAPON FIRE: escape1 starts you unarmed (HUD ammo reads 0), so cheat a weapon
// in first (spdevmap enables cheats), then hold K_MOUSE1 (+attack) and prove the
// HUD's ammo counter actually decrements.
// There is no console readout for ps.ammo, so read the HUD itself: capture just
// the ammo-digit rectangle and compare the PNG bytes. Identical pixels encode to
// identical PNGs, so a byte difference IS a pixel difference.
// The canvas element is 100vw x 100vh but 'object-fit: contain' letterboxes the
// 4:3 frame inside it, so getBoundingClientRect() is NOT the drawn area. Work out
// the real content box or every fraction below lands in the wrong place.
const box = JSON.parse((await S('Runtime.evaluate', { returnByValue: true, expression: `(function(){
  var c = Module.canvas || document.getElementById('canvas');
  var b = c.getBoundingClientRect();
  var vw = Math.min(b.width, window.innerWidth), vh = Math.min(b.height, window.innerHeight);
  var a = c.width / c.height;
  var w = vw, h = vw / a;
  if (h > vh) { h = vh; w = vh * a; }
  return JSON.stringify([b.left + (vw - w) / 2, b.top + (vh - h) / 2, w, h]);
})()` })).result.value);
console.log('CONTENT BOX:', JSON.stringify(box.map(Math.round)));
const ammoShot = async () => {
  // Tight box on the clip-ammo DIGITS only, in CONTENT-box fractions. It must
  // exclude the weapon icon and the gun model: those move with view-bob, so a
  // looser crop would "change" every frame and prove nothing about ammo.
  const clip = { x: Math.round(box[0] + box[2] * 0.80), y: Math.round(box[1] + box[3] * 0.925),
                 width: Math.round(box[2] * 0.06), height: Math.round(box[3] * 0.06), scale: 1 };
  const s = await S('Page.captureScreenshot', { format: 'png', clip });
  return s.data;
};
const holdMouse1 = async (ms) => {
  const cx = Math.round(r[0] + r[2] / 2), cy = Math.round(r[1] + r[3] / 2);
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(ms);
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(800);
};
await consoleCmd('/give all');
await sleep(1500);
await consoleCmd('/weapon 3');   // MP40
await sleep(1500);
const ammoBefore = await ammoShot();
{ const b = await S('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/rtcw-armed.png', Buffer.from(b.data, 'base64')); }
await holdMouse1(900);
const ammoAfter = await ammoShot();
fs.writeFileSync('/tmp/rtcw-ammo-before.png', Buffer.from(ammoBefore, 'base64'));
fs.writeFileSync('/tmp/rtcw-ammo-after.png', Buffer.from(ammoAfter, 'base64'));
console.log('FIRED:', ammoBefore !== ammoAfter ? 'YES (ammo HUD changed)' : 'NO/UNKNOWN');
{ const f = await S('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/rtcw-fired.png', Buffer.from(f.data, 'base64')); }

const all = JSON.parse((await (async()=>{const r=await S('Runtime.evaluate',{expression:'JSON.stringify(window.__l||[])',returnByValue:true});return r.result.value;})()) || '[]');
fs.writeFileSync('/tmp/rtcw-play-console.log', all.join('\n'));
console.log('KEY:', all.filter(x => /pk3 files|escape1|R_LoadWorldMap|CL_InitCGame|Sys_LoadDll|Error|Couldn't|entered|wasm32/i.test(x)).slice(-12).join('\n'));
console.log(ok ? 'RTCW PLAY: map/pk3 activity detected; screenshot /tmp/rtcw-play.png' : 'RTCW PLAY: no map activity; see /tmp/rtcw-play-console.log');
c.kill(); process.exit(0);
