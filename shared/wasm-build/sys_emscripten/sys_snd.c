/*
===========================================================================
idTech3-web — SNDDMA_* sound backend on Web Audio.

The engine's sound contract is a classic DMA ring buffer: the mixer paints
16-bit samples into dma.buffer and advances its own paint cursor, while the
"device" consumes the buffer at dma.speed and reports how far it has played
via SNDDMA_GetDMAPos().

We reproduce that with the non-deprecated "scheduled AudioBufferSource"
pattern: a short timer copies the next slice of dma.buffer into a small
AudioBuffer and schedules it back-to-back on the AudioContext clock, keeping
a fixed look-ahead queued. The play cursor we publish back to C is derived
from ctx.currentTime (the true audio clock), so it advances smoothly and
self-heals after any hiccup.

NEW code (no engine source copied). Notes:
 - Why not ScriptProcessorNode? It is deprecated (and its callback runs on the
   main thread, so it drops out on any main-thread stall > its ~46ms buffer).
 - Why not AudioWorkletNode? Feeding a worklet from wasm memory needs a
   SharedArrayBuffer, which requires COOP/COEP cross-origin isolation — we
   deliberately avoid that to stay single-threaded (see docs/WASM_ADAPTATIONS).
   AudioWorklet without SAB would mean postMessage-copying every block, which
   is strictly worse than scheduling buffers directly.
 - Scheduled AudioBufferSource needs neither: standard Web Audio, no SAB, and
   the look-ahead (IDT3_SND_AHEAD) is tunable — bigger = more jank-proof, at
   the cost of latency. It stays under the engine's own s_mixahead (0.2s) so
   the ring slice we read has already been painted.
 - Browsers only allow an AudioContext to start after a user gesture; we
   create it here and also resume it on the first input event.
===========================================================================
*/
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "q_shared.h"
#include "qcommon.h"
#include "snd_local.h"   // resolved via -I<engine>/client (per-engine include path)

// Ring buffer: 16-bit stereo. Power-of-two sample count keeps the engine's
// masking arithmetic (dma.samples - 1) valid.
#define IDT3_SND_SPEED      22050
#define IDT3_SND_CHANNELS   2
#define IDT3_SND_BITS       16
#define IDT3_SND_SAMPLES    ( 1 << 16 )   // total 16-bit samples (both channels)

static short *idt3_dmaBuffer = NULL;
// Play cursor in *samples* (channel-interleaved), written by JS, read by C.
static volatile int idt3_dmaPos = 0;
static qboolean idt3_sndInited = qfalse;

// Look-ahead / chunk sizing for the scheduler. AHEAD must stay below the engine's
// s_mixahead (0.2s) so the ring slice we read has already been painted by the mixer.
#define IDT3_SND_AHEAD    0.10   // seconds of audio kept scheduled ahead of the clock
#define IDT3_SND_CHUNK    1024   // frames per scheduled AudioBuffer (~21ms @ 48kHz)
#define IDT3_SND_TICKMS   20     // scheduler timer interval (ms)

// EM_JS (not EM_ASM): the JS body contains commas/braces that the EM_ASM macro
// would split on as macro arguments. Returns the real sample rate, or 0.
EM_JS( int, idt3_snd_start, ( short *bufPtr, int samples, int channels, int speed, int *posPtr,
							  double ahead, int chunk, int tickMs ), {
	try {
		var AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return 0;
		var ctx = new AC({ sampleRate: speed, latencyHint: 'interactive' });
		var rate = ctx.sampleRate | 0;
		if (!rate) return 0;
		var frames = (samples / channels) | 0;          // frames in the ring
		var base = bufPtr >> 1;                          // HEAP16 index of the ring
		var S = { ctx: ctx, pos: 0, peak: 0, sched: 0, started: false, startT: 0, timer: 0 };
		Module.__idt3_snd = S;

		// Copy the next `chunk` frames from the ring (linear play position `S.sched`) into a
		// fresh AudioBuffer and schedule it to start exactly where the previous one ended.
		function pump() {
			if (ctx.state !== 'running') return;
			var now = ctx.currentTime;
			if (!S.started) { S.started = true; S.startT = now; S.sched = 0; }
			var horizon = now + ahead;
			// schedule whole chunks until the queue reaches the look-ahead horizon
			while (S.startT + (S.sched + chunk) / rate <= horizon) {
				var buf = ctx.createBuffer(channels, chunk, rate);
				var peak = S.peak;
				for (var c = 0; c < channels; c++) {
					var ch = buf.getChannelData(c);
					for (var i = 0; i < chunk; i++) {
						var fr = (S.sched + i) % frames;              // ring frame
						var v = HEAP16[base + fr * channels + c] / 32768;
						ch[i] = v;
						var a = v < 0 ? -v : v; if (a > peak) peak = a;
					}
				}
				S.peak = peak;
				var src = ctx.createBufferSource();
				src.buffer = buf;
				src.connect(ctx.destination);
				src.start(S.startT + S.sched / rate);
				S.sched += chunk;
			}
			// Publish the play cursor from the audio clock (monotonic, self-healing after a
			// stall) in engine units (interleaved samples).
			var played = Math.floor((now - S.startT) * rate);
			if (played < 0) played = 0;
			S.pos = played;
			HEAP32[posPtr >> 2] = (played % frames) * channels;
		}
		S.timer = setInterval(pump, tickMs);

		// Autoplay policy: an AudioContext may only start after a user gesture.
		var resume = function () { if (ctx.state === 'suspended') ctx.resume(); };
		['mousedown', 'keydown', 'touchstart'].forEach(function (t) {
			window.addEventListener(t, resume, { capture: true });
		});
		resume();
		return rate;
	} catch (err) {
		return 0;
	}
} );

EM_JS( void, idt3_snd_stop, ( void ), {
	var s = Module.__idt3_snd;
	if (s) {
		if (s.timer) { try { clearInterval(s.timer); } catch (e) {} }
		if (s.ctx) { try { s.ctx.close(); } catch (e) {} }
		Module.__idt3_snd = null;
	}
} );

qboolean SNDDMA_Init( void ) {
	if ( idt3_sndInited ) {
		return qtrue;
	}

	idt3_dmaBuffer = (short *)calloc( IDT3_SND_SAMPLES, sizeof( short ) );
	if ( !idt3_dmaBuffer ) {
		Com_Printf( "SNDDMA_Init: out of memory for the DMA buffer\n" );
		return qfalse;
	}

	memset( &dma, 0, sizeof( dma ) );
	dma.channels    = IDT3_SND_CHANNELS;
	dma.samples     = IDT3_SND_SAMPLES;
	dma.samplebits  = IDT3_SND_BITS;
	dma.speed       = IDT3_SND_SPEED;
	dma.buffer      = (byte *)idt3_dmaBuffer;
	dma.submission_chunk = 1;

	// Drain dma.buffer into Web Audio, publishing the play cursor to C.
	// The browser may hand back a different rate than requested; we tell the
	// engine the real one so its mixer resamples correctly.
	int ok = idt3_snd_start( idt3_dmaBuffer, IDT3_SND_SAMPLES, IDT3_SND_CHANNELS,
							 IDT3_SND_SPEED, (int *)&idt3_dmaPos,
							 IDT3_SND_AHEAD, IDT3_SND_CHUNK, IDT3_SND_TICKMS );

	if ( !ok ) {
		Com_Printf( "SNDDMA_Init: no Web Audio available — sound disabled\n" );
		free( idt3_dmaBuffer );
		idt3_dmaBuffer = NULL;
		return qfalse;
	}

	// Use the rate the browser actually gave us.
	dma.speed = ok;
	idt3_sndInited = qtrue;
	Com_Printf( "SNDDMA_Init: Web Audio %d Hz, %d ch, %d bit\n", dma.speed, dma.channels, dma.samplebits );
	return qtrue;
}

int SNDDMA_GetDMAPos( void ) {
	if ( !idt3_sndInited ) {
		return 0;
	}
	return idt3_dmaPos;
}

void SNDDMA_Shutdown( void ) {
	if ( !idt3_sndInited ) {
		return;
	}
	idt3_snd_stop();
	free( idt3_dmaBuffer );
	idt3_dmaBuffer = NULL;
	idt3_sndInited = qfalse;
	memset( &dma, 0, sizeof( dma ) );
}

// The mixer writes straight into dma.buffer; the scheduler timer copies from it on the
// same (main) thread, so the two never run concurrently and there is no lock to take here.
void SNDDMA_BeginPainting( void ) { }

void SNDDMA_Submit( void ) { }
