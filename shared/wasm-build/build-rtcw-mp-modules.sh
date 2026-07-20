#!/usr/bin/env bash
# Build the RTCW-MP native game modules (qagame, cgame, ui) as Emscripten SIDE
# MODULES. The engine (MAIN_MODULE) dlopens them via Sys_LoadDll →
# /rtcw/<name>.wasm. Each module is self-contained (its own q_shared/q_math/bg
# copies) and exports only vmMain + dllEntry, matching the original DLL ABI.
# File lists + -D defines mirror unix/Conscript-{game,cgame,ui}.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$IDTECH3_ROOT/games/rtcw-mp/src"
OUT="$IDTECH3_ROOT/play/rtcwmp"
BUILD="$IDTECH3_ROOT/build-rtcw-mp/modules"
mkdir -p "$BUILD" "$OUT"

INC="-I$SRC/qcommon -I$SRC/game -I$SRC/cgame -I$SRC/ui -I$SRC/botai -I$SRC/botlib"
DEFS="-DMAC_STATIC= -DCPUSTRING=\"wasm32\" -DPATH_SEP='/'"

# SIDE_MODULE=2 keeps the export table to just the ABI entry points dlsym needs.
# idt3_vmMain_arr is the wasm-safe array entry the engine's VM_Call invokes.
LINK="-sSIDE_MODULE=2 ${IDTECH3_THREAD_FLAGS} -fexceptions"

# Per-module extra exports: address-taken symbols whose GOT.func entries the
# dynamic loader resolves against the export table at load time. CG_GetTeamColor
# is taken by address (cgame command table), so with SIDE_MODULE=2's lean export
# table it is absent and BOTH cgame and ui fail to load with
# "undefined symbol 'CG_GetTeamColor'". Same as the SP build.
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
  # idTech3-web: vararg-safe vmMain array wrapper. The arity MUST match each
  # module's real vmMain definition or wasm traps at the call with
  # "signature_mismatch:vmMain" (unreachable) the first time the engine calls in.
  # Verified against the sources:
  #   game/g_main.c:329    vmMain(command, arg0..arg6)   ->  7
  #   cgame/cg_main.c:60   vmMain(command, arg0..arg11)  -> 12
  #   ui/ui_main.c:289     vmMain(command, arg0..arg11)  -> 12
  # This line previously read `[ "$name" = "cgame" ] && nargs=7` with a comment
  # claiming "qagame=12, cgame=7" — qagame and cgame inverted, apparently copied
  # from the SP script with the special-cased name swapped instead of the values
  # being re-checked. MP matches SP here after all: qagame=7, cgame/ui=12.
  local nargs=12; [ "$name" = "qagame" ] && nargs=7
  local shim_o="$BUILD/${name}__idt3_vm_shim.o"
  eval emcc $IDTECH3_COMMON_FLAGS -DIDT3_VMMAIN_ARGS=$nargs -fPIC -c "$HERE/sys_emscripten/idt3_vm_shim.c" -o "$shim_o"
  objs+=("$shim_o")
  for f in "$@"; do
    local o="$BUILD/${name}__$(echo "$f" | tr '/.' '__').o"
    if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$SRC/$f" ] && IDT3_HDR_OK "$o"; then objs+=("$o"); continue; fi
    # idTech3-web: -fvisibility=hidden keeps module globals private. Without it the
    # dynamic loader MERGES same-named non-static globals across modules. MP hit this
    # hard: BOTH cgame/cg_spawn.c:98 and game/g_spawn.c:437 define `spawn_t spawns[]`.
    # cgame's is empty ({0,0} terminator only), but it bound to qagame's REAL table, so
    # spawns[0] became {"info_player_start", SP_info_player_start} while NUMSPAWNS
    # stayed 1 (sizeof is compile-time, from cgame's own array). The first entity whose
    # classname matched then called SP_info_player_start — a void(gentity_t*) — through
    # cg_spawn's void(void) pointer, and wasm's strict indirect-call typing trapped with
    # "function signature mismatch" inside CG_ParseEntityFromSpawnVars during CG_Init.
    # Same class as SP's cgame cvarTable binding to ui_main.c's table.
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
game/g_active.c game/g_alarm.c game/g_antilag.c game/g_bot.c game/g_client.c game/g_cmds.c \
game/g_combat.c game/g_items.c game/g_main.c game/g_mem.c game/g_misc.c game/g_missile.c \
game/g_mover.c game/g_props.c game/g_save.c game/g_script.c game/g_script_actions.c \
game/g_session.c game/g_spawn.c game/g_svcmds.c game/g_syscalls.c game/g_target.c game/g_team.c \
game/g_tramcar.c game/g_trigger.c game/g_utils.c game/g_vehicles.c game/g_weapon.c \
game/q_math.c game/q_shared.c"

# NB cg_newDraw.c was missing here, which is where CG_GetTeamColor lives
# (cg_newDraw.c:2691, address-taken by cg_main.c's cgDC.getTeamColor). Its absence
# broke the cgame link. Checked the whole list against the original
# unix/Conscript-cgame: this was the only omission. cg_spawn.c is deliberately kept
# even though Conscript-cgame lacks it — the file is on disk and IS listed in the
# original cgame.vcproj, so the Unix Conscript is simply stale there.
CGAME_FILES="cgame/cg_consolecmds.c cgame/cg_draw.c cgame/cg_drawtools.c cgame/cg_effects.c \
cgame/cg_ents.c cgame/cg_event.c cgame/cg_flamethrower.c cgame/cg_info.c cgame/cg_localents.c \
cgame/cg_main.c cgame/cg_marks.c cgame/cg_newDraw.c cgame/cg_particles.c cgame/cg_players.c cgame/cg_playerstate.c \
cgame/cg_predict.c cgame/cg_scoreboard.c cgame/cg_servercmds.c cgame/cg_snapshot.c cgame/cg_sound.c \
cgame/cg_spawn.c cgame/cg_syscalls.c cgame/cg_trails.c cgame/cg_view.c cgame/cg_weapons.c \
game/bg_animation.c game/bg_misc.c game/bg_pmove.c game/bg_slidemove.c game/q_math.c \
game/q_shared.c ui/ui_shared.c"

UI_FILES="game/bg_misc.c game/q_math.c game/q_shared.c ui/ui_atoms.c ui/ui_gameinfo.c \
ui/ui_main.c ui/ui_players.c ui/ui_shared.c ui/ui_syscalls.c ui/ui_util.c"

build_module qagame "-DGAMEDLL"  $GAME_FILES
build_module cgame  "-DCGAMEDLL" $CGAME_FILES
build_module ui     ""           $UI_FILES
echo "== modules done: $OUT/{qagame,cgame,ui}.wasm =="
