/*
 * idTech3-web — JKA-specific platform entry points: the symbols JK2's shared platform
 * layer doesn't cover because JKA either changed their signatures or added them
 * outright. Everything here is a real implementation of the win32 original's contract
 * except where a comment says otherwise and explains why the browser has no equivalent.
 */
#include "../server/exe_headers.h"

#include <sys/stat.h>
#include <sys/types.h>
#include <stdio.h>
#include <errno.h>

// idTech3-web: S_StartSound / S_AddLoopingSound are now provided by the real
// client/snd_dma.cpp (sound is compiled in — see build-jka.sh), so their stubs
// were removed here to avoid duplicate-symbol link errors.

// --- Platform asset-cache helpers (JKA copies loose files out of a CD path) -------
//
// Both are reachable only through qcommon/files_pc.cpp's fs_copyfiles path, i.e. when
// fs_cdpath is set and fs_copyfiles is 1 or 2 — the retail "run from CD, cache to hard
// disk" install. A browser has no cdpath, so in practice neither fires; they used to be
// hard-coded to qfalse/qtrue for exactly that reason. They are implemented for real now
// because "unreachable" is not the same as "correct": with MEMFS/IDBFS mounted under
// /jka the copy is perfectly expressible in POSIX, and a stub that lies (the old
// Sys_FileOutOfDate answered "always out of date") would corrupt the cache the moment
// someone did point fs_cdpath at a mounted directory.

/*
==================
Sys_FileOutOfDate

win32 compares the two FILETIMEs with a ~2s slop because FAT timestamps are only
accurate to 2 seconds. st_mtime is already in whole seconds, so the same slop is
literally "differ by more than 2". Returns qtrue => caller should re-copy the source
over the destination.
==================
*/
qboolean Sys_FileOutOfDate( LPCSTR psFinalFileName /* dest */, LPCSTR psDataFileName /* src */ )
{
	struct stat stFinal, stData;

	if ( stat( psFinalFileName, &stFinal ) == 0 && stat( psDataFileName, &stData ) == 0 )
	{
		time_t diff = stFinal.st_mtime - stData.st_mtime;
		if ( diff < 0 ) {
			diff = -diff;
		}
		if ( diff <= 2 ) {
			return qfalse;	// not out of date, ie use it
		}
		return qtrue;		// copy a replacement version over it
	}

	// Same developer-only sanity check as win32: a file that exists locally but not at
	// the source is suspicious enough to mention, but not an error.
	if ( com_developer->integer && stat( psDataFileName, &stData ) != 0 ) {
		Com_Printf( "Sys_FileOutOfDate: reading %s but it's not on the net!\n", psFinalFileName );
	}

	return qfalse;
}

/*
==================
Sys_CopyFile

win32 is CopyFile( src, dst, bFailIfExists = !bOverWrite ), and on failure with
bOverWrite it clears the destination's read-only attribute and retries. The POSIX
equivalent of that attribute dance is chmod( S_IWUSR ); the "fail if exists" flag maps
onto an explicit existence test, since fopen has no such mode for the truncate case.
==================
*/
qboolean Sys_CopyFile( LPCSTR lpExistingFileName, LPCSTR lpNewFileName, qboolean bOverWrite )
{
	struct stat st;
	FILE *fSrc, *fDst;
	char buf[64 * 1024];
	size_t nRead;
	qboolean bOk = qtrue;

	if ( !bOverWrite && stat( lpNewFileName, &st ) == 0 ) {
		return qfalse;		// exists and we were told not to clobber it
	}

	fSrc = fopen( lpExistingFileName, "rb" );
	if ( !fSrc ) {
		return qfalse;
	}

	fDst = fopen( lpNewFileName, "wb" );
	if ( !fDst && bOverWrite && errno == EACCES ) {
		// read-only destination: win32 strips FILE_ATTRIBUTE_READONLY and retries
		if ( stat( lpNewFileName, &st ) == 0 ) {
			chmod( lpNewFileName, st.st_mode | S_IWUSR );
			fDst = fopen( lpNewFileName, "wb" );
		}
	}
	if ( !fDst ) {
		fclose( fSrc );
		return qfalse;
	}

	while ( ( nRead = fread( buf, 1, sizeof( buf ), fSrc ) ) > 0 ) {
		if ( fwrite( buf, 1, nRead, fDst ) != nRead ) {
			bOk = qfalse;
			break;
		}
	}
	if ( ferror( fSrc ) ) {
		bOk = qfalse;
	}

	fclose( fDst );
	fclose( fSrc );

	if ( !bOk ) {
		remove( lpNewFileName );	// never leave a half-written cache entry behind
	}
	return bOk;
}

// --- Dynamic-glow driver workaround ---------------------------------------
//
// NOT a stub: false is the correct value here. win32 (win_glimp.cpp:1361) sets this
// only after detecting an ATI driver whose GL_TEXTURE_RECTANGLE path is broken, and
// the flag is read from exactly two places, both inside r_DynamicGlow (tr_backend.cpp
// and tr_init.cpp). WebGL has no rectangle-texture target and no such driver bug, so
// the "not the broken ATI driver" answer is the faithful one.
bool g_bTextureRectangleHack = false;

// --- GL display lists ------------------------------------------------------
//
// Genuinely unimplementable, and deliberately confined: JKA uses display lists in ONE
// feature, r_DynamicGlow, to replay the ARB_fragment_program blur passes
// (tr_init.cpp builds them, tr_backend.cpp:1681 calls them). WebGL/GLES2 has neither
// display lists nor ARB assembly shaders, so the feature cannot be reproduced without
// rewriting it — which would stop being a 1:1 port of Raven's renderer.
//
// r_DynamicGlow is CVAR_ARCHIVE "0" in the retail game (tr_init.cpp:1107), so the
// browser build and a stock desktop install take the same code path; only a player who
// switches the console variable on would see a difference (there, no glow). Every other
// 2D/HUD/font path in JKA draws through the normal immediate-mode calls, which
// LEGACY_GL_EMULATION does implement.
extern "C" void glDeleteLists( unsigned int, int ) { }
extern "C" void glEndList( void ) { }
extern "C" unsigned int glGenLists( int ) { return 0; }
extern "C" void glNewList( unsigned int, unsigned int ) { }
