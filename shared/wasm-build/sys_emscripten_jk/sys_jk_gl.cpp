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
  #define K_F1 A_F1
  #define K_F2 A_F2
  #define K_F3 A_F3
  #define K_F4 A_F4
  #define K_F5 A_F5
  #define K_F6 A_F6
  #define K_F7 A_F7
  #define K_F8 A_F8
  #define K_F9 A_F9
  #define K_F10 A_F10
  #define K_F11 A_F11
  #define K_F12 A_F12
  #define K_INS A_INSERT
  #define K_DEL A_DELETE
  #define K_HOME A_HOME
  #define K_END A_END
  #define K_PGUP A_PAGE_UP
  #define K_PGDN A_PAGE_DOWN
  #define K_PAUSE A_PAUSE
  #define K_CAPSLOCK A_CAPSLOCK
  #define K_KP_INS A_KP_0
  #define K_KP_END A_KP_1
  #define K_KP_DOWNARROW A_KP_2
  #define K_KP_PGDN A_KP_3
  #define K_KP_LEFTARROW A_KP_4
  #define K_KP_5 A_KP_5
  #define K_KP_RIGHTARROW A_KP_6
  #define K_KP_HOME A_KP_7
  #define K_KP_UPARROW A_KP_8
  #define K_KP_PGUP A_KP_9
  #define K_KP_PLUS A_KP_PLUS
  #define K_KP_MINUS A_KP_MINUS
  #define K_KP_ENTER A_KP_ENTER
  #define K_KP_DEL A_KP_PERIOD
#else
  #define IDT3_RI_ERROR   ri.Error
  #define IDT3_RI_PRINTF  ri.Printf
  #define IDT3_RI_CVARGET ri.Cvar_Get
  #define IDT3_RI_CVARSET ri.Cvar_Set
  /* JK2 keeps the classic q3 K_* names, so its keycodes.h already supplies K_F1..K_F12,
     K_INS/K_DEL/K_HOME/K_END/K_PGUP/K_PGDN, K_PAUSE and the K_KP_* set verbatim. */
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

	// idTech3-web: unless the user pinned a custom mode (r_mode -1), render at the FULL
	// viewport at device pixels — real aspect, no 4:3 pillarbox — under a ~4 MP pixel
	// budget (Module.__idt3_ss scales it for SSAA). Mirrors sys_emscripten/sys_glimp.c;
	// the old gate (rmode==4) also missed JK2 entirely (its default is 3), pinning it to
	// a CSS-stretched 640x480.
	if ( rmode != -1 ) {
		int packed = EM_ASM_INT({
			var dpr = window.devicePixelRatio || 1;
			var de = document.documentElement;
			var vw = window.innerWidth  || (de && de.clientWidth)  || 1280;
			var vh = window.innerHeight || (de && de.clientHeight) || 720;
			var ss = (typeof Module !== 'undefined' && Module.__idt3_ss > 0) ? Module.__idt3_ss : 1;
			var w = Math.max(320, Math.round(vw * dpr * ss));
			var h = Math.max(240, Math.round(vh * dpr * ss));
			var maxPix = Math.min(4.0e6 * ss * ss, 8.0e6);
			var scale = Math.sqrt(Math.min(1, maxPix / (w * h)));
			w = Math.max(320, (Math.floor(w * scale) >> 1) << 1);
			h = Math.max(240, (Math.floor(h * scale) >> 1) << 1);
			return (w << 16) | h;
		});
		w = ( packed >> 16 ) & 0xffff;
		h = packed & 0xffff;
		aspect = (float)w / (float)h;
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
	attrs.antialias = EM_TRUE;   // default-framebuffer MSAA — free edge quality
	attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
	attrs.enableExtensionsByDefault = EM_TRUE;
	// idTech3-web: the renderer NEVER clears the colour buffer. RB_BeginDrawingView sets
	// `clearBits = GL_DEPTH_BUFFER_BIT` and only ORs in GL_COLOR_BUFFER_BIT for r_fastsky
	// / portal / RDF_NOWORLDMODEL — because on desktop GL the backbuffer persists and the
	// skybox is assumed to repaint every pixel. WebGL does not offer that guarantee: with
	// preserveDrawingBuffer false the drawing buffer contents are UNDEFINED after the
	// compositor takes it, so any pixel the world does not fully repaint this frame comes
	// back as whatever the swap chain hands over — typically an older frame on a real
	// multi-buffered GPU, and zeroes under SwiftShader. That difference is why stale-frame
	// wash reproduces on hardware and not in the headless software captures.
	// Ask for a persistent buffer so the engine's "no colour clear" assumption holds.
	attrs.preserveDrawingBuffer = EM_TRUE;
	// idTech3-web: create the context ONCE and reuse it for the rest of the session.
	//
	// vid_restart (RE_Shutdown(qtrue) -> GLimp_Shutdown, then R_Init -> GLimp_Init) used to
	// destroy the context here and ask for a new one. That cannot work in a browser: a canvas
	// yields exactly one WebGL context for its lifetime, so after the destroy the re-create
	// left GL.currentContext null and the very next texture upload threw
	//     Uncaught TypeError: Cannot read properties of null (reading 'version')
	//         at _emscripten_glTexImage2D
	// i.e. vid_restart killed the renderer outright. That matters because vid_restart is not
	// an exotic path -- every video-settings change in the menu issues one, and so does the
	// page's own resize handling.
	//
	// Reusing the live context is also the only honest option for the attributes: WebGL fixes
	// them at creation, so a "new" context could not have applied changed MSAA/depth settings
	// anyway. Everything the engine expects a restart to redo -- re-uploading every texture,
	// re-running GL_SetDefaultState -- still happens, because that is renderer-side work.
	if ( glCtx <= 0 ) {
		glCtx = emscripten_webgl_create_context( CANVAS, &attrs );
		if ( glCtx <= 0 ) { IDT3_RI_ERROR( ERR_FATAL, "GLimp_Init: no WebGL1 context (%d)\n", (int)glCtx ); return; }
	}
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

	// idTech3-web: wipe the whole drawing buffer once, at the new size.
	//
	// The context is created with preserveDrawingBuffer (see above) because the Raven
	// renderer never clears the colour buffer -- it assumes the skybox repaints every
	// pixel. That assumption breaks across a vid_restart at a DIFFERENT resolution: any
	// region the new, smaller viewport does not cover keeps the OLD frame's pixels for
	// the rest of the session, which showed up as a bright stale strip down the right
	// edge after `vid_restart`. One clear at (re)init costs nothing and leaves no stale
	// region behind; a real device gets the same effect for free on a mode change.
	glViewport( 0, 0, w, h );
	glScissor( 0, 0, w, h );
	glClearColor( 0.0f, 0.0f, 0.0f, 1.0f );
	glClear( GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT );

	memset( &glConfig, 0, sizeof( glConfig ) );
	glConfig.vidWidth = w; glConfig.vidHeight = h;
#ifndef IDT3_JKA
	glConfig.windowAspect = aspect;   // JKA's glconfig_t has no windowAspect field
#else
	(void)aspect;
#endif
	glConfig.colorBits = 32; glConfig.depthBits = 24; glConfig.stencilBits = 8;
	// idTech3-web: the analogue of WG_CheckHardwareGamma() (win_gamma.cpp:24). That function
	// asks the platform whether it can set a gamma ramp, honours r_ignorehwgamma, and then
	// sanity-checks the ramp the driver handed back. Here the first question is always yes --
	// GLimp_SetGamma drives an SVG feComponentTransfer LUT in the compositor, which is the same
	// post-framebuffer stage a hardware ramp occupies -- and the sanity checks have no analogue,
	// because there is no prior ramp to read back and no crashed-with-bad-gamma state to repair.
	// r_ignorehwgamma is honoured exactly as the original does.
	//
	// This also decides which of the engine's TWO gamma paths runs. With it false the renderer
	// bakes the ramp into every texture at upload (R_LightScaleTexture) and the Brightness
	// slider does nothing until textures reload; with it true the ramp is applied at output,
	// which is what a desktop player gets. Ordering is already right for the switch: R_Register()
	// registers r_ignorehwgamma at tr_init.cpp:1398, InitOpenGL() (and so this) runs at :1409,
	// and R_InitImages() only uploads at :1411.
	//
	// tr.overbrightBits is unaffected: R_SetColorMappings also zeroes it when !isFullscreen, and
	// a canvas is never fullscreen, so it stays 0 either way -- the same value a windowed desktop
	// run gets.
	glConfig.deviceSupportsGamma =
		( r_ignorehwgamma && r_ignorehwgamma->integer ) ? qfalse : qtrue;
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

	// idTech3-web: GLW_InitExtensions() (win32/win_glimp.cpp:1010-1101) fills the remaining
	// glConfig capability fields. That function lives in the excluded win32 GL layer, so these
	// two stayed 0 from the memset above. Comparing our writes against the original's showed
	// them as the only ones still missing.
	//
	// maxTextureFilterAnisotropy was the damaging one, because tr_image.cpp:124 CLAMPS the
	// cvar down to it:
	//     if ( r_ext_texture_filter_anisotropic->value > glConfig.maxTextureFilterAnisotropy )
	//         Cvar_Set( "r_ext_texture_filter_anisotropic", va("%f", ...) );
	// With the field left at 0, the page's "+set r_ext_texture_filter_anisotropic 8" was
	// rewritten to 0 on the first texture upload, so anisotropic filtering was silently OFF —
	// the engine printed "anisotropic filtering: disabled (0.000000 of 0.000000)" even though
	// EXT_texture_filter_anisotropic is both advertised by the context AND explicitly activated
	// via getExtension() above. Textures were sampled with plain trilinear at grazing angles,
	// which is exactly the ground/wall shimmer you see walking down a corridor.
#define GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT 0x84FF	// matching win_glimp.cpp's own local define
	glConfig.maxTextureFilterAnisotropy = 0;
	glConfig.textureFilterAnisotropicAvailable = qfalse;
	if ( glConfig.extensions_string &&
	     strstr( glConfig.extensions_string, "EXT_texture_filter_anisotropic" ) ) {
		glConfig.textureFilterAnisotropicAvailable = qtrue;
		qglGetFloatv( GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT, &glConfig.maxTextureFilterAnisotropy );
		// The menu slider (ui_shared.cpp:4461) reads glConfig directly, but the original also
		// publishes the cap as a cvar; keep that so a stale archived value cannot exceed it.
		IDT3_RI_CVARSET( "r_ext_texture_filter_anisotropic_avail",
		                 va( "%f", glConfig.maxTextureFilterAnisotropy ) );
	}

	// GL_EXT_texture_env_add. The original gates on the extension string; emscripten's GL
	// emulation does not advertise it, but its TexEnv implementation DOES handle GL_ADD
	// (libglemu.js has explicit GL_ADD cases in the combiner). Without this flag
	// CollapseMultitexture() (tr_shader.cpp:2690) refuses to fold an additive two-stage
	// shader into one multitexture pass and draws it as two passes instead — same image,
	// twice the draw calls, on every additive effect in the game.
	glConfig.textureEnvAddAvailable = qtrue;

#ifdef IDT3_JKA
	// idTech3-web: the dynamic-glow capability gate, taken from the function this file stands in
	// for -- GLW_InitExtensions(), win_glimp.cpp:1464. It enables glow only when the driver has
	// ALL of: GL_TEXTURE_RECTANGLE, GL_ARB_vertex_program, render-to-texture, >= 4 texture units,
	// and either NV register combiners (>= 2 general) or GL_ARB_fragment_program.
	//
	// WebGL1 has none of them. There is no rectangle-texture target, and no assembly-shader
	// pipeline at all -- ARB vertex/fragment programs and NV register combiners have no WebGL
	// equivalent, so RB_BlurGlowTexture()'s qglBindProgramARB path simply cannot run. So we take
	// the original's ELSE branch verbatim: clear the flag and force the cvar to 0.
	//
	// This is not a port limitation, it is the engine's own answer for insufficient hardware:
	// retail JKA on a GeForce 2 did exactly this. tr_backend.cpp:1339 gates the whole glow pass
	// on g_bDynamicGlowSupported, so the flag alone is what disables it; forcing the cvar as well
	// is what makes the renderer report "Dynamic Glow: disabled" rather than claiming it is on
	// because a config or +set left the archived value at 1.
	{
		extern bool g_bDynamicGlowSupported;
		g_bDynamicGlowSupported = false;
		IDT3_RI_CVARSET( "r_DynamicGlow", "0" );
	}
#endif

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
// idTech3-web: deliberately does NOT destroy the WebGL context -- see GLimp_Init. The engine
// calls this from RE_Shutdown(destroyWindow=qtrue), i.e. on vid_restart, and expects to be able
// to bring the window straight back up; a browser canvas cannot hand out a second context, so
// destroying it here is unrecoverable. There is no separate teardown to honour either: the tab
// closing is what releases the context.
void GLimp_Shutdown( void ) { }
void GLimp_SetGamma( unsigned char r[256], unsigned char g[256], unsigned char b[256] ) {
	// idTech3-web: a real gamma ramp, standing in for win_gamma.cpp's GLimp_SetGamma.
	//
	// A hardware gamma ramp is not a rendering feature -- it is a lookup applied to the
	// framebuffer on the way to the display, after everything has been drawn. The browser has
	// exactly that stage, and exactly that primitive: an SVG feComponentTransfer with
	// type="table" is an arbitrary 256-entry per-channel LUT applied by the compositor to the
	// canvas. So the engine's table is handed straight to it, unaltered.
	//
	// Measured, sampling COMPOSITED output (Page.captureScreenshot -- a CSS filter is a
	// compositor stage, so reading the canvas backing store with drawImage cannot see it, and
	// an earlier attempt that did exactly that reported the filter as having no effect):
	//     identity ramp   luma 22.1 -> 24.0   (no-op, within frozen-frame drift)
	//     all-white ramp  luma 254.6
	//     all-black ramp  luma 0.1
	//     r_gamma 3 ramp  luma 22.1 -> 42.5
	//     fps with filter 124.9 vs 124.8 without -- no measurable cost
	//
	// Without this, r_gamma was inert. The engine's software fallback bakes the ramp into
	// textures at UPLOAD time (R_LightScaleTexture, tr_image.cpp:384), so the Brightness slider
	// -- a plain `cvarfloat "r_gamma" 1 .5 3` in setup.menu, with no restart -- did nothing
	// until a vid_restart happened to reload the textures. Measured before this change, with a
	// frozen frame and a no-change control: `r_gamma 3` moved luma by +3.52 against a control
	// drift of +3.64 (i.e. nothing), and only vid_restart moved it, by +29.77.
	EM_ASM( {
		var cv = ( Module[ 'canvas' ] ) || document.getElementById( 'canvas' );
		if ( !cv ) return;
		var mk = function( p ) {
			var a = new Array( 256 );
			for ( var i = 0; i < 256; i++ ) { a[i] = ( HEAPU8[ p + i ] / 255 ).toFixed( 4 ); }
			return a.join( ' ' );
		};
		var ident = true;
		for ( var i = 0; i < 256; i++ ) {
			if ( HEAPU8[ $0 + i ] !== i || HEAPU8[ $1 + i ] !== i || HEAPU8[ $2 + i ] !== i ) { ident = false; break; }
		}
		// An identity ramp is "no ramp": drop the filter entirely rather than pay for a
		// compositor pass that cannot change a pixel. r_gamma defaults to 1, so this is the
		// normal case and the default build composites exactly as it did before.
		if ( ident ) { cv.style.removeProperty( 'filter' ); return; }   // NB not "= ''":
			// inside EM_ASM the C preprocessor reads an empty '' as an empty character
			// constant and warns (-Winvalid-pp-token).
		var svg = document.getElementById( 'idt3GammaSvg' );
		if ( !svg ) {
			svg = document.createElementNS( 'http://www.w3.org/2000/svg', 'svg' );
			svg.id = 'idt3GammaSvg';
			svg.setAttribute( 'style', 'position:absolute;width:0;height:0' );
			svg.innerHTML =
				'<filter id="idt3GammaF" color-interpolation-filters="sRGB">' +
				'<feComponentTransfer>' +
				'<feFuncR type="table" tableValues=""/>' +
				'<feFuncG type="table" tableValues=""/>' +
				'<feFuncB type="table" tableValues=""/>' +
				'</feComponentTransfer></filter>';
			document.body.appendChild( svg );
		}
		svg.querySelector( 'feFuncR' ).setAttribute( 'tableValues', mk( $0 ) );
		svg.querySelector( 'feFuncG' ).setAttribute( 'tableValues', mk( $1 ) );
		svg.querySelector( 'feFuncB' ).setAttribute( 'tableValues', mk( $2 ) );
		cv.style.filter = 'url(#idt3GammaF)';
	}, r, g, b );
}
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
	// idTech3-web: function / navigation / keypad keys MUST be matched by `code` before
	// the ASCII fallback below. Their DOM `which` values (F1..F12 = 112..123, PageUp = 33,
	// End = 35, Home = 36, Insert = 45, Delete = 46) all land inside 32..127, so the
	// fallback silently reinterpreted them as printable characters: F1 arrived as 'p',
	// Delete as '.', Home as '$' — and F8 arrived as 'w', i.e. pressing F8 walked the
	// player forward. JKA's A_* codes for these sit outside the ASCII-aligned span of its
	// enum (A_F1..A_F4 below 32, A_F5..A_F12 and the nav/keypad codes above 127), which is
	// exactly why the fallback could never produce them.
	if ( code[0] == 'F' && code[1] >= '1' && code[1] <= '9' ) {
		if ( !strcmp( code, "F1" ) )  return K_F1;
		if ( !strcmp( code, "F2" ) )  return K_F2;
		if ( !strcmp( code, "F3" ) )  return K_F3;
		if ( !strcmp( code, "F4" ) )  return K_F4;
		if ( !strcmp( code, "F5" ) )  return K_F5;
		if ( !strcmp( code, "F6" ) )  return K_F6;
		if ( !strcmp( code, "F7" ) )  return K_F7;
		if ( !strcmp( code, "F8" ) )  return K_F8;
		if ( !strcmp( code, "F9" ) )  return K_F9;
		if ( !strcmp( code, "F10" ) ) return K_F10;
		if ( !strcmp( code, "F11" ) ) return K_F11;
		if ( !strcmp( code, "F12" ) ) return K_F12;
	}
	if ( !strcmp( code, "Insert" ) )   return K_INS;
	if ( !strcmp( code, "Delete" ) )   return K_DEL;
	if ( !strcmp( code, "Home" ) )     return K_HOME;
	if ( !strcmp( code, "End" ) )      return K_END;
	if ( !strcmp( code, "PageUp" ) )   return K_PGUP;
	if ( !strcmp( code, "PageDown" ) ) return K_PGDN;
	if ( !strcmp( code, "Pause" ) )    return K_PAUSE;
	if ( !strcmp( code, "CapsLock" ) ) return K_CAPSLOCK;
	if ( !strncmp( code, "Numpad", 6 ) ) {
		const char *n = code + 6;
		if ( !strcmp( n, "0" ) ) return K_KP_INS;
		if ( !strcmp( n, "1" ) ) return K_KP_END;
		if ( !strcmp( n, "2" ) ) return K_KP_DOWNARROW;
		if ( !strcmp( n, "3" ) ) return K_KP_PGDN;
		if ( !strcmp( n, "4" ) ) return K_KP_LEFTARROW;
		if ( !strcmp( n, "5" ) ) return K_KP_5;
		if ( !strcmp( n, "6" ) ) return K_KP_RIGHTARROW;
		if ( !strcmp( n, "7" ) ) return K_KP_HOME;
		if ( !strcmp( n, "8" ) ) return K_KP_UPARROW;
		if ( !strcmp( n, "9" ) ) return K_KP_PGUP;
		if ( !strcmp( n, "Add" ) )      return K_KP_PLUS;
		if ( !strcmp( n, "Subtract" ) ) return K_KP_MINUS;
		if ( !strcmp( n, "Decimal" ) )  return K_KP_DEL;
		/* NumpadEnter is caught with Enter above; Multiply/Divide have no A_* code. */
	}
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
// ==========================================================================
// Window resize → debounced vid_restart, and hidden-tab main-loop pacing.
// Mirrors shared/sys_emscripten/sys_glimp.c (see it for the full rationale).
// ==========================================================================
void Cbuf_AddText( const char *text );   // qcommon (same binary)

static double s_resizeAt = 0;
static qboolean s_resizePending = qfalse;

static EM_BOOL OnResize( int t, const EmscriptenUiEvent *e, void *u ) {
	s_resizeAt = emscripten_get_now();
	s_resizePending = qtrue;
	return EM_FALSE;
}
static EM_BOOL OnVisibility( int t, const EmscriptenVisibilityChangeEvent *e, void *u ) {
	// Hidden tabs stop RAF → the engine freezes entirely. Tick on setTimeout while hidden.
	if ( e->hidden ) emscripten_set_main_loop_timing( EM_TIMING_SETTIMEOUT, 50 );
	else             emscripten_set_main_loop_timing( EM_TIMING_RAF, 1 );
	// set_main_loop_timing doesn't re-kick the loop; the previously-queued RAF would be the
	// next tick and never fires when hidden. pause+resume invalidates it and reschedules.
	emscripten_pause_main_loop();
	emscripten_resume_main_loop();
	return EM_FALSE;
}

void IN_Init( void ) {
	emscripten_set_resize_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_FALSE, OnResize );
	emscripten_set_visibilitychange_callback( NULL, EM_FALSE, OnVisibility );
	emscripten_set_keydown_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnKey );
	emscripten_set_keyup_callback( EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, OnKey );
	emscripten_set_mousemove_callback( CANVAS, NULL, EM_TRUE, OnMove );
	emscripten_set_mousedown_callback( CANVAS, NULL, EM_TRUE, OnBtn );
	emscripten_set_mouseup_callback( CANVAS, NULL, EM_TRUE, OnBtn );
	emscripten_set_wheel_callback( CANVAS, NULL, EM_TRUE, OnWheel );
	mouseActive = qtrue;
}
void IN_Shutdown( void ) { mouseActive = qfalse; }
void IN_Frame( void ) {
	// Debounced resize → vid_restart (skip when the user pinned r_mode -1).
	if ( s_resizePending && emscripten_get_now() - s_resizeAt > 300.0 ) {
		s_resizePending = qfalse;
#ifdef IDT3_JKA
		if ( IDT3_RI_CVARGET( "r_mode", "4", 0 )->integer != -1 ) {
#else
		if ( IDT3_RI_CVARGET( "r_mode", "3", 0 )->integer != -1 ) {
#endif
			int vw = EM_ASM_INT({ var d = window.devicePixelRatio || 1; return Math.round((window.innerWidth || 1280) * d); });
			int vh = EM_ASM_INT({ var d = window.devicePixelRatio || 1; return Math.round((window.innerHeight || 720) * d); });
			float dw = (float)vw / (float)glConfig.vidWidth;
			float dh = (float)vh / (float)glConfig.vidHeight;
			int pix = glConfig.vidWidth * glConfig.vidHeight;
			if ( dw < 0.94f || ( dw > 1.06f && pix < 3900000 )
			  || dh < 0.94f || ( dh > 1.06f && pix < 3900000 ) ) {
				// idTech3-web: a vid_restart re-uploads every texture and re-runs
				// R_SetColorMappings — on screen that is a brightness flash plus a hitch.
				// Browsers emit resize events in BURSTS (zoom, devicePixelRatio change, a
				// scrollbar appearing, fullscreen transition), so without a floor the renderer
				// can restart repeatedly and the game appears to flash bright at random.
				// Headless never resizes, so this path does not appear in our own captures at
				// all — hence the log line as well as the cooldown.
				static double s_lastRestart = -1.0e9;
				static int    s_restartCount = 0;
				if ( emscripten_get_now() - s_lastRestart < 3000.0 ) {
					Com_Printf( "IDT3: resize %dx%d -> %dx%d suppressed (vid_restart cooldown)\n",
						glConfig.vidWidth, glConfig.vidHeight, vw, vh );
				} else {
					s_lastRestart = emscripten_get_now();
					Com_Printf( "IDT3: vid_restart #%d from resize %dx%d -> %dx%d\n",
						++s_restartCount, glConfig.vidWidth, glConfig.vidHeight, vw, vh );
					Cbuf_AddText( "vid_restart\n" );
				}
			}
		}
	}
}
void IN_Activate( void ) { }

// ==========================================================================
// Sound — the real Web Audio SNDDMA_* backend lives in sys_jk_snd.cpp now.
// ==========================================================================

// ==========================================================================
// Entry point
// ==========================================================================
static void Sys_Frame( void ) { IN_Frame(); Com_Frame(); }

static void Sys_ApplyInitialTiming( void *unused ) {
	EmscriptenVisibilityChangeEvent v;
	if ( emscripten_get_visibility_status( &v ) == EMSCRIPTEN_RESULT_SUCCESS && v.hidden ) {
		emscripten_set_main_loop_timing( EM_TIMING_SETTIMEOUT, 50 );
		emscripten_pause_main_loop();
		emscripten_resume_main_loop();
	}
}
extern "C" EMSCRIPTEN_KEEPALIVE void idt3_pump_frame( void ) { Sys_Frame(); }

int main( int argc, char **argv ) {
	static char commandLine[MAX_STRING_CHARS] = "";
	for ( int i = 1; i < argc; i++ ) {
		Q_strcat( commandLine, sizeof( commandLine ), argv[i] );
		Q_strcat( commandLine, sizeof( commandLine ), " " );
	}
	Com_Init( commandLine );
	IN_Init();
	// Tabs that START hidden never get a visibilitychange event — one async tick after the
	// loop exists, apply setTimeout pacing + pause/resume (see Wolf sys_main.c for detail).
	emscripten_async_call( Sys_ApplyInitialTiming, NULL, 0 );
	emscripten_set_main_loop( Sys_Frame, 0, 1 );
	return 0;
}

// ==========================================================================
// Fixed-function raster state emscripten's GL emulation leaves unimplemented.
//
// libglemu.js ships these two as literal TODOs -- `glPolygonMode: () => {}` and
// `glShadeModel: () => warnOnce('TODO: glShadeModel')`. A native definition here wins
// over the JS library one at link time (the same mechanism the display-list entry points
// in sys_jka_stubs.cpp already rely on), so the engine gets the real behaviour instead of
// a silent no-op plus a startup warning.

// glPolygonMode -> WEBGL_polygon_mode.
//
// Not cosmetic: GL_State()'s GLS_POLYMODE_LINE branch (tr_backend.cpp:343) is the ONLY
// way the engine draws wireframe, so with a no-op glPolygonMode both `r_showtris 1` and
// `r_debugSurface` rendered their debug geometry FILLED -- a solid white screen instead of
// a wireframe overlay, i.e. the two tools you would reach for first when hunting a
// geometry artifact were themselves broken. The WEBGL_polygon_mode extension provides the
// real thing, and its FRONT_AND_BACK / LINE_WEBGL / FILL_WEBGL enum values are numerically
// identical to desktop GL's, so the engine's arguments pass straight through.
//
// Resolved lazily rather than in GLimp_Init, for two reasons. A lookup pinned to a single
// init would silently break after a vid_restart, which creates a new context. And FILL
// requests never touch the extension at all: GL_FILL is the pipeline's own default, so
// GL_SetDefaultState's opening glPolygonMode(FRONT_AND_BACK, FILL) is a no-op -- while
// getExtension('WEBGL_polygon_mode') makes Chrome log
//   "WebGL: this extension has very low support on mobile devices; do not rely on it ..."
// which would then appear on every boot for a debug feature nobody had asked for. The
// extension is requested only when something actually asks for wireframe.
#define IDT3_GL_FILL 0x1B02
EM_JS(void, idt3_gl_polygon_mode, (int face, int mode, int fill), {
	try {
		var ctx = (typeof GL !== 'undefined' && GL.currentContext) ? GL.currentContext.GLctx : null;
		if (!ctx) return;
		if (ctx.__idt3_polyMode === undefined) {
			if (mode === fill) return;   // default state; do not probe the extension for it
			ctx.__idt3_polyMode = ctx.getExtension('WEBGL_polygon_mode') || null;
		}
		if (ctx.__idt3_polyMode) ctx.__idt3_polyMode.polygonModeWEBGL(face, mode);
	} catch (e) {}
});

extern "C" void glPolygonMode( GLenum face, GLenum mode ) {
	idt3_gl_polygon_mode( (int)face, (int)mode, IDT3_GL_FILL );
}

// glShadeModel. GLES2/WebGL has no flat-shading raster state -- interpolation is always
// smooth -- so there is nothing to forward to. JKA asks for GL_SMOOTH exactly once, in
// GL_SetDefaultState (tr_init.cpp:832), which is already the pipeline's behaviour, so
// accepting it silently is the faithful answer rather than a stub. JK2 additionally
// toggles GL_FLAT around its DrawNormals debug path (tr_shade.cpp:1688); that one cannot
// be honoured, and is a debug view either way. Defining it here also removes the
// "TODO: glShadeModel" line emscripten printed into the engine log on every boot.
extern "C" void glShadeModel( GLenum mode ) { (void)mode; }

// ==========================================================================
// Client state, for the CDP test harnesses.
//
// The probes used to infer "is the player in control yet?" from the picture — hold still,
// look for a frame that is both steady and bright. That guess is wrong in both directions:
// JK2's opening cinematics are steady and dark (so gameplay was reported as "never reached"
// on artus_mine, whose spawn is an unlit cave measured at luma 1.9 in the centre band),
// while its Star Wars title crawl is bright and drifts slowly enough to read as steady, so
// a probe once reported a confident "MOVED: YES" measured entirely on scrolling text.
//
// The engine already knows the answer. cls.state == CA_ACTIVE with no key-catcher means the
// map is running and neither the console nor a menu is swallowing input — exactly the
// precondition those probes were trying to guess. Hand it to them instead.
//
//   Module.ccall('idt3_client_state', 'number', [], [])  ->  state | (keyCatchers << 8)
extern "C" EMSCRIPTEN_KEEPALIVE int idt3_client_state( void ) {
	return (int)cls.state | ( (int)cls.keyCatchers << 8 );
}

// ==========================================================================
// Console command channel for the CDP test harnesses.
//
// Driving the in-game console by synthesising keystrokes is unusable for automated
// A/B work: single-player PAUSES while the console is open, so if the closing toggle
// is missed the engine stops producing frames and every subsequent screenshot is a
// byte-identical copy of the last one — which reads exactly like "the cvar changed
// nothing". That silently invalidated two full bisection runs.
//
// This queues a command straight into the engine's command buffer instead: no console
// UI, no pause, no keystroke timing, nothing to visually verify. Extern "C" so the
// export name is stable (the engine is C++, so Cbuf_AddText itself is mangled).
// Exported via -sEXPORTED_FUNCTIONS in build-jka.sh; harnesses reach it with
//   Module.ccall('idt3_exec_cmd', null, ['string'], ['r_drawentities 0'])

extern "C" EMSCRIPTEN_KEEPALIVE void idt3_exec_cmd( const char *text ) {
	if ( !text || !*text ) return;
	Cbuf_AddText( text );
	Cbuf_AddText( "\n" );   // Cbuf_AddText does not terminate commands itself
}
