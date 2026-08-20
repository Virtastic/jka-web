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

# idTech3-web: argv is assembled as bash ARRAYS, not as a space-joined string. A string
# has to be expanded UNQUOTED to split into separate arguments, and unquoted expansion
# also splits on the spaces *inside* $SRC -- fatal on any host whose checkout path
# contains one (e.g. C:/Users/First Last/... under Git-Bash): every -I became two broken
# arguments and all ~300 engine TUs failed with "no such file or directory". With arrays
# one element is exactly one argv entry, whatever the path looks like.
INCLUDES=( -I"$SRC/qcommon" -I"$SRC/client" -I"$SRC/renderer" -I"$SRC/game" -I"$SRC/ui" \
  -I"$SRC/cgame" -I"$SRC/ghoul2" -I"$SRC/mp3code" -I"$SRC/jpeg-6" -I"$SRC/server" \
  -I"$SRC/RMG" -I"$SRC/zlib32" -I"$SYS" )
# _JK2EXE marks "this TU is the engine, not the game DLL" (JKA keeps JK2's macro
# name). game/genericparser2.cpp is compiled into BOTH the exe and the game DLL, and
# genericparser2.h switches trap_Z_Malloc on it -- Z_Malloc for the engine vs
# gi.Malloc for the game. Without it the engine referenced `gi`, which only exists in
# the game module, and the MAIN_MODULE aborted at startup with "undefined symbol 'gi'".
# The inner quotes below are LITERAL parts of the macro value: CPUSTRING has to expand to
# a C string literal and PATH_SEP to a char literal, so those quotes must survive into
# argv -- hence each such element is quoted around its embedded quote characters.
# -DFINAL_BUILD: the retail engine is built with it. starwars.vcproj's Release
# configuration reads NDEBUG,FINAL_BUILD,_JK2EXE,WIN32,_WINDOWS,_IMMERSION,_FF
# (starwars.dsp line 103 for JK2), and we were defining every one of those we can
# except FINAL_BUILD -- so the browser build was the developer build, not the shipped
# one. It is not only cosmetic:
#   * files_pc.cpp:813 prints "FS_ReadFile: <file> NOT PRECACHED!" in magenta for every
#     asset loaded during play. Four of those appeared on a stock t1_sour boot; retail
#     prints none of them.
#   * snd_ambient / snd_music / snd_mem / msg.cpp carry the same kind of developer
#     diagnostics behind #ifndef FINAL_BUILD.
#   * G2_API.cpp:31 sets G2API_DEBUG to 0 (retail) instead of leaving the debug value.
#   * common.cpp:13 stops pulling win32 platform.h, and OUTPUT_TO_BUILD_WINDOW goes away.
#   * cl_keys.cpp:1336 restores the retail console gate (Shift + `), which is the
#     behaviour a desktop player actually has.
# _IMMERSION/_FF stay undefined on purpose: they are Immersion TouchSense force
# feedback, whose ff/ TUs are excluded above and which no browser can drive. With them
# undefined the engine compiles those paths out entirely, exactly like a machine with
# no force-feedback device.
DEFINES=( -D_JK2EXE -DFINAL_BUILD -DMAC_STATIC= '-DCPUSTRING="wasm32"' "-DPATH_SEP='/'" '-DIDT3_FSROOT="/jka"' \
  -Dstricmp=strcasecmp -Dstrnicmp=strncasecmp -Dstrcmpi=strcasecmp -D_strnicmp=strncasecmp \
  -D_stricmp=strcasecmp -DINT32=int -DIDT3_JKA -DLITTLE_ENDIAN=1 -include "$SYS/jk_compat.h" )
JK2_FLAGS=( -std=gnu++14 -fexceptions -DOPENAL -O3 -fno-strict-aliasing -fPIC ${IDTECH3_THREAD_FLAGS} -DNDEBUG \
  -fno-operator-names -Wno-reserved-user-defined-literal \
  -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types \
  -Wno-return-type -Wno-shift-negative-value -Wno-writable-strings -Wno-invalid-offsetof \
  -Wno-register -Wno-deprecated -Wno-c++11-narrowing -fms-extensions -fdelayed-template-parsing\
  ${IDTECH3_JK_WARNFLAGS} )
CXXARGS=( "${JK2_FLAGS[@]}" "${INCLUDES[@]}" "${DEFINES[@]}" )

# Portable engine sources from the vcproj (win32/smartheap/mac excluded), then drop
# force-feedback -- the only TU group still excluded. See the note below the extraction.
if [ ! -s "$BUILD/engine-sources.txt" ]; then
  grep -oE 'RelativePath="[^"]+\.(cpp|c)"' "$SRC/starwars.vcproj" \
    | sed -E 's/RelativePath="//; s/"//; s#\\#/#g; s#^\./##' \
    | grep -viE "win32/|smartheap/|mac/|0_compiled_first/|/FeelIt" | sort -u > "$BUILD/engine-sources.txt"
fi
# idTech3-web: compile the real sound stack -- mp3code decoder + client/snd_* + cl_mp3
# (JKA, like JK2, stores most sfx as .mp3), and the real RoQ player (client/cl_cin.cpp).
# The cinematics are not decoration: assets0.pk3 carries 14 videos (video/ja01..ja12, the
# chapter intros, plus jk0101_sw and openinglogos), so stubbing them out would silently
# drop the whole story-cutscene layer. Verified decoding and animating in-browser, all 14
# -- see verify-cinematic.mjs.
#
# ff/ is the ONLY group still excluded, and not because of the browser: code/ff/IFC/ ships
# IFC22.dll + IFC22.lib and zero source files, so there is nothing to compile on any
# platform. Everything behind _IMMERSION is off in a stock retail install anyway
# (use_ff defaults to "0"); see docs/WASM_ADAPTATIONS.md.
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
# NB -print0 / read -d "": an unquoted $(find ...) word-splits on the spaces inside the
# checkout path, leaving only non-existent fragments, so -nt was false for every one and
# IDT3_NEWEST_HDR stayed empty -- silently disabling the very staleness check described
# above. NUL-delimited names are the only split-proof form.
IDT3_NEWEST_HDR=""
while IFS= read -r -d "" _h; do
  if [ -z "$IDT3_NEWEST_HDR" ] || [ "$_h" -nt "$IDT3_NEWEST_HDR" ]; then IDT3_NEWEST_HDR="$_h"; fi
done < <(find "$SRC" "$SYS" -name '*.h' -print0 2>/dev/null)
[ -n "$IDT3_NEWEST_HDR" ] && echo "== newest header: $IDT3_NEWEST_HDR =="

compile() {
  local src="$1" tag="$2"
  local o="$BUILD/${tag}.o"
  if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$src" ] \
     && { [ -z "$IDT3_NEWEST_HDR" ] || [ "$o" -nt "$IDT3_NEWEST_HDR" ]; }; then OBJS+=("$o"); return; fi
  # mp3code/ is portable C that miscompiles as C++ (implicit void*->T* casts, K&R
  # head_info3). Build it as plain C, like build-jk2.sh does.
  if [[ "$src" == *"/mp3code/"* ]]; then
    # -Wno-parentheses-equality / -Wno-comment: `if ((x == 2))` in cupl3.c and a nested
    # `/*` in towave.c's banner. Same era-leniency policy as IDTECH3_JK_WARNFLAGS, which
    # this branch does not use because mp3code is C and gets its own minimal flag set.
    if emcc -O2 -fPIC ${IDTECH3_THREAD_FLAGS} -DLITTLE_ENDIAN=1 -Dbyte="unsigned char" \
         -Wno-parentheses-equality -Wno-comment \
         -I"$SRC/mp3code" -c "$src" -o "$o" 2>>"$BUILD/build.errs"; then OBJS+=("$o")
    else FAILED+=("$src"); echo "FAIL $src"; fi
    return
  fi
  local xflag=(); [ "${src##*.}" = "c" ] && xflag=( -x c++ )
  if em++ "${xflag[@]}" "${CXXARGS[@]}" -c "$src" -o "$o" 2>>"$BUILD/build.errs"; then OBJS+=("$o")
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
# NB no -sEXPORTED_FUNCTIONS here. MAIN_MODULE=1 implies LINKABLE, which exports every
# function anyway, so emcc rejected the flag with
#   warning: EXPORTED_FUNCTIONS is not valid with LINKABLE set ... [-Wunused-command-line-argument]
# on every link. The entry points the page and the CDP harnesses call -- _main,
# _idt3_pump_frame, _idt3_exec_cmd, _malloc, _free -- are all present without it
# (verified against the emitted .js); they additionally carry EMSCRIPTEN_KEEPALIVE at
# their definitions, so they survive regardless of this link's export list.
em++ "${OBJS[@]}" $IDTECH3_LINK_FLAGS -sMAIN_MODULE=1 -lopenal \
  --post-js "$HERE/sys_emscripten/glemu_sig_fix.post.js" -o "$OUT/jka.js"
echo "== done: $OUT/jka.js =="
