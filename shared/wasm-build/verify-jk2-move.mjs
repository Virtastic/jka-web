// JK2 movement proof. The free JK2 demo's demo.bsp opens on a ~35s scripted intro
// cinematic (Kyle hidden in a crate); it ends on its own and hands the player control in
// a dim interior of the escape level. We wait it out — crucially, once the cinematic ends
// (in_camera=false) there is NO camera moving the view on its own, so a plain idle-vs-W
// frame diff cleanly isolates player locomotion (unlike DURING the cinematic, where camera
// motion faked it). Require TWO consecutive rounds of standing-still-then-W-moves so a
// stray animation can't trigger a false positive.
//   node verify-jk2-move.mjs
import { execFile } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
const HTTP = 8793, CDP = 9465, GX = 64, GY = 40;
const c = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--no-first-run', '--window-size=1280,800', '--user-data-dir=/tmp/idt3-jk2-move', 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data', x=>d+=x); r.on('end', ()=>res(JSON.parse(d))); }).on('error', rej));
let pg = null; for (let i = 0; i < 25 && !pg; i++) { await sleep(1000); try { pg = (await get('/json')).find(x => x.type === 'page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id = 0;
const S = (m, p) => new Promise(r => { const i = ++id, h = x => { const j = JSON.parse(x); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
await new Promise(r => ws.on('open', r)); await S('Runtime.enable', {}); await S('Page.enable', {});
await S('Page.addScriptToEvaluateOnNewDocument', { source: "window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));" });
await S('Page.navigate', { url: `http://localhost:${HTTP}/index.html?args=` + encodeURIComponent('+set sv_pure 0 +devmap demo') });
const logs = async () => JSON.parse((await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__l||[])', returnByValue: true })).result.value || '[]');
for (let i = 0; i < 30; i++) { await sleep(3000); if (/loaded \d+ faces/.test((await logs()).join('\n'))) break; }
await S('Runtime.evaluate', { expression: "(function(){var c=Module.canvas||document.getElementById('canvas');c.style.setProperty('width','100vw','important');c.style.setProperty('height','100vh','important');c.style.setProperty('object-fit','contain','important');var l=document.getElementById('load');if(l)l.remove();})()" });
console.log('map loaded; waiting out the ~35s intro cinematic...');
await sleep(48000);

function pngLuma(buf) { let p = 8, w = 0, h = 0, idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8); if (t === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); } else if (t === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len)); else if (t === 'IEND') break; p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, st = w * bpp, cur = Buffer.alloc(st), prev = Buffer.alloc(st), g = new Float64Array(GX * GY), cn = new Float64Array(GX * GY); let o = 0;
  for (let y = 0; y < h; y++) { const f = raw[o++]; for (let x = 0; x < st; x++) { const rv = raw[o + x], a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], cc = x >= bpp ? prev[x - bpp] : 0; let v; switch (f) { case 0: v = rv; break; case 1: v = rv + a; break; case 2: v = rv + b; break; case 3: v = rv + ((a + b) >> 1); break; case 4: { const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc); v = rv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc); break; } default: v = rv; } cur[x] = v & 0xff; } o += st; const gy = (y * GY / h) | 0; for (let x = 0; x < w; x++) { const gx = (x * GX / w) | 0, gi = gy * GX + gx; g[gi] += 0.299 * cur[x * 4] + 0.587 * cur[x * 4 + 1] + 0.114 * cur[x * 4 + 2]; cn[gi]++; } cur.copy(prev); }
  for (let i = 0; i < g.length; i++) g[i] /= (cn[i] || 1); return g;
}
const shot = async () => Buffer.from((await S('Page.captureScreenshot', { format: 'png' })).data, 'base64');
// whole-frame luma diff (content only). Post-cinematic there is no camera motion, so any
// change is player-driven; a small threshold on a dim scene is fine.
const diffFrac = (a, b, thr = 8) => { const ga = pngLuma(a), gb = pngLuma(b); let d = 0, n = 0; for (let y = 0; y < GY; y++) for (let x = 0; x < GX; x++) { const cx = x / GX; if (cx < 0.14 || cx > 0.86 || y < 3) continue; n++; if (Math.abs(ga[y * GX + x] - gb[y * GX + x]) > thr) d++; } return d / n; };
const hold = async (ms) => { await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 }); await sleep(ms); await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 }); };

let prevGood = false, moved = false, best = null;
for (let i = 0; i < 10 && !moved; i++) {
  const i0 = await shot(); await sleep(1200); const i1 = await shot(); const idle = diffFrac(i0, i1);
  const before = await shot(); await hold(2000); const after = await shot(); const mv = diffFrac(before, after);
  const good = idle < 0.06 && mv > 0.15 && mv > idle * 3;
  console.log(`round ${i}: idle ${(idle * 100).toFixed(1)}%  W-held ${(mv * 100).toFixed(1)}%  ${good ? 'GOOD' : ''}`);
  if (good) { if (best === null) best = { before, after }; if (prevGood) { moved = true; best = { before, after }; } prevGood = true; } else prevGood = false;
  await sleep(1000);
}
if (best) { fs.writeFileSync('/tmp/jk2-move-before.png', best.before); fs.writeFileSync('/tmp/jk2-move-after.png', best.after); }
else fs.writeFileSync('/tmp/jk2-move-before.png', await shot());
console.log('MOVED:', moved ? 'YES (two consecutive standing-still→W-moves rounds)' : 'NO/UNCLEAR');
ws.close(); c.kill(); process.exit(0);
