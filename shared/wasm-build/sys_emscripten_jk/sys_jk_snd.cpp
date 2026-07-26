/*
 * idTech3-web — JK2/JKA SNDDMA_* sound backend on Web Audio. JK ships a software mixer
 * (snd_mix.cpp + the !s_UseOpenAL paths); s_UseOpenAL defaults to "0", so with OpenAL/EAX
 * compiled-but-never-called the engine paints 16-bit samples into dma.buffer just like
 * RTCW/Wolf:ET. Same DMA-ring device, driven by the non-deprecated scheduled-
 * AudioBufferSource pattern (see shared/wasm-build/sys_emscripten/sys_snd.c for the rationale:
 * no ScriptProcessorNode, no AudioWorklet/SharedArrayBuffer). No engine source copied.
 */
#include "../server/exe_headers.h"
#include "snd_local.h"
#include <emscripten.h>
#define IDT3_SND_SPEED 22050
#define IDT3_SND_CHANNELS 2
#define IDT3_SND_BITS 16
#define IDT3_SND_SAMPLES (1<<16)
#define IDT3_SND_AHEAD 0.10   /* seconds queued ahead (< engine s_mixahead 0.2) */
#define IDT3_SND_CHUNK 1024   /* frames per scheduled AudioBuffer */
#define IDT3_SND_TICKMS 20    /* scheduler timer interval (ms) */
static short *idt3_dmaBuffer=NULL; static volatile int idt3_dmaPos=0; static qboolean idt3_sndInited=qfalse;
EM_JS(int, idt3_jksnd_start,(short *bufPtr,int samples,int channels,int speed,int *posPtr,double ahead,int chunk,int tickMs),{
  try{ var AC=window.AudioContext||window.webkitAudioContext; if(!AC) return 0;
    /* JK's MP3 music decoder only converts to the classic rates — at a 96kHz device
       context it fails outright ("MP3ERR: Decoder unable to convert"). Pin the context to
       44100 (native MP3 rate; the browser resamples to the device internally) instead of
       reusing the page's device-rate context. 'playback' hint = stall-proof buffers. */
    var ctx=new AC({sampleRate:44100,latencyHint:'playback'});
    var rate=ctx.sampleRate|0; if(!rate) return 0;
    var frames=(samples/channels)|0; var base=bufPtr>>1;
    var S={ctx:ctx,pos:0,peak:0,sched:0,started:false,startT:0,timer:0}; Module.__idt3_snd=S;
    function pump(){ if(ctx.state!=='running') return; var now=ctx.currentTime;
      if(!S.started){S.started=true;S.startT=now;S.sched=0;} var horizon=now+ahead;
      while(S.startT+(S.sched+chunk)/rate<=horizon){
        var buf=ctx.createBuffer(channels,chunk,rate); var inv=1/32768;
        /* wrap-split bulk copy: <=2 contiguous ring segments, no per-sample modulo */
        for(var c=0;c<channels;c++){ var ch=buf.getChannelData(c);
          var idx=0,rem=chunk,fr=S.sched%frames;
          while(rem>0){ var n=Math.min(rem,frames-fr); var off=base+fr*channels+c;
            for(var i=0;i<n;i++) ch[idx+i]=HEAP16[off+i*channels]*inv;
            idx+=n; rem-=n; fr=0; } }
        var ch0=buf.getChannelData(0),peak=S.peak;
        for(var p=0;p<chunk;p+=16){ var a=ch0[p]<0?-ch0[p]:ch0[p]; if(a>peak)peak=a; }
        S.peak=peak; var src=ctx.createBufferSource(); src.buffer=buf; src.connect(ctx.destination); src.start(S.startT+S.sched/rate); S.sched+=chunk; }
      var played=Math.floor((now-S.startT)*rate); if(played<0)played=0; S.pos=played; HEAP32[posPtr>>2]=(played%frames)*channels; }
    S.timer=setInterval(pump,tickMs);
    var resume=function(){ if(ctx.state==='suspended')ctx.resume(); }; ['mousedown','keydown','touchstart'].forEach(function(t){window.addEventListener(t,resume,{capture:true});}); resume();
    return rate; }catch(err){return 0;} });
EM_JS(void, idt3_jksnd_stop,(void),{ var s=Module.__idt3_snd; if(s){ if(s.timer){try{clearInterval(s.timer);}catch(e){}} if(s.ctx){try{s.ctx.close();}catch(e){}} Module.__idt3_snd=null; } });
qboolean SNDDMA_Init(void){ if(idt3_sndInited) return qtrue;
  idt3_dmaBuffer=(short*)calloc(IDT3_SND_SAMPLES,sizeof(short)); if(!idt3_dmaBuffer) return qfalse;
  memset(&dma,0,sizeof(dma)); dma.channels=IDT3_SND_CHANNELS; dma.samples=IDT3_SND_SAMPLES; dma.samplebits=IDT3_SND_BITS; dma.speed=IDT3_SND_SPEED; dma.buffer=(byte*)idt3_dmaBuffer; dma.submission_chunk=1;
  int ok=idt3_jksnd_start(idt3_dmaBuffer,IDT3_SND_SAMPLES,IDT3_SND_CHANNELS,IDT3_SND_SPEED,(int*)&idt3_dmaPos,IDT3_SND_AHEAD,IDT3_SND_CHUNK,IDT3_SND_TICKMS);
  if(!ok){ free(idt3_dmaBuffer); idt3_dmaBuffer=NULL; return qfalse; }
  dma.speed=ok; idt3_sndInited=qtrue; Com_Printf("SNDDMA_Init: Web Audio %d Hz, %d ch, %d bit\n",dma.speed,dma.channels,dma.samplebits); return qtrue; }
int SNDDMA_GetDMAPos(void){ return idt3_sndInited?idt3_dmaPos:0; }
void SNDDMA_Shutdown(void){ if(!idt3_sndInited) return; idt3_jksnd_stop(); free(idt3_dmaBuffer); idt3_dmaBuffer=NULL; idt3_sndInited=qfalse; memset(&dma,0,sizeof(dma)); }
void SNDDMA_BeginPainting(void){}
void SNDDMA_Submit(void){}
