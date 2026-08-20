// idTech3-web — two-browser multiplayer match proof (Wolf:ET).
// Browser A hosts a listen server (+devmap); browser B connects to A's relay-assigned
// virtual IP. Proves a full browser<->browser MP connect through net-relay.mjs: B's
// getchallenge reaches A's server, A replies, B advances and connects — no native server.
//   node shared/wasm-build/verify-net-2browser.mjs   (needs server.py wolfet on :8792)
import { CHROME, tmpProfile } from './chrome.mjs';
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import WS from 'ws';
import fs from 'node:fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const HTTP=process.argv[2]||'8792';
const MAP=process.argv[3]||'oasis';
const relay=spawn('node',['shared/web/net-relay.mjs','27960'],{stdio:'inherit'}); await sleep(700);

async function launch(port, args, relayUrl){
  const c=execFile(CHROME,[`--remote-debugging-port=${port}`,'--headless=new','--use-gl=angle','--enable-unsafe-swiftshader','--no-first-run','--window-size=900,600',`--user-data-dir=${tmpProfile(`idt3-2b-${port}`)}`,'about:blank']);
  const get=p=>new Promise((res,rej)=>http.get({port,path:p},r=>{let d='';r.on('data',x=>d+=x);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej));
  let pg=null;for(let i=0;i<25&&!pg;i++){await sleep(1000);try{pg=(await get('/json')).find(x=>x.type==='page')}catch{}}
  const ws=new WS(pg.webSocketDebuggerUrl);let id=0;
  const S=(m,p)=>new Promise(r=>{const i=++id,h=x=>{const j=JSON.parse(x);if(j.id===i){ws.off('message',h);r(j.result)}};ws.on('message',h);ws.send(JSON.stringify({id:i,method:m,params:p}))});
  await new Promise(r=>ws.on('open',r));await S('Runtime.enable',{});await S('Page.enable',{});
  await S('Page.addScriptToEvaluateOnNewDocument',{source:`window.__IDT3_NET_RELAY=${JSON.stringify(relayUrl)};window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));`});
  await S('Page.navigate',{url:`http://localhost:${HTTP}/index.html?args=`+encodeURIComponent(args)});
  return { c, ws, S, logs: async()=>JSON.parse((await S('Runtime.evaluate',{expression:'JSON.stringify(window.__l||[])',returnByValue:true})).result.value||'[]'),
           vip: async()=>(await S('Runtime.evaluate',{returnByValue:true,expression:"(Module.__idt3_net&&Module.__idt3_net.vip)||''"})).result.value };
}
// A hosts (gets vip 10.0.0.2 as first relay conn); B connects to it.
const relayUrl='ws://localhost:27960';
const A=await launch(9621, '+set sv_pure 0 +set dedicated 0 +set sv_maxclients 4 +devmap '+MAP, relayUrl);
// wait for A to boot + register vip
for(let i=0;i<30;i++){await sleep(2000);const v=await A.vip(); if(v){console.log('HOST vip =',v);break;}}
const hostVip=await A.vip();
const B=await launch(9623, '+set sv_pure 0 +connect '+ (hostVip||'10.0.0.2') +':27960', relayUrl);
// watch B's connection progress
let result='no progress';
for(let i=0;i<30;i++){
  await sleep(2000);
  const bl=(await B.logs()).join('\n');
  const al=(await A.logs()).join('\n');
  if(/entered the game|connected\.|CL_InitCGame|Com_InitJournal|gamestate/i.test(bl)){ result='CONNECTED — B joined A'; break; }
  if(/challenge|Sending challenge|connectResponse|Awaiting/i.test(bl)){ result='HANDSHAKING — challenge/connect exchanged'; }
  if(/client.*connect|Going from CS_FREE|SV_DirectConnect|ClientConnect/i.test(al)){ result='SERVER SAW CLIENT — A accepted B'; }
}
{ const shA=await A.S('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(tmpProfile('net-2b-host.png'),Buffer.from(shA.data,'base64')); }
{ const shB=await B.S('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(tmpProfile('net-2b-client.png'),Buffer.from(shB.data,'base64')); }
const bl=(await B.logs()).filter(x=>/challenge|connect|entered|gamestate|CL_InitCGame|Awaiting|Resolving|error/i.test(x)).slice(-6);
const al=(await A.logs()).filter(x=>/onnect|Client \\d|ClientBegin|entered|challenge ping/i.test(x)).slice(-8);
console.log('HOST vip:', hostVip);
console.log('CLIENT B log tail:', JSON.stringify(bl));
console.log('HOST  A log tail:', JSON.stringify(al));
console.log('RESULT:', result);
A.ws.close();A.c.kill();B.ws.close();B.c.kill();relay.kill();process.exit(0);
