// Perf + brightness baseline probe. Measures sustained FPS (RAF ticks/sec), draw
// calls per frame, and mean frame brightness for one game+map.
//   node perf-probe.mjs <httpPort> "<+args>" [label]
import { execFile } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
const HTTP = process.argv[2], ARGS = process.argv[3] || '', LABEL = process.argv[4] || HTTP;
const CDP = 9600 + (parseInt(HTTP, 10) % 100);
const c = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
  '--no-first-run', '--window-size=1280,800', `--user-data-dir=/tmp/idt3-perf-${LABEL}`, 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null; for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r)); await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));
  window.__raf=0;window.__cpu=[];const _r=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=function(cb){return _r(function(t){window.__raf++;var s=performance.now();var r=cb(t);var e=performance.now();window.__cpu.push(e-s);if(window.__cpu.length>240)window.__cpu.shift();return r;});};
  window.__d=0;const _gc=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,a){const c=_gc.call(this,t,a);try{if(c&&!c.__h&&/webgl/i.test(t)){c.__h=1;for(const fn of['drawElements','drawArrays']){const o=c[fn].bind(c);c[fn]=function(...a){window.__d++;return o(...a);};}}}catch(e){}return c;};
`});
await S('Page.navigate', { url: `http://localhost:${HTTP}/index.html?args=` + encodeURIComponent(ARGS) });
const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
for (let i = 0; i < 40; i++) { await sleep(3000); const l = (await logs()).join('\n'); if (/loaded \d+ faces|CL_InitCGame|finished R_Init|entered|SPAWN/i.test(l)) break; }
await sleep(12000);   // let it reach steady state
await S('Runtime.evaluate', { expression: "(function(){var c=Module.canvas||document.getElementById('canvas');c.style.setProperty('width','100vw','important');c.style.setProperty('height','100vh','important');var l=document.getElementById('load');if(l)l.remove();})()" });

const stat = async () => JSON.parse((await S('Runtime.evaluate', { returnByValue: true, expression: "(function(){var c=(window.__cpu||[]).slice().sort(function(a,b){return a-b;});var med=c.length?c[c.length>>1]:0;var p95=c.length?c[Math.min(c.length-1,Math.floor(c.length*0.95))]:0;return JSON.stringify({raf:window.__raf,d:window.__d,cpuMed:med,cpuP95:p95,cpuN:c.length});})()" })).result.value);
const a = await stat(); const t0 = Date.now();
await sleep(6000);
const b = await stat(); const dt = (Date.now() - t0) / 1000;
const frames = b.raf - a.raf, draws = b.d - a.d;
const fps = frames / dt;
const drawsPerFrame = frames ? draws / frames : 0;

// mean brightness of the content
function pngMeanLuma(buf) { let p = 8, w = 0, h = 0, idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8); if (t === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); } else if (t === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len)); else if (t === 'IEND') break; p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, st = w * bpp, cur = Buffer.alloc(st), prev = Buffer.alloc(st); const x0 = (w * 0.16) | 0, x1 = (w * 0.84) | 0; let sum = 0, n = 0, o = 0;
  for (let y = 0; y < h; y++) { const f = raw[o++]; for (let x = 0; x < st; x++) { const rv = raw[o + x], aa = x >= bpp ? cur[x - bpp] : 0, bb = prev[x], cc = x >= bpp ? prev[x - bpp] : 0; let v; switch (f) { case 0: v = rv; break; case 1: v = rv + aa; break; case 2: v = rv + bb; break; case 3: v = rv + ((aa + bb) >> 1); break; case 4: { const pp = aa + bb - cc, pa = Math.abs(pp - aa), pb = Math.abs(pp - bb), pc = Math.abs(pp - cc); v = rv + (pa <= pb && pa <= pc ? aa : pb <= pc ? bb : cc); break; } default: v = rv; } cur[x] = v & 0xff; } o += st; for (let x = x0; x < x1; x++) { sum += 0.299 * cur[x * 4] + 0.587 * cur[x * 4 + 1] + 0.114 * cur[x * 4 + 2]; n++; } cur.copy(prev); }
  return sum / n;
}
const sh = Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64');
fs.writeFileSync(`/tmp/perf-${LABEL}.png`, sh);
const glr = JSON.parse((await S('Runtime.evaluate',{returnByValue:true,expression:"(function(){try{var c=document.querySelector('canvas');var g=c.getContext('webgl2')||c.getContext('webgl');var e=g.getExtension('WEBGL_debug_renderer_info');return JSON.stringify(e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER));}catch(x){return JSON.stringify('?');}})()"})).result.value);
console.log('  GL_RENDERER: '+glr);
const cpuFps = b.cpuMed > 0 ? 1000 / b.cpuMed : 0;
console.log(`${LABEL}: swiftFPS=${fps.toFixed(1)}  draws/frame=${drawsPerFrame.toFixed(0)}  CPU-ms/frame med=${b.cpuMed.toFixed(2)} p95=${b.cpuP95.toFixed(2)} (=> CPU-bound cap ${cpuFps.toFixed(0)}fps, n=${b.cpuN})  meanLuma=${pngMeanLuma(sh).toFixed(1)}/255`);
ws.close(); c.kill(); process.exit(0);
