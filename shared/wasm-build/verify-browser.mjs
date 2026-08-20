#!/usr/bin/env node
// idTech3-web boot smoke test. Loads a game page in headless Chrome via CDP and
// asserts the wasm runtime starts and the engine reaches its frame loop without a
// fatal Com_Error. Usage: node verify-browser.mjs [url]
//   default http://localhost:8790/  (start `python3 shared/web/server.py rtcw` first)
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const URL_ = process.argv[2] || 'http://localhost:8790/';
const PORT = 9224;

const chrome = execFile(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run',
  '--user-data-dir=' + tmpProfile('idt3-verify-profile'), URL_,
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: PORT, path: p }, r => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));

let ok = false, fatal = [];
try {
  await sleep(3000);
  const targets = await get('/json');
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('page target not found');
  const { default: WebSocket } = await import('ws').catch(() => ({ default: null }));
  if (!WebSocket) throw new Error('npm i ws (dev dep) required for the harness');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params) => new Promise(res => {
    const mid = ++id;
    ws.on('message', function h(m){ const j = JSON.parse(m); if (j.id === mid){ ws.off('message', h); res(j.result); } });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const logs = [];
  await new Promise(r => ws.on('open', r));
  await send('Runtime.enable', {});
  ws.on('message', m => {
    const j = JSON.parse(m);
    if (j.method === 'Runtime.consoleAPICalled') {
      logs.push((j.params.args || []).map(a => a.value).join(' '));
    }
  });

  // Wait up to 90s for the engine to reach its frame loop, or a fatal.
  for (let i = 0; i < 90; i++) {
    const r = await send('Runtime.evaluate', { expression:
      'JSON.stringify({run: (typeof Module!=="undefined")&&!!Module.calledRun, booted: !!window.booted})' });
    const s = JSON.parse(r.result.value || '{}');
    const joined = logs.join('\n');
    if (/Com_Init|Working directory|WebGL2|GLimp_Init/.test(joined) && s.run) { ok = true; }
    if (/Sys_Error|Aborted\(|RuntimeError/.test(joined)) { fatal.push(joined.split('\n').slice(-3).join(' | ')); break; }
    if (ok) break;
    await sleep(1000);
  }
  if (!ok && !fatal.length) fatal.push('timeout; last logs: ' + logs.slice(-5).join(' | '));
  ws.close();
} catch (e) {
  fatal.push(String(e));
} finally {
  chrome.kill();
}
console.log(ok ? 'VERIFY OK: engine reached frame loop' : `VERIFY FAIL: ${fatal.join('; ')}`);
process.exit(ok ? 0 : 1);
