/*
===========================================================================
idTech3-web — idt3_dlopen_fresh(): a dlopen() that really re-instantiates.

NEW code. Shared by both platform layers (sys_emscripten/ for the Wolfenstein
engines, sys_emscripten_jk/ for the Raven ones) because both hit the same trap.

Every one of these engines assumes that unloading a game DLL and loading it
again yields a module with FRESH STATICS. RTCW/ET say so outright in
VM_Restart() -- "DLL's can't be restarted in place", which is why it calls
VM_Free()+VM_Create() rather than reusing the handle -- and JK2/JKA rely on the
same thing across Sys_UnloadGame()/Sys_GetGameAPI() on each map load.

Emscripten breaks that contract silently:
  - dlopenInternal() looks the library up in LDSO.loadedLibsByName and, if it is
    already there, merely bumps refcount and hands back the SAME instance;
  - libraries load with nodelete:true (refcount = Infinity), so dlclose() can
    never drop it.
So statics survive what the engine believes is a fresh load.

That is not academic. In RTCW-SP it crashed every /loadgame and every
map_restart: ai_cast keeps `static bot_state_t *botstates[]` pointing into
G_Alloc's pool; on restart G_InitMemory() resets allocPoint to 0 but the stale
pointers survive, so AICast_SetupClient() sees a non-NULL botstates[client],
skips its memset, reads a garbage bs->inuse and returns early WITHOUT setting
cs->bs -- and AICast_UpdateBattleInventory() then dereferences cs->bs->entitynum
("memory access out of bounds").

Approach: dlopen a *unique path* per load. Emscripten's cache is keyed by name,
so a name it has never seen misses, and the module is genuinely instantiated
afresh -- zeroed statics, constructors re-run. We copy the module to that path
and unlink it immediately afterwards (dlopen reads it synchronously), so MEMFS
does not grow.

Rejected alternative: deleting the entries from LDSO.loadedLibsByName /
loadedLibsByHandle directly. It desynchronises emscripten's own bookkeeping and
the next dlsym aborts with "Tried to dlsym() from an unopened handle".

Cost: the superseded instance's code and table entries leak. That is inherent to
emscripten's nodelete (there is no true unload) and is bounded by how rarely maps
restart.

Returns NULL on failure; callers fall back to a plain dlopen of the original
path, which is still correct for a *first* load.
===========================================================================
*/
#include <stdio.h>
#include <string.h>
#include <dlfcn.h>

// The Raven builds compile every .c as C++ (em++ -x c++), so force C linkage or
// the definition mangles while sys_jk.cpp's extern "C" declaration does not.
#ifdef __cplusplus
extern "C" {
#endif

void *idt3_dlopen_fresh( const char *path ) {
	static int seq = 0;
	static char copyBuf[64 * 1024];
	char uniq[1024];
	const char *slash, *base;
	int dirLen;
	FILE *src, *dst;
	size_t n;
	void *handle;

	if ( !path || !*path ) {
		return NULL;
	}

	slash = strrchr( path, '/' );
	base = slash ? slash + 1 : path;
	dirLen = slash ? (int)( slash - path ) : 0;

	// Sibling of the original so any relative lookups still resolve; leading '.'
	// keeps it out of the engine's own directory listings.
	snprintf( uniq, sizeof( uniq ), "%.*s/.idt3.%d.%s", dirLen, path, seq++, base );

	src = fopen( path, "rb" );
	if ( !src ) {
		return NULL;
	}
	dst = fopen( uniq, "wb" );
	if ( !dst ) {
		fclose( src );
		return NULL;
	}
	while ( ( n = fread( copyBuf, 1, sizeof( copyBuf ), src ) ) > 0 ) {
		if ( fwrite( copyBuf, 1, n, dst ) != n ) {
			fclose( dst );
			fclose( src );
			remove( uniq );
			return NULL;
		}
	}
	fclose( dst );
	fclose( src );

	handle = dlopen( uniq, RTLD_NOW );
	remove( uniq );          // dlopen has already read it
	return handle;
}

#ifdef __cplusplus
}
#endif
