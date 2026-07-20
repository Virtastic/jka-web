// Wolf:ET playability test: auto-loads oasis, drives the limbo JOIN-A-TEAM panel
// via the UI cursor (SE_MOUSE relative deltas) + K_MOUSE1, then screenshots.
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const PORT = 9240;
const URL_ = 'http://localhost:8792/index.html?args=' + encodeURIComponent('+set sv_pure 0 +set cg_viewsize 100 +devmap oasis');
const c = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  '--user-data-dir=/tmp/idt3-et-play', 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r)); await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.addScriptToEvaluateOnNewDocument', { source: "window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));window.addEventListener('error',e=>window.__l.push('PAGEERR: '+e.message))" });
await S('Page.navigate', { url: URL_ });

const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
for (let i = 0; i < 120; i++) { await sleep(2000); if (/CL_InitCGame/.test((await logs()).join('\n'))) break; }
await sleep(12000);

// fill the viewport so the shot is legible
const r = JSON.parse((await S('Runtime.evaluate', { returnByValue: true, expression: `(function(){
  var c = Module.canvas || document.getElementById('canvas');
  c.style.setProperty('width','100vw','important'); c.style.setProperty('height','100vh','important');
  c.style.setProperty('object-fit','contain','important');
  var l = document.getElementById('load'); if (l) l.remove();
  var b = c.getBoundingClientRect(); return JSON.stringify([b.left,b.top,b.width,b.height]);
})()` })).result.value);
await sleep(2000);
let s = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/et-limbo.png', Buffer.from(s.data, 'base64'));

// The UI cursor is driven by SE_MOUSE relative deltas; movementX/Y are read-only
// and must be defined on the event (CDP's mouseMoved reports 0,0).
const uiMove = async (dx, dy) => {
  await S('Runtime.evaluate', { expression: `(function(){
    var e = new MouseEvent('mousemove', {bubbles:true});
    Object.defineProperty(e,'movementX',{value:${dx}}); Object.defineProperty(e,'movementY',{value:${dy}});
    window.dispatchEvent(e);
  })()` });
  await sleep(150);
};
const clickAt = async (ux, uy) => {   // ux,uy in ET's 640x480 virtual UI space
  const x = Math.round(r[0] + r[2] * (ux / 640)), y = Math.round(r[1] + r[3] * (uy / 480));
  for (const t of ['mousePressed', 'mouseReleased'])
    await S('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(1200);
};
// pin cursor to 0,0 then move to a target (UI clamps to 0..640/0..480)
const cursorTo = async (ux, uy) => { await uiMove(-4000, -4000); await uiMove(ux, uy); };

// Optional console commands (ET_CMDS): open console with grave, type, close.
const key = async (k, code, which) => {
  for (const t of ['keydown', 'keyup'])
    await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(t)},{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(150);
};
const consoleCmd = async (line) => {
  await key('`', 'Backquote', 192);
  await sleep(800);
  { const sc = await S('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/et-console.png', Buffer.from(sc.data, 'base64')); }
  for (const ch of line) {
    const code = ch === ' ' ? 'Space' : (/[0-9]/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase());
    await key(ch, code, ch.toUpperCase().charCodeAt(0));
  }
  await key('Enter', 'Enter', 13);
  await sleep(800);
  await key('`', 'Backquote', 192);
  await sleep(1200);
  console.log('cmd:', line);
};
for (const line of JSON.parse(process.env.ET_CMDS || '[]')) await consoleCmd(line);

const steps = JSON.parse(process.env.ET_STEPS || '[]');
for (const [ux, uy, label] of steps) {
  await cursorTo(ux, uy);
  await clickAt(ux, uy);
  console.log('clicked', label || (ux + ',' + uy));
}
// ET spawns you at the next reinforcement wave — wait it out, reporting progress.
for (let i = 0; i < 9; i++) {
  await sleep(5000);
  const l = await logs();
  const hit = l.filter(x => /entered the game|joined the|Spawn|revive/i.test(x)).slice(-1)[0] || '';
  console.log('t+' + (i + 1) * 5 + 's ' + hit.slice(0, 70));
}
s = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/et-play.png', Buffer.from(s.data, 'base64'));
// A browser AudioContext only starts after a REAL user gesture; JS-synthesized
// events don't qualify. Send a trusted CDP click (what a real player does), then
// give the mixer a moment before sampling the peak.
for (const t of ['mousePressed', 'mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: Math.round(r[0] + r[2] / 2), y: Math.round(r[1] + r[3] / 2), button: 'left', clickCount: 1, buttons: 1 });
await sleep(4000);
const snd = await S('Runtime.evaluate', { returnByValue: true, expression: `(function(){
  var s = Module.__idt3_snd;
  if (!s || !s.ctx) return 'NO AUDIO CONTEXT';
  return JSON.stringify({ state: s.ctx.state, rate: s.ctx.sampleRate, playCursor: s.pos, peak: s.peak });
})()` });
console.log('AUDIO:', snd.result && snd.result.value);

// MOVEMENT: hold W and prove the player's origin actually changes. Read it from
// the engine via the console ('viewpos' prints the player origin/angles).
const viewpos = async (tag) => {
  await consoleCmd('/viewpos');
  const l = await logs();
  const line = l.filter(x => /\(-?\d+ -?\d+ -?\d+\)|viewpos/i.test(x)).slice(-1)[0] || '(none)';
  console.log('VIEWPOS ' + tag + ': ' + line.slice(0, 80));
  return line;
};
const holdKey = async (k, code, which, ms) => {
  await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(ms);
  await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keyup',{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(600);
};
const before = await viewpos('before');
await holdKey('w', 'KeyW', 87, 2500);   // walk forward
const after = await viewpos('after');
console.log('MOVED:', before !== after && !/none/.test(after) ? 'YES' : 'NO/UNKNOWN');
s = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/et-moved.png', Buffer.from(s.data, 'base64'));

const all = await logs();
fs.writeFileSync('/tmp/et-play-console.log', all.join('\n'));
console.log('KEY:', all.filter(x => /ClientBegin|entered|spawn|team|CL_InitCGame|Error/i.test(x)).slice(-6).join(' | '));
console.log('SHOTS: /tmp/et-limbo.png /tmp/et-play.png');
ws.close(); c.kill();
