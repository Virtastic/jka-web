#!/usr/bin/env bash
# Build Wolf:ET (original GPL drop) client engine to WebAssembly.
# Source lists mirror src/SConscript.core (client build). The unix/win32/mac
# platform files are replaced by shared/wasm-build/sys_emscripten/. The curl
# download system uses the engine's own no-op stubs (qcommon/dl_main_stubs.c);
# splines cameras come from gl_stubs.c for now (like RTCW).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$IDTECH3_ROOT/games/wolfet/src"
SYS="$HERE/sys_emscripten"
OUT="$IDTECH3_ROOT/play/wolfet"
BUILD="$IDTECH3_ROOT/build-wolfet"
mkdir -p "$BUILD" "$OUT"

INCLUDES="-I$SRC/qcommon -I$SRC/client -I$SRC/renderer -I$SRC/game -I$SRC/ui -I$SRC/cgame -I$SRC/botlib -I$SRC/jpeg-6 -I$SYS"
# ET's q_shared.h has no __EMSCRIPTEN__ block → provide the platform trio, plus the
# idTech3-web ABI switches (const url, fqpath loader, fs root).
DEFINES="-DMAC_STATIC= -DCPUSTRING=\"wasm32\" -DPATH_SEP='/' -DIDT3_CONST_URL -DIDT3_LOADDLL_FQPATH -DIDT3_FSROOT=\"/et\""
INCLUDES="$INCLUDES $DEFINES"

ENGINE_C=$(cat <<'EOF'
qcommon/cm_load.c qcommon/cm_patch.c qcommon/cm_polylib.c qcommon/cm_test.c
qcommon/cm_trace.c qcommon/cmd.c qcommon/common.c qcommon/cvar.c qcommon/files.c
qcommon/huffman.c qcommon/md4.c qcommon/msg.c qcommon/net_chan.c qcommon/unzip.c
qcommon/vm.c qcommon/vm_interpreted.c qcommon/dl_main_stubs.c
game/q_math.c game/q_shared.c
client/cl_cgame.c client/cl_cin.c client/cl_console.c client/cl_input.c
client/cl_keys.c client/cl_main.c client/cl_net_chan.c client/cl_parse.c
client/cl_scrn.c client/cl_ui.c
client/snd_adpcm.c client/snd_dma.c client/snd_mem.c client/snd_mix.c client/snd_wavelet.c
server/sv_bot.c server/sv_ccmds.c server/sv_client.c server/sv_game.c server/sv_init.c
server/sv_main.c server/sv_net_chan.c server/sv_snapshot.c server/sv_world.c
renderer/tr_animation_mdm.c renderer/tr_animation_mds.c renderer/tr_backend.c
renderer/tr_bsp.c renderer/tr_cmds.c renderer/tr_cmesh.c renderer/tr_curve.c
renderer/tr_decals.c renderer/tr_flares.c renderer/tr_font.c renderer/tr_image.c
renderer/tr_init.c renderer/tr_light.c renderer/tr_main.c renderer/tr_marks.c
renderer/tr_mesh.c renderer/tr_model.c renderer/tr_noise.c renderer/tr_scene.c
renderer/tr_shade.c renderer/tr_shade_calc.c renderer/tr_shader.c renderer/tr_shadows.c
renderer/tr_sky.c renderer/tr_surface.c renderer/tr_world.c
EOF
)

BOTLIB_C=$(cd "$SRC" && ls botlib/be_*.c botlib/l_*.c 2>/dev/null | tr '\n' ' ')
JPEG_C=$(cd "$SRC" && ls jpeg-6/*.c 2>/dev/null | tr '\n' ' ')
SYS_C="sys_emscripten/sys_emscripten.c sys_emscripten/sys_glimp.c \
sys_emscripten/et_compat.c \
sys_emscripten/sys_main.c sys_emscripten/idt3_dlopen.c sys_emscripten/sys_snd.c sys_emscripten/gl_stubs.c"

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


OBJS=()
EXTRA_CFLAGS=""
compile() {
  local src="$1" tag="$2"
  local o="$BUILD/${tag}.o"
  if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$src" ] && IDT3_HDR_OK "$o"; then
    OBJS+=("$o"); return
  fi
  emcc $IDTECH3_COMMON_FLAGS $INCLUDES $EXTRA_CFLAGS -c "$src" -o "$o"
  OBJS+=("$o")
}

echo "== compiling ET engine core =="
for f in $ENGINE_C; do compile "$SRC/$f" "$(echo "$f" | tr '/.' '__')"; done
echo "== compiling botlib =="
EXTRA_CFLAGS="-DBOTLIB"
for f in $BOTLIB_C; do compile "$SRC/$f" "$(echo "$f" | tr '/.' '__')"; done
EXTRA_CFLAGS=""
echo "== compiling jpeg-6 =="
for f in $JPEG_C; do compile "$SRC/$f" "$(echo "$f" | tr '/.' '__')"; done
echo "== compiling platform layer =="
for f in $SYS_C; do compile "$HERE/$f" "$(echo "$f" | tr '/.' '__')"; done

echo "== linking wolfet.js =="
emcc "${OBJS[@]}" $IDTECH3_LINK_FLAGS \
  -sMAIN_MODULE=1 \
  -sEXPORTED_FUNCTIONS=_main,_idt3_pump_frame,_malloc,_free \
  --post-js "$HERE/sys_emscripten/glemu_sig_fix.post.js" \
  -o "$OUT/wolfet.js"
echo "== done: $OUT/wolfet.js =="
