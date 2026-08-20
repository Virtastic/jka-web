// idTech3-web MP net test: boot a game with the WebSocket relay opted in (window.__IDT3_NET_RELAY)
// and drive a connect, capturing console + the client's assigned vIP. Proves the WS transport.
// Usage: node net-test.mjs <port> "<+args>" <relayUrl> <label> [waitSec]
import { CHROME, tmpProfile } from './chrome.mjs';
import { execFile } from 'node:child_process';
import http from 'node:http';
const PORT = process.argv[2], ARGS = process.argv[3] || '', RELAY = process.argv[4] || 'ws://localhost:27960';
const LABEL = process.argv[5] || PORT, WAIT = parseInt(process.argv[6] || '35', 10);
// argv[7]: explicit CDP port so two instances (host+client) on the same game port don't collide.
const CDP = parseInt(process.argv[7] || (9900 + (parseInt(PORT,10) % 100)), 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const udir = tmpProfile(`idt3-net-${CDP}`); execFile('rm', ['-rf', udir]);
const chrome = execFile(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1024,768',
  `--user-data-dir=${udir}`, 'about:blank']);
const get = p => new Promise((res, rej) => http.get({ port: CDP, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
let pg=null; for (let i=0;i<25 && !pg;i++){ await sleep(1000); try { pg=(await get('/json')).find(x=>x.type==='page'); } catch {} }
const { default: WS } = await import('ws');
const ws = new WS(pg.webSocketDebuggerUrl); let id=0;
const S = (m,p) => new Promise(r => { const i=++id, h=x=>{ const j=JSON.parse(x); if(j.id===i){ ws.off('message',h); r(j.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
const logs=[]; await new Promise(r => ws.on('open', r));
await S('Runtime.enable', {}); await S('Page.enable', {});
ws.on('message', x => { const j=JSON.parse(x); if (j.method==='Runtime.consoleAPICalled') logs.push((j.params.args||[]).map(a=>a.value!==undefined?a.value:'').join(' ')); });
// opt into the relay BEFORE any page script runs
await S('Page.addScriptToEvaluateOnNewDocument', { source: `window.__IDT3_NET_RELAY = ${JSON.stringify(RELAY)};` });
const url = 'http://localhost:'+PORT+'/index.html' + (ARGS ? '?args='+encodeURIComponent(ARGS) : '');
await S('Page.navigate', { url });
// Post-connect console commands (e.g. join a team so the client spawns into the 3D match).
// NET_CMDS='["team r"]' — pushed onto Module.__idt3_con once cgame is up.
const cmds = JSON.parse(process.env.NET_CMDS || '[]');
let ingame = false;
for (let i=0;i<WAIT;i++){
  await sleep(1000);
  if (!ingame && logs.some(l => /CL_InitCGame/i.test(l))) {
    ingame = true;
    if (cmds.length) {
      await sleep(2000);
      for (const c of cmds) {
        await S('Runtime.evaluate', { expression: `(Module.__idt3_con=Module.__idt3_con||[]).push(${JSON.stringify(c)})` });
        console.log('cmd:', c);
        await sleep(1500);
      }
    }
  }
}
// report the assigned vIP + any net state
const st = await S('Runtime.evaluate', { returnByValue:true, expression:
  `(function(){ var s=Module.__idt3_net; return s? JSON.stringify({vip:s.vip, wsState:s.ws&&s.ws.readyState, queued:s.q&&s.q.length, url:s.url}) : 'NO __idt3_net'; })()` });
console.log(`\n===== ${LABEL} =====`);
console.log('net state:', st.result && st.result.value);
const strip = s => s.replace(/\^[0-9]/g,'');
const netlines = logs.filter(l => /challenge|connect|Connect|gamestate|entering|awaiting|resolv|Server|netchan|CL_|deferred|refused|password|snapshot|badcksum|map:/i.test(l)).map(strip);
console.log('--- net/connect log lines ---');
console.log(netlines.slice(-30).join('\n') || '(none)');
// nudge past any intro, then screenshot for visual proof of the networked scene
for (const t of ['mousePressed','mouseReleased']) await S('Input.dispatchMouseEvent',{type:t,x:512,y:384,button:'left',clickCount:1,buttons:1});
await sleep(1500);
try { const shot = await S('Page.captureScreenshot',{format:'png'}); (await import('node:fs')).writeFileSync(tmpProfile(`net-${CDP}.png`), Buffer.from(shot.data,'base64')); console.log('shot: /tmp/net-'+CDP+'.png'); } catch(e){ console.log('shot failed', e.message); }
ws.close(); chrome.kill(); process.exit(0);
