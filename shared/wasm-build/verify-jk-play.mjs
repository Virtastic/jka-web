// JK2/JKA map-load + render probe.
//   node shared/wasm-build/verify-jk-play.mjs <game> <httpPort> "<+args>"
//
// Answers, in order: does the engine keep running (RAF ticks), does the renderer
// actually issue draw calls, and is the framebuffer non-black? A black screenshot
// alone cannot distinguish "stalled", "running but drawing nothing", and "drawing
// a genuinely dark scene".
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const GAME = process.argv[2], PORT_HTTP = process.argv[3];
const ARGS = process.argv[4] || '';
if (!GAME || !PORT_HTTP) { console.error('usage: verify-jk-play.mjs <game> <httpPort> ["+args"]'); process.exit(2); }
const CDP = 9400 + (parseInt(PORT_HTTP, 10) % 100);
const c = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  `--user-data-dir=/tmp/idt3-${GAME}-play`, 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r)); await S('Runtime.enable', {}); await S('Page.enable', {});

// Instrument BEFORE the engine boots: count RAF ticks, and hook getContext so we can
// wrap the GL draw entry points the moment the context is created.
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__l = [];
  for (const k of ['log','warn','error'])
    console[k] = ((o)=>(...a)=>{ try { window.__l.push(a.join(' ')); } catch {} o(...a); })(console[k].bind(console));
  window.addEventListener('error', e => window.__l.push('PAGEERR: ' + e.message + ' | ' + ((e.error&&e.error.stack)||'')));
  window.__raf = 0;
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb){ return _raf(function(t){ window.__raf++; return cb(t); }); };
  window.__gl = { draws: 0, clears: 0, tex2d: 0, ctx: null };
  const _gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs){
    const ctx = _gc.call(this, type, attrs);
    try {
      if (ctx && !ctx.__hooked && /webgl/i.test(type)) {
        ctx.__hooked = true; window.__gl.ctx = type;
        for (const fn of ['drawElements','drawArrays']) {
          const o = ctx[fn].bind(ctx);
          ctx[fn] = function(...a){ window.__gl.draws++; return o(...a); };
        }
        const oc = ctx.clear.bind(ctx);
        ctx.clear = function(...a){ window.__gl.clears++; return oc(...a); };
        const ot = ctx.texImage2D.bind(ctx);
        ctx.texImage2D = function(...a){ window.__gl.tex2d++; return ot(...a); };
      }
    } catch (e) {}
    return ctx;
  };
`});
await S('Page.navigate', { url: `http://localhost:${PORT_HTTP}/index.html` + (ARGS ? '?args=' + encodeURIComponent(ARGS) : '') });

const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
const stats = async () => JSON.parse((await S('Runtime.evaluate', { returnByValue: true, expression:
  "JSON.stringify({raf: window.__raf, gl: window.__gl, lines: (window.__l||[]).length})" })).result.value);

let prev = null;
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  const s = await stats();
  if (i % 3 === 0) console.log(`t+${i*3}s raf=${s.raf} draws=${s.gl.draws} clears=${s.gl.clears} tex=${s.gl.tex2d} ctx=${s.gl.ctx} logs=${s.lines}`);
  // stop once the picture is clearly being produced
  if (s.gl.draws > 500 && prev && s.gl.draws > prev.gl.draws) break;
  prev = s;
}
await S('Runtime.evaluate', { expression: `(function(){
  var c = Module.canvas || document.getElementById('canvas');
  c.style.setProperty('width','100vw','important'); c.style.setProperty('height','100vh','important');
  c.style.setProperty('object-fit','contain','important');
  var l = document.getElementById('load'); if (l) l.remove();
})()` });
await sleep(2500);
const a = await stats();
await sleep(4000);
const b = await stats();

const sh = await S('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(`/tmp/${GAME}-play.png`, Buffer.from(sh.data, 'base64'));
const all = await logs();
fs.writeFileSync(`/tmp/${GAME}-play.log`, all.join('\n'));

console.log(`\n===== ${GAME} =====`);
console.log(`GL context      : ${a.gl.ctx}`);
console.log(`RAF ticks       : ${a.raf} -> ${b.raf}   (${b.raf > a.raf ? 'ENGINE IS RUNNING' : 'STALLED — no frames'})`);
console.log(`draw calls      : ${a.gl.draws} -> ${b.gl.draws}   (${b.gl.draws > a.gl.draws ? 'rendering' : 'NOT drawing'})`);
console.log(`gl.clear calls  : ${a.gl.clears} -> ${b.gl.clears}`);
console.log(`textures uploaded: ${a.gl.tex2d}`);
console.log(`log lines       : ${a.lines} -> ${b.lines}`);
const crashes = all.filter(x => /PAGEERR|RuntimeError|signature|unreachable/i.test(x));
console.log('crashes         : ' + (crashes.length ? crashes[0].slice(0, 100) : 'none'));
console.log('last log line   : ' + (all.slice(-1)[0] || '').slice(0, 100));
console.log(`SHOT: /tmp/${GAME}-play.png  LOG: /tmp/${GAME}-play.log`);
ws.close(); c.kill(); process.exit(0);
