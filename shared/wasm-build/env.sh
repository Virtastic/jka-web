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

# --- toolchain discovery ----------------------------------------------------------
# Emscripten 6.0.1, however it is installed. Original dev box was macOS/Homebrew, which
# puts emcc on /opt/homebrew/bin; a plain `emsdk` checkout (Linux/Windows-Git-Bash) needs
# its emsdk_env.sh sourced instead. Probe in that order and stop at the first hit, so no
# build script has to know which host it is on. Override either by exporting EMSDK=<dir>
# or by having emcc already on PATH before sourcing this file.
[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"
if ! command -v emcc >/dev/null 2>&1; then
  for _emsdk in "${EMSDK:-}" "$HOME/emsdk" /c/dev/emsdk /opt/emsdk; do
    if [ -n "$_emsdk" ] && [ -f "$_emsdk/emsdk_env.sh" ]; then
      # shellcheck disable=SC1090
      . "$_emsdk/emsdk_env.sh" >/dev/null 2>&1 || true
      command -v emcc >/dev/null 2>&1 && break
    fi
  done
  unset _emsdk
fi
command -v emcc >/dev/null 2>&1 || {
  echo "env.sh: emcc not found. Install Emscripten 6.0.1 and either put emcc on PATH" >&2
  echo "        or export EMSDK=<path to your emsdk checkout>." >&2
  return 1 2>/dev/null || exit 1
}
# MSYS/Git-Bash (Windows) rewrites any argument that looks like a POSIX path into a
# Windows one before handing it to a native .exe. emcc IS a native .exe here, and that
# rewrite mangles the engine's compiler *values* — -DPATH_SEP='/' becomes the MSYS root
# directory, and -Dstricmp=strcasecmp survives but -DIDT3_FSROOT="/jka" turns into
# "C:/Program Files/Git/jka". Exclude the flags whose values are engine paths, not host
# paths. (-I/-L/-o still convert, which is what we want.)
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # Prefix list, not a blanket off-switch: -I/-L/-o/-include still convert (emcc.exe
    # needs real Windows paths for those), only -D values are left alone.
    export MSYS2_ARG_CONV_EXCL="-D;-s;-Wl,"
    ;;
esac

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

# --- Raven C++ (JK2/JKA) era-warning relaxations ----------------------------------
# Same principle as IDTECH3_WARNFLAGS above, applied to the 2002-2003 Raven C++ trees:
# relax clang to the era's leniency instead of editing pristine engine source, because
# an edit would be the LESS faithful option -- every category below is a construct that
# shipped in the retail game and behaves identically here.
#
# Each was read before being added, not swept up by category name:
#   extra-tokens ................. `#endif __FOO_H__` -- MSVC-era comment style.
#   non-c-typedef-for-linkage .... `typedef struct { ... } foo_t;` in C++ TUs.
#   missing-declarations ......... `typedef enum { ... };` with no declarator (g_items.h).
#   invalid-source-encoding ...... latin-1 bytes in character literals (cl_keys.cpp).
#   macro-redefined .............. our -Dstricmp=... and the engine's own glext.h guards.
#   comment ...................... `/*` inside a block comment.
#   switch ....................... enums deliberately not exhaustively handled.
#   format ....................... two shapes, both benign HERE: sscanf("%s", &buf) where
#                                  buf is char[N] (same address), and "%d" against `long`,
#                                  which is 32-bit under wasm32's ILP32 model.
#   format-security .............. Com_Printf(variable) in cg_info.cpp.
#   nontrivial-memcall ........... memset() over POD-ish C++ classes (RM_Terrain.h).
#   dangling-else, parentheses-equality, logical-not-parentheses, unused-value,
#   unused-comparison ............ style, not semantics.
#   enum-compare ................. cross-enum compares of int-valued enums.
#   pointer-bool-conversion, tautological-pointer-compare,
#   tautological-constant-out-of-range-compare .... `if (ent->name)` on an array member and
#                                  `x == -1` on an enum/uchar: always-true/false tests the
#                                  original relies on being harmless.
#   array-bounds ................. `color[3]` on a vec3_t that is followed in-struct by the
#                                  alpha it means to write.
#   sizeof-pointer-memaccess ..... `memset(cv, 0, sizeof(cv))` in JK2 cvar.cpp -- a genuine
#                                  Raven bug, present in the retail binary; "fixing" it would
#                                  diverge from the game we are reproducing.
#   null-dereference ............. the deliberate `*(int*)0 = 0` crash in Com_Error.
#   strncat-size ................. NPC_stats.cpp passing the destination size to strncat.
#   int-to-void-pointer-cast, literal-conversion .... narrow casts the original performs.
#   register, deprecated, writable-strings, invalid-offsetof, c++11-narrowing,
#   reserved-user-defined-literal ... C++98-isms clang now warns about by default.
#   c++20-extensions ............. RATL writes `pool_root<T>::iterator` without the
#                                  `typename` C++20 later made optional again.
#   tautological-undefined-compare  `if (&group == NULL)` -- Raven guards references
#                                  against null; always false, and harmless.
#   unsequenced .................. `*dest++ = AVE_PIX(*dest, color)` in cm_draw.cpp.
#                                  Genuinely order-dependent, and genuinely what the
#                                  retail binary was compiled from; changing it would
#                                  be a behavioural edit to pristine source, so it is
#                                  recorded here instead. (RMG terrain draw; no stock
#                                  single-player map reaches it.)
#   absolute-value ............... fabsf() applied to an int (bg_panimate.cpp). The integer
#                                  promotes to float first, so the value is right; only the
#                                  spelling is odd.
export IDTECH3_JK_WARNFLAGS="-Wno-extra-tokens -Wno-non-c-typedef-for-linkage \
-Wno-missing-declarations -Wno-invalid-source-encoding -Wno-macro-redefined -Wno-comment \
-Wno-switch -Wno-format -Wno-format-security -Wno-nontrivial-memcall -Wno-dangling-else \
-Wno-parentheses-equality -Wno-logical-not-parentheses -Wno-unused-value \
-Wno-unused-comparison -Wno-enum-compare -Wno-pointer-bool-conversion \
-Wno-tautological-pointer-compare -Wno-tautological-constant-out-of-range-compare \
-Wno-array-bounds -Wno-sizeof-pointer-memaccess -Wno-null-dereference -Wno-strncat-size \
-Wno-int-to-void-pointer-cast -Wno-literal-conversion \
-Wno-c++20-extensions -Wno-tautological-undefined-compare -Wno-unsequenced -Wno-absolute-value"

# --- link flags (adapted from ja2-web/wasm-build/env.sh) --------------------------
# Memory: pk3s are range-streamed (not materialized in MEMFS), but the loaded map still needs
# real heap — measured peaks (heap-probe.mjs) are ~256MB (RTCW-SP escape1) up to ~442MB
# (Wolf:ET oasis) at map-load, before gameplay adds entities/effects/streamed media. The old
# 256MB INITIAL_MEMORY meant every heavier map crossed the boundary and paid ALLOW_MEMORY_GROWTH
# reallocations (mimalloc heap moves + HEAP-view rebuilds) during load and again in play. Start
# at 512MB so the common desktop scenes never grow (MAXIMUM_MEMORY=4GB still backstops the rest).
# STACK_SIZE=8MB — q3 BSP/collision loads use deep stacks (ja2-web hit exactly this).
# MALLOC=mimalloc: faster, fewer traps.
# ASSERTIONS: emscripten defaults it ON, and an -O3 shipping build was inheriting that.
# Besides the size/speed cost, the GL emulation puts two of its own diagnostics behind
# #if ASSERTIONS (libglemu.js:2164 and :3528), so every boot logged
#   "GL_TEXTURE1 coords are supplied, but that texture unit is disabled..."
#   "DrawElements doesn't actually prepareClientAttributes properly."
# STACK_OVERFLOW_CHECK stays at 1 -- it is a separate setting and the failure it catches
# (deep BSP/collision recursion) is the one worth paying for. Export IDTECH3_ASSERTIONS=1
# to get the checked build back when debugging.
# MEASURED UPDATE (JKA campaign, map-sweep.mjs reporting HEAPU8.length per map): 512MB was
# NOT enough for 'the common desktop scenes never grow'. Loading all 34 JKA campaign maps in
# one session steps the heap twice -- 512 -> 614.4MB at t2_rancor, 614.4 -> 737.4MB at vjun3 --
# and each step is an ArrayBuffer realloc + copy with every HEAP view rebuilt, i.e. exactly the
# stall this setting exists to avoid. It is a step function, not a slope: eight consecutive
# loads of one map hold flat, so these are high-water marks for two big maps, not a leak.
# 768MB clears the measured peak with headroom; MAXIMUM_MEMORY still backstops the rest.
export IDTECH3_LINK_FLAGS="-fexceptions ${IDTECH3_THREAD_LINK} \
-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=805306368 -sMAXIMUM_MEMORY=4294967296 \
-sMALLOC=mimalloc -sEXIT_RUNTIME=0 -sSTACK_SIZE=8388608 -sSTACK_OVERFLOW_CHECK=1 \
-sASSERTIONS=${IDTECH3_ASSERTIONS:-0} \
-sFORCE_FILESYSTEM=1 -lidbfs.js \
-sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=1 -sLEGACY_GL_EMULATION=1 -sGL_UNSAFE_OPTS=0 \
-sERROR_ON_UNDEFINED_SYMBOLS=0 \
-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,ENV,callMain,addRunDependency,removeRunDependency"
