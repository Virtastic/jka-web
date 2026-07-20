/*
 * idTech3-web — MSVC/compat shims for the JK2/JKA C++ build, force-included
 * (-include) so the engine sources stay byte-identical. Provides the MSVC
 * string helpers POSIX/clang lacks. `random` is handled separately by a build
 * define (the engine's `inline float random()` collides with POSIX long random()).
 */
#ifndef IDT3_JK_COMPAT_H
#define IDT3_JK_COMPAT_H
#include <ctype.h>
#include <string.h>

/* Minimal Win32 typedefs the engine uses in a few spots (tr_font, tr_model, …). */
typedef const char *LPCSTR;
typedef char       *LPSTR;
typedef const char *LPCTSTR;
typedef char       *LPTSTR;
typedef char        TCHAR;
typedef unsigned long DWORD;
typedef unsigned int  UINT;
typedef int           BOOL;
typedef unsigned char BYTE;
// mp3code/mp3struct.h uses the engine's lowercase `byte` but doesn't include
// q_shared.h; provide it here (q_shared re-typedefs it identically — legal in C++).
typedef unsigned char byte;
typedef unsigned short WORD;
typedef unsigned short USHORT;
typedef short          SHORT;
typedef unsigned long  ULONG;
typedef long           LONG;
typedef char           CHAR;
typedef unsigned char  UCHAR;
typedef void          *LPVOID;
typedef DWORD         *LPDWORD;
typedef float         FLOAT;
typedef void         *HDC;
typedef void         *HGLRC;
typedef void         *HWND;
typedef void         *HINSTANCE;
#ifndef WINAPI
#define WINAPI
#endif
#ifndef APIENTRY
#define APIENTRY
#endif
#ifndef DECLARE_HANDLE
#define DECLARE_HANDLE(n) typedef void *n
#endif
typedef int INT_PTR;
typedef unsigned int UINT_PTR;

typedef unsigned long COLORREF;
typedef void         *HANDLE;
typedef struct tagPOINT { LONG x, y; } POINT;   /* cm_terrainmap */

/* Win32 debug output — no-op under emscripten (cm/common debug spew). */
static inline void OutputDebugString( const char * ) { }
#ifndef OutputDebugStringA
#define OutputDebugStringA OutputDebugString
#endif

/* NB: do NOT define min()/max() macros here — jk_compat.h is force-included into
 * the engine too, and the macro form breaks engine files that use std::min/max
 * (q_math, tr_shade_calc, …). Mismatched-type min() call sites are cast instead. */

/* MSVC string case helpers (in-place). */
static inline char *strlwr( char *s ) {
	for ( char *p = s; p && *p; ++p ) *p = (char)tolower( (unsigned char)*p );
	return s;
}
static inline char *strupr( char *s ) {
	for ( char *p = s; p && *p; ++p ) *p = (char)toupper( (unsigned char)*p );
	return s;
}

#endif /* IDT3_JK_COMPAT_H */

/* idTech3-web: winmm/msvcrt leftovers used by JK2 game code */
#ifndef IDT3_JK_TIME_SHIMS
#define IDT3_JK_TIME_SHIMS
#ifdef __cplusplus
extern "C" unsigned int timeGetTime(void);
#else
unsigned int timeGetTime(void);
#endif
#include <math.h>
#ifndef _isnan
#define _isnan(x) isnan(x)
#endif
#endif

/* idTech3-web: msvcrt name */
#ifndef _snprintf
#define _snprintf snprintf
#endif
