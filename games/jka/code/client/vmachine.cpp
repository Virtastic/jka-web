// vmachine.cpp -- wrapper to fake virtual machine for client

#include "vmachine.h"
#pragma warning (disable : 4514)

#if defined(__EMSCRIPTEN__)
#include <stdarg.h>
// idTech3-web: cgvm.entryPoint is resolved by Sys_LoadCgame to the side module's
// idt3_vmMain_arr (idt3_vm_shim.c), so we CALL THROUGH THE POINTER — the symbol
// lives in qagame.wasm and the main module cannot import it directly (doing so
// aborts at startup with "external symbol 'idt3_vmMain_arr' is missing").
typedef int ( *idt3_vmMainArr_t )( int command, const int *args );
#endif

/*
==============================================================

VIRTUAL MACHINE

==============================================================
*/
int	VM_Call( int callnum, ... )
{
//	assert (cgvm.entryPoint);

#if defined(__EMSCRIPTEN__)
	// idTech3-web: `(&callnum)[i]` below is an x86 trick — it walks the caller's
	// contiguous pushed stack to reach the varargs. wasm has no such stack: varargs
	// live in a separate buffer, so those reads return garbage, and calling a
	// fixed-arity vmMain through an int(*)(int,...) pointer traps outright with
	// "function signature mismatch". Marshal into an array instead and call the
	// module's array entry. Same fix as RTCW/ET's qcommon/vm.c.
	// 8 args after `command` — cgame/cg_main.cpp:96 declares vmMain(command, arg0..arg7).
	if ( cgvm.entryPoint )
	{
		int args[8];
		va_list ap;
		va_start( ap, callnum );
		for ( int i = 0; i < 8; i++ ) {
			args[i] = va_arg( ap, int );
		}
		va_end( ap );
		return ( (idt3_vmMainArr_t)cgvm.entryPoint )( callnum, args );
	}

	return -1;
#else
	if (cgvm.entryPoint)
	{
		return cgvm.entryPoint( (&callnum)[0], (&callnum)[1], (&callnum)[2], (&callnum)[3],
			(&callnum)[4], (&callnum)[5], (&callnum)[6], (&callnum)[7],
			(&callnum)[8],  (&callnum)[9] );
	}

	return -1;
#endif
}

/*
============
VM_DllSyscall

we pass this to the cgame dll to call back into the client
============
*/
extern int CL_CgameSystemCalls( int *args );
extern int CL_UISystemCalls( int *args );

int VM_DllSyscall( int arg, ... ) {
//	return cgvm->systemCall( &arg );
#if defined(__EMSCRIPTEN__)
	// idTech3-web: `&arg` assumes the remaining varargs sit contiguously after the
	// first one on the caller's stack — true on x86, false on wasm, where they live
	// in a separate buffer. Copy them into a real array first. 16 slots covers every
	// trap_* call site. (idTech3 shipped exactly this shape for PPC, for the same
	// reason: see RTCW/ET's VM_DllSyscall.)
	int args[16];
	va_list ap;
	args[0] = arg;
	va_start( ap, arg );
	for ( int i = 1; i < 16; i++ ) {
		args[i] = va_arg( ap, int );
	}
	va_end( ap );
	return CL_CgameSystemCalls( args );
#else
	return CL_CgameSystemCalls( &arg );
#endif
}
