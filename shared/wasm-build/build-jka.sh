#!/usr/bin/env bash
# Build Jedi Academy (JKA) SP engine to WebAssembly. C++ Raven engine, a delta
# off JK2 — reuses the shared sys_emscripten_jk platform layer + jk_compat.h and
# the same C++ archaeology flags. Source list mirrors code/starwars.vcproj minus
# win32/smartheap/mac. Sound (OpenAL/EAX), mp3, and force-feedback TUs are excluded
# and stubbed (sys_jk_snd.cpp / sys_jk_stubs.cpp). NB: no -D_M_IX86 (it turns on
# x86 inline asm in q_math/etc).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$IDTECH3_ROOT/games/jka/code"
SYS="$HERE/sys_emscripten_jk"
OUT="$IDTECH3_ROOT/play/jka"
BUILD="$IDTECH3_ROOT/build-jka"
mkdir -p "$BUILD" "$OUT"

INCLUDES="-I$SRC/qcommon -I$SRC/client -I$SRC/renderer -I$SRC/game -I$SRC/ui -I$SRC/cgame \
-I$SRC/ghoul2 -I$SRC/mp3code -I$SRC/jpeg-6 -I$SRC/server -I$SRC/RMG -I$SRC/zlib32 -I$SYS"
# _JK2EXE marks "this TU is the engine, not the game DLL" (JKA keeps JK2's macro
# name). game/genericparser2.cpp is compiled into BOTH the exe and the game DLL, and
# genericparser2.h switches trap_Z_Malloc on it -- Z_Malloc for the engine vs
# gi.Malloc for the game. Without it the engine referenced `gi`, which only exists in
# the game module, and the MAIN_MODULE aborted at startup with "undefined symbol 'gi'".
DEFINES="-D_JK2EXE -DMAC_STATIC= -DCPUSTRING=\"wasm32\" -DPATH_SEP='/' -DIDT3_FSROOT=\"/jka\" \
-Dstricmp=strcasecmp -Dstrnicmp=strncasecmp -Dstrcmpi=strcasecmp -D_strnicmp=strncasecmp \
-D_stricmp=strcasecmp -DINT32=int -DIDT3_JKA -DLITTLE_ENDIAN=1 -include $SYS/jk_compat.h"
JK2_FLAGS="-std=gnu++14 -fexceptions -DOPENAL -O3 -fno-strict-aliasing -fPIC ${IDTECH3_THREAD_FLAGS} -DNDEBUG \
-fno-operator-names -Wno-reserved-user-defined-literal \
-Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types \
-Wno-return-type -Wno-shift-negative-value -Wno-writable-strings -Wno-invalid-offsetof \
-Wno-register -Wno-deprecated -Wno-c++11-narrowing -fms-extensions -fdelayed-template-parsing"
IDTECH3_COMMON_FLAGS="$JK2_FLAGS"
INCLUDES="$INCLUDES $DEFINES"

# Portable engine sources from the vcproj (win32/smartheap/mac excluded), then
# drop the OpenAL/EAX sound, mp3, force-feedback, and cinematic TUs (stubbed).
if [ ! -s "$BUILD/engine-sources.txt" ]; then
  grep -oE 'RelativePath="[^"]+\.(cpp|c)"' "$SRC/starwars.vcproj" \
    | sed -E 's/RelativePath="//; s/"//; s#\\#/#g; s#^\./##' \
    | grep -viE "win32/|smartheap/|mac/|0_compiled_first/|/FeelIt" | sort -u > "$BUILD/engine-sources.txt"
fi
# idTech3-web: compile the real sound stack — mp3code decoder + client/snd_* + cl_mp3
# (JKA, like JK2, stores most sfx as .mp3). Keep force-feedback (ff/) and RoQ
# cinematics (cl_cin) excluded/stubbed. See build-jk2.sh for the rationale.
ENGINE_CPP=$(grep -viE "^ff/|/ff/" "$BUILD/engine-sources.txt")
SYS_CPP="sys_emscripten/idt3_dlopen.c sys_emscripten_jk/sys_jk.cpp sys_emscripten_jk/sys_jk_gl.cpp \
sys_emscripten_jk/sys_jk_snd.cpp sys_emscripten_jk/sys_jk_stubs.cpp \
 sys_emscripten_jk/sys_jka_stubs.cpp"

OBJS=(); FAILED=(); : > "$BUILD/build.errs"

# idTech3-web: an object is stale if it is older than its source OR ANY HEADER.
# The check used to compare only against $src, so editing a header (e.g. the
# glIndex_t typedef in renderer/tr_local.h) silently changed NOTHING: every TU was
# considered up to date and the old objects relinked. That produced hours of
# "the fix had no effect" — twice. Coarse on purpose: one header touch rebuilds
# everything, which is the safe direction to err.
# NB no pipe into head here: this script runs under `set -euo pipefail`, and head
# closing the pipe early SIGPIPEs find, which aborts the whole build silently.
IDT3_NEWEST_HDR=""
for _h in $(find "$SRC" "$SYS" -name '*.h' -print 2>/dev/null); do
  if [ -z "$IDT3_NEWEST_HDR" ] || [ "$_h" -nt "$IDT3_NEWEST_HDR" ]; then IDT3_NEWEST_HDR="$_h"; fi
done
[ -n "$IDT3_NEWEST_HDR" ] && echo "== newest header: $IDT3_NEWEST_HDR =="

compile() {
  local src="$1" tag="$2"
  local o="$BUILD/${tag}.o"
  if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$src" ] \
     && { [ -z "$IDT3_NEWEST_HDR" ] || [ "$o" -nt "$IDT3_NEWEST_HDR" ]; }; then OBJS+=("$o"); return; fi
  # mp3code/ is portable C that miscompiles as C++ (implicit void*->T* casts, K&R
  # head_info3). Build it as plain C, like build-jk2.sh does.
  if [[ "$src" == *"/mp3code/"* ]]; then
    if emcc -O2 -fPIC ${IDTECH3_THREAD_FLAGS} -DLITTLE_ENDIAN=1 -Dbyte="unsigned char" \
         -I"$SRC/mp3code" -c "$src" -o "$o" 2>>"$BUILD/build.errs"; then OBJS+=("$o")
    else FAILED+=("$src"); echo "FAIL $src"; fi
    return
  fi
  local xflag=""; [ "${src##*.}" = "c" ] && xflag="-x c++"
  if em++ $xflag $IDTECH3_COMMON_FLAGS $INCLUDES -c "$src" -o "$o" 2>>"$BUILD/build.errs"; then OBJS+=("$o")
  else FAILED+=("$src"); echo "FAIL $src"; fi
}

echo "== compiling JKA engine ($(echo "$ENGINE_CPP" | wc -w) TUs) =="
for f in $ENGINE_CPP; do compile "$SRC/$f" "$(echo "$f" | tr '/.' '__')"; done
echo "== compiling platform layer =="
for f in $SYS_CPP; do compile "$HERE/$f" "$(echo "$f" | tr '/.' '__')"; done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "== ${#FAILED[@]} TUs failed; not linking. See $BUILD/build.errs =="
  printf '  %s\n' "${FAILED[@]}"; exit 1
fi
echo "== linking jka.js =="
em++ "${OBJS[@]}" $IDTECH3_LINK_FLAGS -sMAIN_MODULE=1 -lopenal \
  -sEXPORTED_FUNCTIONS=_main,_idt3_pump_frame,_malloc,_free \
  --post-js "$HERE/sys_emscripten/glemu_sig_fix.post.js" -o "$OUT/jka.js"
echo "== done: $OUT/jka.js =="
