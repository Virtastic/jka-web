// Catch-in-the-act probe: poll frames until the sliver artifact is actually ON SCREEN,
// then capture a burst of frames. Reproducing the artifact on demand is the hard part:
//
// Blind sampling never worked here. The artifact only appears on certain cutscene camera
// cuts, so a probe that samples at a fixed time keeps landing on clean frames and reporting
// a confident nothing. Three separate runs produced clean nulls that way. This inverts it:
// detect first, capture second.
//
//   GPU=1 node catch-sliver.mjs <port> "<+bootargs>" <outDir> [maxPollSec]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = process.argv[2] || '8794';
const ARGS = process.argv[3] || '+devmap yavin1';
const OUTDIR = process.argv[4] || 'C:/dev/shots/catch';
const MAXPOLL = parseInt(process.argv[5] || '260', 10);
const RUNID = process.pid;
const CDP = 9500 + (RUNID % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUTDIR, { recursive: true });

const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio',
  ...(process.env.GPU === '1' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
                              : ['--use-gl=angle', '--enable-unsafe-swiftshader']),
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--hide-scrollbars',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile(`idt3-catch-${RUNID}`)}`, 'about:blank']);

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
console.log('map loaded; polling for the sliver…');

// Detect the artifact IN THE PAGE: a tall run of gold pixels in a single column. Doing it
// in-page avoids shipping a PNG over CDP every poll, so we can sample fast enough to catch
// a transient cut.
const DETECT = `(function(){
  var c = document.getElementById('canvas'); if (!c) return -1;
  var t = document.createElement('canvas'); t.width = 320; t.height = 200;
  var x = t.getContext('2d'); if (!x) return -1;
  try { x.drawImage(c, 0, 0, c.width, c.height, 0, 0, 320, 200); } catch(e) { return -1; }
  var d = x.getImageData(0, 0, 320, 200).data;
  var best = 0, tallCols = 0;
  for (var col = 0; col < 320; col++) {
    var run = 0;
    for (var row = 0; row < 200; row++) {
      var i = (row * 320 + col) * 4;
      var r = d[i], g = d[i+1], b = d[i+2];
      var lum = (r + g + b) / 3 + 0.001;
      var yellow = ((r + g) / 2 - b) / lum;
      if (yellow > 0.45 && Math.abs(r - g) / lum < 0.25 && lum > 25) run++;
    }
    if (run > best) best = run;
    if (run > 60) tallCols++;
  }
  // WIDTH is the discriminator. The artifact is a THIN bar: a handful of columns with a
  // tall gold run. The Star Wars intro logo and the crawl are also tall and gold but span
  // dozens of columns — an earlier version of this probe reported the logo as a catch.
  // Require tall-and-narrow.
  if (tallCols < 1 || tallCols > 10) return 0;
  return best;
})()`;

const WARMUP = parseInt(process.env.WARMUP || '90', 10);   // skip logo + opening crawl
console.log('warm-up ' + WARMUP + 's before polling…');
await sleep(WARMUP * 1000);
let caught = false, bestSeen = 0;
for (let i = 0; i < MAXPOLL; i++) {
  const v = (await S('Runtime.evaluate', { expression: DETECT, returnByValue: true })).result.value;
  if (typeof v === 'number' && v > bestSeen) bestSeen = v;
  if (typeof v === 'number' && v >= 60) {         // a bar spanning >=30% of frame height
    console.log(`sliver detected (gold run ${v}/200 rows) at poll ${i}s — capturing burst`);
    for (let k = 0; k < 6; k++) {                 // burst: the artifact is transient
      const sh = await S('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUTDIR, `caught_${k}.png`), Buffer.from(sh.data, 'base64'));
      await sleep(250);
    }
    caught = true;
    break;
  }
  await sleep(1000);
}

const log = await ring();
fs.writeFileSync(path.join(OUTDIR, 'engine.log'), log);
const fatal = log.split('\n').filter(l => /Aborted|ERR_FATAL|Sys_Error|undefined symbol/i.test(l));
if (fatal.length) console.log('ENGINE FAULT:', fatal[0]);   // a dead engine also yields 0 detections
console.log(caught ? 'CAUGHT — burst written to ' + OUTDIR
                   : `NOT CAUGHT (best gold run seen: ${bestSeen}/200 rows)`);
ws.close(); chrome.kill(); process.exit(0);
