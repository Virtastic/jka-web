// Graphics-fidelity probe: boot a map, report the REAL WebGL context the engine got
// (renderer/vendor, actual depth+stencil bits, MSAA samples, context attributes, active
// extensions) and capture a frame. Software rasterisers hide whole classes of artifact —
// z-fighting in particular is a function of real depth-buffer precision — so this can be
// pointed at either backend:
//   GPU=1 node gfx-probe.mjs <port> "<+args>" <out.png> [waitSec] [settleSec]
// GPU=1 uses ANGLE/D3D11 on the actual adapter; default is the SwiftShader path the other
// harnesses use, so the two can be diffed against each other.
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const PORT = process.argv[2] || '8794';
const ARGS = process.argv[3] || '';
const OUT  = process.argv[4] || tmpProfile('gfx-probe.png');
const WAIT = parseInt(process.argv[5] || '130', 10);
const SETTLE = parseInt(process.argv[6] || '90', 10);
const USE_GPU = process.env.GPU === '1';
const RUNID = process.pid;
const CDP = 9800 + (RUNID % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const gpuFlags = USE_GPU
  ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
  : ['--use-gl=angle', '--enable-unsafe-swiftshader'];

const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio',
  ...gpuFlags,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--hide-scrollbars',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile(`idt3-gfx-${RUNID}`)}`, 'about:blank']);

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

const evalJS = async (expr) => (await S('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
const ring = () => evalJS('String(window.__idt3_dumpLog?window.__idt3_dumpLog():"")');

let loaded = false;
for (let i = 0; i < WAIT; i++) {
  await sleep(1000);
  const t = await ring();
  if (/loaded \d+ faces|CL_InitCGame/i.test(t)) { loaded = true; break; }
}
await sleep(SETTLE * 1000);

// Inspect the live context. GL.currentContext.GLctx is the real WebGLRenderingContext the
// engine draws through, so these are the numbers that actually govern rendering — not what
// glConfig claims (the platform layer hardcodes depthBits=24/stencilBits=8 regardless).
const ctxInfo = await evalJS(`(function(){
  try {
    var gl = (typeof GL!=='undefined' && GL.currentContext && GL.currentContext.GLctx) || null;
    if (!gl) return JSON.stringify({error:'no GL context'});
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    var a = gl.getContextAttributes() || {};
    return JSON.stringify({
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor:   dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR),
      version: gl.getParameter(gl.VERSION),
      depthBits: gl.getParameter(gl.DEPTH_BITS),
      stencilBits: gl.getParameter(gl.STENCIL_BITS),
      redBits: gl.getParameter(gl.RED_BITS),
      samples: gl.getParameter(gl.SAMPLES),
      sampleBuffers: gl.getParameter(gl.SAMPLE_BUFFERS),
      maxTexSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxTexUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      attrs: { alpha:a.alpha, depth:a.depth, stencil:a.stencil, antialias:a.antialias,
               premultipliedAlpha:a.premultipliedAlpha, preserveDrawingBuffer:a.preserveDrawingBuffer },
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      aniso: !!(gl.getExtension('EXT_texture_filter_anisotropic')),
      depthTexture: !!gl.getExtension('WEBGL_depth_texture'),
      canvas: (function(c){ return c ? [c.width, c.height, c.clientWidth, c.clientHeight] : null; })(document.getElementById('canvas'))
    });
  } catch (e) { return JSON.stringify({error: String(e)}); }
})()`);

const log = await ring();
const grab = (re, n) => log.split('\n').filter(l => re.test(l)).slice(0, n || 6);

console.log('===== gfx-probe (' + (USE_GPU ? 'REAL GPU / ANGLE-D3D11' : 'SwiftShader') + ') =====');
console.log('map loaded:', loaded);
console.log('context:', ctxInfo);
console.log('GLimp:', grab(/GLimp_Init/));
console.log('renderer cvars:', grab(/overBright|intensity|gamma|picmip|textureMode|subdivisions/i, 8));
console.log('GL warnings:', grab(/^! /, 10));

// LOG=<path> dumps the ENTIRE engine ring, not a filtered slice — the renderer reports
// shader parse errors, missing images and fallbacks there and nowhere else, and grepping
// for what you already suspect is how you miss the one line that mattered.
if (process.env.LOG) {
  fs.writeFileSync(process.env.LOG, log);
  console.log('full engine log:', process.env.LOG, '(' + log.split('\n').length + ' lines)');
}

const sh = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(sh.data, 'base64'));
console.log('shot:', OUT);
ws.close(); chrome.kill(); process.exit(0);
