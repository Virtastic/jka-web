#!/usr/bin/env bash
# Build the JK2 SP game module (jk2gamex86.dll → qagame.wasm side module).
# JK2 SP merges game logic + cgame + Icarus + NPC AI into one module. Exports
# GetGameAPI. Uses the same C++ archaeology flags as the engine.
#
# NB the project file is code/game/game.dsp, NOT code/game.dsp. Both exist:
#   code/game/game.dsp -> jk2gamex86.dll   127 TUs (80 game, 40 cgame, 5 Icarus, ...)
#   code/game.dsp      -> efgamex86.dll     96 TUs (27 cgame)
# "ef" is Elite Force — code/game.dsp is a leftover from Raven's Star Trek codebase
# and is NOT in StarWars.dsw, which references exactly .\game\game.dsp and
# .\starwars.dsp. Building the Elite Force list dropped the FX_* effect TUs, so
# qagame.wasm imported an undefined FX_BryarProjectileThink (declared in
# game/g_weaponLoad.cpp, defined in cgame/FX_BryarPistol.cpp) and the module failed
# to dlopen with "Couldn't load game".
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$IDTECH3_ROOT/games/jk2/code"
SYS="$HERE/sys_emscripten_jk"
OUT="$IDTECH3_ROOT/play/jk2"
BUILD="$IDTECH3_ROOT/build-jk2/modules"
mkdir -p "$BUILD" "$OUT"

INCLUDES="-I$SRC/game -I$SRC/cgame -I$SRC/qcommon -I$SRC/ui -I$SRC/icarus -I$SRC/ghoul2 -I$SRC/server -I$SYS"
DEFINES="-DMAC_STATIC= -DCPUSTRING=\"wasm32\" -DPATH_SEP='/' -DFINAL_BUILD \
-Dstricmp=strcasecmp -Dstrnicmp=strncasecmp -Dstrcmpi=strcasecmp -D_strnicmp=strncasecmp -D_stricmp=strcasecmp -DINT32=int -include $SYS/jk_compat.h"
# -std=gnu++14: the game module has locals named `forward`/`left`/`right` that collide
# with std::forward etc. (pulled in by `using namespace std;`). gnu++98 predates those
# std utilities entirely — and matches the 2002 code — clearing the ambiguities.
JK2_FLAGS="-std=gnu++14 -fexceptions -O2 -fPIC ${IDTECH3_THREAD_FLAGS} -DNDEBUG \
-fno-operator-names -Wno-reserved-user-defined-literal -Wno-implicit-function-declaration \
-Wno-int-conversion -Wno-incompatible-pointer-types -Wno-return-type -Wno-shift-negative-value \
-Wno-writable-strings -Wno-invalid-offsetof -Wno-register -Wno-deprecated -Wno-c++11-narrowing \
-fms-extensions -fdelayed-template-parsing -Wno-c++11-compat-deprecated-writable-strings"
INCLUDES="$INCLUDES $DEFINES"

# game/game.dsp source list is cached here. Its paths are relative to code/game/:
# ".\foo.cpp" → game/foo.cpp, "..\cgame\foo.cpp" → cgame/foo.cpp, Icarus/ → icarus/.
GAME_CPP=$(sed 's#^\.\./##; s#Icarus/#icarus/#' "$BUILD/../game-sources.txt" 2>/dev/null)
if [ -z "${GAME_CPP:-}" ]; then
  grep "SOURCE=" "$SRC/game/game.dsp" | sed 's/SOURCE=//; s/\\/\//g; s/"//g; s#^\.\./##; s#^\./##; s#Icarus/#icarus/#' \
    | grep -iE "\.(cpp|c)$" | tr -d '\r' | sort -u > "$BUILD/../game-sources.txt"
  GAME_CPP=$(cat "$BUILD/../game-sources.txt")
fi

OBJS=(); FAILED=(); : > "$BUILD/build.errs"

# idTech3-web: an object is stale if it is older than its source OR ANY HEADER.
# Comparing only against the source means a header edit (e.g. the glIndex_t typedef in
# renderer/tr_local.h) changes NOTHING — every TU looks up to date and the old objects
# relink, which cost hours of "the fix had no effect". Coarse on purpose: one header
# touch rebuilds everything, which is the safe direction to err.
# NB no pipe into head: these scripts run under `set -euo pipefail`, and head closing
# the pipe early SIGPIPEs find and aborts the build silently.
IDT3_NEWEST_HDR=""
for _h in $(find "$SRC" "$HERE/sys_emscripten" "$HERE/sys_emscripten_jk" -name '*.h' -print 2>/dev/null); do
  if [ -z "$IDT3_NEWEST_HDR" ] || [ "$_h" -nt "$IDT3_NEWEST_HDR" ]; then IDT3_NEWEST_HDR="$_h"; fi
done
[ -n "$IDT3_NEWEST_HDR" ] && echo "== newest header: $IDT3_NEWEST_HDR =="
IDT3_HDR_OK() { [ -z "$IDT3_NEWEST_HDR" ] || [ "$1" -nt "$IDT3_NEWEST_HDR" ]; }


# idTech3-web: vararg-safe vmMain array wrapper. JK2's cgame/cg_main.cpp declares
# vmMain(command, arg0..arg7) => 8 args after `command`. Compiled as C++ so it binds
# to the module's C++-linkage vmMain.
IDT3_SHIM_O="$BUILD/idt3_vm_shim.o"
em++ $JK2_FLAGS -DIDT3_VMMAIN_ARGS=8 -x c++ -c "$HERE/sys_emscripten/idt3_vm_shim.c" -o "$IDT3_SHIM_O"
OBJS+=("$IDT3_SHIM_O")
for f in $GAME_CPP; do
  # game files live under game/ unless already dir-qualified (cgame/, icarus/, qcommon/, ui/)
  case "$f" in */*) src="$SRC/$f" ;; *) src="$SRC/game/$f" ;; esac
  o="$BUILD/$(echo "$f" | tr '/.' '__').o"
  if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$src" ] && IDT3_HDR_OK "$o"; then OBJS+=("$o"); continue; fi
  if em++ $JK2_FLAGS $INCLUDES -c "$src" -o "$o" 2>>"$BUILD/build.errs"; then OBJS+=("$o");
  else FAILED+=("$f"); echo "FAIL $f"; fi
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "== ${#FAILED[@]} game TUs failed; see $BUILD/build.errs =="; exit 1
fi
echo "== linking qagame.wasm =="
# vmMain/dllEntry are exported too: SP merges cgame into this module, and the
# engine's Sys_LoadCgame dlsym()s them out of the SAME library (see the original
# win32 layer). idt3_vmMain_arr is the vararg-safe array entry VM_Call uses.
em++ "${OBJS[@]}" -sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=_GetGameAPI,_vmMain,_dllEntry,_idt3_vmMain_arr ${IDTECH3_THREAD_FLAGS} -fexceptions \
  -o "$OUT/qagame.wasm"
echo "== done: $OUT/qagame.wasm =="
