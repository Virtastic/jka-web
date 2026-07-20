/*
===========================================================================
idTech3-web platform layer — Emscripten/HTML5 replacement for the original
win32/ + unix/ system code. NEW code written for this port (not copied from
any fork); it reproduces the *original engine's* Sys_/GLimp_/IN_/SNDDMA_
contracts (modeled on the in-tree win32/unix originals) against Emscripten's
HTML5 + WebGL APIs.

Covers RTCW-SP first; the contract is shared across the idTech3 family so
later games reuse this with per-engine deltas.
===========================================================================
*/
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <dirent.h>
#include <unistd.h>
#include <math.h>

#include <emscripten.h>
#include <emscripten/html5.h>

#include "q_shared.h"
#include "qcommon.h"

// ==========================================================================
// Timing
// ==========================================================================
static double sys_timeBase = 0.0;

int Sys_Milliseconds( void ) {
	double now = emscripten_get_now();
	if ( sys_timeBase == 0.0 ) {
		sys_timeBase = now;
		return 0;
	}
	return (int)( now - sys_timeBase );
}

// ==========================================================================
// Event queue (semantics identical to win32/unix originals)
// ==========================================================================
#define MAX_QUED_EVENTS     256
#define MASK_QUED_EVENTS    ( MAX_QUED_EVENTS - 1 )

static sysEvent_t eventQue[MAX_QUED_EVENTS];
static int eventHead, eventTail;

char *Sys_ConsoleInput( void );   // forward decl (defined below)
qboolean Sys_GetPacket( netadr_t *net_from, msg_t *net_message );   // forward decl (net pump below)

void Sys_QueEvent( int time, sysEventType_t type, int value, int value2, int ptrLength, void *ptr ) {
	sysEvent_t *ev;

	ev = &eventQue[ eventHead & MASK_QUED_EVENTS ];
	if ( eventHead - eventTail >= MAX_QUED_EVENTS ) {
		Com_Printf( "Sys_QueEvent: overflow\n" );
		if ( ev->evPtr ) {
			Z_Free( ev->evPtr );
		}
		eventTail++;
	}
	eventHead++;

	if ( time == 0 ) {
		time = Sys_Milliseconds();
	}
	ev->evTime = time;
	ev->evType = type;
	ev->evValue = value;
	ev->evValue2 = value2;
	ev->evPtrLength = ptrLength;
	ev->evPtr = ptr;
}

sysEvent_t Sys_GetEvent( void ) {
	sysEvent_t ev;
	char *s;

	// return queued events first
	if ( eventHead > eventTail ) {
		eventTail++;
		return eventQue[ ( eventTail - 1 ) & MASK_QUED_EVENTS ];
	}

	// browser input is delivered asynchronously via the HTML5 callbacks below,
	// which already pushed into the queue; there is no synchronous message pump.
	// Console input (dev): drained from the JS-side ring if present.
	s = Sys_ConsoleInput();
	if ( s ) {
		int len = strlen( s ) + 1;
		char *b = Z_Malloc( len );
		Q_strncpyz( b, s, len - 1 );
		Sys_QueEvent( 0, SE_CONSOLE, 0, 0, len, b );
	}

	// network packets (multiplayer): drain one datagram from the WebSocket transport
	// per call and queue it as SE_PACKET, exactly as the unix/win platform mains do.
	// In single-player this never fires — the WS is only opened once a real packet is
	// actually sent (see Sys_SendPacket), so SP pays nothing.
	{
		static byte sys_packetReceived[MAX_MSGLEN];
		netadr_t adr;
		msg_t netmsg;
		MSG_Init( &netmsg, sys_packetReceived, sizeof( sys_packetReceived ) );
		if ( Sys_GetPacket( &adr, &netmsg ) ) {
			int len = sizeof( netadr_t ) + netmsg.cursize;
			netadr_t *buf = Z_Malloc( len );
			*buf = adr;
			memcpy( buf + 1, netmsg.data, netmsg.cursize );
			Sys_QueEvent( 0, SE_PACKET, 0, 0, len, buf );
		}
	}

	if ( eventHead > eventTail ) {
		eventTail++;
		return eventQue[ ( eventTail - 1 ) & MASK_QUED_EVENTS ];
	}

	memset( &ev, 0, sizeof( ev ) );
	ev.evTime = Sys_Milliseconds();
	return ev;
}

void Sys_SendKeyEvents( void ) {
	// No-op: HTML5 callbacks queue events asynchronously.
}

// ==========================================================================
// Console I/O
// ==========================================================================
void Sys_Print( const char *msg ) {
	fputs( msg, stdout );
}

// idTech3-web: dev/automation console input. JS pushes command strings onto the
// Module.__idt3_con ring (window/page code or CDP: Module.__idt3_con.push("team r")); the
// engine drains one per frame through the SE_CONSOLE path, exactly like a typed dev console
// line. Lets tooling drive the game (team-join, map changes, cvars) without synthesising
// keystrokes, and gives the page a real console hook. Harmless when nothing pushes.
EM_JS( int, idt3_con_pop, ( int outPtr, int maxlen ), {
	var q = ( typeof Module !== 'undefined' ) && Module.__idt3_con;
	if ( !q || !q.length ) return 0;
	var s = '' + q.shift();
	var len = lengthBytesUTF8( s ) + 1;
	if ( len > maxlen ) len = maxlen;
	stringToUTF8( s, outPtr, len );
	return 1;
} );

char *Sys_ConsoleInput( void ) {
	static char buf[1024];
	return idt3_con_pop( (int)(intptr_t)buf, sizeof( buf ) ) ? buf : NULL;
}

void Sys_ShowConsole( int level, qboolean quitOnClose ) { }
void Sys_DisplaySystemConsole( qboolean show ) { }
void Sys_SetErrorText( const char *text ) { }

void QDECL Sys_Error( const char *error, ... ) {
	va_list argptr;
	char string[4096];

	va_start( argptr, error );
	vsnprintf( string, sizeof( string ), error, argptr );
	va_end( argptr );

	fprintf( stderr, "Sys_Error: %s\n", string );
	EM_ASM( { if (typeof Module !== 'undefined' && Module.onFatal) Module.onFatal(UTF8ToString($0)); }, string );
	emscripten_force_exit( 1 );
}

void Sys_Quit( void ) {
	emscripten_force_exit( 0 );
}

// ==========================================================================
// Filesystem / paths (MEMFS + IDBFS; base = "/rtcw", home = "/userdata")
// ==========================================================================
void Sys_Mkdir( const char *path ) {
	mkdir( path, 0777 );
}

char *Sys_Cwd( void ) {
	static char cwd[MAX_OSPATH];
	if ( !getcwd( cwd, sizeof( cwd ) - 1 ) ) {
		cwd[0] = '\0';
	}
	cwd[MAX_OSPATH - 1] = '\0';
	return cwd;
}

#ifndef IDT3_FSROOT
#define IDT3_FSROOT "/rtcw"   // per-engine builds override with -DIDT3_FSROOT='"/et"' etc.
#endif
char *Sys_DefaultBasePath( void )    { return IDT3_FSROOT; }
char *Sys_DefaultInstallPath( void ) { return IDT3_FSROOT; }
char *Sys_DefaultHomePath( void )    { return "/userdata"; }
char *Sys_DefaultCDPath( void )      { return ""; }
void  Sys_SetDefaultCDPath( const char *path ) { }
void  Sys_SetDefaultInstallPath( const char *path ) { }
void  Sys_SetDefaultHomePath( const char *path ) { }

qboolean Sys_CheckCD( void ) { return qtrue; }

char *Sys_GetCurrentUser( void ) {
	return "player";
}

char *Sys_GetClipboardData( void ) {
	return NULL;
}

// Directory listing — MEMFS/IDBFS support dirent, so we mirror the unix logic.
static void Sys_ListFilteredFiles( const char *basedir, char *subdirs, char *filter, char **list, int *numfiles );

#define MAX_FOUND_FILES 0x1000

static qboolean Sys_MatchFileAttributes( const char *pathname, qboolean wantDir ) {
	struct stat st;
	if ( stat( pathname, &st ) == -1 ) {
		return qfalse;
	}
	return ( ( st.st_mode & S_IFDIR ) != 0 ) == wantDir;
}

char **Sys_ListFiles( const char *directory, const char *extension, char *filter, int *numfiles, qboolean wantsubs ) {
	struct dirent *d;
	DIR *fdir;
	qboolean dironly = wantsubs;
	char search[MAX_OSPATH];
	int nfiles;
	char **listCopy;
	char *list[MAX_FOUND_FILES];
	int i;
	int extLen;

	if ( filter ) {
		nfiles = 0;
		Sys_ListFilteredFiles( directory, "", filter, list, &nfiles );
		list[nfiles] = NULL;
		*numfiles = nfiles;
		if ( !nfiles ) {
			return NULL;
		}
		listCopy = Z_Malloc( ( nfiles + 1 ) * sizeof( *listCopy ) );
		for ( i = 0; i < nfiles; i++ ) {
			listCopy[i] = list[i];
		}
		listCopy[i] = NULL;
		return listCopy;
	}

	if ( !extension ) {
		extension = "";
	}
	if ( extension[0] == '/' && extension[1] == 0 ) {
		extension = "";
		dironly = qtrue;
	}
	extLen = strlen( extension );

	if ( ( fdir = opendir( directory ) ) == NULL ) {
		*numfiles = 0;
		return NULL;
	}

	nfiles = 0;
	while ( ( d = readdir( fdir ) ) != NULL ) {
		Com_sprintf( search, sizeof( search ), "%s/%s", directory, d->d_name );
		if ( !Sys_MatchFileAttributes( search, dironly ) ) {
			continue;
		}
		if ( *extension ) {
			int nameLen = strlen( d->d_name );
			if ( nameLen < extLen ||
				 Q_stricmp( d->d_name + nameLen - extLen, extension ) ) {
				continue;
			}
		}
		if ( nfiles == MAX_FOUND_FILES - 1 ) {
			break;
		}
		list[nfiles] = CopyString( d->d_name );
		nfiles++;
	}
	list[nfiles] = NULL;
	closedir( fdir );

	if ( !nfiles ) {
		*numfiles = 0;
		return NULL;
	}

	listCopy = Z_Malloc( ( nfiles + 1 ) * sizeof( *listCopy ) );
	for ( i = 0; i < nfiles; i++ ) {
		listCopy[i] = list[i];
	}
	listCopy[i] = NULL;
	*numfiles = nfiles;
	return listCopy;
}

static void Sys_ListFilteredFiles( const char *basedir, char *subdirs, char *filter, char **list, int *numfiles ) {
	char search[MAX_OSPATH], newsubdirs[MAX_OSPATH];
	char filename[MAX_OSPATH];
	DIR *fdir;
	struct dirent *d;
	struct stat st;

	if ( *numfiles >= MAX_FOUND_FILES - 1 ) {
		return;
	}
	if ( strlen( subdirs ) ) {
		Com_sprintf( search, sizeof( search ), "%s/%s", basedir, subdirs );
	} else {
		Com_sprintf( search, sizeof( search ), "%s", basedir );
	}
	if ( ( fdir = opendir( search ) ) == NULL ) {
		return;
	}
	while ( ( d = readdir( fdir ) ) != NULL ) {
		Com_sprintf( filename, sizeof( filename ), "%s/%s", search, d->d_name );
		if ( stat( filename, &st ) == -1 ) {
			continue;
		}
		if ( st.st_mode & S_IFDIR ) {
			if ( Q_stricmp( d->d_name, "." ) && Q_stricmp( d->d_name, ".." ) ) {
				if ( strlen( subdirs ) ) {
					Com_sprintf( newsubdirs, sizeof( newsubdirs ), "%s/%s", subdirs, d->d_name );
				} else {
					Com_sprintf( newsubdirs, sizeof( newsubdirs ), "%s", d->d_name );
				}
				Sys_ListFilteredFiles( basedir, newsubdirs, filter, list, numfiles );
			}
		}
		if ( *numfiles >= MAX_FOUND_FILES - 1 ) {
			break;
		}
		Com_sprintf( filename, sizeof( filename ), "%s/%s", subdirs, d->d_name );
		if ( !Com_FilterPath( filter, filename, qfalse ) ) {
			continue;
		}
		list[*numfiles] = CopyString( filename );
		( *numfiles )++;
	}
	closedir( fdir );
}

void Sys_FreeFileList( char **list ) {
	int i;
	if ( !list ) {
		return;
	}
	for ( i = 0; list[i]; i++ ) {
		Z_Free( list[i] );
	}
	Z_Free( list );
}

// ==========================================================================
// Streamed file support (used by cinematics / big reads). The original spins a
// background thread; under emscripten we read synchronously from the VFS.
// ==========================================================================
void Sys_InitStreamThread( void ) { }
void Sys_ShutdownStreamThread( void ) { }
void Sys_BeginStreamedFile( fileHandle_t f, int readahead ) { }
void Sys_EndStreamedFile( fileHandle_t f ) { }
int  Sys_StreamedRead( void *buffer, int size, int count, fileHandle_t f ) {
	return FS_Read( buffer, size * count, f );
}
void Sys_StreamSeek( fileHandle_t f, int offset, int origin ) {
	FS_Seek( f, offset, origin );
}

// ==========================================================================
// Misc system services
// ==========================================================================
// idTech3-web: the win32 layer registered "in_restart" (win_main.c: Sys_In_Restart_f).
// ui_shared.c executes "in_restart" after input-setting changes (and the console showed
// "unknown cmd in_restart" because win32/ is excluded from the wasm build). Under
// emscripten the browser input is always live and never needs restarting, so a no-op
// registration silences the error with correct behavior.
void Sys_In_Restart_f( void ) { }

void Sys_Init( void ) {
	Cvar_Set( "arch", "wasm32" );
	Cvar_Set( "username", Sys_GetCurrentUser() );
	Cvar_Set( "sys_cpustring", "WebAssembly" );
	Cmd_AddCommand( "in_restart", Sys_In_Restart_f );
}

void *Sys_InitializeCriticalSection( void ) { return (void *)-1; }
void  Sys_EnterCriticalSection( void *ptr ) { }
void  Sys_LeaveCriticalSection( void *ptr ) { }

int  Sys_GetProcessorId( void )   { return 0; }
int  Sys_GetHighQualityCPU( void ) { return 1; }
qboolean Sys_LowPhysicalMemory( void ) { return qfalse; }
unsigned int Sys_ProcessorCount( void ) { return 1; }

void Sys_BeginProfiling( void ) { }
void Sys_EndProfiling( void ) { }

void Sys_StartProcess( char *exeName, qboolean doexit ) {
	if ( doexit ) {
		Com_Quit_f();
	}
}

// Sys_OpenURL's url param is `char *` in RTCW-SP but `const char *` in RTCW-MP / ET.
// The per-engine build passes -DIDT3_CONST_URL where the header uses const.
#ifdef IDT3_CONST_URL
#define IDT3_URLARG const char *
#else
#define IDT3_URLARG char *
#endif
void Sys_OpenURL( IDT3_URLARG url, qboolean doexit ) {
	EM_ASM( { window.open( UTF8ToString( $0 ), '_blank' ); }, url );
	if ( doexit ) {
		Com_Quit_f();
	}
}

// SnapVector: round each component to the nearest integer (float still).
void Sys_SnapVector( float *v ) {
	v[0] = rintf( v[0] );
	v[1] = rintf( v[1] );
	v[2] = rintf( v[2] );
}

// ==========================================================================
// Networking — WebSocket transport to shared/web/net-relay.mjs (WS<->UDP bridge).
//
// Browsers can't open UDP sockets, so datagrams ride a WebSocket to the relay, which
// forwards them to real UDP (a normal RTCW-MP / Wolf:ET server, or a relayed peer). The
// engine's loopback path (listen server talking to its own client) never reaches here,
// so single-player and local play are untouched. Wire framing matches the relay:
//   [ip0 ip1 ip2 ip3][port hi][port lo][datagram...]
// netadr_t.port is network byte order (as the unix layer keeps it); we byteswap to/from
// the host-order value the relay frame carries. wasm is little-endian.
// ==========================================================================

// Open the WS to the relay. force!=0 means "a real send is happening, connect now"
// (client). force==0 only connects if the page opted into networking by setting
// window.__IDT3_NET_RELAY — used by the net pump so a HOSTING browser's listen server
// is reachable before the first client packet, while single-player pays nothing.
EM_JS( void, idt3_net_connect, ( int force ), {
	if ( Module.__idt3_net ) return;
	var relay = ( typeof window !== 'undefined' && window.__IDT3_NET_RELAY ) || null;
	if ( !force && !relay ) return;   // no opt-in and not a real send -> stay off the net
	var url = relay || ( 'ws://' + ( ( typeof location !== 'undefined' && location.hostname ) || 'localhost' ) + ':27960' );
	var st = { ws: null, q: [], url: url, vip: null };
	Module.__idt3_net = st;
	try {
		var ws = new WebSocket( url );
		ws.binaryType = 'arraybuffer';
		ws.onmessage = function ( e ) {
			if ( !e.data || e.data.byteLength < 6 ) return;
			var u = new Uint8Array( e.data );
			// control frame: source 0.0.0.0 -> the relay announcing our virtual IP
			if ( u[0] === 0 && u[1] === 0 && u[2] === 0 && u[3] === 0 ) {
				try { st.vip = new TextDecoder().decode( u.subarray( 6 ) ); } catch ( x ) {}
				return;   // not a game packet
			}
			st.q.push( u );
		};
		st.ws = ws;
	} catch ( err ) { /* relay not up; sends no-op until it is */ }
} );

// send one datagram to host-order ip:port; returns 1 if handed to the socket
EM_JS( int, idt3_net_send, ( int a, int b, int c, int d, int port, int dataPtr, int len ), {
	var st = Module.__idt3_net;
	if ( !st || !st.ws || st.ws.readyState !== 1 ) return 0;
	var f = new Uint8Array( 6 + len );
	f[0] = a & 255; f[1] = b & 255; f[2] = c & 255; f[3] = d & 255;
	f[4] = ( port >> 8 ) & 255; f[5] = port & 255;
	f.set( HEAPU8.subarray( dataPtr, dataPtr + len ), 6 );
	try { st.ws.send( f ); return 1; } catch ( e ) { return 0; }
} );

// dequeue one received datagram; writes ip[4] + host-order port (int32) at outAddrPtr,
// payload at bufPtr; returns payload length, or -1 if the queue is empty / not connected.
EM_JS( int, idt3_net_recv, ( int outAddrPtr, int bufPtr, int maxlen ), {
	var st = Module.__idt3_net;
	if ( !st || !st.q.length ) return -1;
	var fr = st.q.shift();
	var plen = fr.length - 6;
	if ( plen > maxlen ) plen = maxlen;
	HEAPU8[outAddrPtr]     = fr[0]; HEAPU8[outAddrPtr + 1] = fr[1];
	HEAPU8[outAddrPtr + 2] = fr[2]; HEAPU8[outAddrPtr + 3] = fr[3];
	HEAP32[( outAddrPtr + 4 ) >> 2] = ( fr[4] << 8 ) | fr[5];
	HEAPU8.set( fr.subarray( 6, 6 + plen ), bufPtr );
	return plen;
} );

void Sys_SendPacket( int length, const void *data, netadr_t to ) {
	if ( to.type != NA_IP && to.type != NA_BROADCAST ) {
		return;   // NA_LOOPBACK etc. are handled by the engine's in-memory loop
	}
	idt3_net_connect( 1 );   // a real send: connect now
	int port = ( ( to.port & 0xff ) << 8 ) | ( ( to.port >> 8 ) & 0xff );   // net -> host order
	idt3_net_send( to.ip[0], to.ip[1], to.ip[2], to.ip[3], port, (int)(intptr_t)data, length );
}

qboolean Sys_GetPacket( netadr_t *net_from, msg_t *net_message ) {
	struct { byte ip[4]; int port; } addr;
	idt3_net_connect( 0 );   // hosting browser (opted in via __IDT3_NET_RELAY) connects eagerly
	int len = idt3_net_recv( (int)(intptr_t)&addr, (int)(intptr_t)net_message->data, net_message->maxsize );
	if ( len < 0 ) {
		return qfalse;
	}
	memset( net_from, 0, sizeof( *net_from ) );
	net_from->type = NA_IP;
	net_from->ip[0] = addr.ip[0]; net_from->ip[1] = addr.ip[1];
	net_from->ip[2] = addr.ip[2]; net_from->ip[3] = addr.ip[3];
	net_from->port = ( ( addr.port & 0xff ) << 8 ) | ( ( addr.port >> 8 ) & 0xff );   // host -> net order
	net_message->readcount = 0;
	net_message->cursize = len;
	return qtrue;
}

qboolean Sys_StringToAdr( const char *s, netadr_t *a ) {
	char copy[128];
	char *colon;
	int b0, b1, b2, b3, port = 27960;   // idTech3 default server port

	memset( a, 0, sizeof( *a ) );
	a->type = NA_IP;
	Q_strncpyz( copy, s, sizeof( copy ) );
	colon = strchr( copy, ':' );
	if ( colon ) {
		*colon = '\0';
		port = atoi( colon + 1 );
	}
	a->port = (unsigned short)( ( ( port & 0xff ) << 8 ) | ( ( port >> 8 ) & 0xff ) );   // host -> net order

	if ( !Q_stricmp( copy, "localhost" ) ) {
		a->ip[0] = 127; a->ip[3] = 1;
		return qtrue;
	}
	if ( sscanf( copy, "%d.%d.%d.%d", &b0, &b1, &b2, &b3 ) == 4 ) {
		a->ip[0] = (byte)b0; a->ip[1] = (byte)b1; a->ip[2] = (byte)b2; a->ip[3] = (byte)b3;
		return qtrue;
	}
	// Hostnames can't be resolved in the browser; connect by numeric IP:port (the relay
	// reaches the real server). A DNS-over-relay path can be added later.
	return qfalse;
}

qboolean Sys_IsLANAddress( netadr_t adr ) {
	if ( adr.type == NA_LOOPBACK ) {
		return qtrue;
	}
	if ( adr.type != NA_IP ) {
		return qfalse;
	}
	if ( adr.ip[0] == 127 ) return qtrue;                                  // loopback
	if ( adr.ip[0] == 10 ) return qtrue;                                   // 10.0.0.0/8
	if ( adr.ip[0] == 192 && adr.ip[1] == 168 ) return qtrue;             // 192.168.0.0/16
	if ( adr.ip[0] == 172 && adr.ip[1] >= 16 && adr.ip[1] <= 31 ) return qtrue; // 172.16.0.0/12
	return qfalse;
}

void Sys_ShowIP( void ) { }

// NET_Sleep: block up to msec waiting for a socket. No sockets in SP → nothing to wait on.
void NET_Sleep( int msec ) { }

// --- Wolf:ET additions (harmless extras for the other engines) -----------
float Sys_GetCPUSpeed( void ) { return 1000.0f; }
qboolean Sys_IsNumLockDown( void ) { return qfalse; }
