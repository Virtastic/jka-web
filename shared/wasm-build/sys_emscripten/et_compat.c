/*
 * idTech3-web — Wolf:ET only. ET's game/q_shared.h "poisons" vsnprintf/_vsnprintf
 * (#define vsnprintf use_Q_vsnprintf) to force engine code onto its safe Q_vsnprintf.
 * A few direct callers remain (our Sys_Error, the splines lib), so `use_Q_vsnprintf`
 * must resolve to a real vsnprintf. This TU deliberately does NOT include q_shared.h,
 * so `vsnprintf` here is the genuine libc one.
 */
#include <stdio.h>
#include <stdarg.h>
#include <stddef.h>

int use_Q_vsnprintf( char *str, size_t size, const char *fmt, va_list ap ) {
	return vsnprintf( str, size, fmt, ap );
}
