/*
===========================================================================
idTech3-web — entry point, RAF frame pump, and native-module loader.
NEW code. main() boots Com_Init then hands the frame to the browser's
requestAnimationFrame via emscripten_set_main_loop; the runtime is kept
live across the (non-returning) call. Game/cgame/ui load as Emscripten
side modules through dlopen — faithful to the engine's DLL architecture.
===========================================================================
*/
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>

#include <stdio.h>
#include <emscripten.h>

#include "q_shared.h"
#include "qcommon.h"

void *idt3_dlopen_fresh( const char *path );   // idt3_dlopen.c

void IN_Init( void );
void IN_Frame( void );
void Sys_InitStreamThread( void );

// ==========================================================================
// Frame pump — one Com_Frame per browser animation frame.
// ==========================================================================
static void Sys_Frame( void ) {
	IN_Frame();
	Com_Frame();
}

// Also exported so a MessageChannel/RAF driver in JS can step the engine
// explicitly (used by the smoke-test harness); mirrors ja2-web's pump_frame.
EMSCRIPTEN_KEEPALIVE
void idt3_pump_frame( void ) {
	Sys_Frame();
}

// ==========================================================================
// Native module loader (Emscripten side modules).
// Signature matches qcommon.h: entryPoint yields vmMain; systemcalls is the
// engine trap handler passed to the module's dllEntry.
// ==========================================================================
// RTCW-MP / Wolf:ET: maps a VM name to its platform module filename (win32 returned
// "%s_mp_x86.dll"); also fed into pure-server referenced-pak checks by sv_init.c.
// Our modules are plain <name>.wasm side modules.
char *Sys_GetDLLName( const char *name ) {
	return va( "%s.wasm", name );
}

// RTCW-MP and Wolf:ET add a `char *fqpath` out-param (T.Ray 2/15/02) that SP lacks.
// Per-engine builds pass -DIDT3_LOADDLL_FQPATH for the MP/ET signature.
#ifdef IDT3_LOADDLL_FQPATH
void * QDECL Sys_LoadDll( const char *name, char *fqpath, int ( QDECL * *entryPoint )( int, ... ),
						  int ( QDECL *systemcalls )( int, ... ) ) {
#else
void * QDECL Sys_LoadDll( const char *name, int ( QDECL * *entryPoint )( int, ... ),
						  int ( QDECL *systemcalls )( int, ... ) ) {
#endif
	char fname[MAX_OSPATH];
	void *libHandle;
	void ( QDECL *dllEntry )( int ( QDECL *syscallptr )( int, ... ) );

	// Game modules ship alongside the base install as <name>.wasm side modules.
#ifndef IDT3_FSROOT
#define IDT3_FSROOT "/rtcw"
#endif
	Com_sprintf( fname, sizeof( fname ), IDT3_FSROOT "/%s.wasm", name );
#ifdef IDT3_LOADDLL_FQPATH
	if ( fqpath ) {
		Q_strncpyz( fqpath, fname, MAX_QPATH );
	}
#endif

	// VM_Restart() requires that unload+reload gives a module with FRESH STATICS
	// ("DLL's can't be restarted in place"), which emscripten's by-name dlopen
	// cache silently denies. idt3_dlopen_fresh() forces a real re-instantiation;
	// see idt3_dlopen.c for the full story and why map_restart crashed without it.
	libHandle = idt3_dlopen_fresh( fname );
	if ( !libHandle ) {
		// Still correct for a first load, just not for a reload.
		libHandle = dlopen( fname, RTLD_NOW );
	}
	if ( !libHandle ) {
		Com_Printf( "Sys_LoadDll(%s) failed: %s\n", name, dlerror() );
		return NULL;
	}

	dllEntry = dlsym( libHandle, "dllEntry" );
	// idTech3-web: prefer the vararg wrapper — wasm traps on fixed-arity vmMain
	// invoked through the engine's int(*)(int,...) pointer.
	*entryPoint = dlsym( libHandle, "idt3_vmMain_arr" );
	if ( !*entryPoint ) {
		*entryPoint = dlsym( libHandle, "idt3_vmMain_va" );
	}
	if ( !*entryPoint ) {
		*entryPoint = dlsym( libHandle, "vmMain" );
	}
	if ( !*entryPoint || !dllEntry ) {
		Com_Printf( "Sys_LoadDll(%s): missing dllEntry/vmMain\n", name );
		dlclose( libHandle );
		return NULL;
	}

	dllEntry( systemcalls );
	Com_Printf( "Sys_LoadDll(%s): loaded side module\n", name );
	return libHandle;
}

void Sys_UnloadDll( void *dllHandle ) {
	if ( dllHandle ) {
		dlclose( dllHandle );
	}
}

// ==========================================================================
// Entry point.
// ==========================================================================
int main( int argc, char **argv ) {
	char commandLine[MAX_STRING_CHARS] = "";
	int i;

	// Reassemble argv into the single command-line string Com_Init expects.
	for ( i = 1; i < argc; i++ ) {
		Q_strcat( commandLine, sizeof( commandLine ), argv[i] );
		Q_strcat( commandLine, sizeof( commandLine ), " " );
	}

	Sys_InitStreamThread();
	Com_Init( commandLine );

	IN_Init();

	// 0 fps → drive from requestAnimationFrame. simulate_infinite_loop=1 keeps the
	// runtime alive so the frame callback (and the live FS/GL state) survive.
	emscripten_set_main_loop( Sys_Frame, 0, 1 );
	return 0;
}
