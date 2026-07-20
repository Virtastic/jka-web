/*
===========================================================================
idTech3-web — fixed-function GL entry points that Emscripten's
LEGACY_GL_EMULATION does not export, plus a few engine functions temporarily
stubbed for the M1 boot milestone.
===========================================================================
*/
#include <GL/gl.h>
#include "q_shared.h"
#include "qcommon.h"

// --- GL fixed-function stubs ---------------------------------------------
// glCallList: display lists. RTCW uses one for the console background on some
// paths; a no-op is safe (nothing is pre-recorded under emscripten).
void glCallList( GLuint list ) { (void)list; }

// glArrayElement: immediate-mode indexed vertex. The renderer's hot paths use
// vertex arrays / DrawElements; this appears only in a legacy fallback. A no-op
// keeps the link clean for M1 (revisit if a fallback path is ever taken).
void glArrayElement( GLint i ) { (void)i; }

// gl_NormalFontBase: display-list base for the bitmap console font. Lived in the
// win32/unix glimp we replaced; Wolf:ET's renderer (tr_main.c) references it via
// qglListBase(). Display lists are no-ops under WebGL, so 0 is fine — the console
// font just won't draw via that legacy path. (RTCW never calls it.)
int gl_NormalFontBase = 0;

// --- Cutscene camera — TEMPORARY M1 stubs --------------------------------
// The real implementations live in games/rtcw-sp/src/splines/splines.cpp (C++).
// Integrating the splines library is deferred until in-game cinematics are
// exercised; stubs let the menu/boot path link and run. Signatures match the
// externs in client/cl_cgame.c.
qboolean loadCamera( int camNum, const char *name ) { (void)camNum; (void)name; return qfalse; }
void     startCamera( int camNum, int time ) { (void)camNum; (void)time; }
qboolean getCameraInfo( int camNum, int time, vec3_t *origin, vec3_t *angles, float *fov ) {
	(void)camNum; (void)time; (void)origin; (void)angles; (void)fov;
	return qfalse;
}
