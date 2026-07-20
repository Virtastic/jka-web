#!/usr/bin/env bash
# Build RTCW-SP (original GPL drop) to WebAssembly.
#
# The original build system is `cons` (ancient Perl tool) — we don't resurrect it; we
# enumerate the source set directly (matching unix/Conscript-client) and drive emcc.
# The unix/ platform files (linux_*.c, unix_*.c) are REPLACED by shared/wasm-build/
# sys_emscripten/. SP game/cgame/ui are native modules statically linked (no QVM here).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$IDTECH3_ROOT/games/rtcw-sp/src"
SYS="$HERE/sys_emscripten"
OUT="$IDTECH3_ROOT/play/rtcw"
BUILD="$IDTECH3_ROOT/build-rtcw-sp"
mkdir -p "$BUILD" "$OUT"

INCLUDES="-I$SRC/qcommon -I$SRC/client -I$SRC/renderer -I$SRC/game -I$SRC/ui -I$SRC/cgame -I$SRC/botlib -I$SRC/jpeg-6 -I$SYS"

# Platform build-defines the original `cons` system supplied per-target. Under emscripten
# none of the engine's platform branches fire, so we provide them explicitly:
#   MAC_STATIC  — Mac-only 'static' qualifier macro; empty elsewhere.
#   CPUSTRING   — arch string reported by Com_Init / version; "wasm32" here.
#   PATH_SEP    — filesystem separator char (POSIX-style under emscripten).
DEFINES="-DMAC_STATIC= -DCPUSTRING=\"wasm32\" -DPATH_SEP='/'"
INCLUDES="$INCLUDES $DEFINES"

# Core engine (platform-independent) — from unix/Conscript-client, minus ../unix/* and asm.
ENGINE_C=$(cat <<'EOF'
qcommon/cm_load.c qcommon/cm_patch.c qcommon/cm_polylib.c qcommon/cm_test.c
qcommon/cm_trace.c qcommon/cmd.c qcommon/common.c qcommon/cvar.c qcommon/files.c
qcommon/huffman.c qcommon/md4.c qcommon/msg.c qcommon/net_chan.c qcommon/unzip.c
qcommon/vm.c qcommon/vm_interpreted.c
game/q_math.c game/q_shared.c
client/cl_cgame.c client/cl_cin.c client/cl_console.c client/cl_input.c
client/cl_keys.c client/cl_main.c client/cl_net_chan.c client/cl_parse.c
client/cl_scrn.c client/cl_ui.c
client/snd_adpcm.c client/snd_dma.c client/snd_mem.c client/snd_mix.c client/snd_wavelet.c
server/sv_bot.c server/sv_ccmds.c server/sv_client.c server/sv_game.c server/sv_init.c
server/sv_main.c server/sv_net_chan.c server/sv_snapshot.c server/sv_world.c
renderer/tr_animation.c renderer/tr_backend.c renderer/tr_bsp.c renderer/tr_cmds.c
renderer/tr_cmesh.c renderer/tr_curve.c renderer/tr_flares.c renderer/tr_font.c
renderer/tr_image.c renderer/tr_init.c renderer/tr_light.c renderer/tr_main.c
renderer/tr_marks.c renderer/tr_mesh.c renderer/tr_model.c renderer/tr_noise.c
renderer/tr_scene.c renderer/tr_shade.c renderer/tr_shade_calc.c renderer/tr_shader.c
renderer/tr_shadows.c renderer/tr_sky.c renderer/tr_surface.c renderer/tr_world.c
EOF
)

# vm_x86.c is x86-only; vm_interpreted.c is the id386=0 path we keep.
# botlib + jpeg-6 compiled as-is (vendored).
BOTLIB_C=$(cd "$SRC" && ls botlib/be_*.c botlib/l_*.c 2>/dev/null | tr '\n' ' ')
JPEG_C=$(cd "$SRC" && ls jpeg-6/*.c 2>/dev/null | tr '\n' ' ')

# Our platform layer (replaces unix/ + win32/).
SYS_C="sys_emscripten/sys_emscripten.c sys_emscripten/sys_glimp.c \
sys_emscripten/sys_main.c sys_emscripten/idt3_dlopen.c sys_emscripten/sys_snd.c sys_emscripten/gl_stubs.c"

PROBE="${1:-}"
compile_one() {
  local f="$1" o="$BUILD/$(echo "$1" | tr '/.' '__').o"
  emcc $IDTECH3_COMMON_FLAGS $INCLUDES -c "$SRC/$f" -o "$o" 2>&1
}

if [ "$PROBE" = "--probe" ]; then
  # Syntax-check the core engine set, collect the error surface, don't link.
  echo "== PROBE: syntax-checking core engine TUs =="
  fail=0
  for f in $ENGINE_C; do
    if ! emcc $IDTECH3_COMMON_FLAGS $INCLUDES -fsyntax-only "$SRC/$f" 2>>"$BUILD/probe.log"; then
      echo "FAIL $f"; fail=$((fail+1))
    fi
  done
  echo "== $fail TUs failed; see $BUILD/probe.log =="
  exit 0
fi

# ---- full compile + link -------------------------------------------------
OBJS=()
EXTRA_CFLAGS=""

# idTech3-web: an object is stale if it is older than its source OR ANY HEADER.
# Comparing only against $src means a header edit (e.g. the glIndex_t typedef in
# renderer/tr_local.h) changes NOTHING — every TU looks up to date and the old
# objects relink. Coarse on purpose: one header touch rebuilds everything.
# NB no pipe into head: under `set -euo pipefail`, head closing the pipe SIGPIPEs
# find and aborts the build silently.
IDT3_NEWEST_HDR=""
for _h in $(find "$SRC" "$HERE/sys_emscripten" -name '*.h' -print 2>/dev/null); do
  if [ -z "$IDT3_NEWEST_HDR" ] || [ "$_h" -nt "$IDT3_NEWEST_HDR" ]; then IDT3_NEWEST_HDR="$_h"; fi
done
[ -n "$IDT3_NEWEST_HDR" ] && echo "== newest header: $IDT3_NEWEST_HDR =="

compile() {  # compile <path-relative-to-SRC-or-abs> <tag>
  local src="$1" tag="$2"
  local o="$BUILD/${tag}.o"
  # Incremental: skip if the object is newer than its source AND every header
  # (set FORCE=1 to rebuild all).
  if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$src" ] \
     && { [ -z "$IDT3_NEWEST_HDR" ] || [ "$o" -nt "$IDT3_NEWEST_HDR" ]; }; then
    OBJS+=("$o"); return
  fi
  emcc $IDTECH3_COMMON_FLAGS $INCLUDES $EXTRA_CFLAGS -c "$src" -o "$o"
  OBJS+=("$o")
}

echo "== compiling engine core =="
for f in $ENGINE_C; do compile "$SRC/$f" "$(echo "$f" | tr '/.' '__')"; done
echo "== compiling botlib =="
EXTRA_CFLAGS="-DBOTLIB"   # botlib TUs select their engine headers behind #ifdef BOTLIB
for f in $BOTLIB_C; do compile "$SRC/$f" "$(echo "$f" | tr '/.' '__')"; done
EXTRA_CFLAGS=""
echo "== compiling jpeg-6 =="
for f in $JPEG_C; do compile "$SRC/$f" "$(echo "$f" | tr '/.' '__')"; done
echo "== compiling platform layer =="
for f in $SYS_C; do compile "$HERE/$f" "$(echo "$f" | tr '/.' '__')"; done

echo "== linking rtcw.js =="
# MAIN_MODULE=2 enables dlopen of the SP game/cgame/ui side modules while keeping
# the export table lean (only symbols the side modules actually import are kept).
emcc "${OBJS[@]}" $IDTECH3_LINK_FLAGS \
  -sMAIN_MODULE=1 \
  -sEXPORTED_FUNCTIONS=_main,_idt3_pump_frame,_malloc,_free \
  --post-js "$HERE/sys_emscripten/glemu_sig_fix.post.js" \
  -o "$OUT/rtcw.js"
echo "== done: $OUT/rtcw.js =="
