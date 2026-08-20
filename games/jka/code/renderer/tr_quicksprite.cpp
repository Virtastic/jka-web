// tr_QuickSprite.cpp: implementation of the CQuickSpriteSystem class.
//
//////////////////////////////////////////////////////////////////////
#include "../server/exe_headers.h"
#include "tr_quicksprite.h"

extern void R_BindAnimatedImage( const textureBundle_t *bundle );


//////////////////////////////////////////////////////////////////////
// Singleton System
//////////////////////////////////////////////////////////////////////
CQuickSpriteSystem SQuickSprite;


//////////////////////////////////////////////////////////////////////
// Construction/Destruction
//////////////////////////////////////////////////////////////////////

CQuickSpriteSystem::CQuickSpriteSystem(void)
{
	int i;

	for (i = 0; i < SHADER_MAX_VERTEXES; i += 4)
	{
		// Bottom right
		mTextureCoords[i + 0][0] = 1.0;
		mTextureCoords[i + 0][1] = 1.0;
		// Top right
		mTextureCoords[i + 1][0] = 1.0;
		mTextureCoords[i + 1][1] = 0.0;
		// Top left
		mTextureCoords[i + 2][0] = 0.0;
		mTextureCoords[i + 2][1] = 0.0;
		// Bottom left
		mTextureCoords[i + 3][0] = 0.0;
		mTextureCoords[i + 3][1] = 1.0;
	}
}

CQuickSpriteSystem::~CQuickSpriteSystem(void)
{
}

void CQuickSpriteSystem::Flush(void)
{
	if (mNextVert==0)
	{
		return;
	}

	/*
	if (mUseFog && r_drawfog->integer == 2 &&
		mFogIndex == tr.world->globalFog)
	{ //enable hardware fog when we draw this thing if applicable -rww
		fog_t *fog = tr.world->fogs + mFogIndex;

#ifdef _XBOX
		qglFogi(GL_FOG_MODE, GL_EXP2);
#else
		qglFogf(GL_FOG_MODE, GL_EXP2);
#endif
		qglFogf(GL_FOG_DENSITY, logtestExp2 / fog->parms.depthForOpaque);
		qglFogfv(GL_FOG_COLOR, fog->parms.color);
		qglEnable(GL_FOG);
	}
	*/
	//this should not be needed, since I just wait to disable fog for the surface til after surface sprites are done

	//
	// render the main pass
	//
	R_BindAnimatedImage( mTexBundle );
	GL_State(mGLStateBits);

	//
	// set arrays and lock
	//
	qglEnableClientState( GL_TEXTURE_COORD_ARRAY);
	qglTexCoordPointer( 2, GL_FLOAT, 0, mTextureCoords );

	qglEnableClientState( GL_COLOR_ARRAY);
	qglColorPointer( 4, GL_UNSIGNED_BYTE, 0, mColors );

	qglVertexPointer (3, GL_FLOAT, 16, mVerts);

	if ( qglLockArraysEXT )
	{
		qglLockArraysEXT(0, mNextVert);
		GLimp_LogComment( "glLockArraysEXT\n" );
	}

	qglDrawArrays(GL_QUADS, 0, mNextVert);

	backEnd.pc.c_vertexes += mNextVert;
	backEnd.pc.c_indexes += mNextVert;
	backEnd.pc.c_totalIndexes += mNextVert;

	//only for software fog pass (global soft/volumetric) -rww
	if (mUseFog && (r_drawfog->integer != 2 || mFogIndex != tr.world->globalFog))
	{
		fog_t *fog = tr.world->fogs + mFogIndex;

		//
		// render the fog pass
		//
		GL_Bind( tr.fogImage );
		// idTech3-web: this pass uses GLS_DEPTHFUNC_EQUAL, and the dissolve work proved depth-equality
		// is unreliable under emscripten's GL emulation (it revealed in 1 of 4 runs and banded into 16
		// column steps). It was therefore a suspect for the reported artifacts -- but it is NOT one,
		// because it never executes: tinting this pass magenta and counting invocations gave 0 runs and
		// 0 magenta pixels on both yavin1 and t2_rogue. Its own comment says "only for software fog
		// pass", and the guard above requires r_drawfog->integer != 2 while JKA defaults r_drawfog to 2
		// (GPU fog). So this is dead code by default and deliberately left untouched.
		GL_State( GLS_SRCBLEND_SRC_ALPHA | GLS_DSTBLEND_ONE_MINUS_SRC_ALPHA | GLS_DEPTHFUNC_EQUAL );

		//
		// set arrays and lock
		//
		qglTexCoordPointer( 2, GL_FLOAT, 0, mFogTextureCoords);
//		qglEnableClientState( GL_TEXTURE_COORD_ARRAY);	// Done above

		qglDisableClientState( GL_COLOR_ARRAY );
		qglColor4ubv((GLubyte *)&fog->colorInt);

//		qglVertexPointer (3, GL_FLOAT, 16, mVerts);	// Done above

		qglDrawArrays(GL_QUADS, 0, mNextVert);

		// Second pass from fog
		backEnd.pc.c_totalIndexes += mNextVert;
#ifdef __EMSCRIPTEN__
		// idTech3-web: the fog pass above disables GL_COLOR_ARRAY (and sets a flat qglColor4ubv)
		// and nothing re-enables it -- this function returns with the colour array still off. Any
		// later draw that expects per-vertex colours then silently inherits that single flat fog
		// colour instead, which is a direct mechanism for surfaces flashing bright/uniform. On
		// desktop GL the leak is usually masked because the next shader stage calls
		// qglEnableClientState(GL_COLOR_ARRAY) itself and the redundant enable is free; we cannot
		// rely on that here, because under LEGACY_GL_EMULATION the enabled-attribute set also
		// determines the vertex layout GLImmediate.createRenderer() builds. Restore it.
		qglEnableClientState( GL_COLOR_ARRAY );
		qglColorPointer( 4, GL_UNSIGNED_BYTE, 0, mColors );
#endif
	}

	// 
	// unlock arrays
	//
	if (qglUnlockArraysEXT) 
	{
		qglUnlockArraysEXT();
		GLimp_LogComment( "glUnlockArraysEXT\n" );
	}

#ifdef __EMSCRIPTEN__
	// idTech3-web: balance the client arrays this function enabled (GL_TEXTURE_COORD_ARRAY and
	// GL_COLOR_ARRAY, above). Neither was ever disabled, so the state leaked out of every
	// surface-sprite batch. Same defect and same reasoning as DrawMultitextured() in tr_shade.cpp:
	// glemu derives the vertex layout from enabledClientAttributes, so a stale array keeps
	// contributing to stride and to the interleaved restride on every later draw, with its pointer
	// still aimed at this system's mTextureCoords / mColors.
	qglDisableClientState( GL_TEXTURE_COORD_ARRAY );
	qglDisableClientState( GL_COLOR_ARRAY );
#endif
	mNextVert=0;
}


void CQuickSpriteSystem::StartGroup(textureBundle_t *bundle, unsigned long glbits, int fogIndex )
{
	mNextVert = 0;

	mTexBundle = bundle;
	mGLStateBits = glbits;
	if (fogIndex != -1)
	{
		mUseFog = qtrue;
		mFogIndex = fogIndex;
	}
	else
	{
		mUseFog = qfalse;
	}

	int cullingOn;
	qglGetIntegerv(GL_CULL_FACE,&cullingOn);

	if(cullingOn)
	{
		mTurnCullBackOn=true;
	}
	else
	{
		mTurnCullBackOn=false;
	}
	qglDisable(GL_CULL_FACE);
}


void CQuickSpriteSystem::EndGroup(void)
{
	Flush();

	qglColor4ub(255,255,255,255);
	if(mTurnCullBackOn)
	{
		qglEnable(GL_CULL_FACE);
	}
}




void CQuickSpriteSystem::Add(float *pointdata, color4ub_t color, vec2_t fog)
{
	float *curcoord;
	float *curfogtexcoord;
	unsigned long *curcolor;

	if (mNextVert>SHADER_MAX_VERTEXES-4)
	{
		Flush();
	}

	curcoord = mVerts[mNextVert];
	memcpy(curcoord, pointdata, 4*sizeof(vec4_t));

	// Set up color
	curcolor = &mColors[mNextVert];
	*curcolor++ = *(unsigned long *)color;
	*curcolor++ = *(unsigned long *)color;
	*curcolor++ = *(unsigned long *)color;
	*curcolor++ = *(unsigned long *)color;

	if (fog)
	{
		curfogtexcoord = &mFogTextureCoords[mNextVert][0];
		*curfogtexcoord++ = fog[0];
		*curfogtexcoord++ = fog[1];

		*curfogtexcoord++ = fog[0];
		*curfogtexcoord++ = fog[1];

		*curfogtexcoord++ = fog[0];
		*curfogtexcoord++ = fog[1];

		*curfogtexcoord++ = fog[0];
		*curfogtexcoord++ = fog[1];

		mUseFog=qtrue;
	}
	else
	{
		mUseFog=qfalse;
	}

	mNextVert+=4;
}
