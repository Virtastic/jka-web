// idTech3-web M4 end-to-end match test: launch a HOST (listen server) and a CLIENT in two
// headless browsers that talk ONLY through the WebSocket relay, join opposite teams via the JS
// console ring, wait out a reinforcement wave, and screenshot both — proving a real networked
// match (connect → gamestate → team join → spawn → 3D view).
//   node net-duel.mjs <gamePort> <relayUrl> <hostArgs> <clientArgs> <hostCmdsJSON> <clientCmdsJSON> <spawnWaitSec>
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const [PORT, RELAY, HOST_ARGS, CLI_ARGS, HOST_CMDS, CLI_CMDS, SPAWN] = [
  process.argv[2], process.argv[3]||'ws://localhost:27960', process.argv[4]||'', process.argv[5]||'',
  process.argv[6]||'[]', process.argv[7]||'[]', parseInt(process.argv[8]||'35',10) ];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { default: WS } = await import('ws');

async function launch(cdp, tag) {
  const udir = `/tmp/idt3-duel-${cdp}`; execFile('rm', ['-rf', udir]);
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
  await S('Page.addScriptToEvaluateOnNewDocument', { source: `window.__IDT3_NET_RELAY = ${JSON.stringify(RELAY)};` });
  return { S, logs, chrome, ws, tag,
    nav: async (args) => S('Page.navigate', { url: 'http://localhost:'+PORT+'/index.html?args='+encodeURIComponent(args) }),
    waitLog: async (re, sec) => { for (let i=0;i<sec;i++){ await sleep(1000); if (logs.some(l=>re.test(l))) return true; } return false; },
    vip: async () => (await S('Runtime.evaluate',{returnByValue:true,expression:`(Module.__idt3_net&&Module.__idt3_net.vip)||''`})).result.value,
    cmd: async (c) => { await S('Runtime.evaluate',{expression:`(Module.__idt3_con=Module.__idt3_con||[]).push(${JSON.stringify(c)})`}); console.log(tag,'cmd:',c); await sleep(1200); },
    shot: async (path) => { const s=await S('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path, Buffer.from(s.data,'base64')); console.log(tag,'shot',path, fs.statSync(path).size); },
    key: async (l) => logs.filter(x=>/CL_InitCGame|entered the game|server models|challenge|Corrupted|refused|ERROR|dropped/i.test(x)).slice(-6) };
}

// --- HOST ---
const host = await launch(9891, 'HOST');
await host.nav(HOST_ARGS);
console.log('host: waiting for map load + relay vIP…');
await host.waitLog(/CL_InitCGame/i, 90);
await sleep(3000);
console.log('host vIP =', await host.vip());
for (const c of JSON.parse(HOST_CMDS)) await host.cmd(c);

// --- CLIENT --- (host is 10.0.0.2, first to connect)
const cli = await launch(9892, 'CLIENT');
await cli.nav(CLI_ARGS);
console.log('client: connecting to host…');
const got = await cli.waitLog(/CL_InitCGame/i, 60);
console.log('client CL_InitCGame:', got);
await sleep(2000);
console.log('client vIP =', await cli.vip());
for (const c of JSON.parse(CLI_CMDS)) await cli.cmd(c);

console.log(`waiting ${SPAWN}s for reinforcement wave / spawn…`);
await sleep(SPAWN*1000);
await host.shot('/tmp/duel-host.png');
await cli.shot('/tmp/duel-client.png');
console.log('HOST key:', (await host.key()).join(' | '));
console.log('CLIENT key:', (await cli.key()).join(' | '));
host.ws.close(); host.chrome.kill(); cli.ws.close(); cli.chrome.kill();
process.exit(0);
