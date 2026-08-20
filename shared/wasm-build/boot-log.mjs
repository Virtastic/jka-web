// idTech3-web — dump the engine's own boot log verbatim.
//
// console-check.mjs classifies; this one does not. When a boot goes wrong the useful
// signal is the ORDER of the engine's lines (which subsystem got as far as printing what
// before it stopped), and any classifier throws that away. Reads the same private ring the
// page keeps (window.__idt3_dumpLog), so it sees exactly what the engine printed.
//
//   node shared/wasm-build/boot-log.mjs <httpPort> "<+args>" [waitSec] [grep-re]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2];
const ARGS = process.argv[3] || '';
const WAIT = parseInt(process.argv[4] || '90', 10);
const GREP = process.argv[5] ? new RegExp(process.argv[5], 'i') : null;
if (!PORT) { console.error('usage: boot-log.mjs <httpPort> ["+args"] [waitSec] [grep-re]'); process.exit(2); }

const CDP = 9600 + (parseInt(PORT, 10) % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,800', `--user-data-dir=${tmpProfile(`idt3-bootlog-${PORT}`)}`, 'about:blank']);

const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => {
  let d = ''; r.on('data', x => d += x); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));

let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => {
  const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } };
  ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p }));
});
await new Promise(r => ws.on('open', r));
await S('Runtime.enable', {}); await S('Page.enable', {});

// Page-level failures never reach the engine ring, so capture them separately.
const page = [];
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__pageerr = [];
  window.addEventListener('error', e => window.__pageerr.push('PAGEERR: ' + e.message));
  window.addEventListener('unhandledrejection', e => window.__pageerr.push('REJECT: ' + (e.reason && e.reason.message || e.reason)));
`});
ws.on('message', x => {
  const j = JSON.parse(x);
  if (j.method === 'Runtime.exceptionThrown')
    page.push('EXCEPTION: ' + (j.params.exceptionDetails?.exception?.description || j.params.exceptionDetails?.text || ''));
});

await S('Page.navigate', { url: `http://localhost:${PORT}/index.html` + (ARGS ? '?args=' + encodeURIComponent(ARGS) : '') });

const evalv = async expr => {
  try {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r && r.result ? r.result.value : undefined;
  } catch { return undefined; }
};

let lines = [], stalled = 0, last = 0;
for (let i = 0; i < WAIT; i++) {
  await sleep(1000);
  const txt = await evalv('String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : "")');
  lines = txt ? txt.split('\n') : [];
  if (lines.length === last) { stalled++; } else { stalled = 0; last = lines.length; }
  if (i > 15 && stalled > 12) break;   // engine has gone quiet: it is either idle or wedged
}
// Optional 5th arg: semicolon-separated console commands to run before dumping, so the
// engine's own state can be interrogated (`cl_paused`, `com_sv_running`, …) and the answer
// lands in the same ring this probe already prints.
const CMDS = (process.argv[6] || '').split(';').filter(Boolean);
for (const c of CMDS) {
  await evalv(`(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(c)}]);return 'ok';}catch(e){return ''+e;}})()`);
  // 400ms was not enough for anything substantial: `vid_restart` tears the renderer down
  // and re-uploads every texture, and the dump was being taken before the second
  // GLimp_Init had even printed. Give each command real time to land.
  await sleep(6000);
}
if (CMDS.length) {
  const txt2 = await evalv('String(window.__idt3_dumpLog ? window.__idt3_dumpLog() : "")');
  lines = txt2 ? txt2.split('\n') : lines;
}
const perr = (await evalv('JSON.stringify(window.__pageerr||[])')) || '[]';
const raf = await evalv('(function(){var n=0;return n;})()');

const shown = GREP ? lines.filter(l => GREP.test(l)) : lines;
console.log(shown.join('\n'));
console.log(`\n===== ${lines.length} engine lines${GREP ? ` (${shown.length} matched)` : ''} =====`);
for (const e of JSON.parse(perr).concat(page)) console.log(e);
void raf;
ws.close(); chrome.kill(); process.exit(0);
