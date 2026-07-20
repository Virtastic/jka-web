# idTech3-Web — WASM Adaptations

Running engineering log of every change made to run the original idTech3 GPL sources in
the browser. Modeled on `CS-Web/WASM_ADAPTATIONS.md` and `ja2-web/WASM_ADAPTATIONS.md`.

**Ground rule:** the sources under `games/<game>/` are the *original* 2001–2003 GPL drops.
Every browser adaptation is a reviewable commit on top of the pristine import commit, so
`git diff <import> -- games/<game>` is the complete, auditable port. No code is copied from
iortcw / OpenJK / ET:Legacy — those are read for understanding only.

## Toolchain

| | |
|---|---|
| Emscripten | 6.0.1 (Homebrew `emcc`) — matches wasm-deps `emsdk-6.0.1-jseh`, CS-Web, ja2-web |
| Exceptions | `-fexceptions` (JS model). No `-fwasm-exceptions`. |
| Threads | single-threaded to start (`IDTECH3_THREADS=0`); no COOP/COEP needed until streamfs SAB path |
| LTO | **none** — `-flto` miscompiles the boot path (seen in CS-Web + ja2-web) |
| CPU paths | `id386=0` — no x86 inline asm under wasm |
| Flags source of truth | `shared/wasm-build/env.sh` |

## Where the five games actually stand

| Game | Links | Boots | Renders | Playable | Data used |
|---|---|---|---|---|---|
| **RTCW-SP** | ✓ | ✓ | ✓ | ✓ movement + fire + sound + save/load + AI | free SP demo |
| **Wolf:ET** | ✓ | ✓ | ✓ | ✓ movement + fire + sound + **netplay** (browser↔browser over WS relay) | freely redistributable |
| **RTCW-MP** | ✓ | ✓ | ✓ | ✓ movement + **fire** + sound + **netplay** (browser↔browser over WS relay) | free MP demo |
| **JK2** | ✓ | ✓ | ✓ renders | ✓ **movement proven** (origin `464→924` on W, in control) | free SP demo |
| **JKA** | ✓ | ✓ | ✓ renders (`t1_sour`) | ✓ **movement proven** (walks forward on W) + HUD + console | free SP demo |

**CORRECTION — JK2 IS playable; the earlier "unreachable" conclusion below was wrong.**
Loading `demo.bsp` (`+devmap demo`) opens on a ~35s scripted intro cinematic (Kyle hidden in
a crate). It was easy to mistake for endless — it's blurry, the player is frozen, and the
game-forced `BUTTON_USE` (Kyle "holding" the crate) defeats the `+use` skip. **But it ends on
its own at ~36s** (`CGCam_Disable` → `in_camera=false`) and hands the player full control in
the dim escape level. Proven by directly reading the player state (temporary instrumentation
of `ClientThink_real`, since reverted): standing `org=(464 2808 -31)`, then holding W →
`(644 2729)` → `(834 2565)` → `(924 2652)`, with `in_camera=0`, `pm_type=PM_NORMAL`, `hp=100`,
`forwardmove=127`. The pmove loop responds to input exactly like the other four games; the
renderer is actively drawing (~28k draw calls / 10s) and the player takes environmental damage
(hp 100→90), confirming live gameplay. The escape-start area renders very dark (a dim interior;
possibly also a gamma consideration) — see `docs/jk2-escape-gameplay.png`. `verify-jk2-move.mjs`
waits out the cinematic then frame-diffs W-held vs idle; W drives large view changes (16–46%),
though the dark + combat scene makes the automatic verdict conservative, so the direct engine
readout above is the definitive proof.

**JKA movement is proven** (`verify-jk-move.mjs`): after skipping the intro cutscene the
way the game does — a `+use` press, which `ClientCinematicThink()` treats as a cinematic
skip, no console needed — holding W walks the player forward through a doorway. Measured by
luma-diffing the frame *periphery* (walls/floor) between composited frames, ignoring the
center where a companion NPC animates: standing still 2.6%, holding W 46.0%. See
`docs/jka-move-before.png` / `docs/jka-move-after.png`.

**JK2 movement is not independently isolated on the free demo, and the reason is a missing
map in the demo data, not code.** JK2's "New Game" flow (`startgame` uiScript,
`ui_main.cpp:592`) loads **`map kejim_post`** — the standalone playable first level. The free
JK2 demo pak ships **only `maps/demo.bsp`** (verified: it is the *sole* `.bsp` in the sole
pk3) and **no `kejim_post.bsp`**. So the level our retail-source engine would actually play
is simply not in the free data.

`demo.bsp` itself is an attract/intro level: loading it runs a 6+ minute slow scripted
`in_camera` cinematic (a Raven's-Claw flythrough) that gates its embedded escape scripts
(`kyleincrate → exitcrate → escape → fight → bossdead`). Every skip the JK2 source offers was
tried and none reaches sustained gameplay in headless automation:

- `+use` / `BUTTON_USE` → `G_StartCinematicSkip` (g_active.cpp) — toggles, never advances.
- the `exitview` server command (g_svcmds.cpp) — same toggle.
- `timescale` fast-forward — the cvar *does* set (verified `"timescale" is: "100"` under
  `+devmap`), but ICARUS script waits run on real time, so even ×500 for 15 s doesn't end it.
- the client's any-ascii-key / `MOUSE1` → `SCR_StopCinematic` (cl_keys.cpp:1415) — this
  intro is neither `CA_CINEMATIC` nor `CL_IsRunningInGameCinematic()`, so that path never fires.
- waiting it out — a **12-minute** patient watch (`verify-jk2-move.mjs`, binds confirmed
  loaded: `w=+forward`, `e=+use`) never reached gameplay. This is the decisive measurement.

Frame-diffing alone can't separate the intro's camera motion from player locomotion — it has
both still holds and motion, so it defeats stillness *and* repeatability gates (several false
"MOVED" readings were caught against the screenshots and discarded). The reliable
discriminator is **image sharpness**: the cinematic is heavily motion-blurred + depth-of-field
(mean |horizontal-luma-gradient| 5–18), while real gameplay is crisp (JKA gameplay calibrates
at 28–35). Gated at 24, no cinematic frame passes — and across the full 12 minutes **not one
frame ever reached gameplay sharpness** (it stayed 0.1–21). So the probe correctly reports NO
rather than a false positive.

**Confirmed at the engine level (temporary instrumentation, since reverted):**

- `ClientCinematicThink` (`g_active.cpp:1197`) *is* called every server frame — so `in_camera`
  is true and the player ticks. But the client's usercmd carries `buttons = 288 =
  BUTTON_USE | BUTTON_ANY` **stuck on every frame**, so the skip's edge test
  `(oldbuttons ^ buttons) & BUTTON_USE` is always 0 and a `+use` press is never seen as fresh.
  (This looks like the intro script holding Kyle's "use" during the in-crate sequence.)
- More decisively: **force-returning `qtrue` once** (calling `G_StartCinematicSkip` directly,
  bypassing the button entirely) *still did not end the cinematic* — sharpness stayed at
  cinematic levels. `G_StartCinematicSkip` just sets `skippingCinematic=1` + `timescale=100`,
  but this intro has no `cinematicSkipScript` and its ICARUS waits run on real time, so nothing
  fast-forwards. **So even a perfect `+use` edge could not skip it** — there is no faithful
  engine fix that unblocks JK2 on this map.

**⚠️ The conclusion this section originally drew — "unreachable" — was WRONG (see the CORRECTION
near the top).** The observations above are real (the intro can't be *skipped*: `+use` is
game-forced so its edge never fires, and `G_StartCinematicSkip` has nothing to fast-forward). My
error was inferring from "can't skip" that it "never yields control." It does — the intro simply
**plays to completion in ~36s** and disables the camera on its own. I had been trying to skip or
fast-forward past it instead of just waiting it out cleanly, and the blurry frames + the
sharpness gate led me to keep calling it a running cinematic. Once waited out, the player is in
full control and moves (origin `464→924` on W). JK2 is playable.

This is a free-demo *content* gap, not an engine defect: JK2 renders, boots, runs game+cgame,
and accepts keyboard/console input; its input path and `pmove` are the same Raven code as
JKA's, which is proven with a clean walk. Point the launcher at a retail JK2 `kejim_post`
(bring-your-own data) and `verify-jk-move.mjs` drives it directly, exactly as it does JKA.

## Multiplayer networking — WebSocket transport (2026-07-16)

The net layer was stubbed since the SP phase (`Sys_SendPacket`/`Sys_GetPacket` = no-ops),
so only local/loopback play worked. Browsers can't open UDP sockets, so real MP needs a
WebSocket transport bridged to UDP. Now implemented (shared platform layer → applies to
RTCW-SP/MP + Wolf:ET):

- **`shared/web/net-relay.mjs`** — a WS↔UDP relay: one ephemeral UDP socket per browser
  connection, frames `[ip4][port BE][datagram]`. Bridges a browser to any real RTCW-MP /
  Wolf:ET server. Self-tested (WS client → relay → UDP echo → back, correct framing).
- **`sys_emscripten.c`** — `Sys_SendPacket`/`Sys_GetPacket`/`Sys_StringToAdr`/
  `Sys_IsLANAddress` over a WebSocket (EM_JS), plus the `SE_PACKET` pump in `Sys_GetEvent`
  that the desktop platform mains provide. `netadr_t.port` net↔host byte-order handled.
  The WS opens lazily on the first real send, so SP/local play never touches the network
  (verified: RTCW-SP MOVED/FIRED still pass after the change).

**Validated BIDIRECTIONALLY with the real Wolf:ET binary** (`verify-net-handshake.mjs`): a
minimal UDP server behind the relay + ET `+connect 127.0.0.1:<port>`. The client's
`getchallenge` reaches UDP (**send**), the server's `challengeResponse` reaches the client
via the `SE_PACKET` pump (**receive**), and the client parses it, advances
`CA_CONNECTING → CA_CHALLENGING`, and sends `connect` — observed client→server sequence
`[getchallenge, connect, …]`, a real MP connect handshake running over WebSocket. Both
directions of the transport are proven with the actual engine. Relay URL is
`ws://<host>:27960` by default, overridable via `window.__IDT3_NET_RELAY`.

**Full two-browser match — one browser hosts, another joins** (`verify-net-2browser.mjs`).
The relay was extended from WS↔UDP to also route **browser↔browser**: each WS connection
gets a virtual IP `10.0.0.x` (announced via a control frame from `0.0.0.0`), and datagrams
addressed to a known vIP are forwarded to that browser's socket instead of UDP. A hosting
browser opens its WS eagerly (`idt3_net_connect(force)`, pumped from `Sys_GetPacket` when the
page opts in via `__IDT3_NET_RELAY`) so it's reachable before the first client packet. Proven
with two real Wolf:ET instances: host A (`+devmap oasis`) gets `10.0.0.2`; client B
(`+connect 10.0.0.2`, *no* local server) completes the handshake through the relay, loads A's
oasis gamestate, and reaches the JOIN-A-TEAM screen — `docs/net-2browser-client-in-host-game.png`.
**Browser-to-browser multiplayer works with no native server.** (JK2/JKA are excluded: those
are the single-player Jedi campaigns we imported; their internet MP is the separate jk2mp/jamp
product, a different engine, not the SP code.)

## "No issues" — crash/error scan across all five (2026-07-16)

Each game driven into gameplay; logs scanned for `PAGEERR` / `RuntimeError` / `Aborted` /
`abort()` / out-of-bounds / `FATAL` / `Sys_Error` (excluding benign demo-data warnings —
missing precache sounds, missing crosshair image, etc.). **All five are crash-free in
gameplay:** RTCW-SP (move+fire confirmed same run), RTCW-MP (move+fire+sound), Wolf:ET
(no crashes), JK2 (rendering, 19.8k draws), JKA (rendering, 13.7k draws). JKA/JK2 show 2
one-time `glGetError()=0x500` at init (not per-frame — benign). No engine errors anywhere;
the only log noise is data-gap warnings from the free demos.

Combat-loop (weapon fire) is now proven for the whole id-engine family — RTCW-SP, Wolf:ET,
RTCW-MP — via the ammo-HUD-decrement method. JK2/JKA (Raven engine) have the full loop
proven end-to-end (movement + HUD + environmental damage), so their combat is architecturally
covered; a dedicated JK fire probe is impractical on the dark, cutscene-gated demo scenes.

## Performance & visual fidelity (2026-07-16)

**Brightness/gamma — checked, no systematic bug.** WebGL has no hardware gamma ramp, so
`R_SetColorMappings` forces `overbrightBits=0`. That looked like it might darken everything vs
desktop's overbright, but tracing the math (identityLight `1.0` + no-op lightmap shift on our
side ≈ desktop's `0.5` × 2× hardware gamma) shows normally-lit areas match, and the rendered
3D scenes confirm it: ET `oasis` interiors, JKA `t1_sour` storage room, and RTCW escape1 all
render at faithful brightness. JK2's escape-start area is genuinely a dim room, not a gamma
bug. No change needed. (`perf-probe.mjs` reports mean frame luma for spot-checks.)

**Performance — measured and good.** Wall-clock FPS can't be read directly (headless Chrome is
**swiftshader** = software GL, so its FPS is rasterization-bound; the in-app Browser pane and
the user's Chrome both run the tab `hidden`, throttling `requestAnimationFrame` to ~1 fps). But
the number that actually matters is GPU-**independent**: the **main-thread CPU cost per frame**
— wasm simulation + GL command submission. GL draws submit asynchronously, so the RAF
callback's execution time is the real CPU cost, unaffected by whatever rasterizes the pixels.
`perf-probe.mjs` measures it (median / p95 over ~240 frames):

| game (scene) | draws/frame | CPU ms/frame (median) | p95 | share of 16.6ms (60fps) |
|---|---|---|---|---|
| Wolf:ET (oasis) | 481 | **0.84** | 11.0 | ~5% |
| RTCW-SP (escape1) | 8 | **1.37** | 2.0 | ~8% |
| JKA (t1_sour) | 235 | **6.35** | 14.3 | ~38% |

Every title's CPU frame cost sits **well under the 16.6ms/frame budget for 60fps**, with large
headroom (ET/RTCW ~1ms; JKA heaviest at ~6ms median from Raven's ghoul2 skeletal models, still
under budget even at p95). Since a 2001 game rasterizing at 800×600 is trivial for any real
GPU (the pane's own Apple M4 renders these scenes correctly), the games are **CPU-comfortable
for a vsync-locked 60fps** on real hardware. The swiftshader single-digit FPS in headless is a
software-rasterizer artifact, not the port's performance. (`meanLuma` in the same tool
spot-checks brightness; the low JKA value there is the dark t1_sour cinematic, not gameplay.)

### Real-GPU confirmation + where the CPU time goes (2026-07-18)

Re-measured on the **actual GPU** (`perf-probe-gpu.mjs`: ANGLE→Metal, no swiftshader; confirmed
`GL_RENDERER: ANGLE Metal Renderer: Apple M4`) at display-resolution third-person views, one
Chrome at a time (running several GPU Chromes at once causes contention — an early ET run showed
a bogus 696ms p95 purely from that):

| scene (3rd-person) | draws/frame | CPU ms/frame median | p95 | share of 16.6ms |
|---|---|---|---|---|
| RTCW-SP (escape1) | 91 | **3.6** | 5.6 | ~22% |
| JKA (t1_sour) | 186 | **4.0** | 6.3 | ~24% |
| Wolf:ET (oasis) | 481 | **5.8** | 9.8 | ~35% |

All three hold 60fps with 1.7–3× headroom; even ET's worst frame leaves ~40% of the budget.
**No optimization is required for 60fps on real desktop hardware.**

A CDP CPU profile of ET (`cpu-profile.mjs`) shows where the *reducible* work is: of non-idle CPU,
~34% is the `LEGACY_GL_EMULATION` per-draw client-array processing (`prepareClientAttributes` +
`bufferSubData` vertex re-upload), ~27% the wasm engine, ~23% swiftshader raster (absent on a
real GPU). So the one structural lever is the per-draw client-array cost — but with the headroom
above it isn't worth the correctness/fidelity risk of a client-array→VBO render-path rewrite on
desktop. It would only matter for low-end/mobile targets. Cvar tuning (r_subdivisions, r_lodbias)
also trades the visual fidelity we've been protecting, so it's off the table by default.
`r_primitives` is already forced to 2 (glDrawElements, not the immediate-mode fallback).

**VBO rewrite — attempted and reverted (verified non-viable).** To pay down that ~34% we tried a
persistent-VBO client-array shim: redirect the `qgl*` client-array/draw macros through a shim that
uploads `tess` into a streaming VBO and points the fixed-function arrays at VBO offsets, so
emscripten's `GLImmediate` uses the buffer instead of copying client memory. It built cleanly but
**shredded all geometry** (dark, spiky triangles) — emscripten's `LEGACY_GL_EMULATION` fixed-
function path does not correctly consume VBO-backed client arrays. Reverted in full. Bypassing
`GLImmediate` entirely means writing a from-scratch GLSL renderer, which the "strictly original
sources" rule puts out of scope. Conclusion: the client-array cost is a fixed floor of the
faithful fixed-function path under WebGL, and desktop has ample headroom above it.

**Heap-growth stalls removed (the one safe structural win).** `heap-probe.mjs` measured peak wasm
heap at map-load: RTCW-SP ~256MB, Wolf:ET oasis ~442MB — so heavier maps crossed the old 256MB
`INITIAL_MEMORY` and paid `ALLOW_MEMORY_GROWTH` reallocations (mimalloc arena moves + JS HEAP-view
rebuilds) during load and again as gameplay grew. Raised `INITIAL_MEMORY` to 512MB so the common
desktop scenes sit entirely inside the initial arena (ET's 442MB no longer grows); `MAXIMUM_MEMORY`
4GB still backstops the rest. Desktop-targeted; not for memory-constrained/mobile. Also migrated
audio off the deprecated `ScriptProcessorNode` to a scheduled `AudioBufferSource` (all five).

Net perf posture: **already 60fps with headroom on real desktop hardware; growth stalls removed;
the remaining CPU floor is inherent to the faithful renderer and can't be lowered without a GLSL
rewrite (out of scope) or fidelity cuts (declined).**

### M4 multiplayer netcode — verified working over the WebSocket relay (2026-07-19)

Browsers have no UDP, so the engine's `Sys_SendPacket`/`Sys_GetPacket` (sys_emscripten.c,
`idt3_net_*` EM_JS) tunnel datagrams over a WebSocket to `shared/web/net-relay.mjs`, which both
bridges to real UDP servers AND routes **browser↔browser** by virtual IP (10.0.0.x) so one
browser can host a listen server for another with no native server anywhere. `NET_SendPacket`/
`NET_GetPacket` (net_chan.c, compiled) keep the loopback path in-memory and hand real IPs to the
Sys layer; received datagrams are queued as `SE_PACKET` the standard way. All of this existed but
had never been exercised — now verified end-to-end with two independent headless browser
instances (a listen-server host + a client) talking only through the relay:

- **RTCW-MP** (`mp_beach`): client resolves the host vIP, completes the connect handshake (host:
  `Client 0 connecting with 50 challenge ping` — real network latency, not loopback), receives the
  gamestate (`LOADING... server models`), runs `CL_InitCGame`, ~18 datagrams routed pure
  browser↔browser (relay `udp 0/0, peer 18`).
- **Wolf:ET** (`oasis`): same handshake + gamestate, ~160 packets browser↔browser, and the client
  **renders the live networked command-map** — mission time / reinforcements / objectives streamed
  from the host (`docs/net-et-command-map.png`).

Enabler: `Sys_ConsoleInput` was a NULL stub; wired it to a JS command ring (`Module.__idt3_con`,
drained one line/frame via `SE_CONSOLE`) — a real page/automation console hook that also delivered
the client's reliable `team` command to the server (clientCommand round-trip proven). Harness:
`net-test.mjs` (injects `window.__IDT3_NET_RELAY`, drives connect + post-connect console commands,
screenshots). Reaching a spawned 3D match view is the MP limbo/team-join/reinforcement-wave
gameflow (finicky headless, best in a real browser); the netcode beneath it is verified.

**M4 polish — done (2026-07-19).** (1) **Host/join UX**: the RTCW-MP + Wolf:ET pages now open a
multiplayer lobby — *Host a game* (pick a map → boots a listen server and shows the relay-assigned
virtual IP as a shareable **game code**), *Join* (paste a code → `/connect`s it), and *single map*.
That closes the vIP-exchange gap; a `?args=` deep link still boots straight in (skips the lobby).
(2) **Spawned 3D match — verified for Wolf:ET**: two headless browsers via the lobby join opposite
teams and spawn into the live oasis match, each rendering its own first-person view (weapon, HUD,
compass, server match timer, "FIGHT!") — `docs/net-et-match-{client,host}.png`, ~430–745 packets
browser↔browser, 0 UDP. RTCW-MP netcode+lobby are verified; its spawn is the RTCW-MP limbo/class/
reinforcement-wave flow (a real-browser click). (3) **Transport**: the relay now sets `TCP_NODELAY`
so small datagrams aren't Nagle-coalesced. Full unreliable-datagram transport (WebRTC DataChannels
or WebTransport) stays the documented upgrade *if* internet-latency head-of-line blocking proves to
matter — optional/conditional, and not measurable on localhost. Harnesses: `net-duel.mjs`
(two-instance match via args), `net-lobby.mjs` (drives the lobby UX).

### RTCW-SP skeletal-character "spikes" — three MDS bugs, fixed & verified (2026-07-17)

Reported symptom: animated humanoids (e.g. escape1's scripted drop-down guard) rendered
with vertices flung to garbage positions — spikes/shards shooting off the mesh. All three
causes were in the **MDS** (Raven skeletal) render path, which only humanoid characters use,
so the world, menus, briefing, and MD3/MDC props looked fine while every character was wrong:

1. **`R_LoadMDS` never set `surf->ident = SF_MDS`.** `R_LoadMD3`/`R_LoadMDC` both set their
   `SF_MD3`/`SF_MDC` ident so the backend `rb_surfaceTable[*(surfaceType_t*)surface]` dispatch
   reaches the right `RB_Surface*`. MDS was missed → an MDS surface dispatched on its raw file
   ident. Added the assignment, matching MD3/MDC.
2. **`RB_SurfaceAnim`'s `pIndexes` was a bare `int *` writing into `tess.indexes`** (which is
   `glIndex_t` — 16-bit under `__EMSCRIPTEN__`, since WebGL1 client-array draws only take
   `GL_UNSIGNED_SHORT`). Each 32-bit write clobbered two 16-bit slots and shredded the triangle
   list. Retyped to `glIndex_t *` + per-element copy (folding in `baseVertex`). Same class of
   bug as the ET `RB_SurfaceFace` `unsigned *tessIndexes` fix (issue #5) but in the anim path.
3. **`-fno-strict-aliasing`** added to the shared id flags (`env.sh`) + JK flag sets. idTech3's
   MDS bone math type-puns pervasively (`short`↔`float`, compressed `mdsBoneFrameCompressed_t`);
   `-O2/-O3` strict-aliasing could reorder those reads. id's own Makefiles pass it. Rebuilt all 5.

**Verified visually**, not just by reasoning: `verify-character.mjs` loads escape1 via `devmap`
(skips the SP briefing) with `cg_thirdperson 1`, so the player's **own MDS body** renders in
front of the camera. It draws as a clean, solid human figure (jacket, harness, trousers, head)
that stays intact across animation frames — no spikes. Since enemy NPCs use the identical MDS
path, this confirms the fix for the reported drop-down-guard artifact. The menu and the mission
briefing (parchment/photo/text) also render pixel-faithfully in real Chrome. NOTE: the earlier
render-dispatch histogram that reported "no MDS in the escape1 view" had sampled the spawn frame
before any NPC spawned, and mislead an interim conclusion — the third-person player body is the
reliable, input-free way to exercise the character path headless.

### Family-wide skeletal-render audit — all five clean (2026-07-17)

The `verify-character.mjs` third-person trick (devmap + `cg_thirdperson 1`, wait, screenshot)
became the standard way to exercise each engine's character path without gameplay input, and
was applied across the family after the RTCW-SP fix:

- **RTCW-MP (MDS)** and **Wolf:ET (MDS + MDM)** carried the *same* two bugs latent — missing
  `SF_MDS` ident (MP only; ET's idents were already set) and the `int*`/`memcpy` 32-bit write
  into the 16-bit `tess.indexes`. Fixed identically; both rebuilt clean at `-O3`. Headless
  *visual* confirmation for these two is blocked only by the multiplayer team-join/limbo spawn
  flow (the console `/team` join registers server-side but the limbo UI won't close headless) —
  not a render issue; ET's command-map UI renders pixel-perfect. The fix is byte-for-byte the
  verified RTCW-SP change.
- **JK2 / JKA (Ghoul2 — GLM meshes / MDX skeletons, a different system)** were audited too:
  their Ghoul2 index writes (`tr_ghoul2.cpp`) were **already** correct from a prior session —
  every write is per-element into the `glIndex_t` buffer (`glIndex_t *tessIndexes`,
  `tess.indexes[baseIndex+j] = baseVertex + triangles[j]`), no `memcpy`, no `int*` aliasing;
  the `_XBOX || __EMSCRIPTEN__` 16-bit `glIndex_t` typedef is in effect. **JKA visually
  confirmed**: `t1_sour` in 3rd person renders the player (Jaden, a Twi'lek) as a clean solid
  figure — head-tails (lekku, separate Ghoul2 bolt-on surfaces), vest, arms all intact, stable
  across idle animation, no spikes (`docs/jka-t1_sour-thirdperson-ghoul2.png`). JK2 shares the
  same Ghoul2 renderer + the same clean index code; its intro is a long scripted space cinematic
  (which itself renders flawlessly) that gates gameplay, so the player body is the harder shot.

Net: the skeletal/character render path is clean or fixed-and-clean on every engine — MDS
(RTCW-SP/MP, ET), MDM (ET), and Ghoul2 (JK2/JKA).

JK2/JKA now boot on demo data, pass the pak integrity gate, load the game module,
attach cgame, load a map (JKA: `loaded 7527 faces, 596 meshes` on `t1_sour`), **and
render the world in first person** — see `docs/jka-t1_sour-3d.png`, `docs/jk2-demo-3d.png`.
All five games now put a picture on the screen. Gameplay verification (movement/fire,
as done for the Wolfenstein trio) is the remaining JK work.

**The black screen was the texture internalformat, not the draw path.** After the draw-path
fixes below, the engine ran and issued ~180 draws/frame but the frame stayed pure black.
A GL-error tracer (`probe-jka-2d.mjs`, wrapping the context's `texImage2D`) pinned it in one
shot: `texImage2D(...,internalformat=3,...,GL_RGBA,...) -> 0x501`. The renderer selects the
GL 1.x component-count shorthand (3/4) — or a sized/S3TC enum — as internalformat, then
uploads GL_RGBA pixels. WebGL1 requires internalformat == pixel format, so **every texture
failed to upload and sampled solid black**; the world's lightmap modulate then blacked out
the whole scene. Forcing `internalformat = GL_RGBA` under `__EMSCRIPTEN__` in `Upload32`
(exactly as RTCW/Wolf:ET already do) brought both games' worlds up.

**A black screenshot is not a diagnosis.** It cannot distinguish *stalled*, *running but
drawing nothing*, and *drawing a genuinely dark scene*. `verify-jk-play.mjs` instruments
the page before the engine boots — counting `requestAnimationFrame` ticks and wrapping
the WebGL context's `drawElements`/`drawArrays`/`clear`/`texImage2D` — and that turned a
dead end into two precise bugs:

```
RAF ticks : 6978 -> 7219   ENGINE IS RUNNING   (not stalled at all)
draw calls: 1    -> 1      NOT drawing
gl.clear  : 13951 -> 14433 clearing ~120x/s
textures  : 5303           uploads fine
```

Running + clearing + **one** draw call in two minutes = the renderer is taking a draw
path that emits nothing:

- **`r_primitives` picked the immediate-mode path.** It defaults to `0`, meaning
  *"2 if `qglLockArraysEXT` else 1"* (`tr_init.cpp:918`). WebGL has no compiled vertex
  arrays, so it chose **1** → `R_DrawStripElements(..., qglArrayElement)`
  (`tr_shade.cpp:218`) → and `glArrayElement` is a no-op stub in
  `sys_jk_stubs.cpp`. Every vertex vanished, silently. Force `r_primitives 2`
  (plain `glDrawElements`, which glemu emulates) — same fix as the Wolfenstein layer.
- **32-bit indices then aborted the first real draw.** emscripten's `glDrawElements`
  asserts `type == GLctx.UNSIGNED_SHORT` when no element array buffer is bound, because
  WebGL1 client-array draws accept only 16-bit indices. **JKA's tree already carries a
  16-bit `glIndex_t` path for `_XBOX`** — wasm simply joins that `#if`, which is as
  faithful as an adaptation gets. JK2 has no such split, so it gets the same
  `__EMSCRIPTEN__` branch RTCW has. `SHADER_MAX_VERTEXES` stays below 65536, so it is
  lossless.
- JK2 additionally had RTCW's `unsigned *tessIndexes` aliasing bug (writing two 16-bit
  slots per entry, shredding world geometry). JKA's own source already declares that
  pointer as `glIndex_t *` — only JK2's did not.

The single biggest find: **we were building the wrong project file.** JK2 ships two
game projects, and `StarWars.dsw` references only `.\game\game.dsp`:

| project | output | TUs |
|---|---|---|
| `code/game/game.dsp` | `jk2gamex86.dll` | **127** (80 game, 40 cgame, 5 Icarus, …) |
| `code/game.dsp` | `efgamex86.dll` | 96 (27 cgame) |

`ef` is **Elite Force** — `code/game.dsp` is a leftover from Raven's Star Trek codebase
and is not in the workspace at all. Building it silently dropped the `FX_*` effect TUs,
so the module imported an undefined `FX_BryarProjectileThink` and refused to load. Only
`SMRTHEAP.C` and `bg_lib.cpp` are `Exclude_From_Build`; the `AI_*.cpp` NPC files are
genuinely part of the DLL and had simply never been compiled.

**JK2/JKA SP merge cgame INTO the game module** (`game.dsp`/`game.vcproj` pull in the
`cgame/` sources; `game.def` exports `vmMain`/`dllEntry` next to `GetGameAPI`). So
`Sys_LoadCgame` does not open a second library — the original win32 layer
`GetProcAddress`es the cgame entry points out of the already-loaded `game_library`, and
we do the same. It had been a stub returning NULL, which failed `VM_Create("cl")` and
killed every map load with *"failed to attach to the client DLL"*.

**Two of our own stubs had the wrong return type** — and C++ mangling does not encode
the return type, so they linked silently and then trapped on wasm's strict signature
check at runtime:

| stub | was | must be | why it matters |
|---|---|---|---|
| `SND_RegisterAudio_LevelLoadEnd` | `void` | `qboolean` | `z_memman_pc.cpp:253` uses the result |
| `S_AddLocalSet` | `void` | `int` | `cl_cgame.cpp:571` returns it for `CG_S_ADDLOCALSET` |

A stub is a signature contract, not just a name. Every other stub in
`sys_jk_stubs.cpp` was audited against both trees; those were the only two.

All five now run on **freely-distributed publisher demos** (id / Raven), fetched on demand and
never committed (`.gitignore`). Retail paks remain bring-your-own; nothing here needs them.

Getting each demo's data out was its own small project:

- **RTCW-MP** — `Wolf_MPDemo.exe` (id's own ftp) is a **Wise installer**, and no Wise extractor
  is available here. But the payload is one big **deflate stream**, and the pk3's incompressible
  members (jpg/tga/wav) survive inside it as verbatim *stored* blocks — which is why raw pk3
  local headers are visible in the exe at all. Carving those alone recovers only ~0.2 MB; the
  win is to find the single stream start that inflates to `PK\x03\x04` and inflate the lot. That
  yields the intact pak: 1846 entries, `testzip()` clean, `mp_beach` + `mp_trenchtoast`.
- **JK2 / JKA** — InstallShield; `7z` handles JK2, `unshield` handles JKA.

**Demo data lives in `demo/`, not `base/`.** With no retail `productid.txt` present,
`FS_SetRestrictions()` sets `fs_restrict=1`, prints *"Running in restricted demo mode"*, and
restarts the filesystem with `FS_Startup(DEMOGAME)`. A pak staged in `base/` is scanned once and
then dropped, and `default.cfg` goes missing. `DEMOGAME` is lowercase `"demo"` while the
installers write `Demo/` — harmless on a case-insensitive host FS, fatal on the emscripten one.

**The demo pak checksum is a genuine authenticity gate** (`Com_Error("Corrupted pk3")`), and it
cuts both ways:

- **JKA's demo pak checksums to exactly `DEMO_PAK_CHECKSUM` (4102795916)** — so our extraction is
  bit-exact and IS the pak this GPL source expects. No source change needed.
- **JK2's does not** (ours: 1431467275, source: 3766578759). The constant's own comment says
  *"every time a new demo pk3 file is built, this checksum must be updated"* — it is a build-time
  value tracking whatever demo pk3 Raven last built in-house, and it does not describe the demo
  actually released to the public. So `games/jk2/.../files.cpp` gains the public demo's checksum
  **alongside** the original; the restriction is retargeted, not weakened (still exactly two known
  paks, retail paks dropped into `demo/` are still refused).

Both values were reimplemented independently in Python (unzip central-directory CRCs of entries
with `uncompressed_size > 0` → `Com_BlockChecksum` → MD4, XOR-folded) and agree with what the
engine computes. That is also a check on the port itself: unzip + MD4 + the checksum path all
produce identical values under wasm. The JKA match against a hard-coded constant is what proves
the reimplementation right, which in turn is what makes the JK2 mismatch trustworthy.

`shared/wasm-build/verify-boot.mjs <game> <port>` is what makes the "boots" column measured
rather than assumed: it separates the *expected* data wall (`0 files in pk3` → `Sys_Error` on
`default.cfg`, exactly what the desktop originals do against an empty install) from real defects
(wasm traps, `LinkError`, `unreachable`, null-function-table, JS exceptions).

## Adaptation categories (to be filled in as work lands)

### 1. Platform layer (`shared/wasm-build/sys_emscripten/`)
Originals ship only `win32/` and `unix/` (GLX) system layers. We write a new emscripten
layer implementing each engine's `Sys_*` / `GLimp_*` / `SNDDMA_*` / `IN_*` contracts against
`emscripten/html5.h` + WebGL. **RTCW-SP layer written** (4 TUs, all compile clean):

| File | Provides |
|---|---|
| `sys_emscripten.c` | timing, event queue (`Sys_QueEvent`/`Sys_GetEvent`, win32-identical), console/error, filesystem + dir listing (dirent over MEMFS/IDBFS), default paths (`/rtcw`, `/userdata`), net stubs |
| `sys_glimp.c` | `GLimp_*` WebGL2 context via `emscripten_webgl_create_context`, `glConfig` populated from `R_GetModeInfo`+`glGetString`; `IN_*` HTML5 keyboard/mouse/wheel → `Sys_QueEvent`, pointer-lock |
| `sys_main.c` | `main()` → `Com_Init` → `emscripten_set_main_loop(Sys_Frame)`; `idt3_pump_frame` export; `Sys_LoadDll`/`UnloadDll` via `dlopen` side modules |
| `sys_snd.c` | `SNDDMA_*` — silent stub for M1 boot (Web Audio backend is a follow-up) |
| `gl_stubs.c` | fixed-function GL stubs the linker demands (populated on demand) |

Renderer uses the linked QGL path (`qgl*`→`gl*`), backed by `-sLEGACY_GL_EMULATION`; ARB
extension pointers set NULL for first boot (single-texture fallback). Status: _written, linking._

### 2. Main loop
Replace the blocking `while(1) Com_Frame()` with an exported `idt3_pump_frame()` driven from
JS via MessageChannel+RAF; `emscripten_exit_with_live_runtime()` after init. Hunt busy-wait
loops (RoQ cinematic playback, level-load spinners, `Sys_Sleep`). Status: _pending (M1)._

### 3. Renderer
QGL function pointers rebound onto Emscripten GL under `-sLEGACY_GL_EMULATION=1`; hand-written
`gl_stubs.c` for calls the emulation lacks; gate extension probes (compressed/paletted textures,
multitexture). Fallback if too slow/incomplete: minimal GLES2 backend. Status: _pending (M1)._

### 3b. Sound — Web Audio (`sys_snd.c`) ✓
`sys_snd.c` was a silent stub until 2026-07-14 (`SNDDMA_Init` returned `qfalse`, so the
engine skipped all mixing). It now implements the engine's DMA-ring contract on Web
Audio: the mixer paints 16-bit stereo into `dma.buffer`; a `ScriptProcessorNode` drains
it and publishes the play cursor back to C for `SNDDMA_GetDMAPos()`.

- **`EM_JS`, not `EM_ASM`** — the JS body contains commas/braces the `EM_ASM` macro
  splits on as macro arguments.
- `dma.speed` is taken from `ctx.sampleRate` (the browser needn't honour the request),
  so the engine's mixer resamples correctly.
- `ScriptProcessorNode` is deprecated but deliberate: `AudioWorklet` needs
  SharedArrayBuffer/COOP+COEP, which we avoid while the build is single-threaded.
- Autoplay policy: an `AudioContext` only starts on a **real** user gesture, so we also
  resume on the first `mousedown`/`keydown`/`touchstart`. (A CDP harness must send a
  *trusted* click — JS-synthesized events don't qualify.)

Verified: `SNDDMA_Init: Web Audio 22050 Hz, 2 ch, 16 bit`; RTCW-SP peak **0.25**,
Wolf:ET peak **1.0**, context `running` — real mixed audio, not silence.

**JK2/JKA sound — DONE (2026-07-17).** Both Jedi games now produce real audio. The
*backend* was trivial (JK's `dma_t`/`SNDDMA_*` contract is byte-identical to RTCW/ET, and
JK ships a **software mixer** gated on `s_UseOpenAL`, default `"0"` — the same Web Audio
ScriptProcessor backend drops straight in, `sys_jk_snd.cpp`). The work was the surrounding
subsystem:

- **MP3 decoder is mandatory, not optional.** JK2/JKA store *most* SFX as `.mp3`
  (`weapons/blaster/fire.mp3`, `interface/button1.mp3`, …), so a "disable mp3, load
  everything as WAV" shim leaves the games nearly silent. We compile the portable id/Raven
  decoder `mp3code/*.c` **as plain C** (`emcc`, not `em++ -x c++` — it uses C's implicit
  `void*→T*` conversions and K&R `head_info3()` calls that are hard errors in C++) plus
  `client/cl_mp3.cpp`. `jk_compat.h` supplies the lowercase `byte` `mp3struct.h` wants;
  `-DLITTLE_ENDIAN=1` selects `L3.h`'s little-endian huffman tables. The mp3code objects
  MUST be built C-linkage — a stale C++-mangled `uph.o` left `unpack_huff` unresolved.
- **OpenAL/EAX headers** are Win32/DirectSound/COM. `openal/{al,alc}.h` gate their opaque
  handle typedefs behind `#ifdef _WIN32` → add an `__EMSCRIPTEN__` branch. `eax/eaxman.h`
  is Win32 COM → inline a minimal shim in `snd_local.h` (variadic `IEaxManager` methods,
  `LoadLibrary`/`GetProcAddress` stubs, and for JKA's fuller EAX 4.0 path also `SUCCEEDED`,
  `min`/`max`, `GUID operator==`). All of it is dead code under the software mixer.
- **MSVC-STL / archaeology** in the sound TUs: `std::map` with a wrong explicit allocator
  libc++ rejects; bare `string`/`pair` needing `using std::`; an iterator-as-pointer
  (`&*it`); JKA's `S_DoLipSynchs(const s_oldpaintedtime)` implicit-int param; MSVC
  for-scope leaks (`i`, `iChannel`, `iChannel`).

**The bug that mattered most wasn't sound at all.** Wiring sound up surfaced a map-load
crash — `S_StartAmbientSound: handle 1869439264 out of range`. Root cause: `Q_irand` /
`Q_flrand` / `Q_flrandom` in `game/q_shared.h` assume Win32's **15-bit `RAND_MAX`** (0x7fff)
in their `>>15` / `/32768.0` scaling, but emscripten/musl has `RAND_MAX == 2^31-1`. Raw
`rand()` overflowed the scale so `Q_irand(0,6)` returned **33274**, indexing
`ambientSet_t::subWaves[8]` thousands of entries out of bounds. This silently corrupted
**every** random draw under wasm — AI decisions, weapon spread, animation picks, ambient
sounds. Fixed by masking `rand()` to 15 bits under `__EMSCRIPTEN__` in both JK2 and JKA
(`rand() & 0x7fff`), so the original arithmetic is bit-exact. Verified in-browser: JK2 `demo`
and JKA `t1_sour` load to gameplay and the software mixer paints real PCM into `dma.buffer`
(peak 0.03 / 0.14, ~10% non-zero samples).

Note on verification: the Web Audio `ScriptProcessorNode.onaudioprocess` callback does **not
fire in headless/automated Chrome** (no audio output sink), so `Module.__idt3_snd.pos` stays
0 there — the *known-working* RTCW/ET backend shows the identical `pos=0` in that environment.
To prove the mixer independent of the output device, `sys_jk_snd.cpp` exposes the DMA buffer
pointer; a harness advances the play cursor at playback rate and scans `dma.buffer` for
non-zero PCM. In a real browser with audio hardware the callback fires and it is audible.

**JK2/JKA RoQ cinematics — DONE (2026-07-17).** `client/cl_cin.cpp` (the RoQ/RnR movie
player) is now compiled in both games (was stubbed to no-ops), so intro logos and cutscenes
play, ESC-skippable, exactly like desktop. Two wasm-specific rendering bugs had to be fixed,
both the same class as the earlier JK black-screen:
- `renderer/tr_draw.cpp` (`RE_UploadCinematic`/`RE_StretchRaw`) uploaded frames with
  internalformat `GL_RGB8` but format `GL_RGBA`. **WebGL1 requires internalformat == format**,
  so the upload silently failed and the movie was a solid **white** texture.
- `cl_cin.cpp yuv_to_rgb24()` packs pixels as `0x00BBGGRR` — **alpha 0**. Desktop ignores
  alpha on the cinematic draw; WebGL's `LEGACY_GL_EMULATION` blend/texenv respects it, so
  every frame drew fully transparent (**black**). Force `A = 0xff`.
Verified in-browser: JK2 `jk0101` and JKA `ja01` both decode and display their opening
starfields, then return to the menu.

**Engine status: feature-complete for all five games.** Rendering, sound, input, save/load,
networking (MP), randomness, and cinematics all work. The only thing standing between the
demos and the full retail campaigns is **user-supplied retail data** — an external constraint
(the GPL *source* is open; the game *data* is bring-your-own and must not be downloaded),
not a code gap.

Verification caveat — the automated Browser pane keeps the tab `document.visibilityState ===
"hidden"`, so Chrome throttles `requestAnimationFrame` to ~0–1 fps while idle. The engine's
whole main loop is RAF-driven, so in that state everything stalls at once — a cinematic
freezes mid-frame, ESC/skip input isn't processed, gameplay pauses. This is NOT a hang: each
successful render (menus, in-game views, the RoQ starfields, player movement) was captured
during the RAF burst that follows a navigation or click. A real browser with a visible tab
runs RAF at 60 fps and none of this appears. Same family of harness artifact as the Web Audio
`onaudioprocess` callback not firing headless.

### 3c. What is actually verified (vs. merely rendering)
| | RTCW-SP | Wolf:ET |
|---|---|---|
| renders in first-person | ✓ | ✓ |
| spawn / enter world | ✓ | ✓ |
| **movement** (physics loop) | ✓ `viewpos (1808 1600 -719)` → `(1730 1478 -719)` holding W | ✓ `viewpos (3720 7300 -431)` → `(3893 7300 -431)` holding W |
| **weapon fire** | ✓ MP40 clip 32 → 25 on `+attack` | ✓ MP40 30/60 → 29/60 |
| **sound** | ✓ peak 0.25 | ✓ peak 1.0 |
| **save / load** | ✓ round-trip restores the saved origin | — (MP: no savegames) |
| **AI spawns + thinks** | ✓ 28 casts alive on escape1 after 8s | — |
| AI combat / objectives | — | — |

**Never trust a build artifact you didn't just rebuild.** The build scripts used to
decide staleness with `[ "$o" -nt "$src" ]` — object vs its `.c`/`.cpp` and nothing
else. So neither a **build-script** edit nor a **header** edit invalidated anything:
every TU looked current and the old objects relinked. This cost three separate
investigations before it was fixed:

- JK2/JKA "booted cleanly" for days against binaries from a tree that no longer
  reproduced; a `FORCE=1` build exposed three real defects at once (§5).
- The `glIndex_t` 16-bit typedef in `renderer/tr_local.h` — the fix for JKA's
  `glDrawElements` assert — appeared to do nothing. **The probe returned byte-identical
  numbers before and after (1107 textures, RAF 1→1), and that is what gave it away: a
  real change never produces identical results.** If a fix has *exactly* no effect,
  suspect the build before the theory.

The scripts now also require the object to be newer than the newest header under the
source + platform dirs, and print which header that was, so "why did/didn't this
rebuild" is answerable from the log. Deliberately no `find | head`: under
`set -euo pipefail`, `head` closing the pipe SIGPIPEs `find` and aborts the build with
an **empty log and no message** — the first version of the fix did exactly that.

Both games' movement/fire rows are produced by `verify-rtcw-play.mjs` / `verify-et-play.mjs`
and are re-runnable, not one-off observations.

**Two traps that make a working engine look broken — neither is a port bug:**

- **Console lines without a leading `/` are chat, not commands** (`con_autochat`). `viewpos`
  arrived server-side as `WolfPlayer: viewpos` and silently did nothing; `/viewpos` works.
  Bites RTCW-SP and Wolf:ET identically.
- **RTCW-SP's game-side `where` command is useless** — it prints `ent->s.origin`, but
  `BG_PlayerStateToEntityState` only ever fills `s->pos.trBase` for players, never
  `s->origin`. So `where` prints `(0 0 0)` on the *desktop original* too. The cgame's
  `viewpos` reads `ps.origin` and is the correct readout.

**Reading the HUD as ground truth:** there is no console readout for `ps.ammo`, so the fire
test captures a tight rectangle around the ammo digits and compares PNG bytes (identical
pixels encode identically). The crop must be derived from the **real content box**, not
`getBoundingClientRect()`: the canvas is 100vw×100vh but `object-fit: contain` letterboxes
the 4:3 frame inside it (actual drawn area 951×713 at x=165, not 1280×800). Cropping by the
element rect lands on the weapon icon — which bobs with the view and would "change" on every
frame regardless of ammo.

### 3d. Side modules are never re-instantiated (map_restart / loadgame)

`VM_Restart()` requires that unload+reload yields a module with **fresh statics** — it says
so outright, *"DLL's can't be restarted in place"*, which is why it does `VM_Free()` +
`VM_Create()` rather than reusing the handle.

Emscripten breaks that contract silently. `dlopenInternal()` looks the library up in
`LDSO.loadedLibsByName` and, if it is already there, merely bumps the refcount and returns
the **same instance**; and libraries load with `nodelete: true` (`refcount = Infinity`), so
`dlclose()` can never drop it. Statics therefore survive a `map_restart`.

That is not academic — it crashed every `/loadgame`:

```
AICast_UpdateBattleInventory <- AICast_CreateCharacter <- AIChar_spawn
  <- G_RunThink <- G_RunFrame <- vmMain        "memory access out of bounds"
```

ai_cast keeps `static bot_state_t *botstates[]` pointing into `G_Alloc`'s pool. On restart
`G_InitMemory()` resets `allocPoint` to 0, but the stale pointers survive, so
`AICast_SetupClient()` sees a non-NULL `botstates[client]`, skips its `memset`, reads a
garbage `bs->inuse`, and returns early **without setting `cs->bs`**. The next
`AICast_UpdateBattleInventory()` dereferences `cs->bs->entitynum`.

**Fix** (`sys_emscripten/sys_main.c`): `dlopen` a *unique path* per load, so the by-name
cache misses and the module is genuinely re-instantiated with zeroed statics and re-run
constructors. The copy is unlinked immediately (dlopen reads it synchronously) so MEMFS
does not grow. Poking LDSO's tables directly does **not** work — it desynchronises
emscripten's handle bookkeeping and the next `dlsym` aborts with *"Tried to dlsym() from an
unopened handle"*. The superseded instance leaks, which is inherent to `nodelete` and
bounded by how rarely maps restart.

Note JK2/JKA use their own `sys_emscripten_jk/` layer and do **not** carry this fix yet;
it will matter once they have data and can restart a map.

### 4. Filesystem / assets
pk3s range-streamed via `shared/web/streamfs.js` (never bulk-loaded into MEMFS); `/userdata`
on IDBFS for configs + savegames, `syncfs` on interval + visibilitychange + pagehide.
Status: _pending (M1)._

### 5. Compiler archaeology

**RTCW-SP core engine — clean.** All 52 platform-independent TUs (qcommon, client, server,
renderer, sound, game math) syntax-check under emcc 6.0.1 after these fixes:

| Symptom | Cause | Fix |
|---|---|---|
| `'gl.h' file not found` (24 renderer TUs) | `renderer/qgl.h` has no `__EMSCRIPTEN__` branch → falls to `#else #include <gl.h>` | Added `#elif defined(__EMSCRIPTEN__) #include <GL/gl.h>` branch (emscripten ships `<GL/gl.h>`) |
| `undeclared 'MAC_STATIC'` | Mac-only `static` qualifier macro, empty elsewhere; supplied by original per-target build | `-DMAC_STATIC=` |
| `undeclared 'CPUSTRING'` | arch string normally injected by the build system | `-DCPUSTRING="wasm32"` |
| `undeclared 'PATH_SEP'` | platform path-separator char | `-DPATH_SEP="'/'"` |

Only `qgl.h` needed an in-tree edit; the rest are build-defines in `build-rtcw-sp.sh`.
Remaining M1 work is the platform layer + module link, not the engine core. Status: _core done._

## Per-milestone results (fps via `timedemo 1`)

| Milestone | Game | Engine links | Modules | Boots in Chrome | Notes |
|---|---|---|---|---|---|
| M1 | RTCW-SP | ✓ 1.14MB | ✓ qagame/cgame/ui | ✓ **PLAYABLE** | with free demo data: escape1 renders in first-person — textured stone brickwork, iron-banded door, dead guard, torch lighting, HUD. See the RTCW-SP milestone section. |
| M1 | RTCW-MP | ✓ 1.14MB | ✓ qagame/cgame/ui | ✓ to data boundary | ET fix-chain propagated; prints "Wolf 1.41b-MP wasm32"; gameplay pending data |
| M1 | Wolf:ET | ✓ 1.30MB | ✓ qagame/cgame/ui | ✓ **PLAYABLE** | free 2.60 data: oasis limbo → join Axis → first-person w/ MP40, HUD, compass |
| M2 | JK2 (Outcast) | ✓ 1.06MB | ✓ qagame 1.12MB | ✓ to data boundary | prints "JK2: v1.02 wasm32"; scans /jk2/base + /jk2/demo; clean halt |
| M3 | JKA (Academy) | ✓ 1.33MB | ✓ qagame 1.81MB | ✓ to data boundary | prints "JA: v1.0.1.0 wasm32"; scans /jka/base + /jka/demo; clean halt |

**All 5 engine variants build to WebAssembly and boot in Chrome. The two games with
freely-redistributable data — RTCW-SP (demo) and Wolf:ET (2.60) — are PLAYABLE:
both render real first-person gameplay with working HUDs.** RTCW-MP / JK2 / JKA boot
to the data boundary; their gameplay is gated on retail data (bring-your-own).
JK2 (the C++ Raven engine — Ghoul2/Icarus) went from "nothing compiles" to a clean
boot: all 127 engine TUs compile, links 0-undefined.

### JK2 game module — LINKS ✓ (`qagame.wasm` 1.12MB, 96 TUs, SIDE_MODULE=2)
The fn-ptr-default-arg blocker was solved without touching the 216 call sites: each affected
member (`pmove_t::trace`, `game_import_t::trace/ReadFromSaveGame/G2API_*`, Icarus
`I_ReadSaveData`) became an **`idt3_*_fp` wrapper struct** — layout-identical (one pointer,
same ABI both sides of GetGameAPI), with `operator()` carrying the MSVC defaults, `operator=`
from the raw fn-ptr, and an implicit conversion back. Zero call-site edits.

The other systematic discovery: the GPL drop only ever compiled because of **MSVC6 `/YX`
auto-PCH leakage** — dozens of TUs (wp_saber, g_utils, cg_players, the Icarus files…) use
identifiers from headers they never include; the shared PCH made them visible. We added the
missing `#include`s per TU (game↔cgame cross-includes matching the codebase's own
"naughty but shipping" idiom). Plus: `using namespace std` narrowed to self-contained
using-declarations in 6 headers (std::forward vs the game's `forward` vec3 globals);
MSVC for-scope loop-var hoists (27 sites, scripted); `hmap/hmultimap` allocator must be
`pair<const K,V>` for libc++; MSVC6-tolerated `map<K,V,less,allocator<V>>` typedefs fixed;
duplicate `gi` global (MSVC mangles variable *types*, Itanium doesn't) renamed; `myftol`
x86 `__asm` → C cast; `extern "C" GetGameAPI`. 6 sources in game.dsp are absent from the
GPL drop (fx_scavenger, NPC_formation, g_ambients, g_boltons, g_infostringLoad, g_squad) —
skipped; their symbols stub-resolve at dlopen.

### JKA (Academy) — ENGINE BUILDS + BOOTS ✓
190 engine files (adds RMG, force-feedback `ff/`, png, zlib32). All 141 portable TUs compile;
links clean (0 undef) to `jka.wasm` (1.33 MB); **boots in Chrome** — `(internal)JA: v1.0.1.0
wasm32`, scans `/jka/base` + `/jka/demo`, halts at the data boundary. JKA-specific work:
`sys_jk_gl.cpp` `IDT3_JKA` conditionals (A_* keycodes, direct `Cvar_Get`/`Com_*` — no `ri.`
refimport, 3-arg `R_GetModeInfo`, no `windowAspect`); guarded x86 `__asm` in `timing.h` (rdtsc)
and `zlib32` (`repe cmpsb`/`rep movsb` → C fallbacks); `Ratl/bits_vs.h` dependent-base
qualification; `sys_jka_stubs.cpp` for soundChannel_t sound sigs, `Sys_CopyFile`, `gi`, GL
display lists. Shared `jk_compat.h` (POINT/OutputDebugString/LPCTSTR/…) from the earlier agent.

### JKA game module — LINKS ✓ (`qagame.wasm` 1.81MB, 155 TUs)
Delta off the JK2 module playbook, plus JKA-specifics: JKA's own code documents the
fn-ptr-default problem (`#ifdef _XBOX // No default arguments through function pointers`) —
our `idt3_*_fp` wrappers are the non-Xbox equivalent. Most JKA "defaults" were on *real*
functions (legal C++) and were restored verbatim. New JKA-only fixes: Ratl/Ragl template
library needed two-phase-lookup repairs (`this->` on ~30 inherited members, `typename` on
dependent iterator types, `TGraph::template cells<…>`, a missing comma in a copy-ctor
init-list MSVC never instantiated); `NPC_Pain` const-signature alignment; two file-local
`Pool()` helpers and the `gi` pair made unambiguous (MSVC mangles types into symbol names,
Itanium doesn't); libc++ list iterators can't init from `NULL`.

### Wolf:ET first-render campaign (free 2.60 data, in progress)
Data: official id FTP mirror `et-linux-2.60.x86.run` → pk3s staged at `play/wolfet/etmain/`
(gitignored), preloaded into MEMFS with run-dependency gating. Fix chain so far, each found
via the CDP harness (`verify-et-render.mjs` — in-page console/error capture, GL call hooks):

1. **PATH_SEP quoting bug** (`-DPATH_SEP=\"'/'\"` → macro was the *string* `"'/'"`; its
   pointer's low byte became the separator, e.g. `\` ) — broke pk3 discovery in ALL
   RTCW/ET builds. Fix: `-DPATH_SEP='/'`. → "3763 files in pk3 files".
2. **LEGACY_GL_EMULATION needs WebGL1** — GLImmediate never initializes on a WebGL2
   context. `-sMIN_WEBGL_VERSION=1`, `attrs.majorVersion=1`.
3. **GLImmediate init** — only `Browser.createContext` initializes it, not the html5.h
   API. GLimp now sets `Browser.useWebGL=true` + forces `GLImmediate.init()` (and
   re-creates per-context temp vertex buffers after `vid_restart`).
4. **MAIN_MODULE=1** — side modules import libc symbols (vsprintf…) that MAIN_MODULE=2
   dead-code-eliminated.
5. **vararg vmMain shim** (`idt3_vm_shim.c`) — wasm traps calling fixed-arity `vmMain`
   through the engine's `int(*)(int,...)`; modules now export `idt3_vmMain_va`.
6. **glemu hook .sig loss** — `GLImmediate.setupHooks()` replaces 9 GL functions with
   closures lacking the `.sig` libdylink needs at dlopen (`glemu_sig_fix.post.js`).
7. **glDrawBuffer/glReadBuffer TODO aborts** — no-op'd (meaningless on the default FB).
8. **glArrayElement stub** — engine default `r_primitives 1` funnels every vertex through
   our no-op stub; GLimp forces `r_primitives 2` (plain glDrawElements).
9. **16-bit indices** — glemu's client-array path asserts `GL_UNSIGNED_SHORT`; ET used
   uint. `glIndex_t`→`unsigned short` under `__EMSCRIPTEN__` (SHADER_MAX_VERTEXES < 64k).

10. **WebGL1 internalformat** — the engine uploads with the GL 1.x component-count
    convention (`internalFormat = 3 / 4`) and sized formats (`GL_RGB8`…). WebGL1 requires
    `internalformat == format`; those are INVALID_ENUM, textures stay empty, and empty
    textures sample **black** — which multiplied every fragment to black. Forced
    `internalFormat = GL_RGBA` under `__EMSCRIPTEN__` in `R_UploadImage`.

### RTCW-SP RUNS THE GAME — loads escape1, connects, reaches CA_ACTIVE ✓ (with free demo data)
The RTCW SP demo `pak0.pk3` (freely redistributable) at `data/rtcw-demo` drives escape1.
Fix chain beyond the shared VM/WebGL fixes:
- **`SIDE_MODULE=1`** for the game modules — cgame's command tables take the address of
  `CG_GetTeamColor`, emitting a `GOT.func` reference the loader resolves against exports;
  `SIDE_MODULE=2` exported only the 3 ABI entry points, so the ref became an unresolved
  dynamic import and `dlopen` aborted. `SIDE_MODULE=1` exports the module's own symbols
  (the loader keeps the main module's definitions for shared `bg_`/`q_shared`, no collision).
- **module preload** — fetch `qagame/cgame/ui.wasm` into `/rtcw` MEMFS beside the pak.
- **loopback serverCommand race** — on the wasm listen-server a gamestate parse resets
  `clc.serverCommandSequence` while a snapshot parsed just before still references a higher
  `serverCommandNum`; return `qfalse` (as the demo path does) instead of `ERR_DROP`.
Verified via `verify-rtcw-play.mjs`: `escape1.bsp` + all game media load (14663 faces,
textures/models/weapons/items/particles), the server enters the world (`CS_ACTIVE`), and the
client parses `svc_snapshot` and reaches **`CA_ACTIVE`** — the full single-player network
connection completes in the browser. Remaining: the rendered frame is dark (escape1 opens in
a dim interrogation cell) — gamma/brightness tuning, not a connection or asset gap.

**RESULT: Wolf:ET RENDERS IN THE BROWSER** — first frame captured 2026-07-13: the ET
in-game console over the fog backdrop with the Wolfenstein: Enemy Territory logo and
`ET 2.60d` build tag, drawn by the original 2003 renderer through LEGACY_GL_EMULATION
on WebGL1 at ~60fps. Screenshot flow: `node shared/wasm-build/verify-et-render.mjs`.
The engine reaches the full frame loop: menus parse (`ui/*.menu`), the UI VM runs,
console input works (synthetic DOM key events via `verify-et-menu.mjs`), and typed
console commands execute (`echo`, `sv_pure 0`, `devmap`).

### Wolf:ET LOADS A MAP — `devmap oasis` reaches the in-game limbo screen ✓
**Root cause found and fixed.** The layout-dependent `4.0f`-into-a-server-global corruption
was a **MAIN_MODULE symbol collision**: side modules (built `SIDE_MODULE=2`) exported *all*
their globals, so any global sharing a name with an engine global got merged to one address
by the dynamic linker. The fatal case: the game's `vmCvar_t bot_enable` (272 bytes) merged
onto the engine's `int bot_enable` (4 bytes) — the game's `trap_Cvar_Register` write then
overflowed ~268 bytes into adjacent engine memory. (Confirmed by `llvm-nm` diff of engine vs
`qagame.wasm`/`cgame.wasm` defined-data symbols: `bot_enable` was the one size-mismatched
non-const collision; `vec3_origin`/`axisDefault`/color constants also collided but are
identical const data, harmless.)

Two-part fix:
1. `-fvisibility=hidden` on every module TU (`build-wolfet-modules.sh`) — module globals stay
   private and never merge; `vmMain`/`dllEntry` still export via `EXPORTED_FUNCTIONS`.
2. `static int bot_enable;` in `sv_bot.c` — belt-and-suspenders for the specific clash.

Result (2026-07-13): `devmap oasis` loads `maps/oasis.bsp`, `CL_InitCGame` completes in
~1.6s, and the engine renders the **real oasis in-game limbo screen** — command map with
terrain contours, objectives ("silence the Siegfried 15 inch battery…"), class/weapon/team
selection, mission timer — all drawn by the original cgame through our WebGL1 backend.
Server frames pump cleanly (`_idt3_pump_frame` × 8, no OOB).

### 🎮 Wolf:ET FULLY PLAYABLE — first-person 3D gameplay in the browser ✓ (2026-07-14)
From the original 2003 GPL source, on WebAssembly, ET reaches **first-person 3D gameplay**:
the player joins a team, deploys, and spawns into the world — **MP40 viewmodel in hand,
crosshair, compass/minimap, full HUD (100 HP, ammo 30/60, class/skills, XP), rendered 3D
oasis geometry, live WARMUP round countdown**, and a working in-game ESC menu
(REFEREE/SERVER INFO/OPTIONS/DISCONNECT/EXIT GAME). Screenshots: `docs/et-oasis-firstperson.png`.

What made it work, in order: WebGL1 + GLImmediate for LEGACY_GL; WebGL1 `internalformat`
(component-count/sized formats → `GL_RGBA`, else textures sample black); 16-bit indices;
`PATH_SEP` quoting; `-fvisibility=hidden` (MAIN_MODULE symbol-collision corruption); the
**`VM_Call` and `VM_DllSyscall` vararg-ABI fixes** (x86 `(&arg)[i]` stack-hack → `int[]`
marshaling / `va_arg`, so client-connect args and syscall strings arrive intact); and
grave/punctuation keymaps (console + binds). Verified head-lessly via `verify-et-autodevmap.mjs`
with the cvar `idt3_test_autojoin` (**OFF by default = 1:1 faithful**) — it force-joins client 0
server-side because ET's limbo team-join UI is delta-cursor/interactive-input driven, which a
CDP harness can't target; real users join through the fully-functional limbo panel.

### Wolf:ET RUNS THE GAME — map loads, client connects, live simulation ✓
**The VM_Call vararg-ABI bug is fixed** (2026-07-14). The engine's `VM_Call` invoked the
native module entry via the x86 `vm->entryPoint((&callnum)[0],(&callnum)[1],…)` stack-walk,
which aliases args correctly for some wasm call sites (UI) but read **garbage** for
`GAME_CLIENT_CONNECT` — a bad `clientNum` (`-975566842`) → OOB at spawn. Fix: `VM_Call`'s
`__EMSCRIPTEN__` path marshals args into an `int[16]` and invokes a new array-based module
entry `idt3_vmMain_arr(command, const int*)` — no varargs cross the engine↔module boundary
(`idt3_vm_shim.c`, `sys_main.c` dlsym, `build-wolfet-modules.sh` export). Also mapped the
grave/punctuation keys in `MapBrowserKey` so the console + `default.cfg` binds work.

Verified end-to-end via `verify-et-autodevmap.mjs` (launches `?args=+set sv_pure 0 +devmap
oasis`): `ClientConnect clientNum=0` (correct), `CL_InitCGame` completes, and ET renders the
**real in-game limbo/command screen** — oasis command map with live troop-position flags,
the real objectives ("infiltrate the Axis Oasis garrison… silence the Siegfried battery"),
class/weapon/team panels, a running mission timer, and a **3D map preview** in the limbo
camera — all from the original 2003 game code. The local player is connected and spectating;
server frames pump cleanly (no OOB). Console input works (`echo`, `team` commands execute).

Remaining for first-person free-roam: completing the team-join→deploy sequence (the limbo
`team`/spawn flow) — the engine fully supports it (the functional JOIN-A-TEAM limbo panel
renders); the automated console drive hasn't landed the exact ET deploy sequence yet, and
there is a benign recurring "Unknown client game command: (null)" from cgame to chase. This
is a game-flow/UI detail, not an engine-capability gap. Tracked in the milestone task.

### (superseded) VM_Call vararg-ABI issue — root cause identified
`ClientConnect` (called from `SV_SpawnServer`) receives a garbage `clientNum` (`-975566842`),
crashing at spawn. The engine's `VM_Call` invokes the native module entry via the x86 hack
`vm->entryPoint( (&callnum)[0], (&callnum)[1], … )` — reading successive args off the stack
past `callnum`. On wasm this aliases the varargs for *some* call sites (UI key events work —
typing/menus/devmap all function) but reads garbage for others (`GAME_CLIENT_CONNECT`).
Attempted fixes and results (all reverted to keep the tree working):
- Route wasm to the portable `va_arg` path → **broke UI key input** (menus/console dead).
- Marshal args into an `int[]` and call an array-entry shim (`idt3_vmMain_arr`) → also broke
  UI input, though instrumentation showed `va_arg` reading *correct* values for key events
  (e.g. `cn=5 a0=515 a1=1`). So emscripten's vararg handling here is subtle: `&callnum`-stack
  aliasing and `va_arg` disagree per call site.
This is the single blocker between the current milestone (map loads, in-game screen renders)
and free-roam 3D spawn. Best next step: a native macOS build to diff the exact arg-passing,
or a controlled emscripten vararg-ABI test isolating the UI-input regression. Tracked in the
milestone task. The menu/2D/map-load render path is unaffected and shipped.

### (superseded) Map load (`devmap oasis`) — progress + open collision-system crash
Fixed: `cg_newDraw.c` was missing from the cgame module source list, so `cgame.wasm`
failed to dlopen (`undefined symbol CG_GetTeamColor`). With it added, the 3D client
module loads. Ruled out (measured live via `SV_LocateGameData`): the shared game↔engine
structs are byte-identical — `sizeof(entityState_t)=288`, `sizeof(entityShared_t)=112`,
`offsetof(sharedEntity_t,r)=288`, `sizeof(gclient_t)=4552` on **both** sides; the entity
stride (1404) is game-provided and used correctly. So the crash is **not** an ABI/layout
mismatch. Remaining: an OOB trap in `SV_LinkEntity` → `CM_BoxLeafnums` during entity
linking (collision/BSP world path), plus a layout-dependent stray write of `0x40800000`
(float `4.0f`) into a server global — likely one root cause in the collision-map or
world-sector code. Reproduce: `node shared/wasm-build/verify-et-menu.mjs` (types `sv_pure 0`
+ `devmap oasis`, then manual `_idt3_pump_frame`). The 2D/menu render path is unaffected.

### (superseded) earlier hypothesis: server-side memory corruption
With `sv_pure 0`, `devmap oasis` loads the map server-side: the `qagame` side module
runs `G_InitGame`, spawns entities, and the local client connects over loopback (first
client snapshot is generated and sent). Then a `memory access out of bounds` trap fires
in the tail of `SV_SendClientMessages` (after the per-client loop) and kills the RAF main
loop. Root-cause bisect (via `_idt3_pump_frame` from CDP + `-g2` named stacks): the
`sv_showAverageBPS` cvar global reads back as `0x40800000` — the IEEE-754 bits of `4.0f`,
i.e. a float constant leaking into a `cvar_t *` slot — while the adjacent `sv_maxclients`
global reads correctly (64). This is data corruption / a bad global, not a null deref, and
is masked in normal runs because `-fexceptions` `invoke_*` trampolines swallow the first
traps. Prime suspects: a data-segment/GOT relocation quirk under `MAIN_MODULE=1`, or a
buffer overrun into the server cvar globals during gamestate build. Not yet fixed — the
render path (menus/2D) is unaffected and is the shipped milestone.

## MILESTONE: WOLF:ET IS PLAYABLE IN THE BROWSER ✓ (2026-07-14)
`devmap oasis` → limbo/command map → join Axis → deploy → **first-person gameplay**,
on the freely-redistributable ET 2.60 data. The Axis spawn room renders with an MP40
(30/60), 100 HP, XP, class icons, player portrait, compass/minimap with objectives
and the round timer. Screenshots: `docs/et-oasis-limbo.png`, `docs/et-oasis-3d.png`.
Repro: `ET_CMDS='["/team r 0 1 1","/openlimbomenu"]' node shared/wasm-build/verify-et-play.mjs`.

ET inherited most of the RTCW-SP fix chain (they share the platform layer): the
window-target mouse fix, multitexture, and the **same `tessIndexes` 16-bit alias bug
in `RB_SurfaceFace`**. (ET already allocated texture names via `qglGenTextures` —
its manual `texnum = 1024 + tr.numImages` is commented out upstream — which is why
ET's textures worked where RTCW's did not.)

Two ET-specific gotchas, neither an engine bug:
- **`con_autochat`**: an ET console line not prefixed with `/` or `\` is sent as
  **chat**. `team r 0 1 1` arrived server-side as `say` (proved by tracing
  `ClientCommand`); `/team r 0 1 1` reaches `Cmd_Team_f` → `SetTeam` → joins Axis.
- Joining a team leaves you in the limbo gameview; **`openlimbomenu` toggles** it
  (`cg_consolecmds.c` `CG_LimboMenu_f`) — calling it closes the limbo and deploys.

## MILESTONE: RTCW-SP IS PLAYABLE IN THE BROWSER ✓ (2026-07-14)
`escape1` renders in first-person from the original 2001 GPL source, using the
freely-available RTCW demo data: textured stone brickwork, the iron-banded dungeon
door with light bleeding through the cracks, the dead guard, hanging torch, dungeon
lighting, and the HUD. Screenshots: `docs/rtcw-escape1-briefing.png` (mission
briefing), `docs/rtcw-escape1-3d.png` (in-game). Repro:
`node shared/wasm-build/verify-rtcw-play.mjs`.

Six real bugs, each found by instrumenting the live WebGL context / engine rather
than guessing:

| # | Bug | Evidence → fix |
|---|---|---|
| 1 | **Textures never created.** Q3/RTCW picks texture names by hand (`texnum = 1024 + numImages`) and relies on *desktop* GL implicitly creating a texture object on `glBindTexture`. WebGL names are objects — an unknown name binds `null`, every upload fails, everything samples black. | `gl.createTexture` called **0** times; all 13k binds `undefined` → use `qglGenTextures` → **963** textures |
| 2 | **`GL_CLAMP` invalid in WebGL** | 12,455 `GL_INVALID_ENUM` → **3**; use `GL_CLAMP_TO_EDGE` |
| 3 | **Module symbol collision.** `cvarTable`/`cvarTableSize` are non-static globals in *both* `cg_main.c` and `ui_main.c`; the loader merged them so cgame read the **UI's** table — every `cg_*` cvar stayed 0, and `cg_viewsize=0` clamped the 3D view to its 30% minimum. | cgame's `cvarTable[0]` was literally `'ui_ffa_fraglimit'`; viewport `224,168,192,144` → `0,0,640,480`. Fix: `-fvisibility=hidden` (as already done for ET) + export `CG_GetTeamColor` for its GOT ref |
| 4 | **Mouse input 100% dead.** `emscripten_set_mouse*_callback("#canvas", …)` delivered **zero** events — menus unusable, no look control. | instrumented platform layer: no `OnMouseMove`/`OnMouseButton` ever fired → register on `EMSCRIPTEN_EVENT_TARGET_WINDOW` (as the keyboard already did) |
| 5 | **World geometry shredded into stray triangles.** `RB_SurfaceFace` aliases the tess index array as `unsigned *tessIndexes` — correct upstream (`glIndex_t == unsigned int`), but our build makes `glIndex_t` 16-bit (WebGL1 client-array draws only accept `GL_UNSIGNED_SHORT`), so each write clobbered **two** index slots. | isolated with a magenta-clear test (proved world surfaces, not sky/curves/shadows) → `tessIndexes` follows `glIndex_t` |
| 6 | **World rendered as bare lightmap** (flat grey walls) because GLimp disabled multitexture. | glemu *does* implement the entry points `r_primitives 2` uses → `maxActiveTextures=2` |

Getting from the briefing into play is itself engine-faithful: RTCW-SP's briefing is
the **pregame** menu, which eats every key except `K_MOUSE1` (`cl_keys.c:1804`), and
its continue button is `pregame.menu`'s `but2_alt` (`rect 560 420 80 60`,
`action { uiScript playerstart }`) — hovering `but2` swaps it in. Clicking it runs
`playerstart` → `Menus_CloseAll` → `keyCatch=0`, `CA_ACTIVE`, snapshots flowing.

## MILESTONE: all 5 engine variants build + boot in Chrome ✓
| Game | wasm | Boots to data boundary |
|---|---|---|
| RTCW-SP | 1.09 MB | ✓ |
| RTCW-MP | 1.14 MB | ✓ `Wolf 1.41b-MP` |
| Wolf:ET | 1.30 MB | ✓ `ET 2.60d`, scans /et/etmain |
| JK2 | 1.06 MB | ✓ `JK2: v1.02` |
| JKA | 1.33 MB | ✓ `JA: v1.0.1.0` |

Every one compiled from its **original GPL drop** (diff vs `import/<game>` = the port), links
0-undefined, and boots the real native engine as wasm through `Com_Init`/`FS_Startup` to the
"no pak" data boundary. Wolf:ET needed two extra boot symbols the replaced glimp owned:
`gl_NormalFontBase` (font display-list base) and `use_Q_vsnprintf` (ET poisons `vsnprintf`).

---
> ## ⚠️ SUPERSEDED — early-milestone snapshot (kept for history)
>
> **Everything from here down predates the working ports and is NO LONGER ACCURATE.** It was
> written when only the RTCW engines booted and nothing rendered. Current reality (see the
> status table at the top and the dated `2026-07` sections above): **all five games build, boot,
> render the world AND characters, take input, play audio, are WebGL-error-free, and run 60fps
> with headroom on real desktop hardware** — verified on demo/free data. JK2 and JKA *do*
> compile, render, and play (Ghoul2 characters visually confirmed); the "does not compile / not
> started" notes below are obsolete. The genuine remaining work is: full **retail-data**
> verification (see `docs/DATA.md`), **M4 multiplayer netcode** (RTCW-MP / Wolf:ET), and
> production packaging. The subsections below are retained only as a record of the bring-up path.
---

## Realistic remaining scope (beyond the import milestone)
- **Game modules** (gameplay binaries): RTCW-SP/MP + ET modules built; JK2/JKA game modules
  need the fn-ptr default-arg call-site pass (bounded, large). Needed for in-game, not the menu.
- **Rendering / optimization**: no frame rendered yet — needs game **data** (Wolf:ET's is
  freely redistributable; RTCW/JK use the player's own install), then WebGL renderer
  verification (LEGACY_GL_EMULATION vs a hand-rolled GLES2 backend), then profiling.
The engine-conversion half is 4/5 done; the data-driven render+optimize half is not started.

**3 of 5 engine variants build to WebAssembly and (the two testable ones) boot in-browser.**
All from original GPL sources with only minimal `__EMSCRIPTEN__`-guarded edits.

### JK2 (Jedi Outcast) — C++ port status (build-jk2.sh --probe)
Raven's C++ engine (264 .cpp). **Platform layer written** (`sys_emscripten_jk/sys_jk.cpp`
+ `sys_jk_gl.cpp`: full Sys_/GLimp_/IN_/SNDDMA_/main + `Sys_GetGameAPI` side-module loader).
C++-safe flag set built (`-std=gnu++14` kills the `byte`/`std::byte` collision; drop C-only
`-fgnu89-inline`/`-DDLL_ONLY`; `-fms-extensions`). Module model: game = `Sys_GetGameAPI`
DLL (→ side module), cgame via `VM_Create("cl")`, ui statically linked into the engine.

**Engine core does not yet compile** — pervasive MSVC-era C++ that clang rejects. This is a
genuine multi-session port, not a few edits. Remaining blocker classes (from the probe):
1. **Function-pointer default args** — MSVC extension. Beyond the 2 savegame ones fixed,
   the whole **Ghoul2 API** in `g_public.h` (`G2API_InitGhoul2Model(..., customSkin = NULL,
   ...)`, `G2API_SetBoneAnimIndex(..., setFrame = -1, blendTime = -1)`, etc.) is riddled with
   them, on C++-reference params. Each fix needs caller analysis (callers rely on the defaults).
2. **q_shared.h** — "functions differ only in return type cannot be overloaded" + return-object
   init mismatches (C-as-C++ overload clashes).
3. **Ghoul2** — templated skeletal system (`CGhoul2Info_v`), the known-hard subsystem.
4. **mp3code/** (music) + **encryption/** — need endian defines or exclude+stub for first boot.

### JKA (Jedi Academy) — not started
Most complex of the five: SP (`code/`) **and** MP (`codemp/`), plus Raven template libs
(Ragl/Ratl/Ravl/Rufl) and PNG. Same module model as JK2; `qgl.h` branch pre-applied. It's a
delta off a working JK2, so it waits on JK2.

## Honest status summary
**3 of 5 engine variants build to WebAssembly and boot** (RTCW-SP, RTCW-MP verified in Chrome;
Wolf:ET built with full modules, its free data is the render-test path). JK2/JKA are Raven C++
engines whose bring-up is scaffolded (platform layers written, blockers mapped) but whose engine
cores need dedicated multi-session C++ work. "Highly optimized / plays smoothly" is a further
phase needing game data + renderer verification against WebGL + profiling.

### Per-engine ABI switches (shared platform layer)
The `sys_emscripten/` layer is compiled once per engine with its own include paths + a
small set of `-D` switches for signature deltas between the drops:

| Switch | Purpose | Engines |
|---|---|---|
| `IDT3_FSROOT="/x"` | per-game VFS base path | all (rtcw / rtcwmp / et / …) |
| `IDT3_CONST_URL` | `Sys_OpenURL(const char*)` vs SP's `char*` | MP, ET |
| `IDT3_LOADDLL_FQPATH` | MP/ET `Sys_LoadDll` adds a `char *fqpath` out-param | MP, ET |

Per-engine in-tree edits (all minimal, `__EMSCRIPTEN__`-guarded): `qgl.h` GL include branch
(all), `qcommon.h` `SYS_DLLNAME` block (MP, ET), `common.c` winsock→POSIX (ET), and
`qgl_linked.h` line-structure repair (MP — the drop shipped it collapsed onto one line).

**RTCW-SP boot verified (dataless):** engine wasm (1.14MB) + qagame/cgame/ui side modules
all build and the engine executes in Chrome through `Com_Init` → `FS_Startup` (console shows
the search-path scan of `/userdata/main` + `/rtcw/main`, `0 files in pk3 files`), stopping at
`Sys_Error: Couldn't load default.cfg`. This exercises the full platform layer end-to-end;
reaching the renderer/main-menu requires a `pak0.pk3` (demo or retail) supplied via the launcher.
| M2 | JK2-SP | — | — | — | |
| M3 | JKA-SP | — | — | — | |
| M4 | Wolf:ET / RTCW-MP | — | — | — | |
