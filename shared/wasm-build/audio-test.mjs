// Verify the scheduled-AudioBufferSource sound backend: boot a game, load a map, send a
// TRUSTED click (CDP events count as a user gesture so the AudioContext resumes), then sample
// {state, rate, pos, peak} over time to prove the play cursor advances and real audio is output.
// Usage: node audio-test.mjs <port> "<+args>" <label> [waitSec]
import { execFile } from 'node:child_process';
import http from 'node:http';
const PORT = process.argv[2], ARGS = process.argv[3] || '', LABEL = process.argv[4] || PORT;
const WAIT = parseInt(process.argv[5] || '80', 10);
const CDP = 9800 + (parseInt(PORT,10) % 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const udir = `/tmp/idt3-au-${PORT}`; execFile('rm', ['-rf', udir]);
const chrome = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1024,768',
  `--user-data-dir=${udir}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
let pg=null; for (let i=0;i<25 && !pg;i++){ await sleep(1000); try { pg=(await get('/json')).find(x=>x.type==='page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id=0;
const S = (m,p) => new Promise(r => { const i=++id, h=x=>{ const j=JSON.parse(x); if(j.id===i){ ws.off('message',h); r(j.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const logs=[]; await new Promise(r=>ws.on('open',r));
await S('Runtime.enable', {}); await S('Page.enable', {});
ws.on('message', x => { const j=JSON.parse(x); if (j.method==='Runtime.consoleAPICalled') logs.push((j.params.args||[]).map(a=>a.value!==undefined?a.value:'').join(' ')); });
await S('Page.navigate', { url: 'http://localhost:'+PORT+'/index.html'+(ARGS?'?args='+encodeURIComponent(ARGS):'') });
let loaded=false;
for (let i=0;i<WAIT;i++){ await sleep(1000); if (logs.some(l=>/CL_InitCGame|Com_TouchMemory|finished R_Init/i.test(l))) { loaded=true; if(i>8) break; } }
await sleep(3000);
// trusted click at canvas centre -> user gesture -> AudioContext resumes
for (const t of ['mousePressed','mouseReleased']) await S('Input.dispatchMouseEvent',{type:t,x:512,y:384,button:'left',clickCount:1,buttons:1});
const snd = async () => JSON.parse((await S('Runtime.evaluate',{returnByValue:true,expression:`(function(){var s=Module.__idt3_snd;if(!s||!s.ctx)return JSON.stringify({err:'NO CTX'});return JSON.stringify({state:s.ctx.state,rate:s.ctx.sampleRate,pos:s.pos,peak:Number(s.peak.toFixed(4)),sched:s.sched});})()`})).result.value);
console.log(`\n===== ${LABEL}: audio backend (scheduled AudioBufferSource) — map ${loaded?'LOADED':'?'} =====`);
let prev=null;
for (let i=0;i<5;i++){ await sleep(1500); const s=await snd();
  const advancing = prev!=null ? (s.pos>prev.pos?'+':'STALLED') : '';
  console.log(`t+${(i+1)*1.5}s  state=${s.state} rate=${s.rate} pos=${s.pos} ${advancing} peak=${s.peak} sched=${s.sched}`);
  prev=s; }
// any WebGL/console errors mentioning audio or ScriptProcessor still?
console.log('ScriptProcessor mentions in console:', logs.filter(l=>/ScriptProcessor/i.test(l)).length);
console.log('SNDDMA line:', (logs.find(l=>/SNDDMA_Init/.test(l))||'(none)'));
ws.close(); chrome.kill(); process.exit(0);
