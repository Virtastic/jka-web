// Time-series capture: boot a map and screenshot every N seconds, keeping all frames.
//   [GPU=1] node seq-shots.mjs <port> "<+args>" <outDir> <count> <everySec> [pre-cmds;semicolon]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.argv[2], ARGS = process.argv[3] || '', OUTDIR = process.argv[4];
const COUNT = parseInt(process.argv[5] || '20', 10), EVERY = parseFloat(process.argv[6] || '3');
const PRE = (process.argv[7] || '').split(';').filter(Boolean);
const CDP = 9700 + (process.pid % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUTDIR, { recursive: true });
const gpu = process.env.GPU === '1'
  ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--enable-unsafe-swiftshader'];
const chrome = execFile(CHROME, [`--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio',
  ...gpu, '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--hide-scrollbars',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-seq-' + process.pid)}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r));
await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.navigate', { url: `http://localhost:${PORT}/index.html?args=` + encodeURIComponent(ARGS) });
const ring = async () => (await S('Runtime.evaluate', { expression: 'String(window.__idt3_dumpLog?window.__idt3_dumpLog():"")', returnByValue: true })).result.value || '';
for (let i = 0; i < 150; i++) { await sleep(1000); if (/loaded \d+ faces/i.test(await ring())) break; }
console.log('map loaded');
// A TRUSTED click: CDP mouse events count as a user gesture, which is what lets the page
// resume its AudioContext. Without it the sound device stays suspended for the whole run,
// and anything the game waits on that is driven by audio never completes.
for (const t of ['mousePressed','mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: 640, y: 360, button: 'left', clickCount: 1, buttons: 1 });
await sleep(500);
const exec = async l => { await S('Runtime.evaluate', { returnByValue: true, expression:
  `(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(l)}]);return 'ok';}catch(e){return ''+e;}})()` }); await sleep(300); };
for (const c of PRE) { console.log('pre: ' + c); await exec(c); }
for (let i = 0; i < COUNT; i++) {
  await sleep(EVERY * 1000);
  const b = Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  fs.writeFileSync(path.join(OUTDIR, `f${String(i).padStart(3, '0')}.png`), b);
}
console.log('done ->', OUTDIR);
ws.close(); chrome.kill(); process.exit(0);
