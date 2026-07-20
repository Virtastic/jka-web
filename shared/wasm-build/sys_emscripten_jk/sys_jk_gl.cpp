/*
===========================================================================
idTech3-web — JK2/JKA GLimp_* (WebGL1), IN_* (HTML5 input), SNDDMA_* (silent
stub for first boot), entry point + RAF frame pump, and native GL stubs.
NEW code (C++). Companion to sys_jk.cpp.
===========================================================================
*/
#include <emscripten.h>
#include <emscripten/html5.h>
#include <GL/gl.h>
#include <string.h>

// C++ engine headers — normal C++ linkage (they pull STL / templated types).
#include "../server/exe_headers.h"  // qcommon: sysEvent_t, SE_*, Com_*
#include "../renderer/tr_local.h"   // glConfig, qgl*, ri, R_GetModeInfo
#include "keycodes.h"

void Sys_QueEvent( int time, sysEventType_t type, int value, int value2, int ptrLength, void *ptr );
void Com_Frame( void );
void Com_Init( char *commandLine );
void IN_Init( void );
void IN_Frame( void );

// JKA deltas vs JK2: the renderer calls Cvar_Get/Com_* directly (no `ri.` refimport),
// R_GetModeInfo is 3-arg (no windowAspect), glconfig_t has no windowAspect field, and
// key codes use the A_* prefix instead of K_*. Map them so the shared logic below works.
#ifdef IDT3_JKA
  #define IDT3_RI_ERROR   Com_Error
  #define IDT3_RI_PRINTF  Com_Printf
  #define IDT3_RI_CVARGET Cvar_Get
  #define IDT3_RI_CVARSET Cvar_Set
  #define K_ESCAPE A_ESCAPE
  #define K_ENTER A_ENTER
  #define K_TAB A_TAB
  #define K_SPACE A_SPACE
  #define K_BACKSPACE A_BACKSPACE
  #define K_UPARROW A_CURSOR_UP
  #define K_DOWNARROW A_CURSOR_DOWN
  #define K_LEFTARROW A_CURSOR_LEFT
  #define K_RIGHTARROW A_CURSOR_RIGHT
  #define K_SHIFT A_SHIFT
  #define K_CTRL A_CTRL
  #define K_ALT A_ALT
  #define K_MOUSE1 A_MOUSE1
  #define K_MOUSE2 A_MOUSE2
  #define K_MOUSE3 A_MOUSE3
  #define K_MWHEELUP A_MWHEELUP
  #define K_MWHEELDOWN A_MWHEELDOWN
#else
  #define IDT3_RI_ERROR   ri.Error
  #define IDT3_RI_PRINTF  ri.Printf
  #define IDT3_RI_CVARGET ri.Cvar_Get
  #define IDT3_RI_CVARSET ri.Cvar_Set
#endif

static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE glCtx = 0;
static qboolean mouseActive = qfalse;
static const char *CANVAS = "#canvas";

// ==========================================================================
// GLimp
// ==========================================================================
void GLimp_Init( void ) {
	EmscriptenWebGLContextAttributes attrs;
	int w = 1024, h = 768; float aspect = (float)w / (float)h;
	int rmode;

#ifdef IDT3_JKA
	rmode = Cvar_Get( "r_mode", "4", 0 )->integer;
	if ( !R_GetModeInfo( &w, &h, rmode ) ) { w = 1024; h = 768; }
	aspect = (float)w / (float)h;
#else
	// idTech3-web: JK2's renderer registers r_mode with default "3" (JKA uses "4"); match it
	// here so this pre-read doesn't create the LATCH cvar with a different default and trip
	// "cvar r_mode given initial values 3 and 4". The display-resolution override below makes
	// the exact mode-table entry moot anyway.
	rmode = ri.Cvar_Get( "r_mode", "3", 0 )->integer;
	if ( !R_GetModeInfo( &w, &h, &aspect, rmode ) ) {
		w = 1024; h = 768; aspect = (float)w / (float)h;
	}
#endif

	// idTech3-web: r_mode 4 (the JK default) is 800x600; the page upscales it (soft/blurry
	// on modern displays). At the default, render at the real display resolution instead,
	// keeping 4:3 (these are 4:3-era games). See shared/sys_emscripten/sys_glimp.c for detail.
	if ( rmode == 4 ) {
		int rh = EM_ASM_INT({
			var dpr = window.devicePixelRatio || 1;
			var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 768;
			var r = Math.round(vh * dpr);
			if ( r > 1200 ) r = 1200;
			if ( r < 480 ) r = 480;
			return r;
		});
		w = ( rh * 4 ) / 3; h = rh; aspect = (float)w / (float)h;
	}
	emscripten_webgl_init_context_attributes( &attrs );
	// WebGL1, NOT WebGL2. These are fixed-function renderers, so they depend on
	// -sLEGACY_GL_EMULATION, and emscripten's GLImmediate only initializes on a
	// WebGL1 context. Asking for 2 booted "fine" and then had no fixed-function
	// pipeline at all: glGet returned nothing (GL_MAX_TEXTURE_SIZE: 0,
	// GL_MAX_ACTIVE_TEXTURES_ARB: 1) and the first draw died in JS. Same lesson the
	// Wolfenstein layer already learned — see sys_emscripten/sys_glimp.c.
	attrs.majorVersion = 1; attrs.minorVersion = 0;
	attrs.alpha = EM_FALSE; attrs.depth = EM_TRUE; attrs.stencil = EM_TRUE;
	attrs.antialias = EM_FALSE; attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
	attrs.enableExtensionsByDefault = EM_TRUE;
	glCtx = emscripten_webgl_create_context( CANVAS, &attrs );
	if ( glCtx <= 0 ) { IDT3_RI_ERROR( ERR_FATAL, "GLimp_Init: no WebGL1 context (%d)\n", (int)glCtx ); return; }
	emscripten_webgl_make_context_current( glCtx );

	// LEGACY_GL_EMULATION's fixed-function state (GLImmediate/GLEmulation) is only
	// initialized by Browser.createContext, not by the html5.h context API — so with
	// the html5 path it stays half-initialized and the first draw dies in JS with
	// "Cannot set properties of null". Force a real init against the live context.
	// This mirrors sys_emscripten/sys_glimp.c; see it for the full reasoning.
	EM_ASM({
		if (typeof Browser !== 'undefined') Browser.useWebGL = true;
		/* GLEmulation's postset may have run init() at page load with no GL context
		   (early-out after setting initted) — force a full init against the live one. */
		if (typeof GLImmediate !== 'undefined' && !GLImmediate.clientColor) {
			GLImmediate.initted = false;
			GLImmediate.init();
		}
		/* temp vertex buffers are per-context; a vid_restart context misses them */
		if (typeof GL !== 'undefined' && GL.currentContext && !GL.currentContext.tempVertexBufferCounters1) {
			GL.generateTempBuffers(true, GL.currentContext);
		}
		/* GLImmediate.setupHooks() replaced these module-scope functions with closures
		   that lack the .sig libdylink needs for addFunction() at dlopen time. */
		if (typeof _glActiveTexture === 'function' && !_glActiveTexture.sig) _glActiveTexture.sig = 'vi';
		if (typeof _glEnable === 'function' && !_glEnable.sig) _glEnable.sig = 'vi';
		if (typeof _glDisable === 'function' && !_glDisable.sig) _glDisable.sig = 'vi';
		if (typeof _glGetIntegerv === 'function' && !_glGetIntegerv.sig) _glGetIntegerv.sig = 'vii';
		if (typeof _glTexEnvi === 'function' && !_glTexEnvi.sig) _glTexEnvi.sig = 'viii';
		if (typeof _glTexEnvf === 'function' && !_glTexEnvf.sig) _glTexEnvf.sig = 'viif';
		if (typeof _glTexEnvfv === 'function' && !_glTexEnvfv.sig) _glTexEnvfv.sig = 'viii';
		if (typeof _glGetTexEnviv === 'function' && !_glGetTexEnviv.sig) _glGetTexEnviv.sig = 'viii';
		if (typeof _glGetTexEnvfv === 'function' && !_glGetTexEnvfv.sig) _glGetTexEnvfv.sig = 'viii';
		/* idTech3-web: the Raven renderer sees EXT_texture_filter_anisotropic in the
		   GL_EXTENSIONS string and sets glConfig.textureFilterAnisotropicAvailable, then
		   calls glTexParameterf(GL_TEXTURE_MAX_ANISOTROPY_EXT,...) on every texture. But
		   WebGL only makes that pname valid AFTER getExtension() is called on the context;
		   without it every call was INVALID_ENUM (anisotropy silently off + per-texture
		   error spam). Activate it explicitly so anisotropic filtering actually works. */
		try { if (typeof GL !== 'undefined' && GL.currentContext && GL.currentContext.GLctx) {
			GL.currentContext.GLctx.getExtension('EXT_texture_filter_anisotropic') ||
			GL.currentContext.GLctx.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
			GL.currentContext.GLctx.getExtension('MOZ_EXT_texture_filter_anisotropic');
		} } catch (e) {}
	});

	emscripten_set_canvas_element_size( CANVAS, w, h );

	memset( &glConfig, 0, sizeof( glConfig ) );
	glConfig.vidWidth = w; glConfig.vidHeight = h;
#ifndef IDT3_JKA
	glConfig.windowAspect = aspect;   // JKA's glconfig_t has no windowAspect field
#else
	(void)aspect;
#endif
	glConfig.colorBits = 32; glConfig.depthBits = 24; glConfig.stencilBits = 8;
	glConfig.deviceSupportsGamma = qfalse;
	glConfig.textureCompression = TC_NONE;
	// idTech3-web: GL_CLAMP_TO_EDGE is core in WebGL1/GLES, always available. The Raven
	// renderer only maps GL_CLAMP -> GL_CLAMP_TO_EDGE when this flag is set (tr_image.cpp),
	// and its detection lived in the excluded win32 GL layer, so the flag stayed false and
	// raw GL_CLAMP (0x2900, invalid in WebGL) leaked through -> INVALID_ENUM + clamped
	// textures silently falling back to REPEAT (sky/HUD/lightmap edge-wrap artifacts).
	glConfig.clampToEdgeAvailable = qtrue;
	glConfig.vendor_string     = (const char *)qglGetString( GL_VENDOR );
	glConfig.renderer_string   = (const char *)qglGetString( GL_RENDERER );
	glConfig.version_string    = (const char *)qglGetString( GL_VERSION );
	glConfig.extensions_string = (const char *)qglGetString( GL_EXTENSIONS );

	// idTech3-web: the renderer only PRINTS glConfig.maxTextureSize (tr_init.cpp:890)
	// — filling it is the platform layer's job, exactly as the original win32 GLimp
	// does (win_glimp_console.cpp:195). We never did, so it stayed 0 from the memset
	// above and every texture-size clamp compared against zero.
	qglGetIntegerv( GL_MAX_TEXTURE_SIZE, &glConfig.maxTextureSize );
	if ( glConfig.maxTextureSize <= 0 ) {
		glConfig.maxTextureSize = 0;
	}

	// LEGACY_GL_EMULATION implements the multitexture entry points its TexEnvJIT
	// needs (glActiveTexture / glClientActiveTexture + per-unit glTexCoordPointer),
	// so diffuse+lightmap can combine in one pass instead of falling back to the
	// two-pass blend. qglMultiTexCoord2fARB stays NULL — glemu has no
	// glMultiTexCoord2f, and only the immediate-mode path would want it.
	qglMultiTexCoord2fARB = NULL;
	qglActiveTextureARB = glActiveTexture;
	qglClientActiveTextureARB = glClientActiveTexture;
	glConfig.maxActiveTextures = 2;
	// No compiled vertex arrays under WebGL.
	qglLockArraysEXT = NULL;
	qglUnlockArraysEXT = NULL;

	// idTech3-web: force the single-glDrawElements path.
	//
	// r_primitives defaults to 0, which means "2 if qglLockArraysEXT else 1"
	// (tr_init.cpp:918). WebGL has no compiled vertex arrays, so it picks 1 —
	// R_DrawStripElements(..., qglArrayElement) (tr_shade.cpp:218). glArrayElement is
	// immediate-mode; LEGACY_GL_EMULATION doesn't provide it and our sys_jk_stubs.cpp
	// no-ops it, so EVERY vertex vanished: the engine ran happily (RAF ticking,
	// gl.clear called ~120x/s, 5303 textures uploaded) and issued exactly ONE draw
	// call in two minutes — a perfectly black screen with no error anywhere.
	// Path 2 is plain glDrawElements, which glemu does emulate. Same fix and same
	// reasoning as the Wolfenstein layer (sys_emscripten/sys_glimp.c).
	IDT3_RI_CVARSET( "r_primitives", "2" );
#ifdef IDT3_JKA
	Com_Printf( "GLimp_Init: WebGL1 %dx%d\n", w, h );   // Com_Printf has no level arg
#else
	ri.Printf( PRINT_ALL, "GLimp_Init: WebGL1 %dx%d\n", w, h );
#endif
}

void GLimp_EndFrame( void ) { qglFlush(); }
void GLimp_Shutdown( void ) { if ( glCtx > 0 ) { emscripten_webgl_destroy_context( glCtx ); glCtx = 0; } }
void GLimp_SetGamma( unsigned char r[256], unsigned char g[256], unsigned char b[256] ) { }
void GLimp_LogComment( char *comment ) { }
qboolean GLimp_SpawnRenderThread( void (*function)( void ) ) { return qfalse; }
void *GLimp_RendererSleep( void ) { return NULL; }
void GLimp_FrontEndSleep( void ) { }
void GLimp_WakeRenderer( void *data ) { }

// ==========================================================================
// Input
// ==========================================================================
static int MapKey( const char *code, unsigned long which ) {
	if ( !strcmp( code, "Escape" ) ) return K_ESCAPE;
	if ( !strcmp( code, "Enter" ) || !strcmp( code, "NumpadEnter" ) ) return K_ENTER;
	if ( !strcmp( code, "Tab" ) ) return K_TAB;
	if ( !strcmp( code, "Space" ) ) return K_SPACE;
	if ( !strcmp( code, "Backspace" ) ) return K_BACKSPACE;
	if ( !strcmp( code, "ArrowUp" ) ) return K_UPARROW;
	if ( !strcmp( code, "ArrowDown" ) ) return K_DOWNARROW;
	if ( !strcmp( code, "ArrowLeft" ) ) return K_LEFTARROW;
	if ( !strcmp( code, "ArrowRight" ) ) return K_RIGHTARROW;
	if ( !strncmp( code, "Shift", 5 ) ) return K_SHIFT;
	if ( !strncmp( code, "Control", 7 ) ) return K_CTRL;
	if ( !strncmp( code, "Alt", 3 ) ) return K_ALT;
	if ( !strncmp( code, "Key", 3 ) && code[3] ) return tolower( code[3] );
	if ( !strncmp( code, "Digit", 5 ) && code[5] ) return code[5];
	// Punctuation the client checks as KEYS (not chars): Backquote toggles the
	// console (CL_KeyEvent special-cases '`'/'~'); the rest keep binds working.
	// Their DOM `which` codes are >= 128, so the ASCII fallback below misses them.
	if ( !strcmp( code, "Backquote" ) )    return '`';
	if ( !strcmp( code, "Minus" ) )        return '-';
	if ( !strcmp( code, "Equal" ) )        return '=';
	if ( !strcmp( code, "BracketLeft" ) )  return '[';
	if ( !strcmp( code, "BracketRight" ) ) return ']';
	if ( !strcmp( code, "Backslash" ) )    return '\\';
	if ( !strcmp( code, "Semicolon" ) )    return ';';
	if ( !strcmp( code, "Quote" ) )        return '\'';
	if ( !strcmp( code, "Comma" ) )        return ',';
	if ( !strcmp( code, "Period" ) )       return '.';
	if ( !strcmp( code, "Slash" ) )        return '/';
	if ( which >= 32 && which < 128 ) return tolower( (int)which );
	return 0;
}
static EM_BOOL OnKey( int t, const EmscriptenKeyboardEvent *e, void *u ) {
	int down = ( t == EMSCRIPTEN_EVENT_KEYDOWN );
	int k = MapKey( e->code, e->which );
	if ( k ) Sys_QueEvent( 0, SE_KEY, k, down, 0, NULL );
	if ( down && e->key[0] && !e->key[1] && (unsigned char)e->key[0] >= 32 )
		Sys_QueEvent( 0, SE_CHAR, (unsigned char)e->key[0], 0, 0, NULL );
	return EM_TRUE;
}
static EM_BOOL OnMove( int t, const EmscriptenMouseEvent *e, void *u ) {
	if ( mouseActive && ( e->movementX || e->movementY ) )
		Sys_QueEvent( 0, SE_MOUSE, e->movementX, e->movementY, 0, NULL );
	return EM_TRUE;
}
static EM_BOOL OnBtn( int t, const EmscriptenMouseEvent *e, void *u ) {
	int down = ( t == EMSCRIPTEN_EVENT_MOUSEDOWN ); int k;
	switch ( e->button ) { case 0: k = K_MOUSE1; break; case 1: k = K_MOUSE3; break;
		case 2: k = K_MOUSE2; break; default: return EM_TRUE; }
	Sys_QueEvent( 0, SE_KEY, k, down, 0, NULL );
	if ( down && mouseActive ) emscripten_request_pointerlock( CANVAS, EM_TRUE );
	return EM_TRUE;
}
static EM_BOOL OnWheel( int t, const EmscriptenWheelEvent *e, void *u ) {
	int k = ( e->deltaY < 0 ) ? K_MWHEELUP : K_MWHEELDOWN;
	Sys_QueEvent( 0, SE_KEY, k, qtrue, 0, NULL );
	Sys_QueEvent( 0, SE_KEY, k, qfalse, 0, NULL );
	return EM_TRUE;
}
void IN_Init( void ) {
	emscripten_set_keydown_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnKey );
	emscripten_set_keyup_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnKey );
	emscripten_set_mousemove_callback( CANVAS, NULL, EM_TRUE, OnMove );
	emscripten_set_mousedown_callback( CANVAS, NULL, EM_TRUE, OnBtn );
	emscripten_set_mouseup_callback( CANVAS, NULL, EM_TRUE, OnBtn );
	emscripten_set_wheel_callback( CANVAS, NULL, EM_TRUE, OnWheel );
	mouseActive = qtrue;
}
void IN_Shutdown( void ) { mouseActive = qfalse; }
void IN_Frame( void ) { }
void IN_Activate( void ) { }

// ==========================================================================
// Sound — the real Web Audio SNDDMA_* backend lives in sys_jk_snd.cpp now.
// ==========================================================================

// ==========================================================================
// Entry point
// ==========================================================================
static void Sys_Frame( void ) { IN_Frame(); Com_Frame(); }
extern "C" EMSCRIPTEN_KEEPALIVE void idt3_pump_frame( void ) { Sys_Frame(); }

int main( int argc, char **argv ) {
	static char commandLine[MAX_STRING_CHARS] = "";
	for ( int i = 1; i < argc; i++ ) {
		Q_strcat( commandLine, sizeof( commandLine ), argv[i] );
		Q_strcat( commandLine, sizeof( commandLine ), " " );
	}
	Com_Init( commandLine );
	IN_Init();
	emscripten_set_main_loop( Sys_Frame, 0, 1 );
	return 0;
}
