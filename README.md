# Star Wars Jedi Knight: Jedi Academy — WebAssembly (browser) port

Browser / WebAssembly port of **Star Wars Jedi Knight: Jedi Academy**, built from the original 2003 Raven Software GPL source drop. Renders and plays in the browser — Ghoul2 skeletal characters, saber, Force.

## Layout
- `games/jka/` — original GPL engine source (pristine import + `__EMSCRIPTEN__`-guarded port commits)
- `shared/wasm-build/` — Emscripten toolchain flags, platform layer, per-game build scripts, CDP test harnesses
- `shared/web/` — COOP/COEP dev server (`server.py`)
- `play//` — the browser entry page
- `docs/WASM_ADAPTATIONS.md` — the engineering log; `docs/DATA.md` — how to supply game data

## Build & run
```sh
source shared/wasm-build/env.sh          # Homebrew Emscripten 6.0.1
shared/wasm-build/build-jka.sh
python3 shared/web/server.py jka           # dev server on :8794
# open http://localhost:8794/
```

**Game data is bring-your-own** — retail pk3s are never committed (GPL covers the *code*, not
id/Raven's assets). See `docs/DATA.md`.

Built with the Claude Agent SDK.
