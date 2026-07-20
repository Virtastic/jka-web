#!/usr/bin/env bash
# Build the RTCW-SP native game modules (qagame, cgame, ui) as Emscripten SIDE
# MODULES. The engine (MAIN_MODULE) dlopens them via Sys_LoadDll →
# /rtcw/<name>.wasm. Each module is self-contained (its own q_shared/q_math/bg
# copies) and exports only vmMain + dllEntry, matching the original DLL ABI.
# File lists + -D defines mirror unix/Conscript-{game,cgame,ui}.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$IDTECH3_ROOT/games/rtcw-sp/src"
OUT="$IDTECH3_ROOT/play/rtcw"
BUILD="$IDTECH3_ROOT/build-rtcw-sp/modules"
mkdir -p "$BUILD" "$OUT"

INC="-I$SRC/qcommon -I$SRC/game -I$SRC/cgame -I$SRC/ui -I$SRC/botai -I$SRC/botlib"
DEFS="-DMAC_STATIC= -DCPUSTRING=\"wasm32\" -DPATH_SEP='/'"

# SIDE_MODULE=2 keeps the export table to just the ABI entry points dlsym needs.
# idt3_vmMain_arr is the wasm-safe array entry the engine's VM_Call invokes (see
# idt3_vm_shim.c / vm.c __EMSCRIPTEN__ path) — no varargs cross the boundary.
# SIDE_MODULE=2 keeps the export table to just the ABI entry points, so module
# globals do NOT merge with same-named symbols elsewhere. (SIDE_MODULE=1 exports
# everything and the loader then merged e.g. cgame's cvarTable/cvarTableSize with
# other definitions — cvarTableSize became 0, CG_RegisterCvars registered nothing,
# and every cgame cvar read 0.)
# CG_GetTeamColor is address-taken (cgame command table) so its GOT.func entry is
# resolved against the export table at load — it must be exported explicitly.
LINK="-sSIDE_MODULE=2 ${IDTECH3_THREAD_FLAGS} -fexceptions"
# Per-module extra exports: address-taken symbols whose GOT.func entries the
# dynamic loader resolves against the export table.
EXPORTS_qagame=""
EXPORTS_cgame=",_CG_GetTeamColor"
EXPORTS_ui=""

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


build_module() {  # build_module <name> <extra-defs> <files...>
  local name="$1"; shift
  local xdefs="$1"; shift
  local objs=()
  local xexp; eval "xexp=\${EXPORTS_$name}"
  # idTech3-web: vararg-safe vmMain array wrapper. RTCW-SP: qagame=7, cgame/ui=12.
  local nargs=12; [ "$name" = "qagame" ] && nargs=7
  local shim_o="$BUILD/${name}__idt3_vm_shim.o"
  eval emcc $IDTECH3_COMMON_FLAGS -DIDT3_VMMAIN_ARGS=$nargs -fPIC -c "$HERE/sys_emscripten/idt3_vm_shim.c" -o "$shim_o"
  objs+=("$shim_o")
  for f in "$@"; do
    local o="$BUILD/${name}__$(echo "$f" | tr '/.' '__').o"
    if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$SRC/$f" ] && IDT3_HDR_OK "$o"; then objs+=("$o"); continue; fi
    # idTech3-web: -fvisibility=hidden keeps module globals private. Without it the
    # dynamic loader MERGES same-named non-static globals across modules — cgame's
    # `cvarTable`/`cvarTableSize` bound to ui_main.c's table, so CG_RegisterCvars
    # registered ui_* cvars and every cg_* cvar stayed 0 (cg_viewsize=0 → the 3D
    # view clamped to the 30% minimum). Same class as ET's bot_enable overflow.
    eval emcc $IDTECH3_COMMON_FLAGS -fvisibility=hidden $INC $DEFS $xdefs -fPIC -c "$SRC/$f" -o "$o"
    objs+=("$o")
  done
  echo "== linking $name.wasm =="
  eval emcc "${objs[@]}" $LINK "-sEXPORTED_FUNCTIONS=_vmMain,_dllEntry,_idt3_vmMain_arr$xexp" -o "$OUT/$name.wasm"
}

GAME_FILES="botai/ai_chat.c botai/ai_cmd.c botai/ai_dmnet.c botai/ai_dmq3.c botai/ai_main.c \
botai/ai_team.c game/ai_cast.c game/ai_cast_characters.c game/ai_cast_debug.c game/ai_cast_events.c \
game/ai_cast_fight.c game/ai_cast_func_attack.c game/ai_cast_func_boss1.c game/ai_cast_funcs.c \
game/ai_cast_script.c game/ai_cast_script_actions.c game/ai_cast_script_ents.c game/ai_cast_sight.c \
game/ai_cast_think.c game/bg_animation.c game/bg_misc.c game/bg_pmove.c game/bg_slidemove.c \
game/g_active.c game/g_alarm.c game/g_bot.c game/g_client.c game/g_cmds.c game/g_combat.c \
game/g_items.c game/g_main.c game/g_mem.c game/g_misc.c game/g_missile.c game/g_mover.c \
game/g_props.c game/g_save.c game/g_script.c game/g_script_actions.c game/g_session.c \
game/g_spawn.c game/g_svcmds.c game/g_syscalls.c game/g_target.c game/g_team.c game/g_tramcar.c \
game/g_trigger.c game/g_utils.c game/g_weapon.c game/q_math.c game/q_shared.c"

CGAME_FILES="cgame/cg_consolecmds.c cgame/cg_draw.c cgame/cg_drawtools.c cgame/cg_effects.c cgame/cg_newDraw.c \
cgame/cg_ents.c cgame/cg_event.c cgame/cg_flamethrower.c cgame/cg_info.c cgame/cg_localents.c \
cgame/cg_main.c cgame/cg_marks.c cgame/cg_particles.c cgame/cg_players.c cgame/cg_playerstate.c \
cgame/cg_predict.c cgame/cg_scoreboard.c cgame/cg_servercmds.c cgame/cg_snapshot.c cgame/cg_sound.c \
cgame/cg_syscalls.c cgame/cg_trails.c cgame/cg_view.c cgame/cg_weapons.c game/bg_animation.c \
game/bg_misc.c game/bg_pmove.c game/bg_slidemove.c game/q_math.c game/q_shared.c ui/ui_shared.c"

UI_FILES="game/bg_misc.c game/q_math.c game/q_shared.c ui/ui_atoms.c ui/ui_gameinfo.c \
ui/ui_main.c ui/ui_players.c ui/ui_shared.c ui/ui_syscalls.c ui/ui_util.c"

build_module qagame "-DGAMEDLL"  $GAME_FILES
build_module cgame  "-DCGAMEDLL" $CGAME_FILES
build_module ui     ""           $UI_FILES
echo "== modules done: $OUT/{qagame,cgame,ui}.wasm =="
