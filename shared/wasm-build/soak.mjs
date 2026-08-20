// Long-duration stability soak: sit in one map and sample frame rate, draw calls, wasm heap and
// function-table size at a fixed interval.
//
// The map sweep answers "does a whole campaign load"; this answers the other half of long-session
// behaviour: does a session that stays put get slower or fatter over time. Both matter and they
// fail differently — a per-frame leak or a growing render list shows up as fps decay with flat map
// state, which no amount of map loading would reveal.
//
// Reports per window so a trend is visible rather than an average that hides it.
//
//   node soak.mjs <httpPort> "<+args>" [minutes] [windowSec]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2] || '8794';
const ARGS = process.argv[3] || '';
const MINUTES = parseFloat(process.argv[4] || '10');
const WINDOW = parseInt(process.argv[5] || '30', 10);
const CDP = 9450 + (process.pid % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-soak-' + process.pid)}`, 'about:blank']);
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

// Count RAF ticks and GL draws from before the engine boots.
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__raf = 0; window.__draws = 0;
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb){ return _raf(function(t){ window.__raf++; return cb(t); }); };
  const _gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs){
    const ctx = _gc.call(this, type, attrs);
    try {
      if (ctx && !ctx.__soaked && /webgl/i.test(type)) {
        ctx.__soaked = true;
        for (const fn of ['drawElements','drawArrays']) {
          const o = ctx[fn].bind(ctx);
          ctx[fn] = function(){ window.__draws++; return o.apply(ctx, arguments); };
        }
      }
    } catch (e) {}
    return ctx;
  };
`});
await S('Page.navigate', { url: `http://localhost:${PORT}/index.html` + (ARGS ? '?args=' + encodeURIComponent(ARGS) : '') });

const evalv = async expr => { try { const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true }); return r && r.result ? r.result.value : undefined; } catch { return undefined; } };
const CA_ACTIVE = 7;
const state = async () => { const v = await evalv(`(function(){try{return Module.ccall('idt3_client_state','number',[],[]);}catch(e){return -1;}})()`); return typeof v === 'number' ? v : -1; };

let ready = false;
for (let i = 0; i < 180; i++) { await sleep(1000); if ((await state() & 0xff) === CA_ACTIVE) { ready = true; break; } }
if (!ready) { console.log('FAIL: never reached gameplay'); ws.close(); chrome.kill(); process.exit(1); }
for (const t of ['mousePressed', 'mouseReleased'])
  await S('Input.dispatchMouseEvent', { type: t, x: 640, y: 360, button: 'left', clickCount: 1, buttons: 1 });
await sleep(3000);

const snap = async () => JSON.parse(await evalv(`JSON.stringify({
  raf: window.__raf, draws: window.__draws,
  heap: (typeof HEAPU8 !== 'undefined' && HEAPU8) ? HEAPU8.length : 0,
  table: (typeof wasmTable !== 'undefined' && wasmTable) ? wasmTable.length : 0
})`) || '{}');

console.log(`soaking ${MINUTES} min in ${WINDOW}s windows…`);
let prev = await snap();
const t0 = Date.now();
const rows = [];
while ((Date.now() - t0) < MINUTES * 60000) {
  await sleep(WINDOW * 1000);
  const cur = await snap();
  const fps = (cur.raf - prev.raf) / WINDOW;
  const dpf = (cur.raf > prev.raf) ? (cur.draws - prev.draws) / (cur.raf - prev.raf) : 0;
  rows.push({ t: Math.round((Date.now() - t0) / 1000), fps, dpf, heap: cur.heap, table: cur.table });
  console.log(`t+${String(Math.round((Date.now()-t0)/1000)).padStart(4)}s  fps=${fps.toFixed(1)}  draws/frame=${dpf.toFixed(0)}  heap=${(cur.heap/1048576).toFixed(1)}MB  table=${cur.table}`);
  prev = cur;
}

// Drop warm-up windows before judging a trend. The first window after CA_ACTIVE can still be
// mid-cutscene or mid-population -- measured on JKA t2_rogue it read fps=67.8 at
// draws/frame=345, against a steady state of ~37fps at ~726 draws/frame. Comparing that against
// the end of the run manufactured an 11.4% "decay" out of a perfectly flat session. Steady state
// is defined by the draw load settling, not by elapsed time.
const steady = rows.findIndex((r, i) => i > 0 && r.dpf > 0 &&
  Math.abs(r.dpf - rows[i - 1].dpf) / Math.max(1, rows[i - 1].dpf) < 0.1);
// steady is the first window that MATCHES its predecessor, so the predecessor was already at
// full draw load -- trim to steady-1, not steady, or a good sample is thrown away.
const warm = steady > 0 ? steady - 1 : 0;
if (warm) console.log(`(discarding ${warm} warm-up window(s): draw load still settling)`);
const rows2 = rows.slice(warm);
const f = rows2.map(r => r.fps);
const first = f.slice(0, Math.max(1, Math.floor(f.length / 3)));
const last = f.slice(-Math.max(1, Math.floor(f.length / 3)));
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const drop = 100 * (avg(first) - avg(last)) / (avg(first) || 1);
const heapGrew = rows.length ? rows[rows.length - 1].heap - rows[0].heap : 0;
const tableGrew = rows.length ? rows[rows.length - 1].table - rows[0].table : 0;
console.log(`\n===== soak: ${MINUTES} min =====`);
console.log(`fps first third ${avg(first).toFixed(1)} -> last third ${avg(last).toFixed(1)}  (${drop >= 0 ? 'down' : 'up'} ${Math.abs(drop).toFixed(1)}%)`);
console.log(`heap grew ${(heapGrew / 1048576).toFixed(1)}MB, table grew ${tableGrew} entries`);
console.log(drop < 10 && heapGrew === 0 && tableGrew === 0 ? 'STABLE' : 'CHECK THE TREND ABOVE');
ws.close(); chrome.kill(); process.exit(0);
