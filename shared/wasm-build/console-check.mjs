// idTech3-web — boot a game headless, capture ALL console + page errors, wait for the
// map to load, and categorize issues. Usage: node console-check.mjs <port> "<+args>" <label> [waitSec]
import { execFile } from 'node:child_process';
import http from 'node:http';
const PORT = process.argv[2], ARGS = process.argv[3] || '', LABEL = process.argv[4] || PORT;
const WAIT = parseInt(process.argv[5] || '75', 10);
const CDP = 9500 + (parseInt(PORT,10) % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const udir = `/tmp/idt3-cc-${PORT}`;
execFile('rm', ['-rf', udir]);
const chrome = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1024,768',
  `--user-data-dir=${udir}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
let pg=null; for (let i=0;i<25 && !pg;i++){ await sleep(1000); try { pg=(await get('/json')).find(x=>x.type==='page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id=0;
const S = (m,p) => new Promise(r => { const i=++id, h=x=>{ const j=JSON.parse(x); if(j.id===i){ ws.off('message',h); r(j.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const logs = [];
await new Promise(r => ws.on('open', r));
await S('Runtime.enable', {}); await S('Page.enable', {}); await S('Log.enable', {});
ws.on('message', x => { const j = JSON.parse(x);
  if (j.method === 'Runtime.consoleAPICalled') logs.push((j.params.args||[]).map(a=>a.value!==undefined?a.value:(a.description||'')).join(' '));
  else if (j.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (j.params.exceptionDetails?.exception?.description || j.params.exceptionDetails?.text || ''));
  else if (j.method === 'Log.entryAdded') logs.push('['+j.params.entry.level.toUpperCase()+'] ' + j.params.entry.text);
});
const url = 'http://localhost:'+PORT+'/index.html' + (ARGS ? '?args='+encodeURIComponent(ARGS) : '');
await S('Page.navigate', { url });
// poll for map-load marker or timeout
let loaded=false;
for (let i=0;i<WAIT;i++){ await sleep(1000);
  if (logs.some(l => /CL_InitCGame|Com_TouchMemory|sending heartbeat|-----  finished R_Init|Loaded .* ambient set/i.test(l))) { loaded=true; }
  if (loaded && i>Math.min(WAIT-1, 8)) break;
}
// categorize
const strip = s => s.replace(/\^[0-9]/g,'');
const uniq = a => [...new Set(a)];
const errs = uniq(logs.filter(l => /\^1|EXCEPTION|Aborted|RuntimeError|Com_Error|ERROR:|undefined symbol|signature mismatch|\[ERROR\]|abort\(|table index is out of bounds|memory access out of bounds/i.test(l)).map(strip));
const warns = uniq(logs.filter(l => /\^3|WARNING:|could not find|not found|NOT PRECACHED|failed|\[WARNING\]|no image|missing/i.test(l) && !/\^1/.test(l)).map(strip));
console.log(`\n===== ${LABEL} (port ${PORT}) — ${logs.length} log lines, map ${loaded?'LOADED':'NOT DETECTED'} =====`);
console.log(`\n--- ERRORS (${errs.length}) ---`);
console.log(errs.length ? errs.slice(0,40).join('\n') : '(none)');
console.log(`\n--- WARNINGS (${warns.length} unique) ---`);
console.log(warns.length ? warns.slice(0,40).join('\n') : '(none)');
ws.close(); chrome.kill(); process.exit(0);
