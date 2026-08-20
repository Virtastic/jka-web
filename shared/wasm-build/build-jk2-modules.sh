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

# idTech3-web: argv is assembled as bash ARRAYS, not as a space-joined string. A string
# has to be expanded UNQUOTED to split into separate arguments, and unquoted expansion
# also splits on the spaces *inside* $SRC -- fatal on any host whose checkout path
# contains one (e.g. C:/Users/First Last/... under Git-Bash): every -I became two broken
# arguments and every engine TU failed with "no such file or directory". With arrays one
# element is exactly one argv entry, whatever the path looks like.
INCLUDES=( -I"$SRC/game" -I"$SRC/cgame" -I"$SRC/qcommon" -I"$SRC/ui" -I"$SRC/icarus" \
  -I"$SRC/ghoul2" -I"$SRC/server" -I"$SYS" )
# The inner quotes below are LITERAL parts of the macro value: CPUSTRING has to expand to
# a C string literal and PATH_SEP to a char literal, so those quotes must survive into
# argv -- hence each such element is quoted around its embedded quote characters.
DEFINES=( -DMAC_STATIC= '-DCPUSTRING="wasm32"' "-DPATH_SEP='/'" -DFINAL_BUILD \
  -Dstricmp=strcasecmp -Dstrnicmp=strncasecmp -Dstrcmpi=strcasecmp -D_strnicmp=strncasecmp \
  -D_stricmp=strcasecmp -DINT32=int -include "$SYS/jk_compat.h" )
# -std=gnu++14: the game module has locals named `forward`/`left`/`right` that collide
# with std::forward etc. (pulled in by `using namespace std;`). gnu++98 predates those
# std utilities entirely — and matches the 2002 code — clearing the ambiguities.
JK2_FLAGS=( -std=gnu++14 -fexceptions -O2 -fno-strict-aliasing -fPIC ${IDTECH3_THREAD_FLAGS} -DNDEBUG \
  -fno-operator-names -Wno-reserved-user-defined-literal -Wno-implicit-function-declaration \
  -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-return-type -Wno-shift-negative-value \
  -Wno-writable-strings -Wno-invalid-offsetof -Wno-register -Wno-deprecated -Wno-c++11-narrowing \
  -fms-extensions -fdelayed-template-parsing -Wno-c++11-compat-deprecated-writable-strings\
  ${IDTECH3_JK_WARNFLAGS} )
CXXARGS=( "${JK2_FLAGS[@]}" "${INCLUDES[@]}" "${DEFINES[@]}" )

# -fno-strict-aliasing (above) is MANDATORY per env.sh and was missing from this module.
#
# bg_lib.cpp is dropped below. It is idTech3's freestanding libc for the QVM interpreter
# and its own header comment reads "this file is excluded from release builds", but
# game.dsp still lists it, so it was compiled into the side module — where its NON-static
# strlen/strcmp/strcpy/strcat/strchr/strstr/tolower/toupper/atoi/atof/abs/fabs/tan/rand/
# vsprintf override musl's for every TU in the module. Its vsprintf implements only
# %i %d %u %f %s, with no case 'c' and no default, so %c expands to NOTHING while still
# consuming its argument. In JK2 that broke cg_main.cpp:1248 (all nine crosshairs collapse
# onto "gfx/2d/crosshair" with no letter -> default missing-image shader, a white-bordered
# black box at screen centre every frame), plus cg_text.cpp subtitles/captions/print text
# and cg_credits.cpp, which are assembled character-by-character via va("%c").
# Same defect found and fixed in jka-web; see its docs/WASM_ADAPTATIONS.md.
# game/game.dsp source list is cached here. Its paths are relative to code/game/:
# ".\foo.cpp" → game/foo.cpp, "..\cgame\foo.cpp" → cgame/foo.cpp, Icarus/ → icarus/.
GAME_CPP=$(sed 's#^\.\./##; s#Icarus/#icarus/#' "$BUILD/../game-sources.txt" 2>/dev/null | grep -v "^bg_lib[.]cpp$" || true)
if [ -z "${GAME_CPP:-}" ]; then
  grep "SOURCE=" "$SRC/game/game.dsp" | sed 's/SOURCE=//; s/\\/\//g; s/"//g; s#^\.\./##; s#^\./##; s#Icarus/#icarus/#' \
    | grep -iE "\.(cpp|c)$" | tr -d '\r' | sort -u > "$BUILD/../game-sources.txt"
  GAME_CPP=$(grep -v "^bg_lib[.]cpp$" "$BUILD/../game-sources.txt")
fi

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


# idTech3-web: vararg-safe vmMain array wrapper. JK2's cgame/cg_main.cpp declares
# vmMain(command, arg0..arg7) => 8 args after `command`. Compiled as C++ so it binds
# to the module's C++-linkage vmMain.
IDT3_SHIM_O="$BUILD/idt3_vm_shim.o"
em++ "${JK2_FLAGS[@]}" -DIDT3_VMMAIN_ARGS=8 -x c++ -c "$HERE/sys_emscripten/idt3_vm_shim.c" -o "$IDT3_SHIM_O"
OBJS+=("$IDT3_SHIM_O")
for f in $GAME_CPP; do
  # game files live under game/ unless already dir-qualified (cgame/, icarus/, qcommon/, ui/)
  case "$f" in */*) src="$SRC/$f" ;; *) src="$SRC/game/$f" ;; esac
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
em++ "${OBJS[@]}" -sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=_GetGameAPI,_vmMain,_dllEntry,_idt3_vmMain_arr ${IDTECH3_THREAD_FLAGS} -fexceptions \
  -o "$OUT/qagame.wasm"
echo "== done: $OUT/qagame.wasm =="
