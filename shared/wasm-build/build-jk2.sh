#!/usr/bin/env bash
# Build Jedi Outcast (JK2) SP engine to WebAssembly. C++ Raven engine.
# Engine source list mirrors code/starwars.dsp minus win32/, smartheap/, mac/,
# 0_compiled_first/ (all replaced by shared/wasm-build/sys_emscripten_jk/).
# --probe : syntax-check the engine core only (surface the C++ archaeology).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$IDTECH3_ROOT/games/jk2/code"
SYS="$HERE/sys_emscripten_jk"
OUT="$IDTECH3_ROOT/play/jk2"
BUILD="$IDTECH3_ROOT/build-jk2"
mkdir -p "$BUILD" "$OUT"

# idTech3-web: argv is assembled as bash ARRAYS, not as a space-joined string. A string
# has to be expanded UNQUOTED to split into separate arguments, and unquoted expansion
# also splits on the spaces *inside* $SRC -- fatal on any host whose checkout path
# contains one (e.g. C:/Users/First Last/... under Git-Bash): every -I became two broken
# arguments and every engine TU failed with "no such file or directory". With arrays one
# element is exactly one argv entry, whatever the path looks like.
INCLUDES=( -I"$SRC/qcommon" -I"$SRC/client" -I"$SRC/renderer" -I"$SRC/game" -I"$SRC/ui" \
  -I"$SRC/cgame" -I"$SRC/ghoul2" -I"$SRC/mp3code" -I"$SRC/jpeg-6" -I"$SRC/server" -I"$SYS" )
# stricmp/strnicmp: MSVC names for the POSIX case-insensitive compares.
# random: the engine's `inline float random()` collides with POSIX `long random()`;
#   rename it (and its call sites) consistently via macro. jk_compat.h (force-included)
#   supplies strlwr/strupr.
# _JK2EXE marks "this TU is the engine, not the game DLL" -- starwars.dsp builds the
# exe with /D "_JK2EXE". It is load-bearing, not cosmetic: game/genericparser2.cpp is
# compiled into BOTH the exe and the game DLL, and genericparser2.h switches on it --
#   #ifdef _JK2EXE  trap_Z_Malloc -> Z_Malloc   (engine's own allocator)
#   #else           trap_Z_Malloc -> gi.Malloc  (game's import table)
# Without it the engine compiled that file in game-DLL mode and referenced `gi`, which
# only exists in the game module (g_main.cpp), so the MAIN_MODULE aborted at startup
# with "undefined symbol 'gi'" long before FS_Startup.
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
DEFINES=( -D_JK2EXE -DFINAL_BUILD -DMAC_STATIC= '-DCPUSTRING="wasm32"' "-DPATH_SEP='/'" '-DIDT3_FSROOT="/jk2"' \
  -Dstricmp=strcasecmp -Dstrnicmp=strncasecmp -Dstrcmpi=strcasecmp -D_strnicmp=strncasecmp \
  -D_stricmp=strcasecmp -DINT32=int -DLITTLE_ENDIAN=1 -include "$SYS/jk_compat.h" )
# JK2 is C++: build our OWN flag set (the shared IDTECH3_COMMON_FLAGS has C-only
# -fgnu89-inline / -DDLL_ONLY which clang rejects for C++). Keep the warning
# relaxations for the era's lenient code, plus C++/MSVC-ism tolerances.
# -std=gnu++14: JK2 is 2002-era C++98. Compiling at C++17+ makes the engine's
# `typedef unsigned char byte` collide with C++17 std::byte (ambiguous everywhere).
# gnu++14 has no std::byte and matches the era — clears the bulk of the ambiguities.
# -fno-operator-names: the renderer uses `or`/`and` as struct member names (they're
#   C++ alternative-operator keywords otherwise). -Wno-reserved-user-defined-literal:
#   old code writes `"..."MACRO` with no space (a C++11 UDL ambiguity).
JK2_FLAGS=( -std=gnu++14 -fexceptions -DOPENAL -O3 -fno-strict-aliasing -fPIC ${IDTECH3_THREAD_FLAGS} -DNDEBUG \
  -fno-operator-names -Wno-reserved-user-defined-literal \
  -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types \
  -Wno-return-type -Wno-shift-negative-value -Wno-writable-strings -Wno-invalid-offsetof \
  -Wno-register -Wno-deprecated -Wno-c++11-narrowing -fms-extensions -fdelayed-template-parsing\
  ${IDTECH3_JK_WARNFLAGS} )
CXXARGS=( "${JK2_FLAGS[@]}" "${INCLUDES[@]}" "${DEFINES[@]}" )   # local flag set for this build only

# Portable engine sources (from starwars.dsp; win32/smartheap/mac excluded).
# `|| true`: under `set -euo pipefail` a VAR=$(failing-pipeline) assignment aborts the
# script, so with no cached list this died silently before reaching the regeneration
# below — i.e. a fresh clone could never build. The fallback was unreachable.
ENGINE_CPP=$(grep -viE "win32/|smartheap/|mac/|0_compiled_first/|/FeelIt" "$BUILD/engine-sources.txt" 2>/dev/null | sed 's#^\./##' || true)

if [ -z "${ENGINE_CPP:-}" ]; then
  # Regenerate the source list from the .dsp if not cached.
  grep "SOURCE=" "$SRC/starwars.dsp" | sed 's/SOURCE=//; s/\\/\//g; s/^\.\///; s/"//g' \
    | grep -iE "\.(cpp|c)$" | grep -viE "win32/|smartheap/|mac/|0_compiled_first/|/FeelIt" \
    | sort -u > "$BUILD/engine-sources.txt"
  ENGINE_CPP=$(cat "$BUILD/engine-sources.txt")
fi

PROBE="${1:-}"
if [ "$PROBE" = "--probe" ]; then
  echo "== PROBE: syntax-checking JK2 engine core =="
  : > "$BUILD/probe.log"; fail=0
  for f in $ENGINE_CPP; do
    ext="${f##*.}"; cc=em++; [ "$ext" = "c" ] && cc=emcc
    if ! $cc $IDTECH3_COMMON_FLAGS $INCLUDES -fsyntax-only "$SRC/$f" 2>>"$BUILD/probe.log"; then
      echo "FAIL $f"; fail=$((fail+1))
    fi
  done
  echo "== $fail/$( echo "$ENGINE_CPP" | wc -w ) TUs failed; see $BUILD/probe.log =="
  exit 0
fi

# ---- full compile + link -------------------------------------------------
# Exclude for the first link (symbols stubbed / tolerated as MAIN_MODULE warnings):
#  - mp3code (music decoder), encryption (net)
#  - client/snd_*, cl_mp3, cl_cin : JK2's sound is OpenAL + Creative EAX
#    (client/openal, client/eax) which don't build under emscripten. The S_ API is
#    stubbed in sys_jk_snd.cpp (silent); Web Audio is a follow-up.
# idTech3-web: the real MP3 decoder (mp3code/ + client/cl_mp3.cpp) is now compiled —
# JK2/JKA store MOST sfx as .mp3 (blaster/fire.mp3, interface/button1.mp3, …), so a
# "disable mp3, load everything as WAV" shim leaves the games nearly silent. The
# decoder is portable C; jk_compat.h supplies `byte` and -DLITTLE_ENDIAN=1 selects
# L3.h's little-endian tables. cl_cin (RoQ cinematics) stays excluded/stubbed.
ENGINE_CPP=$(echo "$ENGINE_CPP" | tr ' ' '\n' | grep -viE "encryption/")
SYS_CPP="sys_emscripten/idt3_dlopen.c sys_emscripten_jk/sys_jk.cpp sys_emscripten_jk/sys_jk_gl.cpp sys_emscripten_jk/sys_jk_snd.cpp sys_emscripten_jk/sys_jk_stubs.cpp"

OBJS=(); FAILED=()

# idTech3-web: an object is stale if it is older than its source OR ANY HEADER. The
# check used to compare only against $src, so editing a header (e.g. the glIndex_t
# typedef in renderer/tr_local.h) silently changed NOTHING — every TU looked up to
# date and the old objects relinked, which cost hours of "the fix had no effect".
# Coarse on purpose: one header touch rebuilds everything, the safe way to err.
# NB no pipe into head: this runs under `set -euo pipefail` and head closing the pipe
# early SIGPIPEs find, aborting the whole build silently.
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
  # mp3code/ is genuine portable C (the id/Raven MP3 decoder). It miscompiles as C++:
  # C's implicit void*->T* conversions become hard errors, and head_info3()'s K&R-style
  # calls mis-resolve as overloads. Build it as plain C (emcc), no -x c++. It needs only
  # its own headers plus the engine's lowercase `byte` and L3.h's little-endian select.
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
  # Raven ships some C++ code in .c files (e.g. renderer/MatComp.c); compile everything
  # as C++ (em++ -x c++) so the -std=gnu++14 flag set applies uniformly.
  local xflag=(); [ "${src##*.}" = "c" ] && xflag=( -x c++ )
  if em++ "${xflag[@]}" "${CXXARGS[@]}" -c "$src" -o "$o" 2>>"$BUILD/build.errs"; then
    OBJS+=("$o")
  else
    FAILED+=("$src"); echo "FAIL $src"
  fi
}

: > "$BUILD/build.errs"
echo "== compiling JK2 engine ($(echo "$ENGINE_CPP" | wc -w) TUs) =="
for f in $ENGINE_CPP; do compile "$SRC/$f" "$(echo "$f" | tr '/.' '__')"; done
echo "== compiling platform layer =="
for f in $SYS_CPP; do compile "$HERE/$f" "$(echo "$f" | tr '/.' '__')"; done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "== ${#FAILED[@]} TUs failed to compile; not linking. See $BUILD/build.errs =="
  printf '  %s\n' "${FAILED[@]}"
  exit 1
fi

echo "== linking jk2.js =="
# NB no -sEXPORTED_FUNCTIONS here. MAIN_MODULE=1 implies LINKABLE, which exports every
# function anyway, so emcc rejected the flag with
#   warning: EXPORTED_FUNCTIONS is not valid with LINKABLE set ... [-Wunused-command-line-argument]
# on every link. The entry points the page and the CDP harnesses call -- _main,
# _idt3_pump_frame, _idt3_exec_cmd, _malloc, _free -- are all present without it
# (verified against the emitted .js); they additionally carry EMSCRIPTEN_KEEPALIVE at
# their definitions, so they survive regardless of this link's export list.
em++ "${OBJS[@]}" $IDTECH3_LINK_FLAGS -sMAIN_MODULE=1 \
  -lopenal \
  --post-js "$HERE/sys_emscripten/glemu_sig_fix.post.js" \
  -o "$OUT/jk2.js"
echo "== done: $OUT/jk2.js =="
