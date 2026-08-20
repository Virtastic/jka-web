# Star Wars Jedi Knight: Jedi Academy — WebAssembly (browser) port

Browser / WebAssembly port of **Star Wars Jedi Knight: Jedi Academy**, built from the original 2003 Raven Software GPL source drop. Renders and plays in the browser — Ghoul2 skeletal characters, saber, Force.

## Layout
- `games/jka/` — original GPL engine source (pristine import + `__EMSCRIPTEN__`-guarded port commits)
- `shared/wasm-build/` — Emscripten toolchain flags, platform layer, per-game build scripts, CDP test harnesses
- `shared/web/` — COOP/COEP dev server (`server.py`)
- `play/jka/` — the browser entry page
- `docs/WASM_ADAPTATIONS.md` — the engineering log; `docs/DATA.md` — how to supply game data

## Build & run
```sh
source shared/wasm-build/env.sh              # Emscripten 6.0.1 (any install; see env.sh)
shared/wasm-build/build-jka.sh                # engine  -> play/jka/{jka.js,.wasm}
shared/wasm-build/build-jka-modules.sh        # game DLL -> play/jka/qagame.wasm
python3 shared/web/server.py jka             # dev server on :8794
# open http://localhost:8794/
```

Both scripts are needed: the engine alone boots to the menu, but loading a map requires the
game module (`qagame.wasm`), which is where SP keeps game + cgame.

Smoke tests (need `npm install` for the `ws` client, and Chrome/Chromium on PATH or `$CHROME`):

```sh
node shared/wasm-build/console-check.mjs 8794 "+map <map>" jka   # errors/warnings on a real boot
node shared/wasm-build/verify-jk-play.mjs jka 8794 "+map <map>"  # is it actually drawing?
node shared/wasm-build/boot-log.mjs 8794 "+map <map>"           # the engine boot log, verbatim
```

**Game data is bring-your-own** — retail pk3s are never committed (GPL covers the *code*, not
id/Raven's assets). See `docs/DATA.md`.

Built with the Claude Agent SDK.
