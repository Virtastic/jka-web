# Self-hosting jka-web

Everything here runs as static files plus the right headers. There is no application server: the
engine is WebAssembly running in the visitor's browser, and game data comes from the visitor's own
disk (or from a demo pak you serve).

## Quick start (local)

**A) Docker — build from source, nothing else installed:**

```sh
git clone https://github.com/Virtastic/jka-web && cd jka-web
docker compose up                      # http://localhost:8080
```

or without compose:

```sh
docker build -t jka-web .
docker run --rm -p 8080:80 jka-web
```

The first build pulls `emscripten/emsdk:6.0.1` (a couple of GB) and compiles the engine for a few
minutes. After that it is layer-cached and rebuilds are quick.

**B) From a release bundle — no compiler needed:**

Grab `jka-web-<tag>.zip` from [Releases](https://github.com/Virtastic/jka-web/releases). It
contains the prebuilt engine plus the pages and the dev server:

```sh
unzip jka-web-*.zip -d jka-web && cd jka-web
python3 server.py                      # http://localhost:8794
```

Open it in desktop Chrome, Chromium, Edge or Brave.

## Serving the game data yourself

By default your instance ships **no game data at all** and visitors bring their own — which is
the safest posture, and the one <https://jka.virtastic.app> uses alongside the demo.

### The free demo (recommended, and legal to redistribute)

The official Jedi Academy demo pak is freely redistributable. Put it at `demo/assets0.pk3` next to
`index.html` and the "Play the demo" route works with no data from the visitor:

```
/usr/share/nginx/html/
  index.html
  launcher.html
  jka.js  jka.wasm  qagame.wasm
  demo/
    assets0.pk3        <- the demo pak, and nothing else
```

With Docker Compose, uncomment the `volumes:` line in `docker-compose.yml` and drop the pak in
`play/jka/demo/`.

> **Put nothing else in `demo/`.** The engine's `FS_SetRestrictions()` sets `fs_restrict 1` and
> requires **exactly one** pak whose checksum matches the built-in `DEMO_PAK_CHECKSUM`. A second
> file there is a hard `Corrupted pk3` error, and the message does not explain why.

### Retail data (only if you have the right to distribute it)

Put a **complete** retail set — `assets0.pk3`, `assets1.pk3`, `assets2.pk3`, `assets3.pk3` — in
`base/`. There is **no marker file to create**: `productid.txt` is not a marker but a key checked
against a scrambled table in the engine, and the retail data already ships it inside `assets2.pk3`.
A complete set drops the demo restrictions by itself.

An *incomplete* set is the failure mode to know about: with no `productid.txt` anywhere the engine
silently falls back to demo mode and then dies on the checksum. See
[`docs/DATA.md`](docs/DATA.md) for the full explanation.

> Retail Jedi Academy data is commercial and **not redistributable**. Host it only where you have
> the right to, and never on a public instance.

## The serving contract

Every response needs the cross-origin isolation header set:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

plus HTTPS (or `http://localhost`), `application/wasm` for `.wasm`, and gzip for `.js`/`.wasm`.

Caching matters more than it looks:

- **HTML: `no-store`.** A stale page can point at engine bytes that no longer exist, and every
  client-side fix would otherwise reach players only when their browser felt like revalidating.
- **`.wasm` / `.data` / `.js` / `.pk3`: `immutable`, one year.** New build, new bytes.

> jka is single-threaded and does not strictly *need* cross-origin isolation to run. The headers
> are kept anyway so the whole Virtastic set behaves identically, and the smoke tests assert them
> as a cheap "config intact" check.

### nginx

`infra/nginx.conf` is the reference vhost, and it is what the Docker image uses. The shape:

```nginx
add_header Cross-Origin-Opener-Policy   "same-origin"  always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
add_header Cross-Origin-Resource-Policy "cross-origin" always;

location = / {
    # add_header in a location REPLACES the server-level ones, so repeat them here —
    # without this the engine silently loses SharedArrayBuffer.
    add_header Cross-Origin-Opener-Policy   "same-origin"  always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "cross-origin" always;
    add_header Cache-Control "no-store" always;
    try_files /index.html =404;
}

location ~* \.(wasm|data|js|pk3)$ {
    add_header Cross-Origin-Opener-Policy   "same-origin"  always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "cross-origin" always;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
}
```

> **Do not add a bare `types { }` block.** It replaces nginx's whole MIME map and breaks
> `text/html`. nginx 1.27's `mime.types` already maps `.wasm` to `application/wasm`.

### Caddy

```caddy
jka.example.com {
    root * /srv/jka-web
    header {
        Cross-Origin-Opener-Policy   "same-origin"
        Cross-Origin-Embedder-Policy "require-corp"
        Cross-Origin-Resource-Policy "cross-origin"
    }
    header /*.html   Cache-Control "no-store"
    @immutable path *.wasm *.data *.js *.pk3
    header @immutable Cache-Control "public, max-age=31536000, immutable"
    file_server
}
```

## Cloud Locker (optional)

`cloud/` is an optional backend: OAuth sign-in plus S3 (or local-disk) storage, so a player's game
data and saves follow them between machines. Uploads are checked against an allowlist
(`cloud/jka-editions.json`) so the locker cannot be used as general file storage.

It is **not wired into `infra/nginx.conf`** — the shipped vhost is deliberately static-only.
Enabling it means adding an `/api` proxy block and running the `cloud/` container. See
`cloud/.env.example` for the configuration surface.

> **Privacy note:** `cloud/attio.mjs` sends a signed-in user's email address to Attio when
> `ATTIO_API_KEY` is set. It is inert without the key. If you enable it, say so in your instance's
> privacy policy.

## Browser support

Desktop **Chrome / Chromium / Edge / Brave**. The bring-your-own-data picker needs the File System
Access API, which Firefox and Safari do not implement. Mobile is out of scope.

## Licensing notes for hosts

The bundle is **GPLv2** — see [`LICENSE`](LICENSE), [`NOTICE.md`](NOTICE.md) and
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md). If you host it publicly, link back to the
corresponding source: this repository, or the `jka-web-src-<tag>.tar.gz` from the matching release.
The shipped pages already carry a source link in the footer, so leaving that intact is enough.

Retail game data must never be bundled by a host. The demo pak may be.

*STAR WARS* and *JEDI KNIGHT* are trademarks of Lucasfilm Ltd. and/or its affiliates. Do not imply
affiliation or endorsement on your instance, and do not use the marks in its name or domain.

---

WASM port © 2025–2026 [Virtastic](https://virtastic.app) — GPL-2.0
