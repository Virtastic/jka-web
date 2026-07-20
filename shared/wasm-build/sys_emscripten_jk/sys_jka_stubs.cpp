/*
 * idTech3-web — JKA-specific stubs (symbols JK2's shared stub layer doesn't cover
 * because JKA changed their signatures or added them). Lets the JKA engine link
 * and boot to the menu; real subsystems (sound, cinematics, asset-copy) land later.
 */
#include "../server/exe_headers.h"

// idTech3-web: S_StartSound / S_AddLoopingSound are now provided by the real
// client/snd_dma.cpp (sound is compiled in — see build-jka.sh), so their stubs
// were removed here to avoid duplicate-symbol link errors.

// --- Platform asset-cache helpers (JKA copies loose files out of pk3s) -----
qboolean Sys_CopyFile( LPCSTR, LPCSTR, qboolean ) { return qfalse; }
qboolean Sys_FileOutOfDate( LPCSTR, LPCSTR ) { return qtrue; }

// --- Renderer global (set by a GL-extension probe we don't run) ------------
bool g_bTextureRectangleHack = false;

// --- Game import table: referenced by a couple of engine TUs; the real one is
//     populated in the game side module. A zeroed instance is fine pre-gameplay.
game_import_t gi;

// --- GL display lists (JKA font/2D paths; LEGACY_GL_EMULATION lacks them) ---
extern "C" void glDeleteLists( unsigned int, int ) { }
extern "C" void glEndList( void ) { }
extern "C" unsigned int glGenLists( int ) { return 0; }
extern "C" void glNewList( unsigned int, unsigned int ) { }
