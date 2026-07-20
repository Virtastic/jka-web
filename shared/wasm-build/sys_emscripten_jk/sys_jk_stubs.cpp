/*
 * idTech3-web — JK2/JKA stubs for excluded subsystems (RoQ cinematics, OpenAL/EAX
 * sound extras, MS SideWinder force-feedback, ambient sound sets). Those TUs don't
 * build under emscripten (see build-jk2.sh exclusions); these silent stubs let the
 * engine link and boot to the menu. Real Web Audio / cinematic support is a follow-up.
 * Signatures match the engine headers so the (mangled) symbol names resolve.
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

// --- Force feedback (MS SideWinder) ---------------------------------------
void FF_Play( ffFX_e ) {}
void FF_Stop( ffFX_e ) {}
void FF_StopAll( void ) {}
void FF_EnsurePlaying( ffFX_e ) {}

// --- Misc platform / math -------------------------------------------------
// myftol is provided by tr_shade_calc.cpp (and is a macro in tr_local.h) — no stub needed
qboolean Sys_LowPhysicalMemory( void ) { return qfalse; }
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

// Ghoul2 info array accessor (real impl lives in an excluded/game TU).
static IGhoul2InfoArray *g_ghoul2InfoArray = NULL;
IGhoul2InfoArray &TheGameGhoul2InfoArray( void ) { return *g_ghoul2InfoArray; }

// --- GL fixed-function entry points LEGACY_GL_EMULATION doesn't export -----
extern "C" void glArrayElement( int i ) { (void)i; }
extern "C" void glCallList( unsigned int list ) { (void)list; }
