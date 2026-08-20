// Attribute errors recorded by emscripten's GL EMULATION layer, which context-level hooks
// cannot see.
//
// gl-error-trace.mjs wraps functions on the WebGLRenderingContext and calls getError() after
// each, so it catches anything the driver rejects. It is blind to the other source: emscripten's
// fixed-function emulation validates arguments itself and calls GL.recordError(GL_INVALID_ENUM)
// for legacy enums it does not implement, WITHOUT ever calling into WebGL. Those errors sit
// latched until something reads them -- and in these engines nothing does, because
// r_ignoreGLErrors ships defaulting to "1", so the first reader is R_Init()'s one unconditional
// check, which then reports an error raised who-knows-how-many maps earlier.
//
// This hooks GL.recordError directly and keeps a stack for each distinct call site.
//
//   node glemu-error-trace.mjs <httpPort> "<+args>" [waitSec] [extraCmds;semicolon]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';

const PORT = process.argv[2] || '8794';
const ARGS = process.argv[3] || '';
const WAIT = parseInt(process.argv[4] || '90', 10);
const CMDS = (process.argv[5] || '').split(';').filter(Boolean);
const CDP = 9350 + (process.pid % 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--window-size=1280,720', `--user-data-dir=${tmpProfile('idt3-glemu-' + process.pid)}`, 'about:blank']);
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

// The engine's glue is loaded with a plain <script> tag, so its top-level `GL` is a global.
// Poll for it and wrap recordError as soon as it appears -- it has to be in place before the
// renderer starts issuing fixed-function calls.
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__glemuErr = [];
  (function poll(){
    try {
      if (typeof GL !== 'undefined' && GL && typeof GL.recordError === 'function' && !GL.recordError.__hooked) {
        var orig = GL.recordError.bind(GL);
        var f = function(e){
          try {
            var st = ''; try { throw new Error(); } catch (ex) { st = (ex.stack||'').split('\\n').slice(2,10).join(' | '); }
            var key = e + '@' + st;
            var list = window.__glemuErr;
            for (var i=0;i<list.length;i++) if (list[i].key === key) { list[i].count++; return orig(e); }
            list.push({ key:key, err:'0x'+(e>>>0).toString(16), stack:st, count:1 });
          } catch (ex2) {}
          return orig(e);
        };
        f.__hooked = true;
        GL.recordError = f;
        return;
      }
    } catch (e) {}
    setTimeout(poll, 50);
  })();
`});

await S('Page.navigate', { url: `http://localhost:${PORT}/index.html` + (ARGS ? '?args=' + encodeURIComponent(ARGS) : '') });
const evalv = async expr => { try { const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true }); return r && r.result ? r.result.value : undefined; } catch { return undefined; } };

for (let i = 0; i < WAIT; i++) {
  await sleep(1000);
  const n = await evalv('(window.__glemuErr||[]).length');
  if (i > 20 && n > 0) break;
}
for (const c of CMDS) {
  await evalv(`(function(){try{Module.ccall('idt3_exec_cmd',null,['string'],[${JSON.stringify(c)}]);return 1;}catch(e){return 0;}})()`);
  // CMD_WAIT: these commands are usually `map <name>`, which needs far longer than a
  // console toggle. Default 6s, raise it when driving map loads.
  await sleep(parseInt(process.env.CMD_WAIT || '6000', 10));
}

const hooked = await evalv('(typeof GL !== "undefined" && GL && !!GL.recordError && !!GL.recordError.__hooked)');
const raw = await evalv('JSON.stringify(window.__glemuErr||[])');
const arr = JSON.parse(raw || '[]');
console.log(`\n===== emscripten GL-emulation recorded errors (hook installed: ${hooked}) =====`);
if (!arr.length) console.log('(none recorded)');
for (const e of arr) {
  console.log(`\n[${e.err}] x${e.count}`);
  console.log('  ' + e.stack);
}
ws.close(); chrome.kill(); process.exit(0);
