#!/usr/bin/env node
// Wolf:ET auto-devmap test: launches with ?args=+set sv_pure 0 +devmap oasis so the
// map loads WITHOUT any synthetic typing (decouples the VM_Call fix test from the
// flaky console-input path). Reports ClientConnect clientNum + whether cgame inits.
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const URL_ = 'http://localhost:8792/index.html?args=' + encodeURIComponent('+set sv_pure 0 +set idt3_test_autojoin 1 +devmap oasis');
const PORT = 9228;

const chrome = execFile(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  '--user-data-dir=' + tmpProfile('idt3-et-auto-profile'), 'about:blank',
]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));

let fatal = [];
try {
  let page = null;
  for (let i = 0; i < 30 && !page; i++) { await sleep(1000); try { const t = await get('/json'); page = t.find(x => x.type === 'page'); } catch {} }
  if (!page) throw new Error('chrome CDP never came up');
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (m, p) => new Promise(res => { const mid = ++id; const h = x => { const j = JSON.parse(x); if (j.id === mid) { ws.off('message', h); res(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
  await new Promise(r => ws.on('open', r));
  await send('Page.enable', {});
  await send('Runtime.enable', {});
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__logs=[]; for(const k of ['log','warn','error']){const o=console[k].bind(console); console[k]=(...a)=>{try{window.__logs.push(a.join(' '))}catch{} o(...a)};}` });
  await send('Page.navigate', { url: URL_ });
  const evalStr = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); return r && r.result ? r.result.value : undefined; };

  let done = false;
  for (let i = 0; i < 300 && !done; i++) {
    await sleep(1000);
    const logs = (await evalStr('JSON.stringify(window.__logs||[])')) || '[]';
    if (/InitCGame|ClientConnect|Sys_Error|Aborted|RuntimeError/.test(logs)) done = true;
  }
  await sleep(8000);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(tmpProfile('et-auto.png'), Buffer.from(shot.data, 'base64'));
  // Join a team (Allied) + pick a class + spawn, via the console.
  const kev = async (key, code, which) => await evalStr(`(function(){ ['keydown','keyup'].forEach(function(t){ window.dispatchEvent(new KeyboardEvent(t,{key:${JSON.stringify(key)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true})); }); return 'k'; })()`);
  const typeCmd = async (line) => {
    await evalStr("Module.canvas.focus(); 'f'");
    await kev('`', 'Backquote', 192);   // open console
    await sleep(400);
    for (const ch of line) { const code = ch === ' ' ? 'Space' : (/[a-z]/.test(ch) ? 'Key'+ch.toUpperCase() : /[0-9]/.test(ch) ? 'Digit'+ch : 'Key'+ch.toUpperCase()); await kev(ch, code, ch.toUpperCase().charCodeAt(0)); }
    await kev('Enter', 'Enter', 13);
    await kev('`', 'Backquote', 192);   // close console
    await sleep(1500);
  };
  // Drive the limbo panel via mouse (move THEN click; cgame tracks the cursor).
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await sleep(250);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(120);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(800);
  };
  // idt3_test_autojoin auto-joins client 0 server-side. Close the limbo (Esc) so the
  // reinforcement-wave spawn drops us into first person, and capture along the way.
  const kev2 = async (key, code, which) => await evalStr(`(function(){ ['keydown','keyup'].forEach(function(t){ window.dispatchEvent(new KeyboardEvent(t,{key:${JSON.stringify(key)},code:${JSON.stringify(code)},keyCode:${which},which:${which},bubbles:true})); }); return 'k'; })()`);
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    await evalStr("Module.canvas.focus(); 'f'");
    await kev2('Escape', 'Escape', 27);   // dismiss limbo → deploy view
    const logs = JSON.parse((await evalStr('JSON.stringify(window.__logs.slice(-2))')) || '[]');
    console.log('t+' + (i+1)*5 + 's: ' + logs.join(' | ').slice(0, 110));
    if ((i+1) % 3 === 0) { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(tmpProfile('et-fps-')+(i+1)+'.png', Buffer.from(s.data, 'base64')); }
  }
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(tmpProfile('et-spawn.png'), Buffer.from(shot2.data, 'base64'));
  const all = JSON.parse((await evalStr('JSON.stringify(window.__logs||[])')) || '[]');
  fs.writeFileSync(tmpProfile('et-auto-console.log'), all.join('\n'));
  const cc = all.filter(l => /ClientConnect|InitCGame|bad index|Aborted|RuntimeError/.test(l)).slice(0, 10);
  console.log('KEY LINES:\n' + cc.join('\n'));
  ws.close();
} catch (e) { fatal.push(String(e)); }
finally { chrome.kill(); }
console.log(fatal.length ? 'FAIL: ' + fatal.join('; ') : 'DONE: /tmp/et-auto.png, /tmp/et-auto-console.log');
