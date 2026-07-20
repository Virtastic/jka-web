// RTCW-SP AI check. The map_restart crash lived in AI character creation
// (AICast_UpdateBattleInventory <- AICast_CreateCharacter <- AIChar_spawn), so
// this is the natural companion proof: do AI casts actually get created and
// linked into the world?
//
// Readout: the game's own 'entitylist' svcmd. AI casts are clients, so they
// print as ET_PLAYER. More than one ET_PLAYER => the player plus live AI.
//
// Scope, honestly: this proves casts are CREATED, LINKED and surviving their
// think (a broken cast trapped the module outright before the dlopen fix). It
// does NOT prove pathfinding, combat or scripting behaviour.
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const PORT = 9238;
const URL_ = 'http://localhost:8790/index.html?args=' + encodeURIComponent('+set com_introplayed 1 +set cg_viewsize 100 +spdevmap escape1');
const c = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  '--user-data-dir=/tmp/idt3-rtcw-ai', 'about:blank']);
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
for (let i = 0; i < 60; i++) { await sleep(2000); if (/CL_InitCGame/.test((await logs()).join('\n'))) break; }
await sleep(14000);

const key = async (k, code, which) => {
  for (const t of ['keydown', 'keyup'])
    await S('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(t)},{key:${JSON.stringify(k)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true}))` });
  await sleep(140);
};
// No leading '/' => the line is CHAT, not a command (con_autochat).
const consoleCmd = async (line) => {
  await key('`', 'Backquote', 192); await sleep(500);
  for (const ch of line) {
    const code = ch === ' ' ? 'Space' : ch === '/' ? 'Slash'
      : (/[0-9]/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase());
    await key(ch, code, ch === '/' ? 191 : ch.toUpperCase().charCodeAt(0));
  }
  await key('Enter', 'Enter', 13); await sleep(900);
  await key('`', 'Backquote', 192); await sleep(900);
};
// Dismiss the UIMENU_PREGAME briefing (pregame.menu but2_alt -> uiScript playerstart)
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

const countPlayers = async (tag) => {
  const before = (await logs()).length;
  await consoleCmd('/entitylist');
  await sleep(1200);
  const lines = (await logs()).slice(before);
  const players = lines.filter(x => /ET_PLAYER/.test(x)).length;
  console.log(`ET_PLAYER entities ${tag}: ${players}`);
  return players;
};
const n1 = await countPlayers('on spawn');

// Let the casts think for a while — a broken cast trapped the module outright
// before the fresh-dlopen fix, so surviving N seconds of AICast_Think is itself
// part of the proof.
await sleep(8000);
const n2 = await countPlayers('after 8s of thinking');

const all = await logs();
const crashed = all.filter(x => /PAGEERR|out of bounds|RuntimeError/i.test(x));
fs.writeFileSync('/tmp/rtcw-ai.log', all.join('\n'));
const sh = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/tmp/rtcw-ai.png', Buffer.from(sh.data, 'base64'));
console.log('\n===== RTCW-SP AI =====');
console.log('crashes: ' + (crashed.length ? crashed[0].slice(0, 80) : 'none'));
console.log('VERDICT: ' + (crashed.length ? 'FAIL — module trapped'
  : n1 > 1 && n2 > 1 ? `PASS — ${n1 - 1} AI cast(s) spawned and still alive after thinking`
  : n1 === 0 ? 'INCONCLUSIVE — entitylist produced nothing'
  : 'INCONCLUSIVE — only the player entity present here'));
ws.close(); c.kill(); process.exit(0);
