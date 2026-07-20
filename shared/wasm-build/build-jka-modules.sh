#!/usr/bin/env bash
# Build the JKA SP game module (jagamex86.dll → qagame.wasm side module).
# Like JK2, SP merges game+cgame+Icarus+Ratl/Ravl/Rufl into one module (game.vcproj,
# 155 TUs). Exports GetGameAPI. Same C++ archaeology flags as the JKA engine.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$IDTECH3_ROOT/games/jka/code"
SYS="$HERE/sys_emscripten_jk"
OUT="$IDTECH3_ROOT/play/jka"
BUILD="$IDTECH3_ROOT/build-jka/modules"
mkdir -p "$BUILD" "$OUT"

INCLUDES="-I$SRC/game -I$SRC/cgame -I$SRC/qcommon -I$SRC/ui -I$SRC/icarus -I$SRC/ghoul2 \
-I$SRC/server -I$SRC/Ratl -I$SRC/Ravl -I$SRC/Rufl -I$SYS"
# game.vcproj release defines: NDEBUG;FINAL_BUILD;WIN32;_WINDOWS;_IMMERSION (minus win32)
DEFINES="-DMAC_STATIC= -DCPUSTRING=\"wasm32\" -DPATH_SEP='/' -DFINAL_BUILD -DIDT3_JKA \
-Dstricmp=strcasecmp -Dstrnicmp=strncasecmp -Dstrcmpi=strcasecmp -D_strnicmp=strncasecmp \
-D_stricmp=strcasecmp -DINT32=int -include $SYS/jk_compat.h"
JKA_FLAGS="-std=gnu++14 -fexceptions -O2 -fPIC ${IDTECH3_THREAD_FLAGS} -DNDEBUG \
-fno-operator-names -Wno-reserved-user-defined-literal -Wno-implicit-function-declaration \
-Wno-int-conversion -Wno-incompatible-pointer-types -Wno-return-type -Wno-shift-negative-value \
-Wno-writable-strings -Wno-invalid-offsetof -Wno-register -Wno-deprecated -Wno-c++11-narrowing \
-fms-extensions -fdelayed-template-parsing -Wno-c++11-compat-deprecated-writable-strings"
INCLUDES="$INCLUDES $DEFINES"

GAME_CPP=$(cat "$BUILD/../game-sources.txt")

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


# idTech3-web: vararg-safe vmMain array wrapper. JKA's cgame/cg_main.cpp declares
# vmMain(command, arg0..arg7) => 8 args after `command`. Compiled as C++ so it binds
# to the module's C++-linkage vmMain.
IDT3_SHIM_O="$BUILD/idt3_vm_shim.o"
em++ $JKA_FLAGS -DIDT3_VMMAIN_ARGS=8 -x c++ -c "$HERE/sys_emscripten/idt3_vm_shim.c" -o "$IDT3_SHIM_O"
OBJS+=("$IDT3_SHIM_O")
for f in $GAME_CPP; do
  src="$SRC/$f"
  o="$BUILD/$(echo "$f" | tr '/.' '__').o"
  if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$src" ] && IDT3_HDR_OK "$o"; then OBJS+=("$o"); continue; fi
  if em++ $JKA_FLAGS $INCLUDES -c "$src" -o "$o" 2>>"$BUILD/build.errs"; then OBJS+=("$o");
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
