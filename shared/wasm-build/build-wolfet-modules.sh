#!/usr/bin/env bash
# Build Wolf:ET game modules (qagame, cgame, ui) as Emscripten SIDE MODULES.
# File lists mirror src/SConscript.{game,cgame,ui}. ET's ai_*.c live in botai/;
# bg_*/g_*/q_* in game/; cg_* in cgame/; ui_* in ui/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/env.sh"

SRC="$IDTECH3_ROOT/games/wolfet/src"
OUT="$IDTECH3_ROOT/play/wolfet"
BUILD="$IDTECH3_ROOT/build-wolfet/modules"
mkdir -p "$BUILD" "$OUT"

INC="-I$SRC/qcommon -I$SRC/game -I$SRC/cgame -I$SRC/ui -I$SRC/botai -I$SRC/botlib"
DEFS="-DMAC_STATIC= -DCPUSTRING=\"wasm32\" -DPATH_SEP='/'"
LINK="-sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=_vmMain,_dllEntry,_idt3_vmMain_va,_idt3_vmMain_arr ${IDTECH3_THREAD_FLAGS} -fexceptions"

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
  # idTech3-web: vararg vmMain wrapper (wasm signature strictness)
  local nargs=12; [ "$name" = "qagame" ] && nargs=7
  local shim_o="$BUILD/${name}__idt3_vm_shim.o"
  eval emcc $IDTECH3_COMMON_FLAGS -DIDT3_VMMAIN_ARGS=$nargs -fPIC -c "$HERE/sys_emscripten/idt3_vm_shim.c" -o "$shim_o"
  objs+=("$shim_o")
  for f in "$@"; do
    local o="$BUILD/${name}__$(echo "$f" | tr '/.' '__').o"
    if [ "${FORCE:-0}" != "1" ] && [ -f "$o" ] && [ "$o" -nt "$SRC/$f" ] && IDT3_HDR_OK "$o"; then objs+=("$o"); continue; fi
    # idTech3-web: -fvisibility=hidden keeps module globals private so they don't
    # merge with same-named engine globals under MAIN_MODULE (e.g. vmCvar_t bot_enable
    # vs the engine's int bot_enable) — such merges overflow adjacent engine memory.
    eval emcc $IDTECH3_COMMON_FLAGS -fvisibility=hidden $INC $DEFS $xdefs -fPIC -c "$SRC/$f" -o "$o"
    objs+=("$o")
  done
  echo "== linking $name.wasm =="
  eval emcc "${objs[@]}" $LINK -o "$OUT/$name.wasm"
}

AI="botai/ai_cmd.c botai/ai_dmgoal_mp.c botai/ai_dmnet_mp.c botai/ai_dmq3.c botai/ai_main.c \
botai/ai_script.c botai/ai_script_actions.c botai/ai_team.c"
BG="game/bg_animation.c game/bg_animgroup.c game/bg_campaign.c game/bg_character.c \
game/bg_classes.c game/bg_misc.c game/bg_pmove.c game/bg_slidemove.c game/bg_sscript.c \
game/bg_stats.c game/bg_tracemap.c"
GCORE="game/g_active.c game/g_alarm.c game/g_antilag.c game/g_bot.c game/g_buddy_list.c \
game/g_character.c game/g_client.c game/g_cmds.c game/g_cmds_ext.c game/g_combat.c \
game/g_config.c game/g_fireteams.c game/g_items.c game/g_main.c game/g_match.c game/g_mem.c \
game/g_misc.c game/g_missile.c game/g_mover.c game/g_multiview.c game/g_props.c game/g_referee.c \
game/g_save.c game/g_script.c game/g_script_actions.c game/g_session.c game/g_spawn.c \
game/g_stats.c game/g_sv_entities.c game/g_svcmds.c game/g_syscalls.c game/g_systemmsg.c \
game/g_target.c game/g_team.c game/g_teammapdata.c game/g_trigger.c game/g_utils.c game/g_vote.c \
game/g_weapon.c game/q_math.c game/q_shared.c"

CG="cgame/cg_atmospheric.c cgame/cg_character.c cgame/cg_commandmap.c cgame/cg_consolecmds.c \
cgame/cg_debriefing.c cgame/cg_draw.c cgame/cg_drawtools.c cgame/cg_effects.c cgame/cg_ents.c \
cgame/cg_event.c cgame/cg_fireteamoverlay.c cgame/cg_fireteams.c cgame/cg_flamethrower.c \
cgame/cg_info.c cgame/cg_limbopanel.c cgame/cg_loadpanel.c cgame/cg_localents.c cgame/cg_main.c \
cgame/cg_marks.c cgame/cg_missionbriefing.c cgame/cg_multiview.c cgame/cg_newDraw.c cgame/cg_particles.c \
cgame/cg_players.c cgame/cg_playerstate.c cgame/cg_polybus.c cgame/cg_popupmessages.c \
cgame/cg_predict.c cgame/cg_scoreboard.c cgame/cg_servercmds.c cgame/cg_snapshot.c \
cgame/cg_sound.c cgame/cg_spawn.c cgame/cg_statsranksmedals.c cgame/cg_syscalls.c \
cgame/cg_trails.c cgame/cg_view.c cgame/cg_weapons.c cgame/cg_window.c \
game/bg_animation.c game/bg_animgroup.c game/bg_character.c game/bg_classes.c game/bg_misc.c \
game/bg_pmove.c game/bg_slidemove.c game/bg_sscript.c game/bg_stats.c game/bg_tracemap.c \
game/q_math.c game/q_shared.c ui/ui_shared.c"

UI="ui/ui_atoms.c ui/ui_gameinfo.c ui/ui_loadpanel.c ui/ui_main.c ui/ui_players.c \
ui/ui_shared.c ui/ui_syscalls.c ui/ui_util.c game/bg_campaign.c game/bg_classes.c \
game/bg_misc.c game/q_math.c game/q_shared.c"

build_module qagame "-DGAMEDLL"  $AI $BG $GCORE
build_module cgame  "-DCGAMEDLL" $CG
build_module ui     "-DUIDLL"    $UI
echo "== ET modules done: $OUT/{qagame,cgame,ui}.wasm =="
