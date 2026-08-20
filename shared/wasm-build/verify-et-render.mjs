#!/usr/bin/env node
// Wolf:ET render smoke test: real Chrome via CDP. Buffers console + page errors
// in-page (robust vs CDP event races), waits for pk3 discovery and R_Init, then
// screenshots to /tmp/et-render.png and dumps the console to /tmp/et-console.log.
// Usage: node verify-et-render.mjs [url]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const URL_ = process.argv[2] || 'http://localhost:8792/index.html';
const PORT = 9226;

const chrome = execFile(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  '--user-data-dir=' + tmpProfile('idt3-et-render-profile'), 'about:blank',
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));

let ok = false, pk3line = '', fatal = [];
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
    }
    window.addEventListener('error', e => window.__logs.push('PAGEERROR: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
    window.addEventListener('unhandledrejection', e => window.__logs.push('UNHANDLED: ' + e.reason));` });
  await send('Page.navigate', { url: URL_ });

  const evalStr = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r && r.result ? r.result.value : undefined;
  };

  for (let i = 0; i < 420; i++) {
    await sleep(1000);
    const joined = (await evalStr('JSON.stringify(window.__logs || [])')) || '[]';
    const m = /(\d+) files in pk3 files/.exec(joined);
    if (m) pk3line = m[0];
    if (/finished R_Init/.test(joined)) ok = true;
    if (/Sys_Error|Aborted\(|RuntimeError|PAGEERROR/.test(joined)) { fatal.push('fatal in logs'); break; }
    if (ok) break;
  }
  if (ok) {
    await sleep(12000);   // let the menu settle and render
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(tmpProfile('et-render.png'), Buffer.from(shot.data, 'base64'));
  }
  const all = await evalStr('JSON.stringify(window.__logs || [])');
  fs.writeFileSync(tmpProfile('et-console.log'), JSON.parse(all || '[]').join('\n'));
  if (!ok && !fatal.length) fatal.push('timeout; pk3line=' + (pk3line || 'none'));
  ws.close();
} catch (e) { fatal.push(String(e)); }
finally { chrome.kill(); }
console.log(ok ? `VERIFY OK: ${pk3line}; render finished; screenshot /tmp/et-render.png` : `VERIFY FAIL: ${fatal.join('; ')}`);
process.exit(ok ? 0 : 1);
