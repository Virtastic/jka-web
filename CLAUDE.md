# jka-web

A browser / WebAssembly port of **Star Wars Jedi Knight: Jedi Academy** (single-player), built
from Raven's **original** 2003 GPL source drop (jedis/jediacademy mirror).

The engine is **GPLv2** — see `LICENSE`, and `games/jka/LICENSE.txt` in the drop itself. Retail game
data is **not** included and is not redistributable: players supply their own legally-obtained copy.
The official free JKA demo (`GameData/Demo/assets0.pk3` from the demo installer, checksum-verified
as `DEMO_PAK_CHECKSUM` in the engine) provides the no-data route; the deployment serves it from
`demo/` and the engine runs it in restricted demo mode (`fs_restrict 1`). See `play/jka/index.html`.

## Hard rule: strictly original sources

`games/jka/` holds the pristine GPL drop (one "pristine import" commit). Every browser adaptation is
a separate reviewable commit on top. **Do not copy code from OpenJK, iortcw, or ET:Legacy** — consult
them for understanding only. The diff of `games/jka` against its import commit *is* the port.

## Layout

- `games/jka/` — the original engine sources (pristine import + port commits)
- `shared/wasm-build/` — `env.sh` (toolchain flags), `sys_emscripten/` + `sys_emscripten_jk/` (our
  platform layer), `build-jka.sh` / `build-jka-modules.sh`, and the CDP test harnesses
- `shared/web/` — `server.py` (COOP/COEP dev server, HTTP-Range for pk3 streaming) and
  `net-relay.mjs` (a standalone WebSocket relay; unused by this single-player port, see below)
- `play/jka/` — `launcher.html` (entry: cloud / hosted / bring-your-own) and `index.html`
  (the game page). Retail pk3s live in `play/jka/base/` locally and are **never** committed.
- `cloud/` — optional Cloud Locker backend: OAuth sign-in plus S3 (or local-disk) storage for game
  data and saves. Not required to play.
- `docs/WASM_ADAPTATIONS.md` — the running engineering log (read/update this)

## Toolchain

Homebrew Emscripten **6.0.1** (`emcc`). Flags live in `shared/wasm-build/env.sh` — source it, don't
hardcode. No `-flto`. Single-threaded. See `docs/WASM_ADAPTATIONS.md`.

## Build / run

```sh
source shared/wasm-build/env.sh
shared/wasm-build/build-jka.sh              # engine   -> play/jka/{jka.js,jka.wasm}
shared/wasm-build/build-jka-modules.sh      # game dll -> play/jka/qagame.wasm
python3 shared/web/server.py jka            # COOP/COEP dev server on :8794
node shared/wasm-build/console-check.mjs 8794 "+set sv_pure 0 +devmap t1_sour"
```

The two build scripts are separate on purpose: the game/cgame logic is an Emscripten **side module**
(`qagame.wasm`) that the engine `dlopen`s per map, mirroring the original's per-map DLL reload.

## Testing

The harnesses in `shared/wasm-build/*.mjs` drive a real headless Chrome over CDP — they boot the
actual engine and assert on what it renders and logs, rather than on mocks:

```sh
node shared/wasm-build/map-sweep.mjs 8794 "<map1,map2,...>"        # whole campaign, one session
node shared/wasm-build/verify-menu.mjs 8794 <map>                  # menus, incl. same-map reload
node shared/wasm-build/verify-transition.mjs 8794 <mapA> <mapB>    # scripted level transition
node shared/wasm-build/verify-jk-save.mjs jka 8794 "+devmap <map>" # save round-trip incl. reload
node shared/wasm-build/verify-cinematic.mjs 8794 <name[,name]>     # RoQ video + audio
```

Two rules earned the hard way, worth keeping in mind when adding a probe (the full list is in the
engineering log):

- **A null result is evidence only if the instrument is proven live.** Run a positive control in the
  same session — twice in this port a "0" came from a probe that could not print at all.
- **A control must assert that the thing it removed is actually gone**, and print that assertion
  beside the result. `git stash` is a no-op on a change that is already committed.

## Scope notes

- **Single-player only.** The multiplayer sources (`games/jka/codemp/`) are part of the pristine
  drop but are not built. `shared/web/net-relay.mjs` and the relay plumbing in `index.html` are
  therefore inert here; they are kept because the relay is a standalone, documented utility
  (`docs/SECURITY.md`) rather than dead code inside the engine.
- **State.** The campaign runs end to end: 34/34 maps load and reach gameplay in one session, saves
  survive a page reload, scripted level transitions carry the player, and the RoQ cinematics play
  with audio. See `docs/WASM_ADAPTATIONS.md` for what was adapted and why.
