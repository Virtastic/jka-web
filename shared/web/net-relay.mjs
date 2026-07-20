// idTech3-web — WebSocket <-> UDP net relay (with browser<->browser routing).
//
// Browsers cannot open UDP sockets, so the wasm engine's Sys_SendPacket/Sys_GetPacket
// speak to this relay over a WebSocket. The relay does two things:
//   1. Bridge to real UDP — a browser client reaches a normal RTCW-MP / Wolf:ET server.
//   2. Route browser<->browser — so one browser can HOST a listen server (a full match
//      between two browsers with no native server anywhere).
//
// Each WS connection is assigned a virtual IPv4 in 10.0.0.x (announced to the browser as
// a control frame from 0.0.0.0). A browser hosting a game tells the client its vIP out of
// band; the client does `/connect 10.0.0.N`. Datagrams whose destination is a known vIP
// are forwarded to that browser's WS (source rewritten to the sender's vIP); everything
// else is bridged to real UDP as before.
//
// Wire framing (binary, both directions):
//   [0..3]  peer IPv4 (4 bytes)         — dst on browser->relay, src on relay->browser
//   [4..5]  peer UDP port (big-endian)
//   [6..]   raw datagram payload (the engine's connectionless/netchan packet)
//
//   node shared/web/net-relay.mjs [wsPort]        (default 27960)
import { WebSocketServer } from 'ws';
import dgram from 'node:dgram';

const WS_PORT = parseInt(process.argv[2] || '27960', 10);
const VPORT = 27960;               // virtual UDP port every browser peer "listens" on
const wss = new WebSocketServer({ port: WS_PORT });
const byVip = new Map();           // "10.0.0.N" -> ws
let nextVip = 2;

const frameFor = (ip, port, payload) => {
  const f = Buffer.alloc(6 + payload.length);
  const p = ip.split('.'); for (let i = 0; i < 4; i++) f[i] = parseInt(p[i], 10) & 0xff;
  f.writeUInt16BE(port & 0xffff, 4); payload.copy(f, 6); return f;
};

wss.on('connection', (ws, req) => {
  const vip = `10.0.0.${nextVip++}`;
  ws.__vip = vip; byVip.set(vip, ws);
  // Disable Nagle: game datagrams are small and latency-sensitive; without TCP_NODELAY the
  // kernel would coalesce them, adding tens of ms of jitter to every packet. (The browser
  // side of a WebSocket is already no-delay.) This is the cheap half of "TCP is not UDP";
  // the full fix for internet-latency head-of-line blocking is WebRTC/WebTransport — see the
  // header note + docs/WASM_ADAPTATIONS.md.
  try { req.socket.setNoDelay(true); } catch {}
  const udp = dgram.createSocket('udp4');
  const tag = `[${vip}]`;
  let sent = 0, recv = 0, peered = 0;
  console.log(`${tag} connected (${req.socket.remoteAddress})`);
  // announce this browser's own vIP (control frame, source 0.0.0.0:0)
  ws.send(frameFor('0.0.0.0', 0, Buffer.from(vip, 'ascii')));

  udp.on('message', (payload, rinfo) => { if (ws.readyState === ws.OPEN) ws.send(frameFor(rinfo.address, rinfo.port, payload)); recv++; });
  udp.on('error', e => console.log(`${tag} udp error: ${e.message}`));
  udp.bind();

  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 6) return;
    const ip = `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
    const port = buf.readUInt16BE(4);
    const payload = buf.subarray(6);
    const peer = byVip.get(ip);
    if (peer && peer !== ws) {
      // browser -> browser: deliver to the peer, source = this browser's vIP
      if (peer.readyState === peer.OPEN) peer.send(frameFor(vip, VPORT, payload));
      peered++;
    } else {
      // browser -> real UDP server
      udp.send(payload, port, ip, err => { if (err) console.log(`${tag} udp send error: ${err.message}`); });
      sent++;
    }
  });

  ws.on('close', () => { byVip.delete(vip); console.log(`${tag} closed (udp ${sent}/${recv}, peer ${peered})`); try { udp.close(); } catch {} });
  ws.on('error', e => console.log(`${tag} ws error: ${e.message}`));
});

console.log(`idTech3-web net relay: ws://0.0.0.0:${WS_PORT}  (WS<->UDP + browser<->browser; peers get 10.0.0.x)`);
