# Security audit — idTech3-web (pre-public review)

Scope: the five browser ports (RTCW-SP/MP, Wolf:ET, JK2, JKA) + shared build/web infra, ahead of
making the repos public and hosting them on the shared VPS. Date: 2026-07.

## 1. Secrets — CLEAN
- `gitleaks detect` over the full monorepo history (**179 commits, ~125 MB**): **61 findings, 0 real
  secrets.** 2 are curl's bundled `tests/stunnel.pem` test cert; 59 are the `generic-api-key`
  heuristic firing on pristine **Raven GPL source** (saber token strings in `wp_saberLoad.cpp`,
  `G2API_*` assignments in `sv_game.cpp`) — game code, not credentials.
- **0 findings in our added files** (`shared/`, `play/`, `docs/`, build scripts) in any commit.
- No private emails in tracked content; the published repos are single-commit (`git archive HEAD`),
  so their history == HEAD (already clean). Verdict: safe to publish re: secrets.

## 2. Vendored dependencies — noted, low runtime exposure (wasm-sandboxed)
The GPL drops bundle old third-party libs, compiled into the wasm:
- **`games/wolfet/src/curl-7.12.2`** (2004; many historical CVEs). curl's role in ET is HTTP
  auto-download of pk3s from servers; under emscripten there are no direct sockets and the browser
  port's networking is the WS relay, so the curl network path is effectively unused/unreachable.
  Exposure: low. **Recommendation:** exclude/stub curl from the ET build, or bump it, in a follow-up.
- **`jpeg-6`, zlib/`unzip`, mp3 decoders (JK)** — parse *user-supplied* pk3 assets. A crafted pk3
  could hit a decoder bug, but everything runs inside the **WebAssembly sandbox** (no host memory,
  no syscalls, no FS outside MEMFS/IDBFS), so worst case is a tab crash, not host compromise. The
  data is the visitor's own (upload-only / their install). Acceptable for preview; note for hardening.

## 3. Network relay — HARDENED (was the one real issue)
`shared/web/net-relay.mjs` bridged a browser's WS frame to **arbitrary `ip:port` over UDP** — on an
internet-exposed `relay.virtastic.app` that is an SSRF / UDP-amplification / reflector vector.
Fixes applied:
- **Browser↔browser only by default** — the WS→real-UDP bridge is now opt-in (`IDT3_RELAY_BRIDGE_UDP=1`),
  OFF in production. Unknown destinations are dropped; no arbitrary UDP leaves the relay. Our deployed
  games only need browser↔browser (host/join by vIP), so this loses nothing.
- **Caps**: max frame size (`maxPayload` 16 KB; netchan packets < 1500 B), per-connection rate limit
  (600 frames/s; legit play ~60/s), max concurrent connections (300).
- **Origin allowlist** (`IDT3_RELAY_ORIGINS`) — restrict WS upgrades to the game hosts in prod.
- Runs as a container with **no host ports** (only the edge Caddy reaches it) behind Cloudflare.

## 4. Web / infra posture
- **COOP/COEP/CORP** set at the origin (container nginx) on every response; edge Caddy adds HSTS +
  `X-Frame-Options`/`X-Content-Type-Options`/`Referrer-Policy` and does not duplicate COOP/COEP.
- **Preview gating**: `X-Robots-Tag: noindex` + `/robots.txt` Disallow + a PREVIEW ribbon; sites are
  not linked from the main site and are kept out of search.
- **No game data** is committed; upload-only for RTCW/JK (visitor's own paks), only ET's freely-
  redistributable data is baked/served. TLS via the existing Cloudflare Origin cert; origin reachable
  only from Cloudflare IP ranges.
- Containers: non-root nginx image, read-only content, no host port publishing.

## Verdict
No blocking secrets or credential leaks. The relay SSRF vector is fixed. Vendored-lib CVEs are
contained by the wasm sandbox + user-owned data and are tracked as follow-ups (curl exclude/bump).
**Cleared for public** (pending the org's trademark decision) and **safe to host as preview.**
