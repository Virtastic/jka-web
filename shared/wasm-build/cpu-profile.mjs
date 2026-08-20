// CPU-profile a running game via the CDP Profiler domain and aggregate self-time by function,
// bucketed into: WASM (engine), GL-emulation JS (draw submission / vertex re-upload),
// swiftshader/GL driver, and other JS. Tells us where the frame time actually goes.
// Usage: node cpu-profile.mjs <port> "<+args>" <label> [waitSec] [sampleSec]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
const PORT = process.argv[2], ARGS = process.argv[3] || '', LABEL = process.argv[4] || PORT;
const WAIT = parseInt(process.argv[5] || '80', 10), SAMPLE = parseInt(process.argv[6] || '6', 10);
const CDP = 9900 + (parseInt(PORT,10) % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const udir = tmpProfile(`idt3-cpu-${PORT}`); execFile('rm', ['-rf', udir]);
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1280,800',
  `--user-data-dir=${udir}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
let pg=null; for (let i=0;i<25 && !pg;i++){ await sleep(1000); try { pg=(await get('/json')).find(x=>x.type==='page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id=0;
const S = (m,p) => new Promise(r => { const i=++id, h=x=>{ const j=JSON.parse(x); if(j.id===i){ ws.off('message',h); r(j.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const logs=[]; await new Promise(r=>ws.on('open',r));
await S('Runtime.enable', {}); await S('Page.enable', {}); await S('Profiler.enable', {});
ws.on('message', x => { const j=JSON.parse(x); if (j.method==='Runtime.consoleAPICalled') logs.push((j.params.args||[]).map(a=>a.value!==undefined?a.value:'').join(' ')); });
await S('Page.navigate', { url: 'http://localhost:'+PORT+'/index.html'+(ARGS?'?args='+encodeURIComponent(ARGS):'') });
let loaded=false;
for (let i=0;i<WAIT;i++){ await sleep(1000); if (logs.some(l=>/CL_InitCGame|Com_TouchMemory|finished R_Init/i.test(l))) { loaded=true; if(i>8) break; } }
await sleep(2000);
await S('Profiler.setSamplingInterval', { interval: 200 });   // microseconds
await S('Profiler.start', {});
await sleep(SAMPLE*1000);
const { profile } = await S('Profiler.stop', {});
// aggregate self-time (ticks) per node, bucket by function/url
const nodes = {}; for (const n of profile.nodes) nodes[n.id] = n;
const self = {};
const dt = profile.timeDeltas, samples = profile.samples;
for (let i=0;i<samples.length;i++){ self[samples[i]] = (self[samples[i]]||0) + (dt[i]||0); }
function bucket(cf){
  const fn = cf.functionName || '(anon)', url = cf.url || '';
  if (url.endsWith('.wasm')) return 'WASM engine';
  if (/_emscripten_gl|glDrawElements|glBufferSubData|glVertexAttribPointer|glDrawArrays|GLImmediate|glBufferData|glTexImage|glTexSubImage|glActiveTexture|glBindTexture|glUseProgram|emscriptenWebGL/i.test(fn)) return 'GL-emulation JS';
  if (/swiftshader|ANGLE|libGL|SwANGLE/i.test(url+fn)) return 'GL driver';
  if (fn === '(program)' ) return '(program/native)';
  if (fn === '(idle)' || fn === '(garbage collector)') return fn;
  if (url.endsWith('.js')) return 'other JS ('+fn+')';
  return '(other: '+fn+')';
}
const buckets = {}, byFn = {};
let total=0;
for (const [nid, t] of Object.entries(self)){
  const n = nodes[nid]; if(!n) continue;
  const b = bucket(n.callFrame); buckets[b]=(buckets[b]||0)+t; total+=t;
  const key = b+' :: '+(n.callFrame.functionName||'(anon)');
  byFn[key]=(byFn[key]||0)+t;
}
const pct = v => (100*v/total).toFixed(1)+'%';
console.log(`\n===== ${LABEL}: CPU profile (${SAMPLE}s, total ${(total/1000).toFixed(0)}ms sampled) =====`);
console.log('\n--- by bucket ---');
for (const [b,t] of Object.entries(buckets).sort((a,b)=>b[1]-a[1])) console.log(`  ${pct(t).padStart(6)}  ${(t/1000).toFixed(0).padStart(5)}ms  ${b}`);
console.log('\n--- top 15 JS functions (self-time; wasm shows as one blob) ---');
for (const [k,t] of Object.entries(byFn).sort((a,b)=>b[1]-a[1]).slice(0,15)) console.log(`  ${pct(t).padStart(6)}  ${k.slice(0,90)}`);
ws.close(); chrome.kill(); process.exit(0);
