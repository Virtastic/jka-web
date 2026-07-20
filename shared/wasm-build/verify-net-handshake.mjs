// idTech3-web — MP net transport handshake proof (Wolf:ET).
// Spins up a minimal UDP "server" behind shared/web/net-relay.mjs, boots the real ET
// wasm with +connect, and proves the WebSocket transport works BOTH ways: the client's
// getchallenge reaches UDP (send), the server's challengeResponse reaches the client
// (receive via the SE_PACKET pump), and the client advances state and sends `connect`.
//   node shared/wasm-build/verify-net-handshake.mjs   (needs server.py wolfet on :8792)
import dgram from 'node:dgram';
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import WS from 'ws';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const OOB=Buffer.from([0xff,0xff,0xff,0xff]);
// minimal ET "server": reply to getchallenge; log what the client sends
const srv=dgram.createSocket('udp4'); let seq=[];
srv.on('message',(m,r)=>{
  const s=m.subarray(4).toString('latin1');
  const cmd=s.split(/[\s\0]/)[0];
  seq.push(cmd);
  if(/getchallenge/i.test(s)) srv.send(Buffer.concat([OOB,Buffer.from('challengeResponse 12345','latin1')]), r.port, r.address);
  if(/^connect/i.test(s)) srv.send(Buffer.concat([OOB,Buffer.from('connectResponse','latin1')]), r.port, r.address);
});
await new Promise(res=>srv.bind(28999,'127.0.0.1',res));
const relay=spawn('node',['shared/web/net-relay.mjs','27960'],{stdio:'ignore'}); await sleep(700);
const CDP=9613;
const c=execFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[`--remote-debugging-port=${CDP}`,'--headless=new','--use-gl=angle','--enable-unsafe-swiftshader','--no-first-run','--window-size=1024,640','--user-data-dir=/tmp/idt3-net-recv','about:blank']);
const get=p=>new Promise((res,rej)=>http.get({port:CDP,path:p},r=>{let d='';r.on('data',x=>d+=x);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej));
let pg=null;for(let i=0;i<25&&!pg;i++){await sleep(1000);try{pg=(await get('/json')).find(x=>x.type==='page')}catch{}}
const ws=new WS(pg.webSocketDebuggerUrl);let id=0;
const S=(m,p)=>new Promise(r=>{const i=++id,h=x=>{const j=JSON.parse(x);if(j.id===i){ws.off('message',h);r(j.result)}};ws.on('message',h);ws.send(JSON.stringify({id:i,method:m,params:p}))});
await new Promise(r=>ws.on('open',r));await S('Runtime.enable',{});await S('Page.enable',{});
await S('Page.addScriptToEvaluateOnNewDocument',{source:"window.__l=[];for(const k of['log','warn','error'])console[k]=((o)=>(...a)=>{try{window.__l.push(a.join(' '))}catch{}o(...a)})(console[k].bind(console));"});
await S('Page.navigate',{url:'http://localhost:8792/index.html?args='+encodeURIComponent('+set sv_pure 0 +set com_developer 1 +connect 127.0.0.1:28999')});
const logs=async()=>JSON.parse((await S('Runtime.evaluate',{expression:'JSON.stringify(window.__l||[])',returnByValue:true})).result.value||'[]');
for(let i=0;i<25;i++){await sleep(2000);if(seq.some(x=>/^connect/i.test(x)))break;}
await sleep(2000);
const cl=(await logs()).filter(x=>/challenge|connect|Connecting|CA_|gamestate/i.test(x)).slice(-6);
console.log('CLIENT->SERVER cmd sequence:', JSON.stringify(seq));
console.log('CLIENT logs:', JSON.stringify(cl));
console.log('RESULT:', seq.some(x=>/^connect/i.test(x)) ? 'PASS — client received challengeResponse and sent connect (receive path works)' : 'only saw: '+seq.join(','));
ws.close();c.kill();relay.kill();srv.close();process.exit(0);
