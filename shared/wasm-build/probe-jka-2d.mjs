// Discriminator: is 2D drawing at all? Open the JKA console (pure 2D stretchpics
// + white text). If it shows, the composite path works and the black world is a
// 3D-only bug (lightmap modulate / camera). If the console is ALSO black, the
// problem is 2D/present-wide. Also traces the FIRST GL call that leaves a
// non-zero glGetError, to pin the 0x500 flood.
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const CDP = 9466, HTTP = 8794;
const c = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--use-gl=angle',
  '--enable-unsafe-swiftshader', '--no-first-run', '--window-size=1280,800',
  '--user-data-dir=' + tmpProfile('idt3-jka-2d'), 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null;
for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r)); await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__l = [];
  for (const k of ['log','warn','error'])
    console[k] = ((o)=>(...a)=>{ try { window.__l.push(a.join(' ')); } catch {} o(...a); })(console[k].bind(console));
  window.__glerr = null;   // first {fn,args,err}
  const _gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs){
    const ctx = _gc.call(this, type, attrs);
    try {
      if (ctx && !ctx.__hooked && /webgl/i.test(type)) {
        ctx.__hooked = true;
        const trace = ['drawElements','drawArrays','texImage2D','texParameteri','texEnvf','bindTexture','vertexAttribPointer'];
        for (const fn of trace) {
          if (typeof ctx[fn] !== 'function') continue;
          const o = ctx[fn].bind(ctx);
          ctx[fn] = function(...a){ const r = o(...a); if (!window.__glerr){ const e = ctx.getError(); if (e){ window.__glerr = fn+'('+a.map(x=>''+x).join(',').slice(0,60)+') -> 0x'+e.toString(16); } } return r; };
        }
      }
    } catch (e) {}
    return ctx;
  };
`});
await S('Page.navigate', { url: `http://localhost:${HTTP}/index.html?args=` + encodeURIComponent('+set sv_pure 0 +map t1_sour') });
const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
for (let i = 0; i < 30; i++) { await sleep(3000); if (/loaded \d+ faces/.test((await logs()).join('\n'))) break; }
await sleep(6000);
// fill viewport
await S('Runtime.evaluate', { expression: `(function(){var c=Module.canvas||document.getElementById('canvas');c.style.setProperty('width','100vw','important');c.style.setProperty('height','100vh','important');c.style.setProperty('object-fit','contain','important');var l=document.getElementById('load');if(l)l.remove();})()` });
await sleep(1500);
let sh = await S('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(tmpProfile('jka-2d-world.png'), Buffer.from(sh.data, 'base64'));
// open console: Shift+` toggles the full console in JKA
const key = async (k, code, which, mods=0) => { for (const t of ['keyDown','keyUp']) await S('Input.dispatchKeyEvent', { type: t, key: k, code, windowsVirtualKeyCode: which, nativeVirtualKeyCode: which, modifiers: mods }); await sleep(250); };
await key('`', 'Backquote', 192, 8 /*shift*/);
await sleep(1500);
sh = await S('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(tmpProfile('jka-2d-console.png'), Buffer.from(sh.data, 'base64'));
const glerr = JSON.parse((await S('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify(window.__glerr)' })).result.value || 'null');
console.log('FIRST GL ERROR:', glerr || 'none');
console.log('SHOTS: /tmp/jka-2d-world.png  /tmp/jka-2d-console.png');
ws.close(); c.kill(); process.exit(0);
