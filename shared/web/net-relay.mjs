// idTech3-web — WebSocket <-> UDP net relay (with browser<->browser routing).
//
// Browsers cannot open UDP sockets, so the wasm engine's Sys_SendPacket/Sys_GetPacket
// speak to this relay over a WebSocket. The relay does two things:
//   1. Route browser<->browser — one browser HOSTs a listen server, another joins by its
//      virtual IP; a full match between two browsers with no native server anywhere.
//   2. (Opt-in) Bridge to real UDP — a browser client reaches a normal RTCW-MP / Wolf:ET
//      server. DISABLED by default (see hardening below) because on a public relay it is an
//      SSRF / UDP-amplification vector: a client could ask the relay to spray UDP at any host.
//
// Each WS connection is assigned a virtual IPv4 in 10.0.0.x (announced to the browser as a
// control frame from 0.0.0.0). Datagrams whose destination is a known vIP are forwarded to
// that browser's WS (source rewritten to the sender's vIP).
//
// Wire framing (binary, both directions):
//   [0..3]  peer IPv4 (4 bytes)         — dst on browser->relay, src on relay->browser
//   [4..5]  peer UDP port (big-endian)
//   [6..]   raw datagram payload (the engine's connectionless/netchan packet)
//
//   node shared/web/net-relay.mjs [wsPort]        (default 27960)
//
// ── Hardening (public deploy, relay.virtastic.app) ───────────────────────────────────────
//   IDT3_RELAY_BRIDGE_UDP=1   allow the WS->real-UDP bridge (default OFF: browser<->browser
//                             only — removes the SSRF/amplification vector entirely).
//   IDT3_RELAY_ORIGINS=a,b    comma-list of allowed WS Origin values (default: allow all;
//                             set to the game hosts in prod, e.g. https://wolfet.virtastic.app).
//   IDT3_RELAY_MAX_CONNS      max concurrent connections (default 300).
//   IDT3_RELAY_MAX_MSG        max frame bytes (default 16384; netchan packets are < 1500).
//   IDT3_RELAY_RATE           max frames/sec per connection (default 600; legit play ~60/s).
// These caps make the internet-exposed relay safe to run behind Cloudflare + Caddy.
import { WebSocketServer } from 'ws';
import dgram from 'node:dgram';

const WS_PORT   = parseInt(process.argv[2] || process.env.IDT3_RELAY_PORT || '27960', 10);
const VPORT     = 27960;               // virtual UDP port every browser peer "listens" on
const BRIDGE_UDP = process.env.IDT3_RELAY_BRIDGE_UDP === '1';     // default: browser<->browser only
const ALLOWED_ORIGINS = (process.env.IDT3_RELAY_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_CONNS = parseInt(process.env.IDT3_RELAY_MAX_CONNS || '300', 10);
const MAX_MSG   = parseInt(process.env.IDT3_RELAY_MAX_MSG   || '16384', 10);
const MAX_RATE  = parseInt(process.env.IDT3_RELAY_RATE      || '600', 10);

const wss = new WebSocketServer({
  port: WS_PORT,
  maxPayload: MAX_MSG,                  // ws-level hard cap on frame size
  // Origin allowlist (optional): reject WS upgrades from disallowed origins early.
  verifyClient: (info) => {
    if (!ALLOWED_ORIGINS.length) return true;
    const o = info.origin || info.req.headers.origin || '';
    return ALLOWED_ORIGINS.includes(o);
  },
});
const byVip = new Map();           // "10.0.0.N" -> ws
let nextVip = 2, conns = 0;

const frameFor = (ip, port, payload) => {
  const f = Buffer.alloc(6 + payload.length);
  const p = ip.split('.'); for (let i = 0; i < 4; i++) f[i] = parseInt(p[i], 10) & 0xff;
  f.writeUInt16BE(port & 0xffff, 4); payload.copy(f, 6); return f;
};

wss.on('connection', (ws, req) => {
  if (conns >= MAX_CONNS) { try { ws.close(1013, 'busy'); } catch {} return; }  // 1013 = try again later
  conns++;
  const vip = `10.0.0.${nextVip++}`;
  ws.__vip = vip; byVip.set(vip, ws);
  // Disable Nagle: game datagrams are small and latency-sensitive; without TCP_NODELAY the
  // kernel coalesces them, adding tens of ms of jitter. (Browser side of a WS is already no-delay.)
  try { req.socket.setNoDelay(true); } catch {}
  // Real-UDP bridge socket only when explicitly enabled (SSRF-safe by default).
  const udp = BRIDGE_UDP ? dgram.createSocket('udp4') : null;
  const tag = `[${vip}]`;
  let sent = 0, recv = 0, peered = 0, dropped = 0;
  // token-bucket rate limiter (refills MAX_RATE/sec)
  let tokens = MAX_RATE, last = 0; // last set on first message via a monotonic-ish counter
  const rl = setInterval(() => { tokens = MAX_RATE; }, 1000);
  console.log(`${tag} connected (${req.socket.remoteAddress}) origin=${req.headers.origin || '-'} bridge=${BRIDGE_UDP}`);
  ws.send(frameFor('0.0.0.0', 0, Buffer.from(vip, 'ascii')));   // announce our vIP

  if (udp) {
    udp.on('message', (payload, rinfo) => { if (ws.readyState === ws.OPEN) ws.send(frameFor(rinfo.address, rinfo.port, payload)); recv++; });
    udp.on('error', e => console.log(`${tag} udp error: ${e.message}`));
    udp.bind();
  }

  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 6 || buf.length > MAX_MSG) { dropped++; return; }
    if (tokens-- <= 0) { dropped++; return; }                    // rate cap: drop excess
    const ip = `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
    const port = buf.readUInt16BE(4);
    const payload = buf.subarray(6);
    const peer = byVip.get(ip);
    if (peer && peer !== ws) {
      if (peer.readyState === peer.OPEN) peer.send(frameFor(vip, VPORT, payload));   // browser -> browser
      peered++;
    } else if (udp) {
      udp.send(payload, port, ip, err => { if (err) console.log(`${tag} udp send error: ${err.message}`); });  // browser -> real UDP (opt-in)
      sent++;
    } else {
      dropped++;   // unknown vIP + bridge disabled: drop (no arbitrary UDP)
    }
  });

  ws.on('close', () => { conns--; clearInterval(rl); byVip.delete(vip);
    console.log(`${tag} closed (peer ${peered}, udp ${sent}/${recv}, dropped ${dropped})`); try { udp && udp.close(); } catch {} });
  ws.on('error', e => console.log(`${tag} ws error: ${e.message}`));
});

console.log(`idTech3-web net relay: ws://0.0.0.0:${WS_PORT}  (browser<->browser${BRIDGE_UDP ? ' + WS<->UDP bridge' : ''}; ` +
  `caps: conns<=${MAX_CONNS}, msg<=${MAX_MSG}B, rate<=${MAX_RATE}/s; origins=${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(',') : 'any'})`);
