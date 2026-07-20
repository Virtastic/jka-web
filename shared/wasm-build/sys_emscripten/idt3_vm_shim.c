/* idTech3-web: wasm has no portable contiguous vararg stack, so the engine's
 * x86 `(&callnum)[i]` VM_Call hack reads garbage for some call sites. The robust
 * bridge is an ARRAY: the engine marshals call args into an int[] and hands this
 * shim a pointer; the shim calls the module's fixed-arity vmMain. No varargs
 * cross the engine↔module boundary. Compiled into every side module.
 * IDT3_VMMAIN_ARGS = number of argN parameters after `command`. It MUST match the
 * module's real vmMain definition or wasm traps at the call with
 * "signature_mismatch:vmMain". Per game, from the sources:
 *   RTCW-SP  qagame=7  (game/g_main.c)      cgame/ui=12
 *   RTCW-MP  qagame=7  (game/g_main.c:329)  cgame=12 (cgame/cg_main.c:60), ui=12
 *   JK2      8 (cgame/cg_main.cpp:89)   — SP merges game+cgame into one module
 *   JKA      8 (cgame/cg_main.cpp:96)   — likewise
 */
#include <stdarg.h>

#ifndef IDT3_VMMAIN_ARGS
#define IDT3_VMMAIN_ARGS 12
#endif

/* JK2/JKA compile this shim as C++. Their vmMain/dllEntry get C linkage in-source
 * (like GetGameAPI already did) so the engine can dlsym them by plain name, so
 * declare vmMain extern "C" here to bind the same unmangled symbol. */
#if defined(__cplusplus)
extern "C" {
#endif

#if IDT3_VMMAIN_ARGS == 12
extern int vmMain( int command, int a0, int a1, int a2, int a3, int a4, int a5,
                   int a6, int a7, int a8, int a9, int a10, int a11 );
#elif IDT3_VMMAIN_ARGS == 8
extern int vmMain( int command, int a0, int a1, int a2, int a3, int a4, int a5,
                   int a6, int a7 );
#elif IDT3_VMMAIN_ARGS == 7
extern int vmMain( int command, int a0, int a1, int a2, int a3, int a4, int a5, int a6 );
#else
#error "IDT3_VMMAIN_ARGS must be 7, 8 or 12 — add the arity your module's vmMain declares"
#endif

/* The engine dlsym()s this and calls it as int(*)(int, const int*). */
int idt3_vmMain_arr( int command, const int *a ) {
#if IDT3_VMMAIN_ARGS == 12
	return vmMain( command, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11] );
#elif IDT3_VMMAIN_ARGS == 8
	return vmMain( command, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7] );
#else
	return vmMain( command, a[0], a[1], a[2], a[3], a[4], a[5], a[6] );
#endif
}

/* Legacy vararg entry kept for any caller still on the x86 hack path. */
int idt3_vmMain_va( int command, ... ) {
	int a[12] = {0};
	va_list ap;
	int i;
	va_start( ap, command );
	for ( i = 0; i < IDT3_VMMAIN_ARGS; i++ ) a[i] = va_arg( ap, int );
	va_end( ap );
	return idt3_vmMain_arr( command, a );
}

#if defined(__cplusplus)
}   /* extern "C" */
#endif
