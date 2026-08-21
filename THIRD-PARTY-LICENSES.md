# Third-party components

Everything below arrived inside Raven's original GPL source drop. This file records what is
there, what licence it carries, and — importantly — which parts this WebAssembly port actually
compiles, since the drop contains a good deal that it does not.

The port itself, and the engine sources, are GPLv2. See `LICENSE` and `NOTICE.md`.

---

## Compiled into the WebAssembly build

### Independent JPEG Group (IJG) — `games/jka/code/jpeg-6/`

36 source files, compiled.

```
Copyright (C) 1994-1995, Thomas G. Lane.
This file is part of the Independent JPEG Group's software.
For conditions of distribution and use, see the accompanying README file.
```

**Note on a gap in the drop:** the IJG licence points at "the accompanying README file", and that
README is **not present** in Raven's drop — only the `.cpp`/`.h` files were shipped. The applicable
terms are therefore the standard IJG conditions for libjpeg 6: the software is provided "AS IS"
without warranty; permission is granted to use, copy, modify and distribute it for any purpose
without fee, subject to the conditions that the original copyright notice and this permission notice
appear in all copies, that the IJG is not to be held liable, and that if the software is used in a
product, acknowledgement in the product documentation is appreciated but not required. The
acknowledgement is made here.

### Xing / EMusic MP3 decoder — `games/jka/code/mp3code/`

21 source files, compiled.

```
MP3 Decoder originally Copyright (C) 1995-1997 Xing Technology
Portions Copyright (C) 1998-1999 EMusic.com
... under the terms of the GNU General Public License; either version 2 of the
License, or (at your option) any later version.
```

GPLv2-or-later, so compatible with this project's GPLv2 distribution.

### zlib — `games/jka/code/zlib32/` and `games/jka/code/qcommon/unzip.cpp`

4 compiled files: `zlib32/deflate.cpp`, `zlib32/inflate.cpp`, `zlib32/zipcommon.cpp` and the
minizip-derived `qcommon/unzip.cpp`, which together implement pk3 reading. Raven's README states the
position explicitly:

```
Some source code in this release is not covered by the GPL:
e.g. zlib is Copyright (C) 1995-1998 Jean-loup Gailly and Mark Adler
```

zlib licence: provided "as-is" with no warranty; the origin must not be misrepresented, altered
source versions must be plainly marked as such, and the notice may not be removed. Its condition 1
notes that acknowledgement in product documentation is appreciated — **acknowledged here**. This
port has not altered the zlib-derived sources.

---

## Present in the sources but **not** compiled

### OpenAL headers — `games/jka/code/client/OpenAL/`

```
Copyright (C) 1999-2000 by authors.
... GNU Library General Public License; either version 2 of the License, or
(at your option) any later version.
```

LGPLv2-or-later. The browser port uses a Web Audio backend (`shared/wasm-build/sys_emscripten_jk/
sys_jk_snd.cpp`) rather than OpenAL, so these headers are not part of the build.

### MicroQuill SmartHeap — `games/jka/code/smartheap/`

Proprietary. The headers are referenced from `cg_predict.cpp` and `sv_world.cpp`, but only behind
`#if MEM_DEBUG`, which is off; `0_compiled_first/` is excluded from the build outright, and
`build-jka.sh` filters `smartheap/` from the engine source list. The header text is left in place as
part of the pristine drop; the SmartHeap **binaries** were removed (below).

---

## Pre-compiled binaries removed from this repository

The drop shipped 24 pre-compiled Windows binaries. **None is GPL-licensed, and none is used by the
WebAssembly build** — `build-jka.sh` excludes `win32/`, `smartheap/` and `mac/`, and the port links
no Windows libraries at all. Redistributing proprietary binaries is not something the GPL grant on
the engine covers, so they have been removed rather than republished:

| Component | Owner | Files |
|---|---|---|
| SmartHeap | MicroQuill Software Publishing | `HA312W32.DLL`, `SHW32.DLL`, `HAW32M.LIB`, `haw32m.lib` |
| OpenAL runtime | Creative Technology | `openal32.dll`, `openal32.lib`, `alut.lib` |
| EAX Manager | Creative Technology | `eaxman.dll` |
| Immersion FeelIt / IFC | Immersion Corporation | `FFC10.dll`, `FFC10d.dll`, `FFC10.lib`, `FFC10d.lib`, `IFC22.dll`, `IFC22.lib` |
| Bink Video | RAD Game Tools | `binkw32.lib` |

Also removed: IDE and version-control artefacts with no licence significance and no use to
anyone — `.ncb` (IntelliSense caches), `.opt` (workspace options), `.plg` (build logs), and a
further 75 files (`vssver.scc` Visual SourceSafe status files and `.aps` resource caches). None is referenced by any build.

This is a deliberate, documented exception to the "pristine import" rule in `CLAUDE.md`: the rule
exists so that the diff against the drop *is* the port, and removing non-redistributable binaries
that the port never touches does not weaken that. Every source file is untouched. The removal is a
single reviewable commit, and the binaries remain available from the original public drop for anyone
who needs them.

---

## The port's own dependencies

The optional Cloud Locker backend (`cloud/`) uses Fastify and the AWS SDK v3 S3 client; see
`cloud/package.json` and `cloud/package-lock.json` for exact versions and their licences (MIT and
Apache-2.0 respectively). It is not required to build or play the game, and nothing in `cloud/` is
linked into the WebAssembly binary.

The test harnesses drive Google Chrome over the DevTools Protocol; Chrome is not bundled or
redistributed here.
