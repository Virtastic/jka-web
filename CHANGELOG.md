# Changelog

Notable changes to this project. The detailed engineering record — including theories that were
wrong and later retracted — lives in `docs/WASM_ADAPTATIONS.md`.

This project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The loading overlay now uses the **same palette as the launcher and the rest of the Virtastic
  set** (ja2-web): black `#0a0a09`, khaki-to-gold progress bar, red accent word, and the same
  ember wash. It previously ran a warmer bronze/amber palette of its own, so the launcher and
  the game page did not look like the same product. Structure was already identical; this is a
  palette change only.

### Added

- **Attio CRM capture** in the Cloud Locker (`cloud/attio.mjs`). On sign-in the backend
  asserts a person record (email + display name) in the operator's Attio workspace, keyed on
  the email so repeats update rather than duplicate. Fired and not awaited, so sign-in can
  never stall or fail because the CRM is slow or down, and completely inert without
  `ATTIO_API_KEY` — with no key configured, nobody's email leaves the box.
  **Privacy:** when enabled this sends a user's email address to a third party; say so in
  your privacy policy and treat the workspace as holding user PII.

### Fixed

- `cloud/test-attio.mjs` exited 127 on Windows despite every check passing — it forced
  `process.exit()` while a socket from the deliberate connection-refused probe was still
  unwinding, tripping a libuv assertion. Any CI gate would have read a green test as a
  failure. It now sets `process.exitCode` and lets node drain.

## [1.0.1] - 2026-08-20

### Testing

Harness reliability only - the engine and the game build are unchanged from 1.0.0.

- `verify-icarus-affect.mjs` now reloads **3 times** per run (`AFFECT_ROUNDS` to change it) and
  judges on the worst single reload rather than one sample. The race is intermittent — three
  single-shot control runs with the fix removed gave 28, 28 and 0 — so one clean reload was weak
  evidence. A PASS is now stronger, though still not a proof of absence.
- `verify-menu.mjs` re-focuses the canvas before dispatching keys. `yavin1` failed
  intermittently (5 pass / 4 fail over 9 runs) with "ESC did not close the in-game menu";
  keyboard focus was drifting off the canvas, so ESC could not close what ESC had opened.
  Now 10 runs, 10 pass, with no regression on other maps.
- `verify-menu.mjs` detects a map that auto-advances (yavin1 moves to yavin1b partway through)
  and reports the level-dependent checks as SKIPPED rather than FAILED. Those checks were
  measuring a level the test was not aiming at, which is a property of the map rather than a
  defect in the engine.

## [1.0.0] — 2026-08-20

First public release: **Jedi Knight: Jedi Academy** single-player, running in the browser from
Raven's original GPL sources.

### The port

- The complete single-player campaign runs end to end: **34/34 maps** load and reach gameplay
  back-to-back in one browser session, with a flat heap across the whole sweep.
- Savegames work and survive a full page reload, persisted through IDBFS.
- Scripted level transitions carry the player and their inventory between maps.
- RoQ cinematics play, with video and audio.
- Rendering runs through WebGL using the engine's own renderer; the skeletal character path (Ghoul2)
  draws correctly.

### Notable engine adaptations

The full list is in `docs/WASM_ADAPTATIONS.md`. The recurring theme: the original unloads and
reloads its game DLL on every map, so file-scope statics reset for free. A persistent WebAssembly
side module does not, and each of these was a real, measured failure:

- `num_roffs`, `NumMiscEnts`, `in_camera`, `CNavigator::Free()` — per-map static resets.
- **`iCGResetCount`**, the per-map cgame reset counter. Its own comment states it is expected to be
  fresh on every DLL load; ours was not, so the second map load in a session concluded a
  `vid_restart` had happened and skipped both resets that flag guards.
- **The ICARUS `affect()` registration race.** NPC names are registered with ICARUS a few frames
  after the entity string is parsed, and `ParseAffect` silently fast-forwards over an affect block
  whose target it cannot resolve — returning `SEQ_OK`, so the script "succeeds" with a chunk
  missing. A cutscene could therefore run its own camera commands, drop every actor block, and
  finish without ever reaching `camera( DISABLE )`, leaving `in_camera` set and the in-game menu
  shut. NPCs are now registered at spawn, the warning is printed unconditionally instead of being
  suppressed by the ICARUS debug cvar, and `verify-icarus-affect.mjs` guards it — proven both ways:
  28 skipped blocks without the fix, 0 with it.
- `NAV_FindClosestWaypointForPoint` — a function-local `static` marker entity, spawned once but
  freed on every call.
- Working brightness/gamma, using an SVG colour transfer function in place of a hardware gamma ramp.

### Browser shell

- `launcher.html` — choose where game data comes from: Cloud Locker, data hosted by the site,
  or your own install via the folder picker. The game page also takes the official free demo
  mission as a no-data route, the same as jk2-web.
- `index.html` — the game page, with loading progress and an in-page console ring.
- Optional Cloud Locker backend (`cloud/`) — OAuth sign-in, then game data and saves in S3 or on
  local disk. Uploads are checked against an allowlist of known-genuine archives, so the locker
  cannot be used as general file storage.

### Licensing

- Distributed under **GPLv2**, matching the engine's grant. An earlier GPLv3 `LICENSE` was incorrect:
  the drop grants version 2 with no "or later" clause for Raven's code.
- Pre-compiled proprietary binaries that shipped inside the drop — SmartHeap, OpenAL, EAX, Immersion
  FeelIt and Bink Video — have been removed. None is used by the WebAssembly build. See
  `THIRD-PARTY-LICENSES.md`.
- **No game data is included or distributed.** Bring your own legally-obtained copy.

### Known limitations

- **Single-player only.** The multiplayer sources are present in the drop but are not built.
- The ICARUS registration race is *narrowed*, not structurally eliminated — registration lands a few
  frames into the level rather than at parse time. It is self-reporting and covered by a regression
  test rather than left silent.
- The folder picker needs a Chromium-based desktop browser (File System Access API).
