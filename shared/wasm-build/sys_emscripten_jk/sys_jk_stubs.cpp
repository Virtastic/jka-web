/*
 * idTech3-web — JK2/JKA platform entry points that the excluded win32 layer used to
 * provide, plus the handful of GL entry points LEGACY_GL_EMULATION does not export.
 *
 * The RoQ, sound and ambient-set stubs this file started life as are all gone: those
 * subsystems are compiled for real now (client/cl_cin.cpp, snd_dma/snd_ambient/snd_music
 * over the Web Audio SNDDMA backend). What is left is either a real implementation of the
 * original's contract or, where the browser genuinely has no equivalent, a documented
 * answer that says which engine feature is affected and whether the retail defaults reach
 * it. Signatures match the engine headers so the (mangled) symbol names resolve.
 */
#include "../server/exe_headers.h"
#include <dlfcn.h>   // idTech3-web: Sys_LoadCgame pulls cgame entry points from the game module
#include "../game/ghoul2_shared.h"
#include "../client/fffx.h"
#include "snd_public.h"
// sfx_t lives in snd_local.h, which pulls the OpenAL/EAX headers we can't build.
// A forward decl of its tag (sfx_s) is enough for the pointer param + symbol name.
typedef struct sfx_s sfx_t;

// --- Cinematics (RoQ) -----------------------------------------------------
// idTech3-web: the real RoQ player (client/cl_cin.cpp) is now compiled, so CIN_* /
// SCR_*Cinematic / CL_*Cinematic come from there — the stubs that used to live here
// were removed to avoid duplicate-symbol link errors.

// --- Sound extras / ambient / music ---------------------------------------
// idTech3-web: the real sound TUs (client/snd_dma.cpp, snd_ambient.cpp, snd_music.cpp)
// are now compiled (Web Audio SNDDMA backend + software mixer), so they provide
// S_StopSounds / AS_ParseSets / s_entityWavVol / … — the stubs that used to live here
// were removed to avoid duplicate-symbol link errors.

// --- Force feedback (Immersion TouchSense / MS SideWinder) ----------------
//
// The retail build defines _IMMERSION and _FF and links the ff/ TUs against the Immersion
// SDK; we define neither, so every _IMMERSION-guarded call site compiles out and the engine
// behaves exactly like a desktop machine with no force-feedback device attached. A few
// entry points sit outside those guards — cl_cgame.cpp calls FF_StopAll() unconditionally —
// and "no device, nothing to do" is the correct answer for each, which is also what the
// original's own no-device path does.
void FF_Play( ffFX_e ) {}
void FF_Stop( ffFX_e ) {}
void FF_StopAll( void ) {}
void FF_EnsurePlaying( ffFX_e ) {}

// --- Misc platform / math -------------------------------------------------
// myftol is provided by tr_shade_calc.cpp (and is a macro in tr_local.h) — no stub needed.
//
// Sys_LowPhysicalMemory is an answer, not a placeholder: win32 returns true below ~96MB of
// physical RAM, and the engine uses it to drop sound quality (snd_dma.cpp), skip
// Com_TouchMemory (cm_load.cpp) and lower texture detail (tr_init.cpp). This build starts on
// a 512MB heap and can grow to 4GB (env.sh) — the plentiful-memory case — so qfalse is the
// faithful reply.
qboolean Sys_LowPhysicalMemory( void ) { return qfalse; }

// in_restart re-opens DirectInput on win32. The HTML5 input layer holds no device handles —
// it is pointer/keyboard events on the canvas, registered once by IN_Init — so there is
// nothing to reopen, and re-running IN_Init would double-register those listeners.
// Accepting the command and doing nothing is the correct behaviour here.
void Sys_In_Restart_f( void ) {}

// cgame VM loader (C++ linkage to match the engine's mangled reference).
//
// JK2/JKA SP build game + cgame into ONE module (game/game.dsp / game.vcproj pull
// in the cgame/ sources, and game.def exports vmMain/dllEntry alongside
// GetGameAPI), so the original win32 Sys_LoadCgame just GetProcAddress()es
// "dllEntry"/"vmMain" out of the ALREADY-LOADED game_library — it does not open a
// second library. We do the same against the same handle.
//
// This was previously a stub returning NULL, which made VM_Create("cl") fail and
// killed every map load with "failed to attach to the client DLL"
// (server/sv_game.cpp:679).
//
// entryPoint is resolved to idt3_vmMain_arr, not vmMain: VM_Call marshals its args
// into an array under __EMSCRIPTEN__ (client/vmachine.cpp) because wasm has no
// contiguous vararg stack for the engine's `(&callnum)[i]` trick to walk.
void *idt3_jk_game_library( void );   // sys_jk.cpp — handle from Sys_GetGameAPI

void *Sys_LoadCgame( int ( **entryPoint )( int, ... ), int ( *systemcalls )( int, ... ) ) {
	void *lib = idt3_jk_game_library();
	void ( *dllEntry )( int ( *syscallptr )( int, ... ) );

	if ( !lib ) {
		Com_Printf( "Sys_LoadCgame: game library not loaded yet\n" );
		return NULL;
	}

	dllEntry = (void (*)( int (*)( int, ... ) ))dlsym( lib, "dllEntry" );
	*entryPoint = (int (*)( int, ... ))dlsym( lib, "idt3_vmMain_arr" );
	if ( !*entryPoint ) {
		*entryPoint = (int (*)( int, ... ))dlsym( lib, "vmMain" );
	}
	if ( !*entryPoint || !dllEntry ) {
		Com_Printf( "Sys_LoadCgame: missing dllEntry/vmMain in the game module\n" );
		return NULL;
	}

	dllEntry( systemcalls );
	return lib;
}

// idTech3-web: TheGameGhoul2InfoArray() used to be stubbed here as `return *(IGhoul2InfoArray
// *)NULL`. It was dead code AND a latent null dereference. CGhoul2Info_v::InfoArray()
// (ghoul2_shared.h:337) selects on _JK2EXE — the engine, which we compile WITH it, takes the
// TheGhoul2InfoArray() branch implemented for real in ghoul2/G2_API.cpp, and only the game
// module (built without _JK2EXE) wants TheGameGhoul2InfoArray, which g_main.cpp defines for
// itself. No engine TU references the symbol, and the link is clean without it.

// --- GL fixed-function entry points LEGACY_GL_EMULATION doesn't export -----
//
// Both are reachable only from code the retail defaults never run, and neither can be
// expressed in WebGL:
//   glArrayElement — tr_shade.cpp's R_DrawStripElements path, used only when r_primitives
//     resolves to 1. GLimp_Init forces the single-glDrawElements path (3) instead, because
//     immediate-mode array elements draw nothing here.
//   glCallList — display lists. Two call sites: the r_DynamicGlow blur passes
//     (tr_backend.cpp), and RB_SurfaceDisplayList (tr_surface.cpp) for SF_DISPLAY_LIST,
//     which exists in the surfaceType_t enum and the dispatch table but which nothing in
//     JK2/JKA ever creates. r_DynamicGlow is CVAR_ARCHIVE "0" in the retail game.
extern "C" void glArrayElement( int i ) { (void)i; }
extern "C" void glCallList( unsigned int list ) { (void)list; }
