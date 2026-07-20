// Exercise the in-page multiplayer LOBBY UX (no ?args): one browser clicks "Host a game" and we
// read the relay-assigned game code it displays; a second browser types that code and clicks
// "Join". Then both join teams and we screenshot — proving the host/join UX + vIP exchange.
//   node net-lobby.mjs <gamePort> <relayUrl> <hostTeamCmd> <clientTeamCmd> <spawnWaitSec>
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const PORT = process.argv[2], RELAY = process.argv[3]||'ws://localhost:27960';
const HOST_TEAM = process.argv[4]||'team b 0 1 1', CLI_TEAM = process.argv[5]||'team r 0 1 1';
const SPAWN = parseInt(process.argv[6]||'40',10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { default: WS } = await import('ws');

async function launch(cdp, tag) {
  const udir = `/tmp/idt3-lobby-${cdp}`; execFile('rm', ['-rf', udir]);
  const chrome = execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${cdp}`, '--headless=new', '--mute-audio', '--use-gl=angle', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--window-size=1024,768',
    `--user-data-dir=${udir}`, 'about:blank']);
  const get = p => new Promise((res, rej) => http.get({ port: cdp, path: p }, r => { let d=''; r.on('data',x=>d+=x); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej));
  let pg=null; for (let i=0;i<25 && !pg;i++){ await sleep(1000); try { pg=(await get('/json')).find(x=>x.type==='page'); } catch {} }
  const ws = new WS(pg.webSocketDebuggerUrl); let id=0;
  const S = (m,p) => new Promise(r => { const i=++id, h=x=>{ const j=JSON.parse(x); if(j.id===i){ ws.off('message',h); r(j.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:i,method:m,params:p})); });
  const logs=[]; await new Promise(r => ws.on('open', r));
  await S('Runtime.enable', {}); await S('Page.enable', {});
  ws.on('message', x => { const j=JSON.parse(x); if (j.method==='Runtime.consoleAPICalled') logs.push((j.params.args||[]).map(a=>a.value!==undefined?a.value:'').join(' ')); });
  const ev = expr => S('Runtime.evaluate',{returnByValue:true,expression:expr}).then(r=>r.result.value);
  return { S, logs, chrome, ws, tag, ev,
    nav: () => S('Page.navigate', { url: 'http://localhost:'+PORT+'/index.html' }),
    waitLog: async (re, sec) => { for (let i=0;i<sec;i++){ await sleep(1000); if (logs.some(l=>re.test(l))) return true; } return false; },
    waitSel: async (sel, sec) => { for (let i=0;i<sec;i++){ if (await ev(`!!document.querySelector(${JSON.stringify(sel)})`)) return true; await sleep(500); } return false; },
    cmd: async (c) => { await S('Runtime.evaluate',{expression:`(Module.__idt3_con=Module.__idt3_con||[]).push(${JSON.stringify(c)})`}); await sleep(1200); },
    shot: async (p) => { const s=await S('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(p, Buffer.from(s.data,'base64')); console.log(tag,'shot',p,fs.statSync(p).size); } };
}

// HOST: click "Host a game", read the game code it shows
const host = await launch(9891,'HOST');
await host.nav(); await host.waitSel('#lb-host', 30);
await host.ev(`document.getElementById('lb-host').click()`);
console.log('HOST: clicked Host a game');
await host.waitLog(/CL_InitCGame/i, 90);
let code=''; for (let i=0;i<20 && !code;i++){ await sleep(1000); code = await host.ev(`(Module.__idt3_net&&Module.__idt3_net.vip)||''`); }
console.log('HOST game code (vIP) =', code);
await sleep(2000); await host.cmd(HOST_TEAM);

// CLIENT: type the code, click Join
const cli = await launch(9892,'CLIENT');
await cli.nav(); await cli.waitSel('#lb-join', 30);
await cli.ev(`document.getElementById('lb-code').value=${JSON.stringify(code)}; document.getElementById('lb-join').click()`);
console.log('CLIENT: entered code + clicked Join');
const ok = await cli.waitLog(/CL_InitCGame/i, 60);
console.log('CLIENT CL_InitCGame:', ok);
await sleep(2000); await cli.cmd(CLI_TEAM);

console.log(`waiting ${SPAWN}s for spawn…`);
await sleep(SPAWN*1000);
await host.shot('/tmp/lobby-host.png'); await cli.shot('/tmp/lobby-client.png');
const key = a => a.filter(x=>/CL_InitCGame|entered the game|server models|challenge/i.test(x)).slice(-4).join(' | ');
console.log('HOST:', key(host.logs)); console.log('CLIENT:', key(cli.logs));
host.ws.close(); host.chrome.kill(); cli.ws.close(); cli.chrome.kill(); process.exit(0);
