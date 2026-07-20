/*
===========================================================================
idTech3-web — Emscripten/HTML5 platform layer for the Raven C++ engines
(Jedi Outcast / Jedi Academy). Replaces win32/ + unix/. NEW code; reproduces
the engine's Sys_/GLimp_/IN_/SNDDMA_ contract (modeled on the in-tree
win32/unix originals) against Emscripten HTML5 + WebGL. C++ (em++).

Differences from the RTCW C layer:
 - glConfig string fields are `const char *` (point at glGetString results).
 - Sys_ListFiles has no `filter` param.
 - Game modules load via Sys_GetGameAPI / VM_Create("cl"), not Sys_LoadDll.
===========================================================================
*/
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <dirent.h>
#include <unistd.h>
#include <math.h>
#include <dlfcn.h>

#include <emscripten.h>
#include <emscripten/html5.h>
#include <GL/gl.h>

// The engine headers are C++ (they pull STL) — include with normal C++ linkage.
#include "../server/exe_headers.h"

#ifndef IDT3_FSROOT
#define IDT3_FSROOT "/jk2"
#endif

// ==========================================================================
// Timing
// ==========================================================================
static double sys_timeBase = 0.0;
int Sys_Milliseconds( void ) {
	double now = emscripten_get_now();
	if ( sys_timeBase == 0.0 ) { sys_timeBase = now; return 0; }
	return (int)( now - sys_timeBase );
}

// ==========================================================================
// Event queue (win32/unix-identical semantics)
// ==========================================================================
#define MAX_QUED_EVENTS  256
#define MASK_QUED_EVENTS ( MAX_QUED_EVENTS - 1 )
static sysEvent_t eventQue[MAX_QUED_EVENTS];
static int eventHead, eventTail;

void Sys_QueEvent( int time, sysEventType_t type, int value, int value2, int ptrLength, void *ptr ) {
	sysEvent_t *ev = &eventQue[ eventHead & MASK_QUED_EVENTS ];
	if ( eventHead - eventTail >= MAX_QUED_EVENTS ) {
		if ( ev->evPtr ) Z_Free( ev->evPtr );
		eventTail++;
	}
	eventHead++;
	if ( time == 0 ) time = Sys_Milliseconds();
	ev->evTime = time; ev->evType = type; ev->evValue = value;
	ev->evValue2 = value2; ev->evPtrLength = ptrLength; ev->evPtr = ptr;
}

sysEvent_t Sys_GetEvent( void ) {
	sysEvent_t ev;
	if ( eventHead > eventTail ) { eventTail++; return eventQue[ ( eventTail - 1 ) & MASK_QUED_EVENTS ]; }
	memset( &ev, 0, sizeof( ev ) );
	ev.evTime = Sys_Milliseconds();
	return ev;
}

void Sys_SendKeyEvents( void ) { }

// ==========================================================================
// Console / errors
// ==========================================================================
void Sys_Print( const char *msg ) { fputs( msg, stdout ); }
char *Sys_ConsoleInput( void ) { return NULL; }
void Sys_ShowConsole( int level, qboolean quitOnClose ) { }
void Sys_DisplaySystemConsole( qboolean show ) { }
void Sys_SetErrorText( const char *text ) { }

void QDECL Sys_Error( const char *error, ... ) {
	va_list argptr; char string[4096];
	va_start( argptr, error );
	vsnprintf( string, sizeof( string ), error, argptr );
	va_end( argptr );
	fprintf( stderr, "Sys_Error: %s\n", string );
	EM_ASM( { if (typeof Module!=='undefined' && Module.onFatal) Module.onFatal(UTF8ToString($0)); }, string );
	emscripten_force_exit( 1 );
}
void Sys_Quit( void ) { emscripten_force_exit( 0 ); }

// ==========================================================================
// Filesystem / paths
// ==========================================================================
void Sys_Mkdir( const char *path ) { mkdir( path, 0777 ); }
char *Sys_Cwd( void ) {
	static char cwd[MAX_OSPATH];
	if ( !getcwd( cwd, sizeof( cwd ) - 1 ) ) cwd[0] = '\0';
	cwd[MAX_OSPATH - 1] = '\0';
	return cwd;
}
char *Sys_DefaultBasePath( void ) { return (char *)IDT3_FSROOT; }
char *Sys_DefaultCDPath( void )   { return (char *)""; }
qboolean Sys_CheckCD( void )      { return qtrue; }
char *Sys_GetCurrentUser( void )  { return (char *)"player"; }
char *Sys_GetClipboardData( void ){ return NULL; }

#define MAX_FOUND_FILES 0x1000
char **Sys_ListFiles( const char *directory, const char *extension, int *numfiles, qboolean wantsubs ) {
	struct dirent *d; DIR *fdir; qboolean dironly = wantsubs;
	char search[MAX_OSPATH]; int nfiles = 0, extLen, i;
	char *list[MAX_FOUND_FILES]; char **listCopy; struct stat st;

	if ( !extension ) extension = "";
	if ( extension[0] == '/' && extension[1] == 0 ) { extension = ""; dironly = qtrue; }
	extLen = strlen( extension );

	if ( ( fdir = opendir( directory ) ) == NULL ) { *numfiles = 0; return NULL; }
	while ( ( d = readdir( fdir ) ) != NULL ) {
		Com_sprintf( search, sizeof( search ), "%s/%s", directory, d->d_name );
		if ( stat( search, &st ) == -1 ) continue;
		if ( ( ( st.st_mode & S_IFDIR ) != 0 ) != dironly ) continue;
		if ( *extension ) {
			int nameLen = strlen( d->d_name );
			if ( nameLen < extLen || Q_stricmp( d->d_name + nameLen - extLen, extension ) ) continue;
		}
		if ( nfiles == MAX_FOUND_FILES - 1 ) break;
		list[nfiles++] = CopyString( d->d_name );
	}
	list[nfiles] = NULL; closedir( fdir );
	if ( !nfiles ) { *numfiles = 0; return NULL; }
	listCopy = (char **)Z_Malloc( ( nfiles + 1 ) * sizeof( *listCopy ), TAG_HUNKALLOC, qtrue );
	for ( i = 0; i < nfiles; i++ ) listCopy[i] = list[i];
	listCopy[i] = NULL; *numfiles = nfiles;
	return listCopy;
}
void Sys_FreeFileList( char **list ) {
	if ( !list ) return;
	for ( int i = 0; list[i]; i++ ) Z_Free( list[i] );
	Z_Free( list );
}

// ==========================================================================
// Streamed files / misc
// ==========================================================================
void Sys_InitStreamThread( void ) { }
void Sys_BeginStreamedFile( fileHandle_t f, int readahead ) { }
void Sys_EndStreamedFile( fileHandle_t f ) { }
int  Sys_StreamedRead( void *buffer, int size, int count, fileHandle_t f ) { return FS_Read( buffer, size * count, f ); }
void Sys_StreamSeek( fileHandle_t f, int offset, int origin ) { FS_Seek( f, offset, (fsOrigin_t)origin ); }

void Sys_Init( void ) { }
int  Sys_GetProcessorId( void ) { return 0; }
void Sys_BeginProfiling( void ) { }
void Sys_EndProfiling( void ) { }

// ==========================================================================
// Networking — stubbed for SP
// ==========================================================================
void NET_Sleep( int msec ) { }

// ==========================================================================
// Native module loader — game as an Emscripten side module.
// ==========================================================================
extern "C" void *idt3_dlopen_fresh( const char *path );   // sys_emscripten/idt3_dlopen.c

static void *game_library;

// Sys_LoadCgame (sys_jk_stubs.cpp) needs this handle: JK2/JKA SP put game AND cgame
// in the same module, so the cgame entry points come out of the library that
// Sys_GetGameAPI already opened — exactly as the original win32 layer does.
void *idt3_jk_game_library( void ) { return game_library; }
void *Sys_GetGameAPI( void *parms ) {
	char fname[MAX_OSPATH];
	void *(*GetGameAPI)( void * );
	Com_sprintf( fname, sizeof( fname ), IDT3_FSROOT "/qagame.wasm" );
	// JK2/JKA unload and reload the game module on every map load, and rely on it
	// coming back with fresh statics. Emscripten's by-name dlopen cache silently
	// returns the SAME instance instead (nodelete => dlclose never drops it), so
	// statics would survive across maps. idt3_dlopen_fresh() forces a real
	// re-instantiation; see sys_emscripten/idt3_dlopen.c for the full story.
	game_library = idt3_dlopen_fresh( fname );
	if ( !game_library ) {
		game_library = dlopen( fname, RTLD_NOW );   // correct for a first load
	}
	if ( !game_library ) { Com_Printf( "Sys_GetGameAPI: %s\n", dlerror() ); Com_Error( ERR_FATAL, "Couldn't load game" ); return NULL; }
	GetGameAPI = (void *(*)( void * ))dlsym( game_library, "GetGameAPI" );
	if ( !GetGameAPI ) { dlclose( game_library ); game_library = NULL; return NULL; }
	return GetGameAPI( parms );
}
void Sys_UnloadGame( void ) { if ( game_library ) dlclose( game_library ); game_library = NULL; }

// idTech3-web: winmm timeGetTime() used directly by JK2 game code (g_main, g_navigator)
extern "C" unsigned int timeGetTime( void ) {
	return (unsigned int)emscripten_get_now();
}
