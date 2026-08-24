# jka-web

**Star Wars Jedi Knight: Jedi Academy, single-player, running in a browser tab.**

<p>
  <a href="https://jka.virtastic.app">▶ Play now</a> ·
  <a href="https://discord.gg/PzFfDkbSue">Discord</a> ·
  <a href="https://www.youtube.com/@Virtastic-Apps">YouTube</a> ·
  <a href="https://github.com/Virtastic/jka-web/releases">Releases</a> ·
  <a href="https://github.com/Virtastic/jka-web/issues">Issues</a>
</p>

A WebAssembly port of Raven Software's **original 2003 GPL source release**, compiled with
Emscripten. It runs entirely on your machine: the engine is WebAssembly, the game data is read
from your own disk or from the free demo, and nothing is uploaded or streamed. Ghoul2 skeletal
characters, the saber, and Force powers all work; the campaign runs end to end.

The port is deliberately conservative — `games/jka/` is Raven's pristine drop, and every browser
adaptation is a separate reviewable commit on top, so `git diff <import> -- games/jka` *is* the
port. No code is copied from OpenJK or iortcw. The engineering log, including theories that
turned out to be wrong, is in [`docs/WASM_ADAPTATIONS.md`](docs/WASM_ADAPTATIONS.md).

## Playing

Open **<https://jka.virtastic.app>** in desktop Chrome, Chromium, Edge or Brave, then pick a route:

- **Play the demo** — the official free demo mission. Nothing to own, nothing to install.
- **Bring your own copy** — point the picker at the `GameData/base` folder of a legal install and
  select the `assets*.pk3` files (`assets0`, `assets1`, `assets2`, `assets3`). They are read
  straight from your disk; **nothing is uploaded**.

Saves and settings persist in the browser (IDBFS), independent of which data you loaded.

> **Windows tip:** copy `GameData` somewhere outside `Program Files` first — browsers refuse to
> grant folder access inside protected system paths, and that is where Steam installs by default.

Single-player only. The multiplayer sources are part of the drop but are not built.

## Quick start (Docker)

From a clean clone, with nothing but Docker installed:

```sh
docker build -t jka-web .          # compiles the engine from source
docker run --rm -p 8080:80 jka-web # http://localhost:8080
```

or simply:

```sh
docker compose up                  # http://localhost:8080
```

The first build pulls the Emscripten toolchain image and compiles for a few minutes; after that
it is layer-cached. See [`SELF_HOSTING.md`](SELF_HOSTING.md) for serving it on a real server, and
for how to add the free demo pak so the demo route works on your own instance.

## What's in this repo

This repo is **code only**. No game data of any kind is committed.

| Path | What it is |
|---|---|
| `games/jka/` | Raven's pristine GPL drop + the `__EMSCRIPTEN__`-guarded port commits |
| `shared/wasm-build/` | `env.sh` (the toolchain pin), the Emscripten platform layer, build scripts, CDP test harnesses |
| `shared/web/` | `server.py` — the COOP/COEP dev server, with HTTP-Range for pk3 streaming |
| `play/jka/` | `index.html` (the game page) and `launcher.html`. Built `.js`/`.wasm` are gitignored |
| `cloud/` | Optional Cloud Locker backend — OAuth sign-in plus S3 storage. Not required to play |
| `infra/` | `nginx.conf` (the serving contract) and the Terraform DNS reference |
| `ci/` | A reference Jenkins pipeline |

### Not included (kept local)

Retail `.pk3` archives, the demo pak, `build-jka/`, the generated `jka.js`/`.wasm`/`qagame.wasm`,
and `node_modules/`. The `.gitignore` and `.dockerignore` are written so game data cannot be
committed or baked into an image by accident.

## Running (dev)

```sh
source shared/wasm-build/env.sh         # Emscripten 6.0.1 — see env.sh for discovery
shared/wasm-build/build-jka.sh          # engine   -> play/jka/{jka.js,jka.wasm}
shared/wasm-build/build-jka-modules.sh  # game DLL -> play/jka/qagame.wasm
python3 shared/web/server.py jka        # dev server on :8794
```

Both build scripts are needed: the engine alone boots to the menu, but loading a map requires the
game module (`qagame.wasm`), which is where single-player keeps game + cgame. They are separate on
purpose — `qagame.wasm` is an Emscripten **side module** that the engine `dlopen`s per map,
mirroring the original's per-map DLL reload.

## Building

Emscripten **6.0.1**, pinned in `shared/wasm-build/env.sh` — source it rather than hardcoding
flags. No `-flto` (it miscompiles the boot path). Single-threaded. Pure C++: no Rust, no
`-pthread`, so the toolchain is just `emscripten/emsdk:6.0.1` with nothing added.

## Testing

The harnesses in `shared/wasm-build/*.mjs` drive a real headless Chrome over CDP — they boot the
actual engine and assert on what it renders and logs, rather than on mocks:

```sh
node shared/wasm-build/map-sweep.mjs 8794 "<map1,map2,...>"        # whole campaign, one session
node shared/wasm-build/verify-menu.mjs 8794 <map>                  # menus, incl. same-map reload
node shared/wasm-build/verify-transition.mjs 8794 <mapA> <mapB>    # scripted level transition
node shared/wasm-build/verify-jk-save.mjs jka 8794 "+devmap <map>" # save round-trip incl. reload
```

## Hosting on a real server

The one hard requirement is the cross-origin isolation header set (COOP/COEP/CORP) plus correct
`application/wasm` and cache headers. `infra/nginx.conf` is the reference vhost, and
[`SELF_HOSTING.md`](SELF_HOSTING.md) has worked nginx and Caddy configs.

## Browser support

Desktop **Chrome / Chromium / Edge / Brave**. The folder picker uses the File System Access API,
which Firefox and Safari do not implement; mobile is out of scope.

## License

jka-web is licensed under the **GNU General Public License, version 2** — see
[`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).

**GPLv2, not GPLv3.** Raven's drop grants version 2 and does not include the customary "or (at
your option) any later version" clause for Raven's own code, so the combined work cannot be
relicensed forward.

- Engine code under `games/jka/` — Copyright (C) 2003 Activision / Raven Software, released by
  the copyright holder under GPLv2.
- The port — the Emscripten platform layer, build scripts, the browser shell under `play/`, the
  test harnesses, and the optional cloud backend — is likewise GPLv2.
- Bundled third-party components keep their own licenses; see
  [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md), which also records which of them are
  actually compiled into the WebAssembly binary.

### Game data and trademarks

*STAR WARS* and *JEDI KNIGHT* are trademarks of Lucasfilm Ltd. and/or its affiliates. Activision
and Raven Software are trademarks of their respective owners. This project is **not affiliated
with, endorsed by, or sponsored by** any of them; the names are used only to identify the software
this is derived from.

**No retail game data is included in, or distributed by, this repository.** The retail archives
are commercial content and are not redistributable — you must supply your own legally-obtained
copy, or use the official free demo mission.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — it covers the two rules that matter most here:
`games/jka/` stays a pristine import with the port as separate commits, and claims about engine
behaviour need a measurement with a positive control, not a plausible story.

## Community

- **[Discord](https://discord.gg/PzFfDkbSue)** — the fastest place for help, screenshots and news.
- **[YouTube (@Virtastic-Apps)](https://www.youtube.com/@Virtastic-Apps)** — demos, build logs, and
  the other native-to-browser ports we work on.
- **[GitHub Discussions](https://github.com/Virtastic/jka-web/discussions)** — longer-form
  questions and showcase threads.

Security issues: please follow [`SECURITY.md`](SECURITY.md) rather than opening a public issue.

## Credits

Raven Software and Activision, for releasing the engine sources under the GPL in the first place.

WASM port © 2025–2026 [Virtastic](https://virtastic.app). Built with the Claude Agent SDK.
