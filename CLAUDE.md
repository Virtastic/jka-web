# idTech3-Web

Browser / WebAssembly ports of four GPL-released idTech3 games, built from their **original**
2001–2003 source drops:

- **RTCW-SP / RTCW-MP** — Return to Castle Wolfenstein (id-Software GPL drop)
- **wolfet** — Wolfenstein: Enemy Territory (id-Software GPL drop)
- **jk2** — Jedi Knight II: Jedi Outcast (Raven GPL drop, grayj/Jedi-Outcast mirror)
- **jka** — Jedi Knight: Jedi Academy (Raven GPL drop, jedis/jediacademy mirror)

## Hard rule: strictly original sources

`games/<game>/` holds the pristine GPL drop (one "pristine import" commit each). Every browser
adaptation is a separate reviewable commit on top. **Do not copy code from iortcw, OpenJK, or
ET:Legacy** — consult them for understanding only. The diff of `games/<game>` vs its import
commit *is* the port.

## Layout

- `games/<game>/` — original engine sources (pristine import + port commits)
- `shared/wasm-build/` — `env.sh` (toolchain flags), `sys_emscripten/` (our platform layer),
  per-game `build-*.sh`, `harness.mjs` / `verify-browser.mjs` (CDP smoke tests)
- `shared/web/` — shared browser shell: `server.py` (COOP/COEP dev server), `streamfs.js`
  (pk3 HTTP-Range streaming), `launcher.js` (bring-your-own-data), `persist.js` (IDBFS saves)
- `play/<game>/index.html` — thin per-game entry pages
- `data/fsroot-<game>/` — tiny link-time preload (default configs); retail pk3s never committed
- `docs/WASM_ADAPTATIONS.md` — the running engineering log (read/update this)
- `manifests/idtech3-web.deps.json` — wasm-deps manifest (deps are near-empty by design)

## Toolchain

Homebrew Emscripten **6.0.1** (`emcc`). Flags live in `shared/wasm-build/env.sh` — source it,
don't hardcode. No `-flto`. Single-threaded by default. See `docs/WASM_ADAPTATIONS.md`.

## Build / run (per game, e.g. rtcw-sp)

```sh
source shared/wasm-build/env.sh
shared/wasm-build/build-rtcw-sp.sh          # -> play/rtcw/{rtcw.js,.wasm,.data}
python3 shared/web/server.py rtcw           # COOP/COEP dev server on :8790
node shared/wasm-build/verify-browser.mjs   # CDP boot/menu/save smoke test
```

## Milestones

M0 scaffolding · **M1 RTCW-SP (current)** · M2 JK2-SP · M3 JKA-SP · M4 Wolf:ET + RTCW-MP (net) · M5 polish/prod.
See `/Users/mstavridis/.claude/plans/we-are-doing-a-dazzling-crane.md` for the full plan.
