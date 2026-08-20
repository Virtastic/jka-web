#!/usr/bin/env node
// Wolf:ET menu interaction probe: boots, dismisses the console (Escape), clicks,
// and screenshots each step to /tmp/et-menu-N.png.
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const URL_ = process.argv[2] || 'http://localhost:8792/index.html';
const PORT = 9227;

const chrome = execFile(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  '--user-data-dir=' + tmpProfile('idt3-et-menu-profile'), 'about:blank',
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));

let ok = false, fatal = [];
try {
  let page = null;
  for (let i = 0; i < 30 && !page; i++) {
    await sleep(1000);
    try { const t = await get('/json'); page = t.find(x => x.type === 'page'); } catch {}
  }
  if (!page) throw new Error('chrome CDP never came up');
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params) => new Promise(res => {
    const mid = ++id;
    const h = m => { const j = JSON.parse(m); if (j.id === mid) { ws.off('message', h); res(j.result); } };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise(r => ws.on('open', r));
  await send('Page.enable', {});
  await send('Runtime.enable', {});
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__logs = [];
    for (const k of ['log','warn','error']) {
      const orig = console[k].bind(console);
      console[k] = (...a) => { try { window.__logs.push(a.join(' ')); } catch {} orig(...a); };
    }` });
  await send('Page.navigate', { url: URL_ });

  const evalStr = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r && r.result ? r.result.value : undefined;
  };
  for (let i = 0; i < 420 && !ok; i++) {
    await sleep(1000);
    const joined = (await evalStr('JSON.stringify(window.__logs || [])')) || '';
    if (/finished R_Init/.test(joined)) ok = true;
  }
  if (!ok) throw new Error('boot timeout');
  await sleep(10000);

  const shot = async n => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(tmpProfile(`et-menu-${n}.png`), Buffer.from(s.data, 'base64'));
  };
  const key = async (keyName, code, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      await sleep(80);
    }
  };
  // synthetic DOM keyboard events — emscripten's window-level handlers accept them.
  // Retries until the engine console echoes the line (matches via window.__logs).
  await send('Page.bringToFront', {});
  // Open the ET console (grave/backtick) so typed lines are executed as commands.
  const openConsole = async () => {
    await evalStr("Module.canvas.focus(); 'f'");
    await evalStr(`(function(){
      function kev(t){ window.dispatchEvent(new KeyboardEvent(t, {key: '\`', code: 'Backquote', keyCode: 192, which: 192, bubbles: true})); }
      kev('keydown'); kev('keyup'); return 'toggled';
    })()`);
    await sleep(800);
  };
  const typeLine = async (line, expectRe) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await evalStr("Module.canvas.focus(); 'f'");
      if (attempt === 0) await openConsole();
      await evalStr(`(function(){
        function kev(t, key, code, which){ window.dispatchEvent(new KeyboardEvent(t, {key: key, code: code, keyCode: which, which: which, bubbles: true})); }
        var s = ${JSON.stringify(line)};
        for (var i = 0; i < s.length; i++) {
          var ch = s[i]; var code = ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase();
          kev('keydown', ch, code, ch.toUpperCase().charCodeAt(0));
          kev('keyup', ch, code, ch.toUpperCase().charCodeAt(0));
        }
        kev('keydown', 'Enter', 'Enter', 13); kev('keyup', 'Enter', 'Enter', 13);
        return 'typed';
      })()`);
      await sleep(1500);
      const logs = (await evalStr('JSON.stringify(window.__logs.slice(-10))')) || '[]';
      if (expectRe.test(logs)) { console.log(`typed OK (attempt ${attempt + 1}): ${line}`); return true; }
    }
    console.log('typing never registered: ' + line);
    return false;
  };
  await shot(1);
  await typeLine('echo IDT3_INPUT_OK', /IDT3_INPUT_OK/);
  await shot(2);
  await typeLine('sv_pure 0', /sv_pure/);
  await typeLine('devmap oasis', /devmap|oasis|Loading|CM_|----- Server/i);
  await sleep(6000); await shot(3);   // limbo/command-map screen
  // join a team → autospawn into the 3D world
  await typeLine('team r', /team|Allied|spawn/i);
  await sleep(4000);
  await typeLine('class 0 1', /class|Soldier/i);
  await sleep(6000); await shot(4);   // should be in-world now
  // keep pumping so the world renders a few frames
  console.log('manual pump: ' + await evalStr("(function(){ for(var k=0;k<8;k++){ try { Module._idt3_pump_frame(); } catch(e){ return 'pump threw @iter'+k+': ' + (e && e.stack || e); } } return 'pumped 8x ok'; })()"));
  await sleep(3000); await shot(5);
  fs.writeFileSync(tmpProfile('et-menu-console.log'), JSON.parse(await evalStr('JSON.stringify(window.__logs)') || '[]').join('\n'));
  console.log('full log at /tmp/et-menu-console.log');
  ws.close();
} catch (e) { fatal.push(String(e)); }
finally { chrome.kill(); }
console.log(fatal.length ? 'MENU PROBE FAIL: ' + fatal.join('; ') : 'MENU PROBE OK: /tmp/et-menu-{1..4}.png');
process.exit(fatal.length ? 1 : 0);
