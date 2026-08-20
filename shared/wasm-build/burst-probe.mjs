// Burst probe for TRANSIENT render artifacts (one-frame geometry glitches).
// Boots a map on the real GPU, waits out the intro cinematic, walks the player forward
// with W to reach open terrain, then rapid-fires screenshots and keeps only the frames
// that deviate from their neighbours — a single-frame stretched-polygon glitch shows up
// as a luma/edge outlier against an otherwise smoothly-changing sequence.
//   GPU=1 node burst-probe.mjs <port> "<+args>" <outDir> [settleSec] [shots]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.argv[2] || '8794';
const ARGS = process.argv[3] || '';
const OUTDIR = process.argv[4] || 'C:/dev/shots/burst';
const SETTLE = parseInt(process.argv[5] || '200', 10);
const SHOTS = parseInt(process.argv[6] || '60', 10);
const RUNID = process.pid;
const CDP = 9900 + (RUNID % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUTDIR, { recursive: true });

const gpuFlags = process.env.GPU === '1'
  ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--enable-unsafe-swiftshader'];
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', ...gpuFlags,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--hide-scrollbars',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile(`idt3-burst-${RUNID}`)}`, 'about:blank']);

const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => {
  let d = ''; r.on('data', x => d += x); r.on('end', () => res(JSON.parse(d)));
}).on('error', rej));
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
console.log('map loaded; waiting out the intro cinematic…');
await sleep(SETTLE * 1000);

// The intro hands over control on its own; a +use tap covers the case where it does not.
const key = async (k, code, vk, ms) => {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(ms);
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
await key('e', 'KeyE', 69, 120);
await sleep(1500);

// Walk forward into the open terrain, sweeping the view so foliage enters the frame.
await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });

const shot = async () => Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64');
const frames = [];
for (let i = 0; i < SHOTS; i++) {
  frames.push(await shot());
  if (i % 10 === 9) { // nudge the view so new geometry keeps entering frame
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 360, deltaX: 90, deltaY: 0, button: 'none' });
  }
}
await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });

frames.forEach((b, i) => fs.writeFileSync(path.join(OUTDIR, `burst_${String(i).padStart(3, '0')}.png`), b));
console.log(`wrote ${frames.length} frames to ${OUTDIR}`);
console.log('engine fatals:', (await ring()).split('\n').filter(l => /ERR_FATAL|Sys_Error|RuntimeError/.test(l)).slice(0, 3));
ws.close(); chrome.kill(); process.exit(0);
