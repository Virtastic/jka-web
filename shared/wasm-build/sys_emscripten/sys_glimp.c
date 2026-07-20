/*
===========================================================================
idTech3-web — GLimp_* (WebGL2 context) and IN_* (HTML5 input) for RTCW-SP.
NEW code; reproduces the renderer's GLimp contract and the client's input
model against Emscripten's WebGL + HTML5 event APIs.
===========================================================================
*/
#include <emscripten.h>
#include <emscripten/html5.h>
#include <GL/gl.h>
#include <string.h>

#include "../renderer/tr_local.h"   // glConfig, qgl* (linked → gl*), ri
#include "keys.h"                    // K_* codes

// Renderer-side ARB/EXT function pointers we may enable (defined in tr_init.c).
extern void ( APIENTRY * qglMultiTexCoord2fARB )( GLenum texture, GLfloat s, GLfloat t );
extern void ( APIENTRY * qglActiveTextureARB )( GLenum texture );
extern void ( APIENTRY * qglClientActiveTextureARB )( GLenum texture );
extern void ( APIENTRY * qglLockArraysEXT )( GLint, GLint );
extern void ( APIENTRY * qglUnlockArraysEXT )( void );

// Platform → engine event push (defined in sys_emscripten.c).
void Sys_QueEvent( int time, sysEventType_t type, int value, int value2, int ptrLength, void *ptr );

static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE glContext = 0;
static qboolean mouseActive = qfalse;
static const char *CANVAS = "#canvas";

// ==========================================================================
// GLimp
// ==========================================================================
void GLimp_Init( void ) {
	EmscriptenWebGLContextAttributes attrs;
	int w = 1024, h = 768;
	float aspect = (float)w / (float)h;

	// Resolve the requested video mode through the renderer's mode table.
	if ( !R_GetModeInfo( &w, &h, &aspect, Cvar_VariableIntegerValue( "r_mode" ) ) ) {
		w = 1024; h = 768; aspect = (float)w / (float)h;
	}

	// idTech3-web: r_mode 3 (the default) is 640x480, and the canvas is object-fit:contain
	// + image-rendering:auto in the page — so that 640x480 backing store gets SMOOTHLY
	// UPSCALED to the browser window, i.e. a soft/blurry image on any modern display. Render
	// at the actual displayed device-pixel resolution instead. Keep 4:3 (these are 2001 4:3
	// games; the 2D HUD/menus assume it) — the page letterboxes to 4:3 anyway. r_mode -1 /
	// an explicit r_mode still wins (the user can override), so only auto-size at the default.
	if ( Cvar_VariableIntegerValue( "r_mode" ) == 3 ) {
		// Height-limited 4:3 fit in the (landscape) viewport, at device pixels. Use the live
		// viewport size — emscripten_get_element_css_size reports the 640x480 default here.
		int rh = EM_ASM_INT({
			var dpr = window.devicePixelRatio || 1;
			var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 768;
			var r = Math.round(vh * dpr);
			if ( r > 1200 ) r = 1200;               // cap fill cost (crisp on ~1080p; users can set r_mode)
			if ( r < 480 ) r = 480;
			return r;
		});
		w = ( rh * 4 ) / 3; h = rh; aspect = 4.0f / 3.0f;
	}

	emscripten_webgl_init_context_attributes( &attrs );
	attrs.majorVersion = 1;          // WebGL1 — LEGACY_GL_EMULATION (fixed-function) only initializes on WebGL1 contexts
	attrs.minorVersion = 0;
	attrs.alpha = EM_FALSE;
	attrs.depth = EM_TRUE;
	attrs.stencil = EM_TRUE;
	attrs.antialias = EM_FALSE;
	attrs.preserveDrawingBuffer = EM_FALSE;
	attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
	attrs.enableExtensionsByDefault = EM_TRUE;

	glContext = emscripten_webgl_create_context( CANVAS, &attrs );
	if ( glContext <= 0 ) {
		ri.Error( ERR_FATAL, "GLimp_Init: could not create WebGL2 context (%d)\n", (int)glContext );
		return;
	}
	emscripten_webgl_make_context_current( glContext );

	// LEGACY_GL_EMULATION's fixed-function state (GLImmediate/GLEmulation) is only
	// initialized by Browser.createContext, not the html5.h context API - run it here.
	EM_ASM({
		if (typeof Browser !== 'undefined') Browser.useWebGL = true;
		/* GLEmulation's postset may have run init() at page load with no GL context
		   (early-out after setting initted) — force a full init against the live context. */
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
	});
	emscripten_set_canvas_element_size( CANVAS, w, h );

	memset( &glConfig, 0, sizeof( glConfig ) );
	glConfig.vidWidth = w;
	glConfig.vidHeight = h;
	glConfig.windowAspect = aspect;
	glConfig.colorBits = 32;
	glConfig.depthBits = 24;
	glConfig.stencilBits = 8;
	glConfig.displayFrequency = 60;
	glConfig.isFullscreen = qfalse;
	glConfig.stereoEnabled = qfalse;
	glConfig.smpActive = qfalse;
	glConfig.deviceSupportsGamma = qfalse;   // no gamma ramp in the browser
	glConfig.textureCompression = TC_NONE;
	glConfig.textureEnvAddAvailable = qtrue;
	glConfig.anisotropicAvailable = qfalse;
	glConfig.maxAnisotropy = 0;

	Q_strncpyz( glConfig.vendor_string, (const char *)qglGetString( GL_VENDOR ), sizeof( glConfig.vendor_string ) );
	Q_strncpyz( glConfig.renderer_string, (const char *)qglGetString( GL_RENDERER ), sizeof( glConfig.renderer_string ) );
	Q_strncpyz( glConfig.version_string, (const char *)qglGetString( GL_VERSION ), sizeof( glConfig.version_string ) );
	Q_strncpyz( glConfig.extensions_string, (const char *)qglGetString( GL_EXTENSIONS ), sizeof( glConfig.extensions_string ) );

	// idTech3-web: LEGACY_GL_EMULATION does implement the multitexture entry points
	// its TexEnvJIT needs (glActiveTexture / glClientActiveTexture + per-unit
	// glTexCoordPointer), which is the path r_primitives 2 uses. Enabling it lets
	// diffuse+lightmap combine in one pass instead of relying on the two-pass
	// blend fallback (which rendered world surfaces as bare lightmap).
	// qglMultiTexCoord2fARB stays NULL: it is only used by R_ArrayElementDiscrete
	// (r_primitives 3), which we never take, and glemu has no glMultiTexCoord2f.
	qglMultiTexCoord2fARB = NULL;
	qglActiveTextureARB = glActiveTexture;
	qglClientActiveTextureARB = glClientActiveTexture;
	// No compiled vertex arrays under WebGL.
	qglLockArraysEXT = NULL;
	qglUnlockArraysEXT = NULL;
	glConfig.maxActiveTextures = 2;

	ri.Printf( PRINT_ALL, "GLimp_Init: WebGL2 %dx%d — %s\n", w, h, glConfig.renderer_string );

	// gl_stubs.c no-ops glArrayElement (immediate mode); without compiled vertex
	// arrays the renderer defaults to that path (r_primitives 1) and every vertex
	// vanishes. Force the plain glDrawElements path, which LEGACY_GL emulates.
	ri.Cvar_Set( "r_primitives", "2" );
}

void GLimp_EndFrame( void ) {
	// The browser presents the default framebuffer automatically after the RAF
	// callback returns; there is no explicit swap. A flush keeps ordering sane.
	qglFlush();
}

void GLimp_Shutdown( void ) {
	if ( glContext > 0 ) {
		emscripten_webgl_destroy_context( glContext );
		glContext = 0;
	}
	memset( &glConfig, 0, sizeof( glConfig ) );
}

void GLimp_SetGamma( unsigned char red[256], unsigned char green[256], unsigned char blue[256] ) {
	// No gamma-ramp control in WebGL.
}

void GLimp_LogComment( char *comment ) { }

// Single-threaded: no SMP render thread.
qboolean GLimp_SpawnRenderThread( void ( *function )( void ) ) { return qfalse; }
void *GLimp_RendererSleep( void ) { return NULL; }
void GLimp_FrontEndSleep( void ) { }
void GLimp_WakeRenderer( void *data ) { }
void GLimp_SwitchFullscreen( qboolean fullscreen ) { }

// ==========================================================================
// Input — HTML5 callbacks → Sys_QueEvent
// ==========================================================================
static int MapBrowserKey( const char *code, unsigned long which ) {
	// Prefer DOM `code` (physical key) for game keys; fall back to keyCode.
	if ( !strcmp( code, "Escape" ) ) return K_ESCAPE;
	if ( !strcmp( code, "Enter" ) || !strcmp( code, "NumpadEnter" ) ) return K_ENTER;
	if ( !strcmp( code, "Tab" ) ) return K_TAB;
	if ( !strcmp( code, "Space" ) ) return K_SPACE;
	if ( !strcmp( code, "Backspace" ) ) return K_BACKSPACE;
	if ( !strcmp( code, "ArrowUp" ) ) return K_UPARROW;
	if ( !strcmp( code, "ArrowDown" ) ) return K_DOWNARROW;
	if ( !strcmp( code, "ArrowLeft" ) ) return K_LEFTARROW;
	if ( !strcmp( code, "ArrowRight" ) ) return K_RIGHTARROW;
	if ( !strncmp( code, "Alt", 3 ) ) return K_ALT;
	if ( !strncmp( code, "Control", 7 ) ) return K_CTRL;
	if ( !strncmp( code, "Shift", 5 ) ) return K_SHIFT;
	if ( !strcmp( code, "Insert" ) ) return K_INS;
	if ( !strcmp( code, "Delete" ) ) return K_DEL;
	if ( !strcmp( code, "PageDown" ) ) return K_PGDN;
	if ( !strcmp( code, "PageUp" ) ) return K_PGUP;
	if ( !strcmp( code, "Home" ) ) return K_HOME;
	if ( !strcmp( code, "End" ) ) return K_END;
	// Grave/backtick: default.cfg binds ` and ~ to "toggleconsole".
	if ( !strcmp( code, "Backquote" ) ) return '`';
	if ( !strcmp( code, "Minus" ) ) return '-';
	if ( !strcmp( code, "Equal" ) ) return '=';
	if ( !strcmp( code, "BracketLeft" ) ) return '[';
	if ( !strcmp( code, "BracketRight" ) ) return ']';
	if ( !strcmp( code, "Semicolon" ) ) return ';';
	if ( !strcmp( code, "Quote" ) ) return '\'';
	if ( !strcmp( code, "Comma" ) ) return ',';
	if ( !strcmp( code, "Period" ) ) return '.';
	if ( !strcmp( code, "Slash" ) ) return '/';
	if ( !strcmp( code, "Backslash" ) ) return '\\';
	if ( code[0] == 'F' && code[1] >= '1' && code[1] <= '9' ) {
		int n = atoi( code + 1 );
		if ( n >= 1 && n <= 12 ) return K_F1 + ( n - 1 );
	}
	// Letter / digit physical keys → lowercase ascii.
	if ( !strncmp( code, "Key", 3 ) && code[3] ) return tolower( code[3] );
	if ( !strncmp( code, "Digit", 5 ) && code[5] ) return code[5];
	// Fall back to the ascii-ish keyCode for the rest.
	if ( which >= 32 && which < 128 ) return tolower( (int)which );
	return 0;
}

static EM_BOOL OnKey( int eventType, const EmscriptenKeyboardEvent *e, void *ud ) {
	int down = ( eventType == EMSCRIPTEN_EVENT_KEYDOWN );
	int key = MapBrowserKey( e->code, e->which );
	if ( key ) {
		Sys_QueEvent( 0, SE_KEY, key, down, 0, NULL );
	}
	// Printable char events for text entry / console.
	if ( down && e->key[0] && !e->key[1] && (unsigned char)e->key[0] >= 32 ) {
		Sys_QueEvent( 0, SE_CHAR, (unsigned char)e->key[0], 0, 0, NULL );
	}
	// Swallow browser defaults for game keys (Tab, arrows, etc.).
	return EM_TRUE;
}

static EM_BOOL OnMouseMove( int eventType, const EmscriptenMouseEvent *e, void *ud ) {
	if ( mouseActive ) {
		if ( e->movementX || e->movementY ) {
			Sys_QueEvent( 0, SE_MOUSE, e->movementX, e->movementY, 0, NULL );
		}
	}
	return EM_TRUE;
}

static EM_BOOL OnMouseButton( int eventType, const EmscriptenMouseEvent *e, void *ud ) {
	int down = ( eventType == EMSCRIPTEN_EVENT_MOUSEDOWN );
	int key;
	switch ( e->button ) {
		case 0: key = K_MOUSE1; break;
		case 1: key = K_MOUSE3; break;
		case 2: key = K_MOUSE2; break;
		case 3: key = K_MOUSE4; break;
		case 4: key = K_MOUSE5; break;
		default: return EM_TRUE;
	}
	Sys_QueEvent( 0, SE_KEY, key, down, 0, NULL );
	// Request pointer lock on first in-canvas click.
	if ( down && mouseActive ) {
		emscripten_request_pointerlock( CANVAS, EM_TRUE );
	}
	return EM_TRUE;
}

static EM_BOOL OnWheel( int eventType, const EmscriptenWheelEvent *e, void *ud ) {
	int key = ( e->deltaY < 0 ) ? K_MWHEELUP : K_MWHEELDOWN;
	Sys_QueEvent( 0, SE_KEY, key, qtrue, 0, NULL );
	Sys_QueEvent( 0, SE_KEY, key, qfalse, 0, NULL );
	return EM_TRUE;
}

void IN_Init( void ) {
	emscripten_set_keydown_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnKey );
	emscripten_set_keyup_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnKey );
	// idTech3-web: register mouse on the window, not "#canvas". The canvas selector
	// never delivered any events here (verified: zero OnMouseMove/OnMouseButton
	// callbacks), leaving the mouse completely dead — menus unusable and no look
	// control. The keyboard already uses the window target and works.
	emscripten_set_mousemove_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnMouseMove );
	emscripten_set_mousedown_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnMouseButton );
	emscripten_set_mouseup_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnMouseButton );
	emscripten_set_wheel_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnWheel );
	mouseActive = qtrue;
}

void IN_Shutdown( void ) {
	mouseActive = qfalse;
}

void IN_Frame( void ) { }

void IN_Activate( void ) { }

void IN_ClearStates( void ) { }

void IN_ActivateMouse( void )   { mouseActive = qtrue; }
void IN_DeactivateMouse( void ) {
	mouseActive = qfalse;
	emscripten_exit_pointerlock();
}
