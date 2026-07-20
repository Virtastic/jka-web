# Single-source toolchain env for idTech3-web (source this from all build scripts).
#
# Toolchain: Homebrew Emscripten 6.0.1 (matches wasm-deps `emsdk-6.0.1-jseh` and the
# ja2-web / CS-Web ports). JS exceptions (-fexceptions), single-threaded by default.
#
# Design notes / pin history:
#  - emcc 6.0.1: same as CS-Web (OpenMW) and ja2-web; verified present via `emcc --version`.
#  - NO -flto: wasm-ld miscompiles the boot path (observed in both CS-Web and ja2-web).
#  - Single-threaded to start: the original idTech3 engines are single-threaded, so we
#    avoid -pthread (and the COOP/COEP cross-origin-isolation requirement) until/unless
#    the SharedArrayBuffer-backed streamfs pk3 reader is adopted. Flip IDTECH3_THREADS=1
#    to opt into the threaded flag set.
#  - id386=0 C paths everywhere: no x86 inline asm under wasm.

export IDTECH3_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
# Homebrew emscripten 6.0.1 (emcc/em++/emcmake/emar on default PATH)
export PATH="/opt/homebrew/bin:$PATH"

# --- exceptions / threading toggle ------------------------------------------------
if [ "${IDTECH3_THREADS:-0}" = "1" ]; then
  IDTECH3_THREAD_FLAGS="-pthread"
  IDTECH3_THREAD_LINK="-pthread -sPTHREAD_POOL_SIZE=8 -sENVIRONMENT=web,worker"
else
  IDTECH3_THREAD_FLAGS=""
  IDTECH3_THREAD_LINK="-sENVIRONMENT=web"
fi

# --- compile flags ----------------------------------------------------------------
# -fexceptions: JS-exception model (only the JK C++ code truly needs it; harmless for C).
# LEGACY_GL_EMULATION is a *link* setting; the renderer is built against Emscripten GL headers.
# Warning relaxations: the 2001–2003 sources were written for lenient C89/MSVC compilers.
# Modern clang promotes several benign K&R-isms to hard errors. To honor the "strictly
# original, keep source byte-identical" rule we relax clang to the era's leniency rather
# than editing the engine code (editing would be *less* faithful). These are all benign
# categories for this codebase (implicit decls, int/pointer width, time_t width, etc.).
IDTECH3_WARNFLAGS="-Wno-implicit-function-declaration -Wno-int-conversion \
-Wno-incompatible-pointer-types -Wno-incompatible-function-pointer-types \
-Wno-implicit-int -Wno-return-type -Wno-deprecated-non-prototype -Wno-shift-negative-value"
# -fgnu89-inline: the sources use MSVC/gnu89 `__inline` (no `static`), which under C99
# inline semantics emits NO external symbol (e.g. Matrix4MultiplyInto3x3AndTranslation).
# gnu89 inline emits a callable definition — matching the era's compiler, no source edits.
# -DDLL_ONLY: makes vm.c provide its own empty VM_Compile/VM_CallCompiled stubs (we run
# native SP modules + the interpreter, never the x86 compiled VM). Only vm.c reads it.
# -fPIC: MAIN_MODULE/SIDE_MODULE dynamic linking requires position-independent code.
# (RTCW happened to link without it; ET's renderer globals produce
# R_WASM_MEMORY_ADDR_LEB relocations that wasm-ld rejects in non-PIC MAIN_MODULE code.)
# -O3: measurably faster than -O2 on the engine hot paths (culling/tessellation/sim) and,
# more importantly, cuts worst-case frame time — Wolf-ET oasis went 5.63->4.90ms median and
# 31.7->8.1ms p95 (the stutter). ~10-20% larger wasm; worth it. (No -flto per CLAUDE.md.)
# -fno-strict-aliasing is MANDATORY for idTech3: the engine pervasively type-puns
# (short*<->float* in the MDS skeletal math, byte-buffer casts, union tricks). Its
# original Makefiles pass it; without it, -O2/-O3 strict-aliasing optimizations
# miscompile that code — e.g. character (MDS) skeletal models render with vertices
# flung to garbage positions ("spikes"/shards shooting off the mesh).
export IDTECH3_COMMON_FLAGS="-fexceptions -O3 -fno-strict-aliasing -fPIC -fgnu89-inline -DDLL_ONLY ${IDTECH3_THREAD_FLAGS} ${IDTECH3_WARNFLAGS} -DNDEBUG"

# --- link flags (adapted from ja2-web/wasm-build/env.sh) --------------------------
# Memory: pk3s are range-streamed (not materialized in MEMFS), but the loaded map still needs
# real heap — measured peaks (heap-probe.mjs) are ~256MB (RTCW-SP escape1) up to ~442MB
# (Wolf:ET oasis) at map-load, before gameplay adds entities/effects/streamed media. The old
# 256MB INITIAL_MEMORY meant every heavier map crossed the boundary and paid ALLOW_MEMORY_GROWTH
# reallocations (mimalloc heap moves + HEAP-view rebuilds) during load and again in play. Start
# at 512MB so the common desktop scenes never grow (MAXIMUM_MEMORY=4GB still backstops the rest).
# STACK_SIZE=8MB — q3 BSP/collision loads use deep stacks (ja2-web hit exactly this).
# MALLOC=mimalloc: faster, fewer traps.
export IDTECH3_LINK_FLAGS="-fexceptions ${IDTECH3_THREAD_LINK} \
-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=536870912 -sMAXIMUM_MEMORY=4294967296 \
-sMALLOC=mimalloc -sEXIT_RUNTIME=0 -sSTACK_SIZE=8388608 -sSTACK_OVERFLOW_CHECK=1 \
-sFORCE_FILESYSTEM=1 -lidbfs.js \
-sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=1 -sLEGACY_GL_EMULATION=1 -sGL_UNSAFE_OPTS=0 \
-sERROR_ON_UNDEFINED_SYMBOLS=0 \
-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,ENV,callMain,addRunDependency,removeRunDependency"
