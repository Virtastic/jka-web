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

# idTech3-web: argv as bash ARRAYS, not a space-joined string -- see build-jka.sh. An
# unquoted string expansion splits on the spaces inside $SRC too, which breaks every -I
# on hosts whose checkout path contains one.
INCLUDES=( -I"$SRC/game" -I"$SRC/cgame" -I"$SRC/qcommon" -I"$SRC/ui" -I"$SRC/icarus" \
  -I"$SRC/ghoul2" -I"$SRC/server" -I"$SRC/Ratl" -I"$SRC/Ravl" -I"$SRC/Rufl" -I"$SYS" )
# game.vcproj release defines: NDEBUG;FINAL_BUILD;WIN32;_WINDOWS;_IMMERSION (minus win32)
# Inner quotes are LITERAL parts of the macro value (C string / char literals), so they
# have to survive into argv.
DEFINES=( -DMAC_STATIC= '-DCPUSTRING="wasm32"' "-DPATH_SEP='/'" -DFINAL_BUILD -DIDT3_JKA \
  -Dstricmp=strcasecmp -Dstrnicmp=strncasecmp -Dstrcmpi=strcasecmp -D_strnicmp=strncasecmp \
  -D_stricmp=strcasecmp -DINT32=int -include "$SYS/jk_compat.h" )
# -fno-strict-aliasing is MANDATORY here, exactly as it is for the engine (see env.sh).
# It was missing from this module while build-jka.sh had it, so the whole of game+cgame —
# FxPrimitives, cg_marks, cg_effects, cg_ents, the bg_* movement/animation math — was being
# compiled at -O2 WITH strict aliasing live. idTech3 type-puns pervasively (byte-buffer
# casts, short*<->float*, union tricks), and the documented failure mode is precisely
# "vertices flung to garbage positions (spikes/shards shooting off the mesh)": the module
# hands the engine a vertex with a junk position and the renderer faithfully draws a
# triangle stretched across the screen.
JKA_FLAGS=( -std=gnu++14 -fexceptions -O2 -fno-strict-aliasing -fPIC ${IDTECH3_THREAD_FLAGS} -DNDEBUG \
  -fno-operator-names -Wno-reserved-user-defined-literal -Wno-implicit-function-declaration \
  -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-return-type -Wno-shift-negative-value \
  -Wno-writable-strings -Wno-invalid-offsetof -Wno-register -Wno-deprecated -Wno-c++11-narrowing \
  -fms-extensions -fdelayed-template-parsing -Wno-c++11-compat-deprecated-writable-strings\
  ${IDTECH3_JK_WARNFLAGS} )
CXXARGS=( "${JKA_FLAGS[@]}" "${INCLUDES[@]}" "${DEFINES[@]}" )

# game/game.vcproj source list, cached under the (gitignored) build dir. This used to
# be a bare `cat` of that cache, so a fresh clone — where build-jka/ does not exist yet —
# failed with "No such file or directory" before compiling anything. Generate it the way
# build-jka.sh does for the engine. vcproj paths are relative to code/game/:
# "./foo.cpp" → game/foo.cpp, "../cgame/foo.cpp" → cgame/foo.cpp. Unlike JK2, JKA's
# directory casing already matches the vcproj, so no case fixups are needed.
if [ ! -s "$BUILD/../game-sources.txt" ]; then
  grep -oE 'RelativePath="[^"]+\.(cpp|c)"' "$SRC/game/game.vcproj" \
    | sed -e 's/RelativePath="//' -e 's/"$//' | tr '\134' '/' | tr -d '\r' \
    | sed -e 's#^\.\./##' -e 's#^\./#game/#' -e 's#^\([^/]*\.c\(pp\)\?\)$#game/\1#' \
    | sort -u > "$BUILD/../game-sources.txt"
fi
# game/bg_lib.cpp is idTech3's freestanding libc for the QVM interpreter, and its own
# header comment says it: "this file is excluded from release builds". game.vcproj still
# lists it (in its QVM/debug configuration, which the RelativePath scrape above cannot
# see), so it was being compiled into the side module — where its NON-static definitions
# of strlen/strcmp/strcpy/strcat/strchr/strstr/tolower/toupper/atoi/atof/abs/fabs/tan/
# rand/vsprintf override musl's for every TU in the module.
#
# That is not cosmetic. bg_lib's vsprintf implements ONLY %i %d %u %f %s — it has no
# `case 'c'` and no default, so %c silently expands to NOTHING while still consuming its
# argument. Everything the game builds with va("...%c"...) came out truncated:
#   * cg_main.cpp    — all 9 crosshairs registered as "gfx/2d/crosshair" (no letter), so
#                      every one resolved to the default missing-image shader and the game
#                      drew a white-bordered black box in the middle of the screen forever.
#   * cg_text.cpp    — subtitles, captions and on-screen print text are assembled with
#                      va("%c%c", hi, lo), i.e. the entire story text layer.
#   * g_items.cpp / wp_saber.cpp — force-heal sound paths ("heal%d_%c.mp3").
#   * g_combat.cpp   — dismemberment surface names ("%s%c").
# And bg_lib's tan/atof/rand are QVM approximations replacing the real ones.
#
# Dropping the TU restores musl for all of it; nothing here needs a symbol bg_lib
# uniquely provides (every one of them is standard C).
GAME_CPP=$(grep -v '^game/bg_lib\.cpp$' "$BUILD/../game-sources.txt")

OBJS=(); FAILED=(); : > "$BUILD/build.errs"

# idTech3-web: an object is stale if it is older than its source OR ANY HEADER.
# Comparing only against the source means a header edit (e.g. the glIndex_t typedef in
# renderer/tr_local.h) changes NOTHING — every TU looks up to date and the old objects
# relink, which cost hours of "the fix had no effect". Coarse on purpose: one header
# touch rebuilds everything, which is the safe direction to err.
# NB no pipe into head: these scripts run under `set -euo pipefail`, and head closing
# the pipe early SIGPIPEs find and aborts the build silently.
# NB -print0 / read -d "": an unquoted $(find ...) word-splits on the spaces inside the
# checkout path, leaving only non-existent fragments, so -nt was false for every one and
# IDT3_NEWEST_HDR stayed empty -- silently disabling the very staleness check described
# above. NUL-delimited names are the only split-proof form.
IDT3_NEWEST_HDR=""
while IFS= read -r -d "" _h; do
  if [ -z "$IDT3_NEWEST_HDR" ] || [ "$_h" -nt "$IDT3_NEWEST_HDR" ]; then IDT3_NEWEST_HDR="$_h"; fi
done < <(find "$SRC" "$HERE/sys_emscripten" "$HERE/sys_emscripten_jk" -name '*.h' -print0 2>/dev/null)
[ -n "$IDT3_NEWEST_HDR" ] && echo "== newest header: $IDT3_NEWEST_HDR =="
IDT3_HDR_OK() { [ -z "$IDT3_NEWEST_HDR" ] || [ "$1" -nt "$IDT3_NEWEST_HDR" ]; }


# idTech3-web: vararg-safe vmMain array wrapper. JKA's cgame/cg_main.cpp declares
# vmMain(command, arg0..arg7) => 8 args after `command`. Compiled as C++ so it binds
# to the module's C++-linkage vmMain.
IDT3_SHIM_O="$BUILD/idt3_vm_shim.o"
em++ "${JKA_FLAGS[@]}" -DIDT3_VMMAIN_ARGS=8 -x c++ -c "$HERE/sys_emscripten/idt3_vm_shim.c" -o "$IDT3_SHIM_O"
OBJS+=("$IDT3_SHIM_O")
for f in $GAME_CPP; do
  src="$SRC/$f"
  o="$BUILD/$(echo "$f" | tr '/.' '__').o"
  if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$src" ] && IDT3_HDR_OK "$o"; then OBJS+=("$o"); continue; fi
  if em++ "${CXXARGS[@]}" -c "$src" -o "$o" 2>>"$BUILD/build.errs"; then OBJS+=("$o");
  else FAILED+=("$f"); echo "FAIL $f"; fi
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "== ${#FAILED[@]} game TUs failed; see $BUILD/build.errs =="; exit 1
fi
echo "== linking qagame.wasm =="
# vmMain/dllEntry are exported too: SP merges cgame into this module, and the
# engine's Sys_LoadCgame dlsym()s them out of the SAME library (see the original
# win32 layer). idt3_vmMain_arr is the vararg-safe array entry VM_Call uses.
if ! em++ "${OBJS[@]}" -sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=_GetGameAPI,_vmMain,_dllEntry,_idt3_vmMain_arr ${IDTECH3_THREAD_FLAGS} -fexceptions \
  -o "$OUT/qagame.wasm"; then
  echo "FATAL: qagame.wasm link failed (see errors above)"; exit 1
fi
# A real SIDE_MODULE is ~1.5 MB; a few hundred bytes means the game objects were missing and only
# the export stub got written (the silent failure that shipped a broken module in jk2-web on a
# fresh Linux build — see its build-jk2-modules.sh).
_qsz=$(wc -c < "$OUT/qagame.wasm")
[ "$_qsz" -gt 262144 ] || { echo "FATAL: qagame.wasm is only $_qsz bytes -- game objects did not link"; exit 1; }
echo "== done: $OUT/qagame.wasm ($_qsz bytes) =="
