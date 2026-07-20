# Supplying game data (demo + full retail)

The engines ship **no retail data** — you bring your own (GPL covers the *code*, not id/Raven's
assets). Each game loads its `.pk3` archives from `play/<game>/<gamedir>/`. The dev server
(`shared/web/server.py`) exposes `GET /__paks?dir=<gamedir>` which lists every `*.pk3` there, and
each `play/<game>/index.html` auto-discovers and loads **all** of them — so the *same* code path
serves the tiny free demo and the full retail install. Drop paks in, reload, done.

## Where each game's paks go

| Game | Port | Data dir | Retail paks (typical) | Run |
|------|------|----------|-----------------------|-----|
| RTCW-SP | 8790 | `play/rtcw/main/` | `pak0.pk3` (+ `sp_pak1..4.pk3`) | `python3 shared/web/server.py rtcw` |
| RTCW-MP | 8791 | `play/rtcwmp/main/` | `mp_pak0..3.pk3`, `pak0.pk3` | `python3 shared/web/server.py rtcwmp` |
| Wolf:ET | 8792 | `play/wolfet/etmain/` | `pak0..2.pk3`, `mp_bin.pk3` (freely redistributable) | `python3 shared/web/server.py wolfet` |
| JK2 | 8793 | `play/jk2/base/` (retail) · `play/jk2/demo/` (demo) | `assets0..2.pk3` | `python3 shared/web/server.py jk2` |
| JKA | 8794 | `play/jka/base/` (retail) · `play/jka/demo/` (demo) | `assets0..3.pk3` | `python3 shared/web/server.py jka` |

Then open `http://localhost:<port>/` (append `?args=+devmap <map>` to jump straight into a map).

## RTCW-SP / RTCW-MP / Wolf:ET — just drop paks in

1. Copy your retail `.pk3` files into the data dir above (e.g. RTCW-SP retail `pak0.pk3` →
   `play/rtcw/main/`). Leave or replace the demo pak; the loader takes whatever is there.
2. Restart that game's server (so `/__paks` re-scans) and reload the page.

That's it — no filename list to edit. Verified end-to-end on the demo/free data for all three.

## JK2 / JKA — one extra step (demo checksum vs retail)

These Raven engines gate demo vs retail themselves:

- **Demo mode** (what ships now): the engine sees no `productid.txt` marker, runs
  `fs_restrict 1`, and requires **exactly one** pak whose checksum matches the built-in
  `DEMO_PAK_CHECKSUM` — any extra/altered pak → hard error `Corrupted pk3`. So the demo dir holds
  precisely the genuine `assets0.pk3` and nothing else. (These two loaders are intentionally left
  on their demo path; do not add paks to `demo/`.)
- **Retail mode**: put the retail `assets0..N.pk3` in `play/jk2/base/` (resp. `play/jka/base/`),
  add a `productid.txt` marker file in `play/jk2/base/`, and set `window.__JK2_GAMEDIR = 'base'`
  (resp. `__JKA_GAMEDIR`) near the top of that game's `index.html`. With the marker present the
  engine drops demo restrictions and loads the full `base/` search path normally.

This retail path is **not yet verified** (needs the retail data); it's the first thing to test in
the production-data pass.

## Memory ceiling (why full-load, and its limit)

Paks are currently `fetch()` + `FS.writeFile` into MEMFS (the wasm heap). We can't use
`FS.createLazyFile` HTTP-Range streaming because modern browsers hard-block the synchronous XHR it
needs on the main thread ("Cannot do synchronous binary XHRs outside webworkers"). Full-load is
fine for the demo and **retail SP** (~0.5GB of paks + working set ≈ 1–1.5GB, under the 4GB wasm32
ceiling; the initial heap is 512MB, grows as needed). A title whose data approaches ~3GB (e.g. a
full install with movies) would need the engine moved into a **Web Worker + WORKERFS** so sync
reads stream from disk — the one known scaling task, tracked for later, not needed for SP campaigns.

## Saves / configs

Persisted in IndexedDB at `/userdata` (mounted via IDBFS, flushed every 15s and on tab hide).
They survive reloads and are independent of the paks you mount.
