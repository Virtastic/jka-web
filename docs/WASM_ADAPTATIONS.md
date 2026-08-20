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
| **JKA** | ✓ | ✓ | ✓ renders (`t1_sour`, `yavin1`) | ✓ **retail campaign plays** — real main menu, `map yavin1`, cutscene → player control, HUD | free SP demo **+ retail (Steam, 1.22 GB)** |

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

**Verified visually**, not just by reasoning: `verify-character.mjs` (a screenshot-only probe,
since deleted -- see "Ghoul2 characters and entity rendering, finally measured" below) loaded
escape1 via `devmap` (skipping the SP briefing) with `cg_thirdperson 1`, so the player's **own
MDS body** rendered in front of the camera. It drew as a clean, solid human figure (jacket,
harness, trousers, head) that stayed intact across animation frames — no spikes. Since enemy
NPCs use the identical MDS path, this confirms the fix for the reported drop-down-guard
artifact. The menu and the mission briefing (parchment/photo/text) also render pixel-faithfully
in real Chrome. NOTE: the earlier render-dispatch histogram that reported "no MDS in the escape1
view" had sampled the spawn frame before any NPC spawned, and mislead an interim conclusion —
the third-person player body is the reliable, input-free way to exercise the character path
headless.

### Family-wide skeletal-render audit — all five clean (2026-07-17)

That third-person trick (devmap + `cg_thirdperson 1`, wait, screenshot) became the standard way
to exercise each engine's character path without gameplay input, and was applied across the
family after the RTCW-SP fix:

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

## M5 polish: full-viewport rendering, quality, hidden-tab survival (2026-07)

Platform-layer pass (one commit, `shared/wasm-build/sys_emscripten*` — no `games/` changes)
plus a page pass, driven by live preview feedback ("dim, pillarboxed, console noise"):

- **Backing store = full viewport at device pixels** (both GLimp layers): unless `r_mode -1`
  is pinned, `GLimp_Init` sizes the canvas to `innerWidth×innerHeight×devicePixelRatio` under
  a ~4 MP pixel budget (`?ss=` scales it; hard 8 MP ceiling). Replaces the old default-mode
  gate that was mismatched per game (fired at `r_mode==3` Wolf / `==4` JK), which pinned
  **Wolf:ET to 800×600 and JK2 to 640×480** CSS-stretched, and always forced 4:3 pillarboxing.
  3D is aspect-correct (`fov_y = atan2(height, width/tan(fov_x/2))` in every cgame); the
  640×480-projected 2D HUD stretches, as these engines did on real widescreen in-period.
- **Debounced resize → vid_restart** (300 ms, >6 % change): window/DPR changes re-init video
  through the proven vid_restart path (the GLEmulation re-init block exists precisely for it).
- **MSAA on** (`attrs.antialias = TRUE`, default-framebuffer) + **anisotropic** ext activated,
  `glConfig.anisotropicAvailable/maxAnisotropy` filled (consumed by Wolf:ET `GL_TextureAnisotropy`
  and JK's upload path; RTCW's renderer never applies it — cvar present but inert there).
- **Hidden tabs keep ticking**: `visibilitychange` swaps the main loop to
  `EM_TIMING_SETTIMEOUT(50)` while hidden and back to RAF when visible. Before this, RAF
  stopping froze the engine entirely — MP netchan died on a tab switch and loads stalled
  (also the reason headless/occluded CDP tabs appeared to hang at "Awaiting gamestate").
- **Audio**: the AudioContext now runs at the **device rate** (`latencyHint:'playback'`),
  reusing a page-precreated context from the launcher's click gesture (starts un-suspended);
  requesting 22050 had made the browser resample every scheduled buffer. Ring copy is now a
  wrap-split bulk pass (≤2 contiguous segments, no per-sample modulo); peak probe sparse.
- **Brightness (the "dim RTCW" report)**: no gamma ramp in the browser means the overbright
  pipeline under-lights everything. Pages now boot with `r_overBrightBits 0`,
  `r_mapOverBrightBits 2`, `r_intensity 1.3`, `r_gamma 1.2` (all latched, baked at texture/
  lightmap upload). Page fallback: `?bright=N` CSS filter.
- **Pages**: tuned boot config (`com_maxfps 125`, `r_picmip 0`, trilinear, aniso, Hor+
  `cg_fov` clamped to [90,121]); any `?r_*/cg_*/com_*/s_*/cl_*=v` becomes a trailing `+set`;
  engine output goes to a 2000-line ring (console clean; fatals still `console.error`);
  `?debug` log panel with download; `storage.persist()`; `webglcontextlost` → sync + reload.

## JKA retail campaign — verified on a real Steam install (2026-08-16)

First run against **retail** data rather than the free demo: the Steam copy of Jedi Academy
(`GameData/base/assets0..3.pk3`, 1.22 GB, **23,744 files**). This closes the "retail path not yet
verified" item in `docs/DATA.md`.

**Result: the full campaign boots and plays in the browser.** Retail logo sequence → the real
main menu (NEW / LOAD / CONTROLS / SETUP / EXIT, which the demo data cannot reach at all) →
`map yavin1` → Star Wars crawl → the scripted arrival cutscene with Ghoul2 characters → the
cutscene ends on its own and hands over player control, third-person, full HUD at 100/100.
Engine log confirms unrestricted mode: no `Running in restricted demo mode`, no `Corrupted pk3`,
no fatals, `gamename: base`.

**No marker file is needed for retail.** `FS_SetRestrictions()` resolves `productid.txt` through
the search path *including inside the paks*, and stock JKA ships it in `assets2.pk3` (JK2 ships it
in `assets0.pk3`). `docs/DATA.md` previously instructed creating one by hand; that was wrong — the
file is a scrambled key checked against `fs_scrambledProductId`, not a marker, and a wrong one is a
fatal `Invalid product identification`. The real hazard is an *incomplete* pak selection, which
lands in demo mode and then dies on the checksum; the launcher now pre-checks for a
`productid.txt` entry in the selected zips' central directories and says so plainly.

### `game/bg_lib.cpp` was hijacking libc in the game module — crosshair, subtitles, `rand`, `tan`

The visible symptom was a white-bordered black box fixed at the centre of the screen in every
gameplay frame — idTech3's default missing-image shader — plus a
`WARNING: Couldn't find image for shader gfx/2d/crosshair` with **no letter suffix**. It is present
in this repo's own committed `docs/jka-move-*.png`, so it had been shipping since the first port
commit, on the demo data and on macOS too.

`cg_main.cpp` registers the nine crosshairs with `va("gfx/2d/crosshair%c", 'a'+i)`. Instrumenting
the loop showed the argument arriving correctly (`chr=97..105`) but the result being
`len=16 name=[gfx/2d/crosshair]` — `%c` expanding to *nothing*, so all nine collapsed onto one
name, the image lookup failed, and every crosshair became the default shader. (One warning per
module rather than nine, because the shader cache absorbs the repeats.)

Root cause: **`game/bg_lib.cpp`** — idTech3's freestanding libc for the QVM interpreter, whose own
header comment reads *"this file is excluded from release builds"*. `game.vcproj` still lists it,
and the `RelativePath` scrape that builds `game-sources.txt` cannot see build configurations, so it
was being compiled into the side module. Its **non-static** definitions then override musl's for
every TU in that module:

```
abs atof atoi fabs rand strcat strchr strcmp strcpy strlen strstr tan tolower toupper vsprintf
```

`bg_lib`'s `vsprintf` implements only `%i %d %u %f %s`. There is no `case 'c'` **and no default**,
so `%c` emits nothing while still consuming its argument. Everything the game builds that way was
silently truncated:

| Site | What broke |
|---|---|
| `cgame/cg_main.cpp` | all 9 crosshairs → default missing-image shader |
| `cgame/cg_text.cpp` | subtitles, captions, on-screen print text — assembled with `va("%c%c", hi, lo)` |
| `cgame/cg_credits.cpp` | end credits text |
| `game/g_items.cpp`, `game/wp_saber.cpp` | force-heal sound paths `heal%d_%c.mp3` |
| `game/g_combat.cpp` | dismemberment surface names `"%s%c"` |

And `rand`/`tan`/`atof` were QVM approximations standing in for the real ones throughout the game
module.

Fix is one line in `shared/wasm-build/build-jka-modules.sh` — drop `game/bg_lib.cpp` from the
source list, as Raven's own comment intends. Every symbol it defined is standard C, so musl
supplies all of them. Verified: the warning is gone and the crosshair renders.

Ruled out along the way, each with a standalone reproduction: `va()` itself, `%c` under the JKA
compile flags, `%c` across translation units, `%c` in a `MAIN_MODULE`, `%c` in a `SIDE_MODULE`, and
`va` interposition between main and side modules. All behaved correctly — which is what pointed at
a competing `vsprintf` definition rather than a toolchain vararg problem.

### Function/navigation/keypad keys were mapped to the wrong keys entirely

`sys_jk_gl.cpp`'s `MapKey()` fell through to `if (which >= 32 && which < 128) return tolower(which)`
for anything it did not match by `code`. The DOM `which` values for F1–F12 (112–123), PageUp (33),
End (35), Home (36), Insert (45) and Delete (46) all land inside that range, so they were
reinterpreted as printable characters: F1 arrived as `p`, Home as `$`, Delete as `.` — and **F8
arrived as `w`, i.e. pressing F8 walked the player forward.** JKA's `A_*` codes for these sit
outside the ASCII-aligned span of its enum (`A_F1..A_F4` below 32, `A_F5..A_F12` and the nav/keypad
codes above 127), so the fallback could never have produced them. Added explicit `code` matches for
F1–F12, Insert/Delete/Home/End/PageUp/PageDown, Pause, CapsLock and the keypad, for both the JKA
(`A_*`) and JK2 (`K_*`) code sets.

### Browser feel

- **Render resolution follows the viewport** — confirmed on retail: viewport 833×897 at DPR 1.5
  gives a 1250×1346 backing store, i.e. full viewport at device pixels, under the 4 MP budget.
  Resizing re-runs it through the debounced `vid_restart`.
- **Fullscreen (`Alt+Enter`)** — the port had none, and Jedi Academy is a fullscreen game. Handled
  at the page level in the **capture** phase so the engine never sees the bare Enter (which would
  confirm a menu item mid-transition). Entering/leaving fullscreen changes `innerWidth/Height`,
  which the existing resize path already turns into a correctly sized backing store. A one-shot
  toast advertises it, since it is otherwise undiscoverable.
- **Retail-aware launcher** — the page queries the dev server's `/__paks?dir=base` and, when a full
  install is staged, relabels the first card and plays `base/` instead of the demo. Static hosts
  404 that and keep the demo, so one page serves both — which is what `docs/DATA.md` always claimed
  but the JKA loader did not actually do (it hardcoded `demo` + `assets0.pk3`).
- **Staging failures are fatal now** — they used to `console.warn` and drop the run dependency, so
  the engine booted on top of missing data and died later somewhere unrelated. A short read is
  detected too (it would otherwise reach the engine as a zero-padded pak, i.e. an unexplained
  `Corrupted pk3` much later).

### Toolchain / harness portability

The build ran on Windows with **no engine source changes**. `env.sh` hardcoded `/opt/homebrew/bin`;
it now probes Homebrew, `$EMSDK`, `~/emsdk`, `/c/dev/emsdk`, `/opt/emsdk` in order, and on
MSYS/Git-Bash sets `MSYS2_ARG_CONV_EXCL='-D;-s;-Wl,'` so the path-mangler leaves `-DPATH_SEP='/'`
and `-DIDT3_FSROOT="/jka"` alone while still converting `-I`/`-o`. Build from a source path with no
spaces in it — the scripts interpolate `$SRC`/`$INCLUDES` unquoted.

`build-jka-modules.sh` used to `cat` a `game-sources.txt` that nothing generated, so a fresh clone
failed before compiling anything; it now derives the list from `game/game.vcproj` the way
`build-jka.sh` does for the engine.

All 30 CDP harnesses hardcoded the macOS Chrome bundle path and `/tmp`, making the test suite
macOS-only. They now share `shared/wasm-build/chrome.mjs` (per-platform resolution, `$CHROME`
override, `tmpProfile()` for scratch paths). They also read the engine's log ring
(`window.__idt3_dumpLog`) in addition to `console.*` — since the M5 console-hygiene change routed
engine output away from the console, every log-driven wait in those harnesses had been silently
running to its full timeout. `package.json` declares the previously undeclared `ws` dependency.

### CORRECTION to the M5 "brightness" entry — three of the four cvars were doing nothing

The M5 polish section above records the page booting with `r_overBrightBits 0`,
`r_mapOverBrightBits 2`, `r_intensity 1.3`, `r_gamma 1.2` as a fix for a "dim" report.
Re-examined against the JKA source while chasing a washed-out-lighting complaint:

- `r_overBrightBits 0` — already the JKA default (`tr_init.cpp`), and `R_SetColorMappings()`
  forces `tr.overbrightBits = 0` anyway whenever `deviceSupportsGamma` is false *and* again
  when not fullscreen. Redundant.
- `r_mapOverBrightBits 2` — **not a JKA cvar**. It is RTCW/Q3; JKA has no reference to it
  anywhere. Setting it just created an unused cvar. Lightmap shifting in JKA goes through
  `R_ColorShiftLightingBytes()`, which keys off `tr.overbrightBits` (0 here) and therefore
  copies lightmap bytes through unchanged.
- `r_gamma 1.2` — already the JKA default in this build.
- `r_intensity 1.3` — the only real deviation, and destructive. It is baked into every
  texture at upload (`s_gammatable[s_intensitytable[p]]` in `R_LightScaleTexture`) and
  **clamps at 255**, so highlights are permanently crushed to flat white with no way to
  recover them at draw time.

So the engine had already solved the no-hardware-gamma problem by forcing overbright to 0
(giving `identityLight = 1.0`); the override block was over-brightening on top of an
already-correct image. Measured A/B on `yavin1`, identical walk and settle, real GPU:

| | mean luma | pixels clipped to pure white |
|---|---|---|
| `r_intensity 1.3` | 65.5 | 2.67 % |
| `r_intensity 1.0` | 44.5 | 1.86 % |

The block is removed; the page now leaves brightness to the engine. Everything stays
overridable per-run through the existing `?r_*=` query params for A/B work.

### The game module was built WITH strict aliasing — stretched-triangle geometry artifacts

Reported symptom: large triangles with hard straight edges stretching out of the terrain
across the sky, appearing and vanishing as the player moves, on `yavin1` with retail data.

`env.sh` already states the rule for this codebase:

> `-fno-strict-aliasing` is MANDATORY for idTech3: the engine pervasively type-puns
> (`short*`<->`float*` in the MDS skeletal math, byte-buffer casts, union tricks). Its
> original Makefiles pass it; without it, `-O2`/`-O3` strict-aliasing optimizations
> miscompile that code — e.g. character (MDS) skeletal models render with vertices flung
> to garbage positions ("spikes"/shards shooting off the mesh).

`build-jka.sh` passes it. **`build-jka-modules.sh` did not**, and compiled at `-O2`, so the
entire game+cgame side module — `FxPrimitives`, `FxScheduler`, `cg_marks`, `cg_effects`,
`cg_ents`, `cg_players`, the `bg_*` movement/animation math — was built with strict
aliasing live. That is the half of the port that *produces* vertex data; the engine then
faithfully draws whatever positions it is handed, so a junk vertex becomes a triangle
stretched across the screen. Exactly the documented failure mode, in exactly the module
that was missing the flag.

Fixed in `build-jka-modules.sh`. `build-jk2-modules.sh` had the identical omission and was
fixed alongside it (not retested — this tree carries no JK2 sources).

Note the flag change invalidates every object in the module, so the fix requires a full
rebuild (`rm -rf build-jka/modules`), not an incremental one — the staleness check compares
timestamps against sources and headers, and cannot see a compiler-flag change.

Still outstanding at the time of writing: `mp3code/` is compiled by `build-jka.sh` through a
separate `emcc -O2` path that also lacks the flag. It is a bit-twiddling audio decoder, so
the same hazard applies in principle, but nothing has been observed and it was left alone.

### Also corrected while chasing this

- **Colour buffer is never cleared.** `RB_BeginDrawingView` sets `clearBits =
  GL_DEPTH_BUFFER_BIT` and only adds `GL_COLOR_BUFFER_BIT` for `r_fastsky` / portals /
  `RDF_NOWORLDMODEL`, because desktop GL keeps a persistent backbuffer and the skybox is
  assumed to repaint every pixel. WebGL gives no such guarantee: with
  `preserveDrawingBuffer` false the buffer contents are undefined once the compositor takes
  it. `GLimp_Init` now requests `preserveDrawingBuffer = EM_TRUE`. Worth knowing when
  reproducing renderer bugs: SwiftShader tends to hand back zeroes here while a real
  multi-buffered GPU hands back an older frame, so this class of defect does **not**
  reproduce in the headless software captures.

### Dead ends, recorded so they are not re-investigated

Each was disproved with evidence, not intuition:

- **Alpha test** — glemu does emulate it (generates `discard` in the fragment shader), and
  `qgl_linked.h` maps `qglAlphaFunc` straight to it. Fern cutouts render correctly.
- **Depth precision** — the real context reports 24-bit depth, 8-bit stencil, 4x MSAA
  (Intel UHD / ANGLE D3D11). `glConfig.depthBits` is hardcoded to 24 in the platform layer
  but is only ever used for a memory estimate and a printf, so the wrong claim is harmless.
- **Index truncation** — `SHADER_MAX_VERTEXES` is 1000, so the port's `unsigned short`
  `glIndex_t` really is lossless.
- **`prepareClientAttributes` early-out** — the engine re-points its client arrays on
  virtually every draw, so the stale-layout path is not reached.
- **Lens flares** — `tr_flares.cpp` is not in `starwars.vcproj`, is not compiled, and
  `RB_RenderFlares()` is commented out at `tr_backend.cpp:1007`. Note `r_flareSize` and
  `r_flareFade` are referenced there but never declared or registered anywhere in the tree,
  which is only harmless because the TU is dead.
- **Dynamic glow** — `r_DynamicGlow` defaults to 0.
- **The GL-emulation log warnings** (`glShadeModel`, `prepareClientAttributes`,
  `GL_TEXTURE1 coords`) — all inside `#if ASSERTIONS`; diagnostics, not failures.
- **Missing translation units** — `tr_animation.cpp`, `tr_bsp_xbox.cpp`, `tr_flares.cpp`
  are not compiled, but nothing references them and the link emits no undefined-symbol
  stubs.

### OPEN: thin vertical "sliver" artifacts on retail yavin1 (2026-08-16)

Reported as vertical bars cutting across characters during the yavin1 shuttle cutscene —
a gold/brass bar running floor-to-ceiling past Rosh's head, and several thin tan/black
lines across the Twi'lek's face at closer camera cuts. **Not fixed.** What follows is what
has been established, so the next attempt does not re-tread it.

**Confirmed a real defect, against ground truth.** The native Steam `jasp.exe` was run on
the same map and captured with the engine's own `screenshot` command (not a screen grab).
Same cutscene, same camera cuts, same characters: **no slivers anywhere**. So this is ours,
not period-correct geometry. Worth stating because two earlier "artifacts" in this
investigation turned out to be correct rendering (the Massassi temple wall silhouette, and
a fern passing close to the camera).

**Bisected with a frozen-frame cvar harness** (`shared/wasm-build/cvar-ab.mjs`):

| toggle | result |
|---|---|
| `r_drawentities 0` | **slivers gone** — they are entity geometry |
| `r_drawworld 0` | slivers remain — not world/BSP |
| `cg_shadows 0` | slivers remain |
| `cg_g2Marks 0` | slivers remain |
| `r_dynamiclight 0` | slivers remain |
| `r_ghoul2nolerp/noblend/animsmooth/unsquash` | slivers remain, identical — not bone lerp/blend |

Also ruled out from the engine's own load output: `0 flares` in yavin1 (so `r_flares` and
`RB_SurfaceFlare` are irrelevant here regardless of the stubbed occlusion test), and
`Dynamic Glow: disabled`.

**Entity bases look sane.** `RE_AddRefEntityToScene` was temporarily instrumented (since
reverted) to print any entity submitted with an anisotropic or collapsed axis
(`max/min > 4`, any axis `> 6` or `< 0.08`). Across ~240s of rendering covering the whole
cutscene: **zero hits**. Every legitimate prop has axis length exactly equal to a uniform
`modelScale` (rocks/trees at 0.5x, 0.75x, 2x, 3x). Caveat: the capture frame for that run
did not itself contain a sliver, so this is strong but not airtight.

Taken together that points **downstream of entity submission** — the mesh/vertex transform
rather than the entity data. `tr_mesh.cpp` (MD3 `RB_SurfaceMesh` / LOD lerp) and the Ghoul2
vertex path are the untested ground.

**Methodology notes — these cost hours, do not repeat them.**

- **Never A/B two separate runs by screenshot.** The cutscene camera lands on a different
  cut every run. A control (two runs, identical settings) measured 23 vs 17 columns on the
  same metric — larger than any effect being chased. Flare, fog and strict-aliasing
  "results" were all noise read as signal.
- **Verify the capture actually contains the artifact** before drawing any conclusion from
  its absence. Two runs produced confident-looking nulls from frames that simply had no
  sliver in them.
- **Do not drive cvars by synthesising console keystrokes.** SP pauses while the console is
  open, so a missed closing toggle stops frame production and every later capture is
  byte-identical — indistinguishable from "the cvar did nothing". This silently invalidated
  two full bisection runs. Use the command channel instead (below).
- `timescale 0` does not freeze the scene, it stops the engine producing frames entirely.
  `timescale 0.01` keeps the render loop alive with the camera effectively static.

**New harness capability added while chasing this:**

- `idt3_exec_cmd` (platform layer, `sys_jk_gl.cpp`) — queues a console command straight into
  the engine's command buffer, reachable from CDP via
  `Module.ccall('idt3_exec_cmd', null, ['string'], ['r_drawentities 0'])`. No console UI, no
  pause, no keystroke timing. `extern "C"` so the export name is stable.
- `shared/wasm-build/cvar-ab.mjs` — frozen-frame A/B harness built on it.
- `shared/wasm-build/gfx-probe.mjs` — reports the REAL context (renderer, depth/stencil bits,
  MSAA samples, attributes) and with `LOG=<path>` dumps the entire engine ring. Confirmed on
  this hardware: ANGLE/D3D11 Intel UHD, 24-bit depth, 8-bit stencil, 4x MSAA.
- `shared/wasm-build/burst-probe.mjs` — walks the player and rapid-fires captures for
  transient artifacts.

Native reference screenshots of yavin1 (correct appearance) are the baseline to diff future
attempts against; regenerate them by running `jasp.exe +exec <cfg>` with a cfg of
`wait`/`screenshot` pairs, then remove the cfg and `base/screenshots/` afterwards — and back
up `base/jaconfig.cfg` first, since the engine rewrites it on exit.

#### Sliver investigation — later findings, and two corrections

**Correction 1: "absent in the native game" is weaker than first stated.** The native
reference screenshots were taken at t=35/60/85/110/135s and the browser captures at various
settles, so the cameras were never at matching positions. Across eight native frames
spanning the whole cutscene there is no gold bar anywhere, and the bar appears in a large
fraction of browser captures — so it remains strong evidence, but it is not the
frame-to-frame proof it was originally written up as. It is the same different-frames trap
that invalidated the cvar A/B comparisons.

**Correction 2: "it is entity geometry" is not established.** That came from the
`r_drawentities 0` panel, where the camera had also crawled between captures and the panel
showed different framing. The bar may have been out of frame rather than removed.

**A colour-based detector does not work on this map.** `catch-sliver.mjs` polls for a tall
run of gold pixels. It false-positived twice with high confidence:

1. the **Star Wars intro logo** (yellow, tall vertical letter strokes)
2. the **jungle canopy** in the aerial shuttle shot (yellow-green foliage, tall narrow runs)

Adding a width constraint (tall AND <=10 columns) plus a 110s warm-up killed the first but
not the second. Yellow content is too common in yavin1 for hue to be a usable trigger. A
future attempt should key on something structural — e.g. a near-vertical straight edge with
consistent width over many rows — or drive it from a known-good save/camera rather than
hunting a moving cutscene.

**Leading hypothesis, untested:** the bar passes IN FRONT of a character face in the user's
screenshot. If it is a seat pole or handrail standing behind them, nothing about the
geometry is wrong — it is a depth-test/occlusion failure, geometry drawing through what
should hide it. That would explain every negative result so far: sane vertex data, sane
entity basis, no line-like world geometry, and no degenerate transform. `GL_State` handles
`GLS_DEPTHTEST_DISABLE` and `GLS_DEPTHMASK_TRUE` normally, so the next place to look is
whether depth state leaks between draws under LEGACY_GL_EMULATION, or whether a specific
shader stage is being drawn with depth writes disabled when it should not be.

## Presentation: aligned with ja2-web / openmw-web (2026-08-16)

`play/jka/index.html` carried the *shape* of the shared launcher (topbar, eyebrow, serif
masthead, engraved rule, bracketed cards, footer) from the earlier "mirror the openmw/ja2
launcher pattern" commit, but three parts of the design system had never been brought over.
They are now.

**On palette.** The first pass kept jk2-web's existing Outcast-blue and argued for per-game hues
(ja2-web is Arulco khaki/blood, openmw-web is Vvardenfell ash/bronze). That was wrong for the
brief, which was consistency — blue read as a different product, not a sibling. jka-web and
jk2-web now share one style block **byte for byte**; the two `<style>` sections were already
identical in structure at 213 lines each and differed only in colour values, so jk2-web's was
replaced wholesale with this one. Diff them before editing either — they are meant to stay in
lockstep, and each game's identity comes from its title, glyph and copy rather than its hue.

### The loading screen

Was: an eyebrow, an `<h1>`, a 300px hairline bar and a grey message line. No progress semantics
at all — `setLoading()` regex-matched `x / y` out of whatever text it was handed and otherwise
just printed it.

Now the full overlay anatomy the other two use:

| Part | Behaviour |
|---|---|
| `.ld-glyph` | 56px SVG, 7s rotation; **stops and turns `--err`** in the error state |
| `.ld-title` | serif `clamp(26px,5vw,40px)` with one accented word |
| `.ld-status` | 11.5px uppercase `.22em`, the human-readable phase |
| `.ld-bar` / `.ld-fill` | 4px track, three-stop gradient fill |
| `.indet` | 34%-wide fill sweeping on `ldSlide`, until real byte counts arrive |
| `.ld-detail` | monospace counts |
| `.ld-credit` | project / licence / source |
| `::before` | the launcher's ember gradient, `ldEmber` 9s |

Two behavioural points worth keeping:

- **The indeterminate state is load-bearing.** A bar parked at 0% reads as a hang, and a 1.2GB
  retail stage is long enough that this matters. It sweeps until something reports bytes.
- **`setFatal()` leaves the error state visibly dead** — spinner stopped, status "Could not
  start", detail and bar in `--err`. The old code set `msg.style.color='#c33'`; a still-spinning
  loader after a fatal is why "it just hangs forever" reports happen.

### Progress is now aggregate, not per-file

`__stage()` fetches every pak **concurrently**, so reporting one file's percentage made the bar
jump backwards each time another file's headers landed. `__reportProgress()` sums `__got` /
`__need` across all in-flight files and reports one total; files whose headers have not arrived
contribute 0 to both sides, so the total grows rather than starting wrong. Verified live:
mid-load frames show `410.9 / 598.6 MB · 5 files` with the bar tracking it.

### Help modal + `.note`

Added `.help-btn` (the "?" on the bring-your-own card) and the shared `.modal-bd` / `.modal`
component, carrying the productid.txt explanation that previously existed only as a runtime
error message. Two details:

- `card()`'s click handler now ignores `button` as well as form controls. Without that, opening
  help *also* fired the card and launched the game underneath the sheet the player was reading.
- The modal lives **outside** `#vt-launcher`. Nesting it would trap it in the launcher's
  `z-index:20` stacking context, so the PREVIEW plaque (`z-80`) would paint over its backdrop.
  `boot()` removes both together.

Rejection messages moved from overwriting the card's `p.lead` to a dedicated `.note` line — the
lead explains what the card does and is still needed after a rejection.

### Verified

Headless CDP, retail data, both games: launcher → card click → real staging progress → engine
boot. jka `23744 files in pk3 files`, jk2 `14978`, no fatals, no demo fallback, renderer up.
`.cards` moved to `repeat(auto-fit,minmax(300px,440px))` so the tile count can vary without a
breakpoint. Note the engine never writes `document.title`, so the title-lock script ja2-web and
openmw-web need (SDL2 calls `SDL_SetWindowTitle` on boot) is **not** required here.

## Full-session audit on retail data (2026-08-17)

Method: boot with `?args=+devmap <map>`, wait for `loaded N faces`, drive real input, then dump
and triage the **entire** engine log ring rather than a boot snippet. Most asset and state
warnings only appear once a map loads its shaders/models/sounds, so a 7-second boot log had been
hiding everything below.

**A harness that cannot fail is worse than no harness.** The first run of this audit printed a
confident "no warnings, no errors, no fatals" — against a **dead dev server**. It had audited a
browser error page. The audit now asserts two preconditions before believing any silence: the
page must expose `#canvas` and `window.__idt3_dumpLog`, and the engine log must have >10 lines.
Both abort with a distinct exit code.

### FIXED: anisotropic filtering was silently off

`GLW_InitExtensions()` (win32/win_glimp.cpp:1010-1101) fills the last few `glConfig` capability
fields, and it lives in the excluded win32 GL layer. Diffing every `glConfig.*` write in that
function against our platform layer showed exactly two never being set:

| field | consequence |
|---|---|
| `maxTextureFilterAnisotropy` | left 0, and tr_image.cpp:124 **clamps the cvar down to it** — so the page's `+set r_ext_texture_filter_anisotropic 8` was rewritten to 0 on first texture upload |
| `textureEnvAddAvailable` | left qfalse, so `CollapseMultitexture()` (tr_shader.cpp:2690) never folds an additive two-stage shader into one pass |

The engine had been printing `anisotropic filtering: disabled (0.000000 of 0.000000)` while
`EXT_texture_filter_anisotropic` was both advertised by the context *and* explicitly activated
via `getExtension()`. Now `anisotropic filtering: enabled (8.000000 of 16.000000)` and
`texenv add: enabled`. glemu does not advertise `EXT_texture_env_add` but its TexEnv combiner
implements `GL_ADD` (explicit cases in libglemu.js), which is why the flag is safe to force.

### FIXED: saves and settings did not survive a reload

The persistence design rested on a false premise, stated in the old comment as "(idTech3
fs_homepath)". **JKA has no `fs_homepath` — the string appears nowhere in the engine source.**
That is a Q3/RTCW cvar. So `ENV.HOME = '/userdata'` plus an IDBFS mount there persisted
*nothing*: savegames go to `saves/<name>.sav` relative to the gamedir (sv_savegame.cpp:167) and
the config to `<gamedir>/jaconfig.cfg` — both under `/jka/base`, plain MEMFS.

Verified by walking both trees at runtime: `/jka/base/saves` held `auto.sav` +
`auto_t1_sour.sav`, `/jka/base` held `jaconfig.cfg`, and `/userdata` was `(empty)`. The page
footer claimed "Saves and settings persist in your browser"; they did not.

Fix: IDBFS is now mounted directly on `/jka/base/saves` and `/jka/demo/saves`. `/jka/base`
itself cannot be the mount point — the staged paks live there, and IDBFS would try to push
1.2GB of retail assets into IndexedDB. `jaconfig.cfg` is a few KB in that same unmountable
directory, so it is mirrored to `/userdata/cfg_jka_base_jaconfig.cfg` on every sync and copied
back inside the `syncfs(true)` restore callback, which runs before `Com_Init` execs it.

Proven across a real reload in one browser profile: a uniquely-named marker file written into
the mounted saves dir came back with its contents intact, `seta vt_persist_probe 8675309` read
back in session 2, and `couldn't exec jaconfig.cfg` disappeared from the boot log. Note the
autosave alone proves nothing here — it is rewritten every time the map loads, which is why the
test uses a marker.

One bug of my own worth recording: the mirror first used `'/userdata' + dir.replace(/\//g,'_')`,
which is `/userdata_jka_base_...` — a file at the MEMFS root, **outside** the mount. It wrote
successfully and persisted nothing.

### NOT bugs — checked and dismissed with evidence

- **`sound system is muted` at init.** `s_soundMuted = 1;` sits directly above the
  `S_SoundInfo_f()` call in pristine Raven code; it is cleared later (cl_main.cpp:433). Asking
  the engine again after the map loads reports 54.55MB WAV/MP3 + 4.95MB music loaded and dynamic
  music running.
- **`GL_TEXTURE1 coords are supplied, but that texture unit is disabled`** and **`DrawElements
  doesn't actually prepareClientAttributes properly`** — both `#if ASSERTIONS` diagnostics in
  emscripten's glemu. Supplying a texcoord array for a disabled unit is legal on desktop GL and
  ignored there too.
- **`TODO: glShadeModel`** — glemu stubs it, and the engine calls it exactly once, with
  `GL_SMOOTH` (tr_init.cpp:832). That is the GL default, and GLES2/WebGL has no flat shading at
  all, so the stub is correct.
- **`Dynamic Glow: disabled`** — `r_DynamicGlow` defaults to `"0"` in pristine JKA
  (tr_init.cpp:1105-1107). Native behaviour.
- **`WrongDocumentError ... pointer lock`** — an unhandled promise rejection from emscripten's
  own `requestPointerLock` wrapper, which has no `.catch`. Pointer lock demonstrably engages
  (`document.pointerLockElement === canvas`, no exception, in a clean run).

### CORRECTION: "explicit saving is broken" was wrong

I reported this as a serious defect. It is not. `save` prints nothing and writes no file at
level start because the game is legitimately **paused behind the level-start UI**: `cl_paused`
is `1` (CVAR_ROM, set by the UI at ui_atoms.cpp:76), so `SV_CheckPaused()` returns early from
`SV_Frame` and `sv.time` never advances. With the server frozen, the client snapshot ring is
never filled, so the guard at sv_savegame.cpp:658 — which reads
`svs.clients[0].frames[outgoingSequence & PACKET_MASK].ps.stats[STAT_HEALTH]`, not authoritative
health — sees 0 and refuses the save as "dead".

Temporary instrumentation (since reverted) made this unambiguous: while paused,
`frameHealth=0` but `gentHealth=100`, `addrType=1 == NA_LOOPBACK`, `rate=99999`, and
`sv.time` moved **1800 → 1850 in 70 seconds**. After dismissing the screen with a click and
Space, `cl_paused=0`, `sv.time` ran 1850 → 6050 → 12750 → 19000 (real time), `outSeq` reached
348, `frameHealth` became 100, and `save vt_realsave` wrote **vt_realsave.sav (306721b)**.

Two things this cost, worth remembering: it was *not* a hidden-tab artifact — `visibilityState`
was `visible`, `hasFocus()` true, rAF a steady 125fps, and the server still frozen; rendering
framerate tells you nothing about whether the simulation is running. And a headless harness that
never dismisses a level-start screen will make a perfectly healthy build look broken.

### Measured, retail data, `t1_sour`

`7527 faces, 596 meshes, 36 flares` · 125 fps sustained · 54MB of level audio with dynamic music
· mouse look changes the frame · no fatals · 23744 files across assets0-3 · no demo fallback.

### Sliver artifact: geometry corruption is RULED OUT (2026-08-17)

Colour-based screenshot detection failed twice on this (the Star Wars logo and the jungle canopy
are also tall and yellow). Replaced with a **renderer-side detector**: temporary instrumentation
in `R_DrawElements` projected every triangle about to be drawn through
`backEnd.ori.modelMatrix` × `backEnd.viewParms.projectionMatrix`, and reported any whose
screen-space bounding box was thin (≤5px) and tall (≥60px), together with `tess.shader->name`.
That identifies the artifact by *what draws it* instead of by its pixels. All instrumentation has
been reverted; `games/` is pristine.

First pass, 401 reports on `yavin1`, ranked:

| hits | shader |
|---|---|
| 130 | `models/map_objects/danger/shuttle_chair` |
| 54 | `textures/imperial/outside_wall_base` |
| 53 | `textures/taspir/rustmetal1` |
| 52 | `textures/factory/basic4_railing` |
| 27 each | `models/players/rebel/rebel_torso`, `textures/imperial/pipe_small`, `textures/danger/danger_pipe` |
| 9-15 | `models/players/rebel/accessories`, `models/map_objects/yavin/tree09`, `tree09_vines_b`, `textures/yavin/treebarkstump`, `temple_stone2` |

The shuttle interior with rebel passengers — which is exactly where the reported screenshot was
taken, a bar beside a seated character's leg.

**But a chair strut, a pipe, a railing and a tree trunk ARE legitimately thin and tall on
screen.** That is the same error as the colour detector, one level deeper. So a second pass added
the discriminator that settles it: the **world-space edge lengths** of each offending triangle.
Legitimate thin geometry has small, sane edges; a vertex flung to a garbage position produces an
absurd one.

| max world edge | hits | shader | plausible? |
|---|---|---|---|
| 746.5 | 9 | `yavin/tree09` | yes — tall tree trunk |
| 485.6 | 1 | `yavin/tree09a_b` | yes |
| 288.1 / 264.0 | 3 | `treebarkstump`, `temple_stone2` | yes |
| 170.1 | 38 | `imperial/outside_wall_base` | yes — world BSP wall |
| 101.2 / 99.0 | 76 | `basic4_railing`, `rustmetal1` | yes |
| 88.4 / 72.0 | 38 | `pipe_small`, `danger_pipe` | yes |
| 38.0 | 95 | `shuttle_chair` | yes — chair is ~30-40 units |
| **3.2 / 2.9** | 38 | `rebel/rebel_torso`, `rebel/accessories` | yes — normal torso triangle, close to camera |

**Every single offender is correctly sized.** No absurd edges, at any point in the level.

This eliminates the entire family that prior effort had gone into and that the earlier notes
listed as leading suspects: vertex corruption, index truncation, bone-interpolation error,
garbage transforms, degenerate entity bases. Whatever the artifact is, the vertices reaching the
GPU are right. It is a **shading, blending or occlusion** phenomenon on legitimately thin
geometry — consistent with the depth/occlusion hypothesis recorded earlier ("the bar passes in
front of a face that should occlude it").

**`yavin1` is unusable for image A/B — do not retry it there.** Attempted a statistical
comparison of `r_ext_texture_filter_anisotropic` 1 vs 16 with the world paused. The control
(same config, two runs of 18 frames) drifted **0.845** in mean vertical-edge energy while the
config change moved it only **0.108**, and frame luma wandered 6 → 22 across the run: the intro
cutscene keeps cutting the camera, and the foliage uses `deformVertexes` animation, so the scene
never stabilises. The A/B harness now measures a control noise band first and refuses to report a
verdict that does not clear it — which is what the earlier single-screenshot A/Bs should have
done.

**Status: root cause still not identified.** The search space is now much smaller and the
geometry hypothesis is closed. Next step would be depth/blend state rather than vertices:
capture `GLS_DEPTHTEST_DISABLE` / `GLS_DEPTHMASK_TRUE` / blend bits per offending surface from
`GL_State()` in tr_backend.cpp for the shaders named above, on a scene that can actually be held
still (not yavin1).

### ROOT CAUSE: the screen-dissolve wipe (2026-08-17) — FIXED

`RE_InitDissolve()` / `RE_ProcessDissolve()` in `renderer/tr_draw.cpp` use the **depth buffer as
a stencil**:

1. `qglClear( GL_DEPTH_BUFFER_BIT )` with clear depth 1.0.
2. Blit an alpha-tested "fuzzy" sprite with
   `GLS_DEPTHMASK_TRUE | GLS_SRCBLEND_ZERO | GLS_DSTBLEND_ONE | GLS_ATEST_LT_80` — contributes
   **no colour**, exists only to write depth where `ATEST_LT_80` passes.
3. Blit black over the already-revealed region, also writing depth.
4. Reveal the saved pre-transition screen with **`GLS_DEPTHFUNC_EQUAL`**, so it appears only
   where that mask landed.

Every one of those blits goes through `RE_Blit()`, which is immediate-mode
`qglBegin(GL_QUADS)` / `qglTexCoord2f` / `qglVertex2f` — the exact path emscripten warns about
in our own boot log: *"using emscripten GL immediate mode emulation. This is very limited in what
it supports"*. The mask depth does not survive it, so the `GL_EQUAL` reveal fails.

Measured on `t2_rogue`, 4 runs per depth-func, sampling the transition window (frames where the
bright pre-transition screen is still up):

| depth func | reveal drew | banding |
|---|---|---|
| `GL_EQUAL` (as shipped) | **1 of 4 runs** | that frame had **16 sharp column steps** |
| `GL_LEQUAL` (tried) | 4 of 4 runs | none, but covered the **whole screen** — no wipe boundary (12/12 frames perfectly flat) |

Neither is the intended progressive wipe, so this is **not** a depth-func tuning problem — the
depth-as-stencil technique itself does not survive the emulation. Raven already knew it was
marginal on real hardware: `iSAFETY_SPRITE_OVERLAP 2 // #pixels to overlap blit region by, in
case some drivers leave onscreen seams`.

**This matches the original report exactly**: intermittent **vertical** bars, at
**cinematic→ingame** transitions (`cl_cin.cpp:1897`, `cl_ui.cpp:332`) and level-load end
(`RE_RegisterMedia_LevelLoadEnd`), flickering as the 0.75s wipe animates, drawn as a 2D overlay
so it appears *in front of* characters — which is why the earlier "it is drawn over a face that
should occlude it" hunch was directionally right while every geometry hypothesis came back clean.

**Fix**: skip the dissolve under `__EMSCRIPTEN__` (same style as the existing `__EMSCRIPTEN__`
branch for `glIndex_t` in tr_local.h). `Dissolve.iStartTime` stays 0, so `RE_ProcessDissolve()`
never enters its body and never issues those blits — the banding becomes structurally impossible
rather than merely unobserved. The cost is a 0.75s cosmetic wipe, replaced by a clean cut.
Restoring the effect properly means clipping the reveal with a **scissor rectangle** per wipe
direction instead of using the depth buffer as a stencil.

**No-regression checks after the change** (both games): scene renders, `view changed: YES` on
mouse look, 111-125 fps, level audio and dynamic music intact, no fatals. The steady-state
anisotropy A/B still reproduces cleanly on `t2_rogue` (control drift 0.0148; 2.7936 → 3.3270 →
2.7890), confirming normal rendering is untouched.

Two honest notes. The post-fix banding *measurement* is not a valid check — with the dissolve
gone the burst captures only load-screen frames, and a uniform load screen is indistinguishable
from a clean transition by that metric; the guarantee here is structural, from the early return.
And the depth-func A/B reported earlier in these notes (no effect in steady-state gameplay) was
correct but did **not** cover this path, because the dissolve is not running during steady-state
play — which is why it read as a dead end at the time.

### Still-open artifacts, and a correction to the detector work above (2026-08-17)

Two artifacts reported from real hardware after the dissolve fix: a thin gold vertical bar drawn
over a seated character in the yavin1 shuttle, and a large smeared surface in the yavin1
exterior, plus intermittent whole-screen/object over-brightness.

**Correction.** The "geometry corruption is RULED OUT" conclusion earlier in this file was
methodologically wrong. Both v2 and v3 detectors gated on a *thin* screen-space bounding box
(≤5px then ≤14px wide). A large smeared surface cannot pass that gate, so those runs could not
have found it regardless of whether corruption existed. The world-space edge results they
reported are still valid *for thin bars*; they say nothing about the wide case.

**What a gate-free data check actually found.** A v4 probe with no screen-shape gate at all,
testing the vertex arrays directly at `R_DrawElements` for non-finite values, absurd magnitudes
(|coord| > 1e5), out-of-range indices, and NaN in normals/texcoords:

```
110s of yavin1, software rendering : 0 hits
110s of yavin1, real GPU (ANGLE D3D11, GPU=1) : 0 hits
```

So the engine's vertex data reaching the main draw path is clean. If garbage is reaching the GPU,
it is introduced **downstream** in emscripten's client-array emulation, or in a draw path this
probe does not cover — `tr_quicksprite.cpp` (its own arrays, and it uses `GLS_DEPTHFUNC_EQUAL`),
terrain (`RB_SurfaceTerrain`), `tr_WorldEffects.cpp`, and the 2D immediate-mode path all bypass
`R_DrawElements`.

**The real blocker is reproduction.** Neither artifact has appeared in any headless capture. Two
environment differences matter and both were overlooked for too long:

- Harnesses ran `--enable-unsafe-swiftshader` (software). Re-running with `GPU=1`
  (`--use-angle=d3d11 --enable-gpu`) still produced 0 hits, but this file already warned that
  stale-buffer defects "do not reproduce in headless software captures" — that warning should
  have been applied to the whole detector effort much earlier.
- **Headless never resizes the window and never changes devicePixelRatio.** Every log shows
  exactly one `Initializing Renderer`, so the resize path is completely unexercised here.

### Resize-driven vid_restart is now logged and rate-limited

`IN_Frame()`'s debounced resize handler issues `vid_restart`, which re-uploads every texture and
re-runs `R_SetColorMappings()`. On screen that is a **brightness flash plus a hitch** — a good
match for the reported "super brightness on objects or screen then it goes away". Browsers emit
resize events in bursts (zoom, DPR change, a scrollbar appearing, fullscreen transition), so
without a floor the renderer can restart repeatedly.

It now logs each restart with the before/after resolution and enforces a 3s cooldown, printing
`suppressed (vid_restart cooldown)` when it declines. This is unfalsifiable from headless, which
is exactly why it needed to become observable rather than be "fixed" on a hunch.

### `?diag=1` — HUD for catching this on real hardware

Adds a corner readout: fps, renderer-init count, resize-driven `vid_restart` count, suppressed
count, canvas vs window size and DPR, the last restart line, and **F9 to download the full engine
log**. Verified rendering: `fps 125 / renderer inits 1 / resize vid_restarts 0 / canvas 1258x702`.

Run `play/jka/index.html?diag=1`, reproduce the artifact, press F9. If `resize vid_restarts`
climbs while playing, the brightness flashing is that path and the cooldown/threshold is the
place to fix it. If it stays at 0, the flashing is in the renderer and the next place to
instrument is the draw paths that bypass `R_DrawElements`, listed above.

No-regression after both changes, both games: `view changed: YES`, 125 fps, no fatals.

### The artifact hunt was aimed at the wrong map — yavin1 never renders the world

`r_speeds` comparison, retail data, real GPU:

| map | faces loaded | peak surfs | leafs | verts | world rendered? |
|---|---|---|---|---|---|
| `yavin1`   | 1877 | **1** | **0** | **4** | **NO** |
| `t1_sour`  | 7527 | 616  | 79  | 16552 | yes |
| `t2_rogue` | 6489 | 1409 | 357 | 17393 | yes |

`+devmap yavin1` sits at one surface / four vertices / **zero BSP leafs** for at least 120s — a
single fullscreen quad, i.e. video or 2D. A captured frame confirms it: the Star Wars opening
crawl. `r_speeds` stops printing entirely at ~t+15s and the world never renders.

**This invalidates the targeting of every geometry probe in this file.** All of them were armed
on `yavin1`, on a timer, with no check that the world was being drawn — so they were scanning a
video quad and correctly reporting zero anomalies. "Geometry is clean" was true of what they
measured and says nothing about gameplay geometry. Any future detector must gate on
`surfs > 20 || leafs > 0` before believing a clean result.

ROQ playback itself works: `cinematic openinglogos` gives 22/24 non-black frames across 16
distinct brightness levels. And the engine renders real levels correctly — 616-1409 surfaces and
~17k verts on t1_sour/t2_rogue.

So the reported artifacts occur during yavin1's intro sequence, which never hands off to
gameplay. That failure to hand off is the next thing to root-cause: `music/cinematic_1.mp3 NOT
PRECACHED!` appears in the user's log, and the in-game-cinematic path (`cl_cin.cpp`, which sets
`cl_paused=1` and clears it at line 1910) is the place to look. Repeated fade-to-black between
intro clips matches "goes black for a second and fades back in, over and over".

Note also that the earlier `luma`/`flicker` measurements on yavin1 (one 7s black period, two
0.1s dips, 124fps) were measuring the intro presentation, not gameplay, and should not be read
as gameplay stability numbers.

### yavin1 is not stuck — it waits for player input (and that broke every probe aimed at it)

| yavin1 run | world rendering |
|---|---|
| 240s, **no input** | NEVER — peak 1 surface |
| 150s, **with click/Escape/Space** | **began at t+5s, 976 surfaces / 38 leafs** |

The intro cutscene advances on player input. No headless probe in this file ever sent any, so
every one of them sat in the intro for its whole window measuring a fullscreen quad. That is the
single reason so many came back "clean". The engine was fine throughout.

Past the intro the shuttle scene is **real in-engine geometry** (976 surfaces), not video — an
earlier guess in these notes that it might be a ROQ frame was wrong for that scene. Captured
frames of it reproduce the user's screenshot composition (Twi'lek + Rosh, seat rows) and render
correctly: a column-brightness scan for the reported thin vertical bar found **0 bright narrow
columns in 8/8 frames**, and again 0 in 8/8 when re-run at the user's own reported resolution
(forced device-scale 2, GLimp 1512x1168 vs their 1556x1364).

So the artifacts remain **unreproduced locally** on ANGLE D3D11 at both resolutions. The
outstanding difference is the GPU/driver itself.

### Fixed: TEXTURE1 client-array state leak (and a 40% regression caught on the way)

`DrawMultitextured()` enables unit 1's `GL_TEXTURE_COORD_ARRAY` and never disables it — the
disable is inside `#ifdef _XBOX` in JKA and absent entirely in JK2. Desktop GL ignores texcoords
for a disabled unit; glemu does not, because `GLImmediate.createRenderer()` derives the vertex
layout from `enabledClientAttributes`, so a stale TEXTURE1 keeps contributing to `stride` and to
the interleaved restride on every later single-texture draw. Both engines already do the correct
paired teardown elsewhere in the same file.

**The obvious fix costs 40% of the frame rate.** Disabling per-draw measured 125fps -> 73-78fps on
t1_sour, because `glEnableClientState` is a no-op when the array is already on: the original
invalidates glemu's cached renderer once, while a disable/enable pair invalidates it twice for
every multitexture draw. Hoisting the teardown to once per surface (end of the stage loop)
restores the full 125fps and still stops the state leaking into later surfaces and 2D passes.
The `warnOnce` message still fires for the intra-surface transient; that part is cosmetic.

### Dev servers: start them detached

Background shells started by the agent are torn down with the session, which is why the servers
died repeatedly mid-investigation (jk2 exited code 4 while still serving fine). Start them so
they outlive it:

```sh
powershell -Command "Start-Process python -ArgumentList 'shared/web/server.py','jka' -WorkingDirectory 'C:\dev\jka-web' -WindowStyle Hidden"
```

### Attempted and reverted: stencil-based screen dissolve

The dissolve wipe being skipped under emscripten is a real 1:1 deviation, so it was worth trying
to restore properly rather than leaving it disabled. The plan was sound: the shipped technique
uses the depth buffer as a stencil and matches an ortho z with `GL_EQUAL`, which is
float-precision-fragile under the emulation, whereas the context already provides a real **8-bit
stencil buffer** (`stencil(8-bits)` in the log) whose compare is exact. A scissor rectangle was
rejected first because it cannot reproduce the fuzzy alpha-tested edge or either circular mode.

It was implemented — `glClearStencil`/`GL_ALWAYS`+`GL_REPLACE` around the existing mask blits,
reveal gated on `GL_EQUAL 1`, state restored afterwards — and then **reverted, because it could
not be validated**:

- Triggering the effect through its own console command (`endscreendissolve` →
  `CL_EndScreenDissolve_f` → `re.InitDissolve(qtrue)`) produced no measurable wipe. A
  centre-vs-edge luma probe over ~290 frames, twice, showed a flat difference of 8 — a growing
  iris would sweep that value.
- A first per-column edge detector was also wrong for this effect: it locked onto a static scene
  edge at column 37 in 309/309 frames. `endscreendissolve` forces the *circular* wipe, which has
  no vertical step edge to find. Worth recording as a detector-design mistake, not a result.
- `re.ProcessDissolve()` *is* called every frame (cl_scrn.cpp:412), and both mask images exist in
  retail data (`gfx/2d/iris_mono.tga`; `textures/common/dissolve.png` for JKA, `.tga` for JK2),
  so the failure to activate is in the trigger path, not the assets or the draw loop.

Shipping it anyway would have meant unvalidated stencil enable/disable wrapped around the shared
2D blit path that the HUD and console also draw through — a regression risk with no measured
benefit. The disable stays, and it is not merely a cosmetic loss avoided: an A/B on yavin1 showed
peak frame luma **255.0 with the effect enabled** (fully blown-out frames) versus **45.8 with it
skipped**, so skipping it also removes a white flash.

A future attempt should drive the effect from a **level-load transition**, which is where the
original banded-reveal measurements came from, rather than from the console command.

### Screen dissolve: root cause found, effect deliberately left disabled

Three implementations were written and reverted. The measurements matter more than the attempts:

| variant | peak frame luma, yavin1 |
|---|---|
| effect skipped | **45.8** |
| as shipped (depth mask + `GLS_DEPTHFUNC_EQUAL`) | **255.0** — fully white frames |
| rewritten onto the 8-bit stencil buffer | **255.0** — unchanged |
| stencil **+ `qglColorMask(0,0,0,0)`** on the mask passes | **255.0** — unchanged |

Masking colour writes off on every mask blit changed nothing, so the white does not come from
them. Instrumenting the capture directly — poisoning the buffer with `0x40` first so "wrote
white" could be distinguished from "never wrote" — gave:

```
IDT3CAP readPixels mean=255 white=3476/3476 zero=0 px0=255,255,255,255 glErr=0x0 vid=1258x702
```

`qglReadPixels` **does** write, and it writes pure white. Not an MSAA-resolve problem either:
re-running with `attrs.antialias = EM_FALSE` gave the identical `mean=255`.

**So the earlier conclusion in this file — "the depth-as-stencil technique does not survive the
emulation" — was wrong.** The masking was never the issue. The default framebuffer genuinely
reads back white at the moment `RE_RegisterMedia_LevelLoadEnd()` runs, which is a question about
what the loading screen leaves in the buffer, not about the wipe. A fix belongs there, or in
capturing via `glCopyTexImage2D` the way the Xbox build does (`qglCopyBackBufferToTexEXT`).

The effect stays skipped because every variant that enables it produces a 0.75s **full-white
flash**, which is worse for the player than a hard cut. That is a deliberate, measured deviation
from 1:1, recorded as such — not an unexamined gap.

Two traps worth inheriting: the effect only activates from a **level-load transition**
(instrumented: `init type=0 forceCirc=0`, 34 frames spanning pct 0..99 on a `map` change), never
from `endscreendissolve`; and because that console command forces the **circular** wipe, a
per-column edge detector is useless on it — one reported the same static scene edge in 309/309
frames.

#### Dissolve, final narrowing: `readPixels` fails at that call site, not in general

- The in-game `screenshot` command uses the same `qglReadPixels` and **works**: 250453-byte jpg,
  byte mean 124, 3/250 sampled bytes >= 250.
- Sampling the canvas every 250ms through a `map` change shows a normal dark loading screen —
  **luma 22-29, zero white pixels** for the entire load.
- At that same moment the dissolve's `readPixels` reports **mean=255, 3476/3476 white**.

The canvas has content and `readPixels` returns white. The difference is *when*: screenshots are
serviced inside the render command stream right after a frame is issued, while
`RE_InitDissolve()` is called from the load path and reads the default framebuffer directly,
outside it — and `R_SyncRenderThread()` is not enough to make it readable there.

Fixing it means moving the capture into the render command stream (as the screenshot path does)
or using a GPU-side `glCopyTexImage2D` like the Xbox build's `qglCopyBackBufferToTexEXT`. That is
restructuring work for a 0.75s cosmetic transition, so it is not attempted — but it is now fully
characterised, with the falsifying evidence recorded, rather than left as a guess.

#### Dissolve: both candidate fixes implemented, measured, and reverted — with the reason

- **(b) GPU capture** (`qglCopyTexSubImage2D` from the per-frame path) produced a **correct
  progressive wipe**: 65-69 frames with a strong edge across **38 distinct column positions
  (3..44)**, reproducible. So the masking is genuinely fine. But `copyTexSubImage` inherits the
  framebuffer's bottom-left origin and cannot flip, while `RE_InitDissolve` flips before upload;
  compensating with a flipped reveal quad also flips the top-left sub-rectangle mapping, giving a
  clean wipe over a **white** region.
- **(a) CPU capture** from the per-frame path (`readPixels` + row-flip + `texSubImage2D`, mirroring
  Init exactly) still started the transition white: luma **204, 1152/1440 sampled pixels >= 250**,
  settling to 28 after.

**The constraint is mutual exclusion, not a bug.** `readPixels` only returns real content from the
per-frame path (`SCR_DrawScreen`) — but `cl_scrn.cpp:405` has already run `CL_CGameRendering` by
then, so the framebuffer holds the **new** level. The old screen the effect exists to reveal is
already gone. The only moment it *is* on screen is during load, which is exactly where
`readPixels` returns white.

A working fix must capture at level-load **start**, into a texture held across the load, or make
reads work from the load path. That is a larger change than either attempt, and it is why the
effect stays skipped rather than half-fixed — a wipe revealing white is worse than a hard cut.

### RESOLVED: the screen dissolve now works — the capture was relocated, not the wipe

The wipe was never broken. The image it reveals was.

| variant | peak frame luma, yavin1 |
|---|---|
| as shipped (capture in `RE_InitDissolve`) | **255.0** — fully white frames |
| effect skipped | 45.8 |
| **capture relocated (shipped now)** | **27.8** — no blowout, **0 white pixels** across a transition |

`qglReadPixels` returns pure white from the `RE_InitDissolve` call site (mean=255, 3476/3476
white, `glErr=0`, proven with the buffer poisoned to `0x40` first) but real content from the
per-frame path (mean 27..53, 0/256 white). Eliminated individually along the way: the masking
technique, MSAA resolve, the clear colour, a bound FBO, sync/ordering, and
`preserveDrawingBuffer` being ignored. The `screenshot` command uses the same call and works,
because it is serviced from inside the render command stream.

Capturing *later* fails too — by the per-frame path `cl_scrn.cpp:405` has already run
`CL_CGameRendering`, so the old screen is gone. Capturing into a *texture* at load start fails
because loading purges and reloads media.

**The fix:** request a grab at `RE_RegisterMedia_LevelLoadBegin` (tr_model.cpp), take it from the
per-frame path while the old screen is still up, and hold it as **raw bytes** across the load — a
plain buffer is immune to the media purge. `RE_InitDissolve` consumes it in place of its own read,
in raw bottom-up order so the existing flip applies unchanged.

Verified: fuzzy alpha-tested wipe boundary revealing the previous screen, captured on both games;
125 fps; no fatals; `jka` max luma 27.8 and `jk2` 22.1 across transitions with zero white pixels.
Rejected alternatives are recorded in the source: `qglCopyTexSubImage2D` cannot flip (it produced
a *correct* sweeping wipe — 38 distinct edge positions — over a white region), and a stencil
rewrite of the masking changed nothing, because masking was never at fault.

### The reported artifacts: four detector designs, none of which can find them

Recorded so nobody rebuilds these. All run on retail data, real GPU (ANGLE D3D11):

| detector | outcome |
|---|---|
| column mean luma | **0 hits** — too insensitive to a thin saturated line against a dark scene |
| gold/saturation per column (bar = tall run in few columns) | **983 hits, all false** — fired on character skin tone and warm scenery; every captured frame was clean |
| non-finite / absurd vertex values, bad indices | **0 hits** across 50s of driven play on two levels, gated on the world actually rendering |
| world-space edge outlier vs batch median | fired on ordinary large wall brushes (`worstEdge=1528, med=32`) |

Also tried and ruled out: matching the reporter's resolution (forced DPR 2, GLimp 1512x1168 vs
their 1556x1364) — 0 bright narrow columns in 8/8 frames; and hunting with sabers drawn plus
`r_dynamiclight 1`, on the theory that the thin tapering gold shape is a saber blade and that
saber/effect geometry goes through `tr_quicksprite.cpp`, which bypasses `R_DrawElements` and was
never instrumented. That theory is still untested in substance, because the detector could not
distinguish a blade from skin tone.

The artifacts have never appeared in any local capture. The remaining difference is the GPU driver.
The productive next step is a `?diag=1` capture from the reporting machine at the moment it
happens — the HUD there reports fps, renderer-init count, resize-driven vid_restart count, canvas
vs window size and DPR, and F9 dumps the full engine log.

Uninstrumented draw paths, for whoever gets a reproduction: `tr_quicksprite.cpp` (own vertex
arrays, and it uses `GLS_DEPTHFUNC_EQUAL`), `RB_SurfaceTerrain`, `tr_WorldEffects.cpp`, and the 2D
immediate-mode path.

### FIXED: quicksprite client-array state leaks — a mechanism for the reported brightness flashing

Found by **auditing the draw paths that bypass `R_DrawElements`** rather than by trying to detect
the artifact in pixels. Worth noting the pattern: three of the four bugs actually fixed in this
project came from code inspection (the `bg_lib` libc hijack, the TEXTURE1 leak, the aniso/texenv
gaps); only the dissolve needed measurement. Every pixel-detector built to chase the reported
artifacts either missed them or fired on legitimate content.

`CQuickSpriteSystem::Flush()` (tr_quicksprite.cpp) — surface sprites, i.e. effects/foliage — has
two unbalanced states:

1. **`GL_COLOR_ARRAY` is disabled by the fog pass and never re-enabled.** The function returns with
   the colour array off, and with a flat `qglColor4ubv(fog colour)` still current. Any later draw
   expecting per-vertex colours silently gets that single flat colour instead. **This is a direct
   mechanism for "super brightness on objects or screen, then it goes away."** Desktop GL usually
   masks it, because the next shader stage calls `qglEnableClientState(GL_COLOR_ARRAY)` itself and a
   redundant enable is free; under `LEGACY_GL_EMULATION` the enabled-attribute set also determines
   the vertex layout `GLImmediate.createRenderer()` builds, so that accident cannot be relied on.
2. **`GL_TEXTURE_COORD_ARRAY` is enabled at the top of `Flush()` and never disabled** — the same
   defect, and the same reasoning, as `DrawMultitextured()` in tr_shade.cpp.

Both are balanced now, in **both games** (JK2 has the identical code). Verified: 125 fps, no
fatals, view responds, both games.

**Still a suspect, deliberately not changed:** the fog pass draws with `GLS_DEPTHFUNC_EQUAL`
(tr_quicksprite.cpp:108 in JKA, :88 in JK2). The dissolve investigation proved depth-equality is
unreliable under this emulation — it revealed in only 1 of 4 runs and banded into 16 column steps.
So this fog pass may draw where it should not, or not at all. Altering it changes rendering
semantics on a path that has no reproduction yet, so it is recorded rather than touched.

#### And the `GLS_DEPTHFUNC_EQUAL` fog pass is a non-issue — measured, not assumed

The quicksprite fog pass was left as a suspect above. It is not one: tinting it magenta and
counting invocations gave **0 runs and 0 magenta pixels** on both `yavin1` and `t2_rogue`.

Its own comment reads "only for software fog pass (global soft/volumetric)", and the guard requires
`r_drawfog->integer != 2` while JKA defaults `r_drawfog` to **2** (GPU fog). So the path is dead
code by default and cannot be producing the reported artifacts. Left untouched, with that recorded
in the source so it is not re-suspected.

### Systematic client-state audit — complete, and the result is clean

`tr_init.cpp:835` states the engine's own invariant: *"the vertex array is always enabled, but the
color and texture arrays are enabled and disabled around the compiled vertex array call."* Raw
counts in `tr_shade.cpp` violate it (TEXTURE_COORD 10 enables / 4 disables, COLOR 9 / 3;
NORMAL_ARRAY is correctly 5/5) — but the count alone is not the bug. **Direction matters:**

- A leaked **enable** is benign here. The next surface re-enables *and* re-points the array, so the
  layout stays consistent. `RB_FogPass()` and `ProjectDlightTexture()` both leak enables; neither
  is harmful. (`RB_FogPass` also overwrites `tess.svars.colors` with the flat fog colour, which is
  fine because fog is the last pass of a surface and colours are recomputed for the next.)
- A leaked **disable** is harmful: a later draw expecting per-vertex colour silently gets whatever
  flat `qglColor` was last set. That is the defect fixed in `CQuickSpriteSystem::Flush()`.

Every site classified:

| site | direction | affects normal play? |
|---|---|---|
| `DrawMultitextured` TEXTURE1 | leaked enable | **fixed** (state leaked into later surfaces) |
| `CQuickSpriteSystem::Flush` COLOR_ARRAY | **leaked disable** | **fixed** — the harmful one |
| `CQuickSpriteSystem::Flush` TEXTURE_COORD | leaked enable | **fixed** |
| `RB_FogPass`, `ProjectDlightTexture` | leaked enable | no — callers re-enable and re-point |
| `DrawTris` | leaked disable | no — debug only, needs `r_showtris` |
| `RB_IterateStagesGeneric`; all NORMAL_ARRAY | balanced | — |
| `R_DrawElements` lines 182/198 | commented out in the original | — |

So there are **no remaining client-state leaks that affect normal rendering** in either game. This
class of bug — the one that produced both artifacts I could actually explain — is closed by
enumeration rather than by sampling pixels.



## Build hygiene sweep: the shipped build was the *developer* build (2026-08-18)

Found by making the build genuinely clean rather than by chasing a symptom. Worst first; the
first two meant the port could not be built at all on two of the three host families it
claims to support.

### The build scripts could not survive a space in the checkout path

All four scripts assembled compiler arguments as space-joined *strings* and expanded them
**unquoted**, which is the only way a string splits into separate argv entries:

```sh
INCLUDES="-I$SRC/qcommon -I$SRC/client ..."
em++ $xflag $IDTECH3_COMMON_FLAGS $INCLUDES -c "$src" -o "$o"
```

Unquoted expansion splits on *every* space, including the ones inside `$SRC`. On a checkout
under `C:/Users/First Last/...` — an ordinary Windows home directory — each `-I` became two
broken arguments and **every engine TU failed**, 1008 diagnostics of the form

```
clang++: error: no such file or directory: 'Last/Documents/.../games/<game>/code/qcommon'
```

Everything is a bash array now: one element is exactly one argv entry whatever the path looks
like. The inner quotes of `-DCPUSTRING="wasm32"` and `-DPATH_SEP='/'` are literal parts of the
macro values, so they are quoted to survive into argv.

The same defect had silently disabled the header-staleness check both scripts describe as
load-bearing. `for _h in $(find "$SRC" ... -print)` word-splits identically, so every candidate
was a non-existent fragment, `-nt` was false for all of them, `IDT3_NEWEST_HDR` stayed empty and
**editing a header rebuilt nothing** — the exact failure its own comment says cost hours, twice.
Now `-print0` / `read -r -d ""`.

### #include directives that resolved only because Windows is case-insensitive

`#include "rm_headers.h"` for `RM_Headers.h`, `#include "tr_QuickSprite.h"` for
`tr_quicksprite.h`, `#include <FLOAT.H>` for `<float.h>`. Every one is a hard "file not found"
on a case-sensitive filesystem — the Docker image, any Linux CI — so the port was
Windows/macOS-only in practice. Rewritten to the on-disk spelling, driven by clang's own
`-Wnonportable-include-path` diagnostic, which reports the correct name alongside the offending
line.

### The engine was compiled WITHOUT `FINAL_BUILD`

The retail Release configuration is `NDEBUG,FINAL_BUILD,_JK2EXE,WIN32,_WINDOWS,_IMMERSION,_FF`
(`starwars.vcproj` for JKA, `starwars.dsp` line 103 for JK2). We defined every one of those we
can *except* `FINAL_BUILD`, so what shipped in the browser was Raven's developer configuration.
Not cosmetic:

* `files_pc.cpp:813` printed `FS_ReadFile: <file> NOT PRECACHED!` in magenta for every asset
  loaded during play — four on a stock boot; retail prints none.
* `snd_ambient` / `snd_music` / `snd_mem` / `msg.cpp` carried the same developer diagnostics.
* `G2_API.cpp:31` now sets `G2API_DEBUG` to the retail `0`.
* `common.cpp:13` stops pulling win32 `platform.h`; `OUTPUT_TO_BUILD_WINDOW` goes away.
* `cl_keys.cpp:1336` restores the retail console gate (Shift + `` ` ``).

`_IMMERSION`/`_FF` stay undefined deliberately: Immersion TouchSense force feedback, whose `ff/`
TUs are excluded and which no browser can drive. Undefined, the engine compiles those paths out
entirely — exactly like a desktop machine with no force-feedback device.

### `ASSERTIONS` was on in an `-O3` shipping build

Emscripten defaults `ASSERTIONS` to 1 and the link never overrode it. Beyond size and speed, the
GL emulation hides two of its own diagnostics behind `#if ASSERTIONS`, so every boot logged
`GL_TEXTURE1 coords are supplied, but that texture unit is disabled…` and `DrawElements doesn't
actually prepareClientAttributes properly.` Now `-sASSERTIONS=${IDTECH3_ASSERTIONS:-0}`, with
`STACK_OVERFLOW_CHECK` still at 1 — the failure that one catches (deep BSP/collision recursion)
is worth paying for.

### `glPolygonMode` and `glShadeModel` were emscripten TODOs — so `r_showtris` drew a white screen

`libglemu.js` ships `glPolygonMode: () => {}` and `glShadeModel: () => warnOnce('TODO: …')`.
`GL_State()`'s `GLS_POLYMODE_LINE` branch is the engine's *only* wireframe path, so with a no-op
`glPolygonMode` both `r_showtris 1` and `r_debugSurface` drew their debug geometry **filled** — a
solid white screen. Worth dwelling on given how much of this log is geometry-artifact hunting:
the first two tools you would reach for were themselves broken the whole time.

`glPolygonMode` is now backed by the `WEBGL_polygon_mode` extension — its `FRONT_AND_BACK` /
`LINE_WEBGL` / `FILL_WEBGL` values are numerically identical to desktop GL's, so the engine's
arguments pass straight through. The lookup is lazy and skips `GL_FILL` entirely, because FILL is
already the pipeline default and probing the extension makes Chrome log a "very low support on
mobile devices" warning that would then appear on every boot for a debug feature nobody asked
for. `glShadeModel` is accepted silently: GLES2 has no flat-shading raster state, and the engine
asks for `GL_SMOOTH`, which is already what the pipeline does.

### Warnings: 1,900+ → 0, across both engines and both game modules

Every category was read before being suppressed; the audit is the comment block above
`IDTECH3_JK_WARNFLAGS` in `env.sh`. Two clang diagnostics carry **no option name at all**, so
`-Wno-` cannot reach them and they were fixed in source instead — both token-level and
parse-identical:

* `typedef typename T X;` → `typedef T X;` (RATL headers). MSVC accepted `typename` before a bare
  template parameter; standard C++ allows it only before a qualified dependent name.
* `ang[ROLL] =- ang[ROLL];` → `= -` (`cg_camera.cpp`). A unary minus that reads as `-=`; the
  commented-out line above it in the original spells the same operation.

### Stubs removed, or promoted to real implementations

* `Sys_CopyFile` / `Sys_FileOutOfDate` were hard-coded `qfalse` / `qtrue`. Now real POSIX
  implementations of the win32 contract, 2-second mtime slop and read-only retry included.
  They are reachable only through `fs_copyfiles` with an `fs_cdpath` set — but "unreachable" is
  not "correct": the old `Sys_FileOutOfDate` answered *always out of date*, which would have
  corrupted the cache the moment anyone did mount one.
* `game_import_t gi` — deleted. With `-D_JK2EXE` no engine TU references it; the link is clean.
* `TheGameGhoul2InfoArray()` returned `*(IGhoul2InfoArray *)NULL` — dead code *and* a latent null
  dereference. `CGhoul2Info_v::InfoArray()` selects on `_JK2EXE`, so the engine takes the real
  `TheGhoul2InfoArray()` in `G2_API.cpp` and only the game module wants the other, which
  `g_main.cpp` defines for itself. Deleted.
* What remains is documented rather than pretended away: the display-list entry points and
  `g_bTextureRectangleHack` are confined to `r_DynamicGlow` (CVAR_ARCHIVE `"0"` in the retail
  game, and WebGL has neither display lists nor ARB assembly shaders); `SF_DISPLAY_LIST` exists
  in the enum and dispatch table but nothing in JK2/JKA ever creates one; `glArrayElement` is on
  the `r_primitives 1` path that `GLimp_Init` deliberately never selects.

### Harness fixes

`console-check.mjs` read only the CDP console stream, but the page routes all engine output into
a private ring (`window.__idt3_dumpLog`) to keep devtools clean — so it saw **one** log line on a
perfectly healthy boot and declared "map NOT DETECTED" every time. It drains the ring now. Two
new probes: `boot-log.mjs` (dump the engine's boot log verbatim, in order — a classifier throws
away exactly the signal you need when a boot goes wrong) and `seq-shots.mjs` (time-series
capture, which is how the intro cutscenes above were verified frame by frame).

### Result, JKA

165 engine TUs and 155 game-module TUs compile with **0 errors and 0 warnings**; the link is
clean (the `EXPORTED_FUNCTIONS is not valid with LINKABLE set` warning is gone — `MAIN_MODULE=1`
exports everything anyway, and the entry points carry `EMSCRIPTEN_KEEPALIVE`). A stock
`+map t1_sour` boot produces **0 errors and 0 warnings** in `console-check.mjs`, down from six.
`verify-jk-play` reports 164k draw calls and the intro cutscene plays through to the saber
ignition and Chewbacca, verified frame by frame with `seq-shots.mjs`.

### The thin-line artifact: reproduced locally at last, and it is NOT map content

Earlier entries in this log record four detector designs that could never reproduce the reported
"sliver" artifacts. It reproduces reliably on `+devmap t1_sour` at roughly 7 s of settle: a
bright hairline running across the landing pad, plus a fainter dotted one, both depth-tested
(the walking Twi'lek occludes them).

What is now established, with evidence rather than inference:

| finding | how |
|---|---|
| **not** painted map content | the pad is `textures/desert/concrete_floor_light`/`_dark`, pulled out of `assets1.pk3` — plain concrete, no markings |
| comes from the **diffuse** pass | survives `r_fullbright 1`, disappears under `r_lightmap 1` |
| belongs to an **entity**, not the world | of eight cvars bisected at a fixed camera (`r_surfaceSprites`, `cg_marks`, `cg_g2Marks`, `r_flares`, `cg_shadows`, `r_dynamiclight`, `r_fastsky`, `r_drawentities`) only `r_drawentities 0` removes it |
| **not** stretched/degenerate geometry | a temporary probe in `RB_EndSurface` measuring every tessellated triangle found no entity surface whose longest edge exceeded 8× its own mesh average, and no absurd vertex anywhere |
| **not** a long thin quad either | a full inventory of every entity surface drawn in the scene (shader, tri count, longest edge, sort) shows no 2-triangle surface longer than 158 units |

So the geometry reaching the rasteriser is sane, and the remaining suspects are the draw paths
that never reach `RB_EndSurface` at all — `tr_quicksprite.cpp`, `RB_SurfaceTerrain`,
`tr_WorldEffects.cpp` — or a rasterisation/shading effect on near-edge-on surfaces of
`models/map_objects/kejim/ravenbody` (the Raven's Claw hull, the one entity surface in the scene
with 476-unit edges). Recorded here rather than guessed at; the probe code is not committed, but
it is three dozen lines in `RB_EndSurface` and is described precisely enough above to rebuild.


#### CORRECTION to the bisection above, and four more eliminations

The cvar bisection has to be read with a caveat I only found afterwards: **`t1_sour` opens on a
scripted cutscene whose camera CUTS**, and `cvar-ab.mjs` freezes the world with `timescale 0.01`,
which does not stop a camera cut. So consecutive captures in that scene are not guaranteed to
share a viewpoint, and "only `r_drawentities 0` removed it" is weaker evidence than it looked —
that capture may simply have been framed elsewhere. Any future A/B for this artifact needs a
static viewpoint, not a cutscene.

Four measurements from instrumented builds, which do not depend on the camera at all:

1. **No procedurally-generated entity surface is drawn in the first 45 s of `t1_sour`.** A probe
   on the `RB_SurfaceEntity()` dispatch, printing the first three occurrences of every
   `reType`, produced **nothing**. That rules out `RT_SPRITE`, `RT_LINE`, `RT_ELECTRICITY`,
   `RT_BEAM`, `RT_CYLINDER`, `RT_SABER_GLOW` and `RT_ORIENTED_QUAD` for this scene outright —
   including `RB_SurfaceBeam`, which was a good suspect precisely because it is the one path that
   bypasses `tess` entirely (`qglBegin`/`qglVertex3fv`, binding `tr.whiteImage` additively).
2. **`RB_SurfaceCylinder` is never reached** either, checked separately.
3. **No entity surface of ≤4 triangles has an edge longer than 200 units** — i.e. there is no long
   thin quad being drawn, which is the shape the artifact actually has.
4. **No entity surface has an edge outlying its own mesh** (max > 8× that mesh's mean longest
   edge), so nothing is stretched or degenerate.

What the map *does* contain at exactly that spot is worth recording for whoever picks this up.
`t1_sour`'s entity lump has two `fx_runner`s:

```
"targetname" "claw_tractor_beam"   "origin" "6749 -2652 616"  "fxFile" "cinematics/tiny_tractor_beam.efx"
"targetname" "falcon_tractor_beam" "origin" "6749 -3491 616"  "fxFile" "cinematics/tiny_tractor_beam.efx"
```

Two beams, same X and Z, 839 units apart in Y — which is the geometry of the two roughly-parallel
lines in the capture. `tiny_tractor_beam.efx` is a single `Cylinder` primitive, `size 50`,
`length 486`, `alpha 0.1`, shader `textures/common/nightbeam` (`blendFunc GL_ONE GL_ONE`,
`rgbGen const (0.145 0.180 0.322)`, `clampmap textures/common/gradient`) — i.e. a wide, faint,
additive blue-grey cone. A collapsed version of that effect is exactly what the artifact looks
like. But both fx_runners carry `spawnflags 1`, and measurement (2) says the cylinder path does
not run in this window, so if they are the cause it is not through `RB_SurfaceCylinder`.

The other candidate the inventory turns up is plain hull geometry seen nearly edge-on: the two
ships in frame are `models/map_objects/kejim/ravenbody` (315 tris, longest edge 476 units) and
`models/map_objects/ships/falcon_shield_rear` (218 tris, 296 units) — one large flat panel each,
and one *shield* surface, which would be blended. Two ships, two lines.

Neither is confirmed. What is now certain is that the artifact is **not** stretched geometry, not
a degenerate vertex, not a procedural line/beam/sprite, and not painted into the floor texture —
four hypotheses that between them account for most of the effort spent on this in earlier
sessions.

#### And a correction to my own correction: `r_debugSort` is fine, I misread its scale

I first recorded the `r_debugSort` sweep (3/4/8/13/15) as "the cvar appears inert, the full scene
still renders at 3". That was wrong, and worth keeping visible because the mistake is easy to
repeat: `shaderSort_t` counts `SS_BAD 0, SS_PORTAL 1, SS_ENVIRONMENT 2, SS_OPAQUE 3` — so
`r_debugSort 3` keeps *all opaque geometry*, which is most of the frame. The sweep never went
below opaque, and the cvar was doing exactly what it says.

Read correctly, that sweep is the most informative measurement of the lot: **the line is still
drawn at `r_debugSort 3`, so the surface that paints it sorts at or below `SS_OPAQUE`.** It is
ordinary opaque geometry — not a decal (4), not see-through (5), not fog (12), not any of the
blend buckets (14+). That is consistent with the entity-surface inventory, in which every entity
surface in the scene reported `sort=3.0` except two at 14 and 15, and it points away from every
effect/blend explanation and towards plain model geometry.


### RESOLVED: the thin-line artifact is the landing lights — it is map content, not a defect

Identified by bisection, with a temporary console-driven shader filter in `RB_EndSurface`:

```c
// r_idt3_skip <substring>  -> skip every surface whose shader name contains <substring>
if ( pat[0] && strstr( tess.shader->name, pat ) ) { tess.numIndexes = tess.numVertexes = 0; return; }
```

driven live through `idt3_exec_cmd` by `cvar-ab.mjs`, so a whole bisection level runs inside one
boot at one camera. **Set `r_clear 1` before doing this.** Skipping geometry leaves the colour
buffer uncleared, so the frame fills with stale content from earlier frames and every capture
lies — that confound wasted several rounds here and produced two flatly wrong intermediate
conclusions (that the line survived skipping *everything*, and that it came from the ships).
With `r_clear 1` the untouched background is flat red and each result is unambiguous.

The bisection, each step a single A/B run:

| skip | line |
|---|---|
| `/` (everything) | gone — confirms the filter works |
| `textures` (all world) | **still there** |
| `models` (all models) | **gone** |
| `models/players`, `models/items`, `models/weapons` | still there |
| `models/map_objects` | **gone** |
| `map_objects/ships`, `/kejim`, `/imp`, `/cairn` | still there |
| `map_objects/desert` | **gone** |
| `desert/wall_light`, `/evaporator`, `/vent`, `/wall_tanks`, `/view_panel`, `/switch` | still there |
| `desert/landing_light` | **gone** |

`models/map_objects/desert/landing_light_glow` — the glow cover of `landing_light.md3`. And the
map places **twenty** of them:

```
"classname" "misc_model_static"  "model" "models/map_objects/desert/landing_light.md3"
"mins" "-12 -12 0"  "maxs" "12 12 32"  "origin" "8640 -3776 0"        (x20, no modelscale)
```

Twenty small lamps in rows along the landing pad. Seen from the cutscene's low camera they
recede to a vanishing point — which is precisely the "one solid line plus one dotted line
converging" shape that has been chased through this log for several sessions.

Everything about how they are drawn checks out:

* **Geometry is exact.** Instrumenting `RB_EndSurface` for this shader: `nv=64 ntri=70
  maxedge=10 size=19,20,15` — matching the MD3 on disk (surface `obj01`, 64 verts, 70 tris,
  bounds ±10 × ±10 × 17..32). Nothing is stretched, and the transform is not scaling it: the
  entities carry no `modelscale`.
* **The colour matches the texture.** `landing_light_glow.jpg` is a pale cream lamp cover; the
  line is pale cream.
* **The stage logic matches retail.** The shader is an opaque cover stage plus an additive
  `glow` stage. `tr_shade.cpp:2268` only rejects *non*-glow stages during a glow pass, so glow
  stages draw normally in the main pass whether or not `r_DynamicGlow` is on — the same as a
  desktop install at the retail default of `r_DynamicGlow 0`.

So this is the map's own landing lights, drawn the way the shipped game draws them with dynamic
glow off. It is not a port defect, and there is nothing here to fix.

The one honest caveat: with `r_DynamicGlow 1` a desktop player gets a bloom pass over these
lamps, softening them into halos. That feature needs display lists and ARB assembly shaders and
cannot be reproduced under WebGL (see the display-list note above), so a player who turns it on
would see these lamps stay crisp. The retail default is off, which is what this build matches.

**Method note worth keeping.** Every pixel-detector built for this in earlier sessions failed
(four designs, all recorded above). Bisecting *what is drawn* rather than trying to recognise
the artifact in pixels found it in about ten runs. The filter is ~8 lines and is not committed,
but it is quoted in full above.


### The probes were guessing "is the player in control?" from pixels — now they ask the engine

`verify-jk-move.mjs` decided the player had control by looking for a frame that was both
**steady** and **bright**. That guess is wrong in both directions, and both directions bit:

* **False negative.** JK2's `artus_mine` spawns the player in an unlit cave. Measured centre-band
  luma there is **1.9**, far under the probe's `> 22` gate, so it burned its whole budget and
  reported *"never confirmed player control"* on a build that was in `CA_ACTIVE` with time
  advancing — verified directly with a temporary `CL_Frame` probe:
  `state=7 keyCatch=0 serverTime=64460 msec=8`.
* **False positive, which is worse.** On `kejim_post` the Star Wars title crawl is bright and
  drifts slowly enough to read as steady, so the probe confirmed "control" on the very first
  round and then printed a confident **`MOVED: YES`** measured entirely on scrolling title text.
  It also printed `MOVED: YES` on a *black* cinematic fade, because a black frame trivially
  satisfies "idle is quiet".

The engine already knows the answer, so it now hands it over — a new export beside
`idt3_exec_cmd` in the shared platform layer:

```c
// state | (keyCatchers << 8).  CA_ACTIVE (7) with no key-catcher == map running, and
// neither console nor menu is eating input.
extern "C" EMSCRIPTEN_KEEPALIVE int idt3_client_state( void ) {
    return (int)cls.state | ( (int)cls.keyCatchers << 8 );
}
```

`CA_ACTIVE` alone is still not sufficient — it is also true while an in-game ICARUS cinematic
plays, and JKA's `t2_rogue` reaches it at wait+1 with the intro camera still flying (idle diff
**42%**). The test is therefore the engine's fact **AND** a steady frame, with the brightness
term dropped entirely. Both games now pass on maps that previously defeated the probe:

| | control confirmed | idle | W-held | verdict |
|---|---|---|---|---|
| JKA `t2_rogue` | engine | 1.4% | 44.7% | **MOVED: YES** |
| JK2 `artus_mine` | engine | 0.0% | 17.0% | **MOVED: YES** |

Other probe fixes from the same session, each one a wrong answer someone would otherwise have
believed:

* `MOVED:` never reports YES/NO off the frame diff when control was never established; it says
  `UNCONFIRMED` instead.
* The wait budget is an argument (`[rounds]`), because 30 rounds cannot outlast JK2's ~70s crawl.
* The cinematic-skip keypress only fires in the first 8 rounds — each press *toggles* the skip,
  so pressing forever kept flipping it back off.
* `cvar-ab.mjs` sanitises the cvar value before putting it in a filename; a value of `/` or `*`
  (exactly what a shader-name bisect needs) produced an unopenable path and killed the run.
* `seq-shots.mjs` sends a trusted CDP click after load, the gesture that lets the page resume its
  AudioContext.
* `boot-log.mjs` takes optional console commands, so engine state (`cl_paused`, `timescale`, …)
  can be read out of the same log it already prints.
* `console-check.mjs` counts `loaded N faces` as a map-loaded marker — without it JKA reported
  "map NOT DETECTED" while rendering 218 draws/frame.

**Standing lesson for anything that skips geometry:** set `r_clear 1` first. With the colour
buffer left uncleared, skipped geometry leaves stale pixels from earlier frames and every capture
lies — two flatly wrong conclusions came out of that before it was noticed.


## The side module is never re-instantiated — two campaign-breaking leaks, found by sweeping maps

`map-sweep.mjs` is new: it drives `map <name>` for a whole campaign **through the engine's own
command buffer in one browser session**, then reports, per map, whether it reached `CA_ACTIVE`
and every complaint the engine made while loading it. That last part is the point. Booting the
same level over and over — which is what every probe here did before — cannot see a fault that
only appears on the *fourteenth* map, and both faults below are exactly that shape.

They share one root cause, already named elsewhere in this log: **on PC the game/cgame is a DLL
that is unloaded and reloaded for every map, so its file-scope statics start each map at zero
for free. Our module is a wasm side module instantiated once for the session and never
re-instantiated.** Every static the original silently relies on the loader to re-zero is a
latent bug here, and neither of these has any reset in the original source, because on PC
neither ever needed one.

### `Maximum misc_model_static reached (2000)` — JKA stops loading maps entirely after ~14

`cg_main.cpp` keeps `static int NumMiscEnts` alongside a fixed `MiscEnts[MAX_MISC_ENTS]` array,
and `CG_CreateMiscEntFromGent()` hard-errors when it fills. Raven *did* write the reset — for
Xbox only, and left the reason in a comment:

```c
#ifdef _XBOX	// I can't believe that this isn't necessary on PC, but I'll hold off
	NumMiscEnts = 0;
	memset( MiscEnts, 0, sizeof(MiscEnts) );
#endif
```

It isn't necessary on PC for the DLL-reload reason; Xbox links the game in statically and had to
do it by hand. We are in the Xbox situation exactly, so `__EMSCRIPTEN__` joins that guard. It
lands in `CG_PreInit()`, which runs from `dllEntry()` — and our `Sys_LoadCgame` calls `dllEntry`
on every map load, so this fires once per map precisely as the DLL reload would.

Severity, measured: the sweep ran 14 maps cleanly and then **every remaining map failed to load
at all** — `t1_sour`, `t1_surprise`, `t2_dpred`, `t2_rancor`, `t2_rogue`, `t2_trip` … all
`loaded=false active=false`. A player working through the campaign hits a wall roughly two
thirds of the way in and cannot continue.

### `MAX_ROFFS count exceeded` — scripted cameras and moving objects stop working (both games)

`g_roff.cpp` has `roff_list_t roffs[MAX_ROFFS]; int num_roffs = 0;` — and `MAX_ROFFS` is
**32**, with the original's own comment reading *"hard coded number of max roffs **per level**,
sigh.."*. Per level. Nothing in the original ever assigns `num_roffs` again, because the DLL
reload did it.

Without a reset the count climbs across maps and, once past 32, every further `.ROF` is refused:

```
MAX_ROFFS count exceeded.  Skipping load of .ROF 'roff/cinematic35_kyle_jump'
ROFF camera playback failed
```

ROFFs drive scripted camera moves and moving map objects, so this quietly breaks cinematics
rather than crashing — the worse failure mode of the two, because nothing announces it.

And it is not only a capacity leak. Each cached entry's `fileName` and `data` come from
`G_NewString`/`G_Alloc`, i.e. the game arena that `G_InitMemory()` resets **one line above**
where the fix goes. A stale entry therefore points into memory the next map has reused, so a
name lookup that matches a previous map's ROFF hands back a dangling pointer. The reset goes
immediately after `G_InitMemory()` in `InitGame()`, under `__EMSCRIPTEN__`.

Both fixes are in JK2 and JKA (the `misc_model_static` one is JKA-only — JK2 has no
cgame-side misc-model cache).

**Method note.** Neither fault is visible from a single map, a screenshot, or a clean compile;
both were found by loading the campaign end to end and *reading what the engine said*. That is
now a standing check rather than a one-off — `map-sweep.mjs <port> "<maps>"`, exit code non-zero
if any map fails to reach gameplay.


#### CORRECTION: `CG_PreInit()` was the wrong place, and why exposes a bigger problem

The fix described just above — adding `__EMSCRIPTEN__` to Raven's `_XBOX` guard in
`CG_PreInit()` — **did not work**, and finding out why turned up something more important than
the leak itself.

After that change the sweep failed at exactly the same map, and a probe printing the counter at
the top of `CG_PreInit` said `NumMiscEnts was 0` on every single map — while the map load still
died at 2000. Both readings were true. Printing the *address* of the variable from both the
reset and the increment, across three loads of one map, shows why:

```
map 1   CG_PreInit 0x5f44978    spawn 0x5f44978     (same instance)
map 2   CG_PreInit 0xeba4978    spawn 0x5f44978     (reset hit a different instance)
map 3   CG_PreInit 0xf3a4978    spawn 0x5f44978
```

`Sys_GetGameAPI()` re-instantiates `qagame.wasm` on every map through
`idt3_dlopen_fresh()` — deliberately, so the module's statics come back zeroed the way a PC DLL
reload delivers them. But **emscripten's dynamic linker has a flat symbol namespace**: the second
instance's exported names are already claimed by the first, so calls resolve back into instance
#1, while `dlsym()` on the new handle reaches instance #2. `CG_PreInit` is reached via `dlsym`
(`Sys_LoadCgame` → `dllEntry`), so it kept zeroing a copy nothing plays on; the count on the live
instance climbed 400 → 800 → 1200 → 1600 → 2000 across reloads of a single map.

So `idt3_dlopen_fresh()` does not deliver what its comment promises for these engines. It
allocates a fresh instance per map — which is where the "superseded instance leaks" cost noted in
that file comes from — but gameplay keeps running on the first one, so the statics it was meant
to refresh are refreshed on a copy nobody uses. Worse, module state is now *split* across
instances depending on how each symbol happens to be reached.

The working fix follows from that: **reset from code that runs on the instance gameplay is on.**
`InitGame()` is reached through `ge->Init`, i.e. instance #1, so both resets live there — the
`.ROF` cache directly, and the misc-model cache through a new `CG_ResetMiscEnts()` in
`cg_main.cpp`. Raven's `_XBOX` guard is left exactly as shipped. (This is also why the `.ROF`
fix worked first time while the `misc_model_static` one did not: it was already in `InitGame`.)

Verified: `t1_sour` loaded six times back-to-back, all OK, zero engine complaints — it previously
died on the fourth.

**The broader item this leaves open** is `idt3_dlopen_fresh()` itself. Its RTCW-SP justification
(stale `botstates[]` pointers crashing every `/loadgame`) is real and recorded in
`sys_emscripten/idt3_dlopen.c`, but the flat-namespace behaviour measured here means it cannot be
relied on to give the JK engines fresh statics, and each map pays a full extra instantiation of
the ~2MB module for a copy that is never played. Either these engines should load the module once
and reset explicitly (which is what the two fixes above now do), or the re-instantiation needs to
be shown to actually take effect for RTCW too — worth measuring there with the same
address-printing trick before trusting it.


## Whole-port verification, end to end (2026-08-19)

Everything below is a fresh measurement against the final binaries, not a recollection.

| check | JKA |
|---|---|
| engine build (165 TUs) | 0 errors, 0 warnings |
| game module build (155 TUs) | 0 errors, 0 warnings |
| link | clean |
| boot `t1_sour` (`console-check.mjs`) | **0 errors, 0 warnings** |
| render (`verify-jk-play.mjs`) | 170k draw calls, no crashes |
| sustained fps (`perf-probe.mjs`) | 123 fps, CPU 7.67 ms median / 8.51 ms p95 |
| audio (`audio-test.mjs`) | context running 44.1 kHz, play cursor advancing, peak 1.0 |
| movement (`verify-jk-move.mjs`) | **MOVED: YES** — control confirmed by the engine, idle 1.4% vs W-held 44.7% |
| **whole campaign** (`map-sweep.mjs`, 34 maps, one session) | **34/34 reach gameplay** |
| savegame round-trip (`verify-jk-save.mjs`) | **PASS** — 229,937-byte save, survives a full page reload, `load` reaches gameplay |

The campaign sweep leaves exactly two distinct engine complaints across all 34 maps:

* `WARNING: reused image gfx/sprites/y_grass_tall with mixed glWrapClampMode parm` — retail
  content referencing one image at two clamp modes; JK2's data does the same with its ATST HUD
  icons.
* `glGetError() = 0x500` on `t2_rancor` only. This is `R_Init()`'s own end-of-init check
  (`tr_init.cpp:1419`), which the original performs too. It is **not** a driver-side fault:
  hooking *every* function on the WebGL context (`GLERR_ALL=1 gl-error-trace.mjs`) captures no
  error at all, so nothing was rejected by WebGL. It is emscripten's GL emulation recording
  `GL_INVALID_ENUM` internally for a legacy fixed-function enum it does not implement — those
  calls never reach the context, which is why context-level hooks cannot see them. One
  informational line, on one map, after which that map renders and plays normally. Left as-is
  and recorded; catching it would mean instrumenting emscripten's own `GL.recordError`.


### `vid_restart` killed the renderer outright — a canvas only ever yields one WebGL context

Found while chasing the single `glGetError() = 0x500` the campaign sweep reported. That error
turned out to come from `InitOpenGL()`, which only runs again on a **renderer restart** — so I
issued one, and the game died on the spot:

```
Uncaught TypeError: Cannot read properties of null (reading 'version')
    at _emscripten_glTexImage2D
    at <wasm> ...
```

`GLimp_Shutdown()` was calling `emscripten_webgl_destroy_context()`, and `GLimp_Init()` then
asked the canvas for a new one. A browser canvas hands out exactly one WebGL context for its
lifetime, so after the destroy there was nothing to get back: `GL.currentContext` stayed null and
the first texture upload of the reload threw.

This is not an exotic path. `vid_restart` is what every video-settings change in the menu issues
— resolution, texture detail, anisotropy, MSAA — and this log already records the page's own
resize handling triggering restarts too (which is why they were rate-limited). Any player who
opened the video menu and changed anything lost the renderer.

The fix is to create the context once and keep it: `GLimp_Init()` reuses `glCtx` if it already
has one, and `GLimp_Shutdown()` no longer destroys it. Nothing the engine expects from a restart
is lost, because the parts that matter — deleting and re-uploading every texture, re-running
`GL_SetDefaultState`, reloading the world — are renderer-side work that still happens. Reusing
is also the only honest option for the context *attributes*: WebGL fixes those at creation, so a
"fresh" context could never have applied a changed MSAA or depth setting anyway.

`GLimp_Init()` additionally clears the whole drawing buffer once at the (possibly new) size. The
context is created with `preserveDrawingBuffer` because the Raven renderer never clears colour —
it assumes the skybox repaints every pixel — and that assumption does not survive a restart at a
different resolution, where any region the new viewport does not cover would keep the old frame's
pixels for the rest of the session.

Verified after the fix, on both games: `vid_restart` completes (renderer re-initialises, world
reloads), with **no exception, no page error and no GL error**, and gameplay continues — HUD,
NPCs and weapon fire all rendering.

**A wrong turn worth recording.** I read a bright vertical band in the post-restart screenshot as
a viewport seam and "fixed" it twice before measuring it. Scoring the mean horizontal luma
gradient per column put the suspect edge at 33.7 — but the same measurement on frames from runs
with *no* restart at all gives 23.4, 26.8 and 31.3 for ordinary scenery. It was a wall edge in
the cantina corridor. The lesson is the same one this log keeps relearning: score the pixels
before believing what they look like.


### CORRECTION: the `0x500` does not come from `InitOpenGL` — `glGetError` clears as it reports

Earlier in this log I attributed the campaign sweep's single `glGetError() = 0x500` to
`InitOpenGL()`, on the strength of a probe that checked the error after each step of `R_Init()`
and reported `GLSTEP InitOpenGL -> 0x500`. That reading was wrong, and the way it was wrong is
worth keeping.

`glGetError()` **returns and clears** one latched error. Instrumenting further:

* every call in `GL_SetDefaultState()` individually — clean;
* every GL-touching step in our own `GLimp_Init()` — clean;
* every function on the WebGL context (`GLERR_ALL=1 gl-error-trace.mjs`) — **no error at all**,
  so nothing was rejected by WebGL itself.

Yet the sweep still reports it, on the same map, every run. The explanation is that nothing else
in the engine ever calls `glGetError` during play: `GL_CheckErrors()` returns immediately because
`r_ignoreGLErrors` is `Cvar_Get(..., "1", CVAR_ARCHIVE)` — **the retail default is to ignore GL
errors**. So a flag set at any point during seventeen maps of ordinary rendering simply sits
latched until the next `R_Init()` performs the one unconditional check in the renderer, which
then reports it and clears it. The step probe pointed at `InitOpenGL` only because that was the
first `glGetError()` call after the flag had already been set — it was reporting the *reader*,
not the writer.

What sets it is emscripten's GL emulation recording `GL_INVALID_ENUM` internally for a legacy
fixed-function enum it does not implement; those calls never reach the context, which is exactly
why hooking every context entry point sees nothing. Finding the specific call would mean
instrumenting emscripten's own `GL.recordError`.

Consequences, stated plainly: one informational line per long session, no visual effect, on a
check whose companion cvar the retail game ships set to "ignore". Desktop behaves the same way —
if its driver latched an error, retail would print the identical line from the identical check.
Left as-is, and recorded so the next person does not re-derive the wrong attribution.


## The last two "limitations" were not limitations — they are the engine's own configurations

I had been recording dynamic glow and force feedback as things WebGL cannot provide. That framing
was wrong in an important way: **both are paths the shipped engine already takes on its own**, and
what the port owed was to take them the same way, not to apologise for them.

### Dynamic glow: the original has a hardware gate, and we now go through it

`RB_BlurGlowTexture()` needs `GL_VERTEX_PROGRAM_ARB` plus either NV register combiners or
`GL_ARB_fragment_program` — assembly-shader pipelines with no WebGL equivalent at all (WebGL has
only GLSL ES). So the blur genuinely cannot run. But that is a question the engine asks itself,
in `GLW_InitExtensions()` (win_glimp.cpp:1464):

```c
if ( bTexRectSupported && bARBVertexProgram && bHasRenderTexture && qglActiveTextureARB
     && glConfig.maxActiveTextures >= 4
     && ( ( bNVRegisterCombiners && iNumGeneralCombiners >= 2 ) || bARBFragmentProgram ) )
    g_bDynamicGlowSupported = true;
else {
    g_bDynamicGlowSupported = false;
    Cvar_Set( "r_DynamicGlow", "0" );
}
```

and `tr_backend.cpp:1339` gates the entire glow pass on that flag. A GeForce 2 running retail JKA
in 2003 failed this check and played with glow off — no error, no missing feature, just the
engine's answer for that hardware.

Our `GLimp_Init()` stands in for `GLW_InitExtensions()`, so it now takes the else branch
verbatim: clears `g_bDynamicGlowSupported` and force-sets the cvar. The earlier
`__EMSCRIPTEN__`-only `CVAR_ROM` lock on `r_DynamicGlow` is gone; the cvar is registered exactly
as shipped (`CVAR_ARCHIVE`), because the engine's own gate is what should be doing the work.

The visible difference: booting with `+set r_DynamicGlow 1` used to report **"Dynamic Glow:
enabled"** while `g_bDynamicGlowSupported` silently suppressed the pass — a log that contradicted
the renderer. It now reports **"Dynamic Glow: disabled"**, which is what retail prints on hardware
that fails the check. Still 0 errors and 0 warnings on boot.

### Force feedback: a Win32 binary blob, and off by default in retail anyway

Three facts from the drop itself settle this:

* `code/ff/IFC/` contains **`IFC22.dll` and `IFC22.lib` and zero source files** — Immersion
  Foundation Classes shipped as a prebuilt Win32 x86 binary. There is nothing to compile to wasm,
  and that is equally true for a Linux or macOS build; it is not a browser problem.
* Every entry point is behind `#ifdef _IMMERSION` (`cl_main.cpp:186`, `:437`, `:1136`). Building
  without it is a first-class configuration of the shipped source, which is exactly what we do.
* `CL_InitFF()` reads `Cvar_Get( "use_ff", "0", CVAR_ARCHIVE )` and calls `FF_Shutdown()` unless
  it is set **and** `FF_Init()` finds hardware. **Force feedback is off in a stock retail
  install.**

So a player on this port gets precisely what a player gets on a stock retail install without an
Immersion TouchSense device — which is to say, essentially every player. The `FF_*` no-ops in
`sys_jk_stubs.cpp` exist only to satisfy the handful of call sites that sit outside the
`_IMMERSION` guards, and "no device, nothing to do" is what the original's own no-device path
does.

Neither item is outstanding work. Both are recorded here so nobody re-opens them as gaps.


#### `0x500`: both candidate sources eliminated, and it is a log line rather than a defect

Recorded so nobody repeats the three instrumentation passes. There are exactly two ways a GL
error can be latched under this stack, and neither is producing it:

| candidate | how it was checked | result |
|---|---|---|
| a real WebGL rejection | `GLERR_ALL=1 gl-error-trace.mjs` wraps **every** function on the context and calls `getError()` after each | **none** |
| emscripten's fixed-function emulation | `glemu-error-trace.mjs` (new) hooks `GL.recordError` — the glue calls it from 60 sites — across the exact 18-map sequence that reproduces the report | **none** |

Also ruled out earlier: every individual call in `GL_SetDefaultState()`, and every GL-touching
step of our own `GLimp_Init()`.

What is certain is the reporting side. `glGetError()` returns and clears **one** latched error;
nothing in the engine reads it during play, because `r_ignoreGLErrors` is registered
`Cvar_Get( "r_ignoreGLErrors", "1", CVAR_ARCHIVE )` — the shipped default is to ignore GL errors
— so the first and only reader is the unconditional check at the end of `R_Init()`. Whatever set
the flag, it is reported once, on whichever map happens to trigger the next renderer init, and
cleared.

Impact: one informational line per long session, no visual effect, from a check the retail game
pairs with an "ignore errors" default. Desktop prints the identical line from the identical check
whenever its driver latches anything. Not carried as a defect; the elimination table above is the
useful part for anyone who picks it up.


### The per-map module re-instantiation leaks, measured — and the obvious fix is unsafe

`sys_emscripten/idt3_dlopen.c` says the superseded instance's code and table entries leak, and
calls that "bounded by how rarely maps restart". A campaign is 34 map loads, so it is worth a
number rather than an adjective. `map-sweep.mjs` now reports wasm linear memory and function-table
size per map, and eight consecutive loads of one map give:

```
table=8947  9007  9067  9127  9187  9247  9307  9367      (+60 per map load, monotonic)
```

Sixty function-table entries per map, plus one retained `WebAssembly.Instance` of the ~2MB side
module each time — the latter never shows in `HEAPU8`, because side-module code lives in JS
objects, not the linear memory. Linear memory itself stays flat at the 512MB initial allocation.

**Tried, and reverted.** Replacing `idt3_dlopen_fresh()` with a plain `dlopen()` in
`Sys_GetGameAPI()` removes the growth completely — table pinned at 8947 across eight loads — and
JKA survived eight consecutive loads of `t1_sour`, which is also the regression test for the
misc-model cache. But **JK2 then could not load the same map twice**: `kejim_post` loaded once and
every reload afterwards came back `loaded=false active=false`, silently, with no engine error.

That is a direct contradiction of the address measurement recorded above, which showed the cgame
statics being reset on a fresh instance while gameplay stayed on instance #1 — if the fresh
instance really were unused, dropping it could not break anything. Something in the JK2 load path
does depend on it. Correctness wins: the re-instantiation stays, and the leak stays with it, now
quantified instead of hand-waved.

Anyone revisiting this should start from that contradiction rather than from the leak. A likely
next step is checking whether `dlsym()` on the fresh handle resolves per-instance or through
emscripten's flat namespace — note that the changing `dllEntry` address across loads does **not**
prove per-instance resolution, because emscripten allocates a new table slot on every `dlsym` of
the same function.


## Long-session behaviour, measured (2026-08-19)

Two failure modes, tested separately because they fail differently.

### Loading a whole campaign: no leak, but two avoidable stalls (fixed)

`map-sweep.mjs` now reports wasm linear memory and function-table size per map. Across all 34 JKA
campaign maps in one session the heap was a **step function, not a slope**:

```
512.0MB  x17 maps ... -> 614.4MB at t2_rancor ... -> 737.4MB at vjun3 ... flat to the end
```

Eight consecutive loads of a single map hold perfectly flat, so those steps are
`ALLOW_MEMORY_GROWTH` high-water marks for two big maps, not a per-map leak. But each step is an
ArrayBuffer realloc + copy with every HEAP view rebuilt — precisely the stall `INITIAL_MEMORY`
exists to prevent, and `env.sh` had picked 512MB on the belief that "the common desktop scenes
never grow". The campaign disproves that.

`INITIAL_MEMORY` is now **768MB**, which clears the measured peak with headroom. Re-running the
full campaign: **34/34 maps, heap constant at 768.0MB, zero growth events.**

A hypothesis this also killed: `t2_rancor` was both the first heap-growth map *and* the map that
reports the stray `glGetError() = 0x500`, which made a realloc-disturbs-GL-bookkeeping story look
attractive. With the reallocs gone the `0x500` is unchanged, so that correlation was coincidence.
Another eliminated candidate for that line.

The one genuine growth that remains is the function table, +60 entries per map load from the
per-map module re-instantiation — quantified and explained in its own entry above, where the
obvious fix is also shown to be unsafe.

### Sitting in one map: `soak.mjs`

The sweep answers "does a campaign load"; it cannot see a per-frame leak or a render list that
grows while the map state is static. `soak.mjs` sits in one map and samples frame rate, draws per
frame, heap and table size per window, printing the trend rather than an average that would hide
it, and comparing the first third of the run against the last.

Results, 8-minute runs, each game soaked alone:

| | JKA (`t2_rogue`) | JK2 (`artus_mine`) |
|---|---|---|
| fps, first third -> last third | 42.3 -> 43.1 (**up 1.9%**) | 122.1 -> 124.4 (**up 1.9%**) |
| draws/frame | constant ~726 | constant ~112 |
| heap growth | **0.0MB** | **0.0MB** |
| function-table growth | **0 entries** | **0 entries** |
| verdict | STABLE | STABLE |

Zero heap growth, zero table growth and a flat draw count over eight minutes of continuous play:
there is no per-frame leak in either engine, and the +60-entries-per-map table growth documented
above really is per-*map-load*, not per-frame.

**The tool was wrong before it was right, in a way worth recording.** The first JKA soak reported
`fps first third 42.4 -> last third 37.6 (down 11.4%)` and flagged `CHECK THE TREND ABOVE`. That
decay did not exist. The first sample window opened the moment the client reached `CA_ACTIVE`,
while the scene was still populating -- it read `fps=67.8` at **`draws/frame=345`**, against a
steady state of ~37fps at ~726 draws/frame. Averaging a half-loaded frame into the baseline
manufactured an 11.4% "decay" out of a session that was flat.

The give-away was in the output all along: fps and draws/frame move together. A real
degradation shows fps falling while the draw load stays put; a warm-up artifact shows both
climbing to a plateau. So the trend judgement now discards leading windows until the *draw load*
settles (within 10% of the previous window) rather than trusting elapsed time, and says how many
it dropped. Same session, corrected: **up 1.9%**.

A second, smaller bug in the same fix, caught before it could mislead: `steady` is the index of
the first window that *matches* its predecessor, so the predecessor was already at full draw load.
Trimming `steady` windows threw away a good sample; it trims `steady - 1`.

## The Brightness slider did nothing (2026-08-19)

`GLimp_SetGamma` was an empty function and `glConfig.deviceSupportsGamma` was hard-coded
`qfalse`, on the reasoning that WebGL has no gamma-ramp API. Both engines therefore fell back to
the renderer's *software* gamma path, which bakes the ramp into every texture at upload time
(`R_LightScaleTexture`, tr_image.cpp:384). The Brightness control in the menus is a plain
`cvarfloat "r_gamma" 1 .5 3` (setup.menu / ingamesetup.menu) with no restart attached, so nothing
ever reloaded the textures and **dragging the slider had no effect at all** until something else
happened to trigger a `vid_restart`.

Measured before the fix, with the world frozen at `timescale 0` and a no-change control to
separate real effect from frozen-frame drift:

```
control (no change)             luma 21.73 -> 25.37   drift +3.64
after "r_gamma 3", no restart   luma 21.73 -> 25.24   delta +3.52   <- i.e. nothing
after vid_restart               luma 21.73 -> 51.50   delta +29.77
```

### The fix: a gamma ramp is a compositor stage, and the browser has one

A hardware gamma ramp is not a rendering feature. It is a per-channel lookup applied to the
finished framebuffer on the way to the display, after everything has been drawn. The browser has
that exact stage and that exact primitive: an SVG `feComponentTransfer` with `type="table"` is an
arbitrary 256-entry per-channel LUT applied by the compositor to the canvas. So `GLimp_SetGamma`
now hands the engine's table straight to it, unaltered, and `deviceSupportsGamma` is decided the
way `WG_CheckHardwareGamma()` (win_gamma.cpp:24) decides it -- including honouring
`r_ignorehwgamma`. The original's other two checks have no analogue here: there is no prior ramp
to read back for a sanity check, and no crashed-with-bad-gamma state to repair.

An identity ramp removes the filter entirely rather than paying for a compositor pass that cannot
change a pixel -- `r_gamma` defaults to 1, so the default build composites exactly as before.

Verified, again against a control:

```
after "r_gamma 3", no restart   JKA luma 21.48 -> 46.38  (drift +3.28)
                                JK2 luma 16.03 -> 51.46  (drift +5.17)
fps with LUT filter 124.9  vs  124.8 without   -- no measurable cost
```

Ordering was already correct for the switch: `R_Register()` registers `r_ignorehwgamma`
(tr_init.cpp:1398), `InitOpenGL()` runs at :1409, and `R_InitImages()` only uploads at :1411.
`tr.overbrightBits` is unaffected, because `R_SetColorMappings` also zeroes it when
`!isFullscreen` and a canvas is never fullscreen -- it stays 0 either way, the same value a
The renderer's own report changed to match, which is the same kind of correction as the
`Dynamic Glow: disabled` line: `GfxInfo_f` now prints **`GAMMA: hardware w/ 0 overbright bits`**
instead of the software-gamma line, because that is now true. Every other consumer of the flag
was checked and none of them change behaviour here -- engine screenshots gamma-correct only when
`tr.overbrightBits > 0` (tr_init.cpp:528, :558), which stays 0 windowed, and the levelshot path
(:650) now bakes gamma in exactly as it does on a desktop with a ramp.

windowed desktop run gets. Boot, map load, movement and save/load are unchanged, and the default
appearance is identical: at `r_gamma 1` the table is the identity, so the software path was baking
an identity too.

### Two measurement traps this walked into, both worth remembering

**A CSS filter is invisible to `drawImage(canvas)`.** The first cost/correctness experiment
sampled luma by drawing the canvas into a scratch 2D canvas -- which reads the canvas *backing
store*, not the composited page. It reported an all-white ramp as luma 24.4 and an all-black ramp
as 25.1, i.e. "the filter does nothing", and the fps figure taken alongside it was equally
meaningless. Sampling `Page.captureScreenshot` instead gave all-white 254.6 and all-black 0.1.
Anything that measures a compositor effect has to measure composited output.

**Luma is not linear under a gamma curve.** After the fix, `vid_restart` appeared to *double* the
gamma: filtered luma went 46.4 before the restart to 100.8 after, while the gamma-1 control moved
only 21.5 -> 29.0. Reasoning linearly, that looked exactly like textures being baked *and* the
filter applied. They were not: stripping the filter after the restart gave 28.6, matching the
gamma-1 control's 29.0 almost exactly, so the textures were clean. The scene itself is simply
brighter after a restart (the world runs unfrozen for ~18s while the renderer comes back), and a
1/3-power curve amplifies a shift in a mostly-dark scene enormously. The check that settled it was
removing the filter and re-measuring -- not any amount of further arithmetic.


## RoQ cinematics: verified, and the build comments were describing a build that no longer existed

The story cutscenes had never been tested. `assets0.pk3` carries **14 RoQ videos in JKA**
(`video/ja01`..`ja12` -- the chapter intros -- plus `jk0101_sw` and `openinglogos`) and **15 in
JK2** (`jk0101`..`jk09`, the Mon Mothma briefing set, `openinglogos`, `outcast`). Nothing in the
suite touched them: map sweeps, saves and movement all skip the `CA_CINEMATIC` path entirely.

They also *looked* excluded. Both build scripts still carried comments from the first link saying
cinematics (and, in JK2's case, the whole sound stack) were "excluded/stubbed" -- but the actual
filters had long since narrowed to `ff/` for JKA and `encryption/` for JK2, so `client/cl_cin.cpp`
was in fact being compiled and linked all along. `sys_jk_stubs.cpp` said so; the build scripts
contradicted it. Comments corrected in both.

`verify-cinematic.mjs` plays a list of videos in one session and, per video, requires:
`CA_CINEMATIC` reached, the picture to genuinely **change** (16x16 luma signature sampled at 2Hz
-- a cinematic can hold one decoded frame forever, or run its clock without presenting, and a
single screenshot cannot tell), a non-black peak, the audio play cursor to advance, and no errors.
Audio matters on its own: RoQ carries its own `ZA_SOUND_MONO`/`ZA_SOUND_STEREO` chunks decoded by
`RllDecode*ToStereo` into snd_dma's raw-sample ring, and nothing else in the suite exercises that
ring.

Result: **JKA 14/14, JK2 15/15**, every one decoding, animating and audible (audio peak
0.47-0.49). Per-video log attribution uses `###IDT3CIN <name>` markers and cuts from the *last*
occurrence, because the log ring is capped and shifts -- the same trap that once made map 1's
output appear under map 15 in `map-sweep.mjs`.

One correction along the way: the first version called a `stopcinematic` command between videos.
No such command exists -- only `cinematic` and `ingamecinematic` are registered (cl_main.cpp:1285).
None is needed either: `PlayCinematic()` calls `SCR_StopCinematic()` itself before starting the
next one. The harness now sends ESC instead, which is the player's own stop path
(cl_keys.cpp:1352).

## The movement probe was still guessing from pixels, and it was wrong in both directions

`verify-jk-move.mjs` had already been changed to ask the engine whether the player is in control
(`cls.state == CA_ACTIVE`, no key-catcher) instead of inferring it from the picture. The *second*
half of the question -- did the player actually move -- was still a periphery pixel diff: hold W,
and call it movement if the frame changed much more than it does standing still.

That metric fails on real maps, in both directions, and both failures were reproduced:

| | IDLE | W-HELD | pixel verdict | engine `viewpos` |
|---|---|---|---|---|
| JKA `t1_sour` | 53.8% | 29.3% | NO/UNCLEAR | **moved 280.0 units** |
| JK2 `kejim_post` | 0.0% | 0.1% | NO/UNCLEAR | **moved 126.0 units** |

JKA's opening map animates constantly -- vines, water, foliage -- so *standing still* already
repaints half the periphery and nothing the player does can stand out against it. JK2's is a dim
interior where 2.5 seconds of running barely changes a pixel. One map is too noisy for the test,
the other too quiet, and both reported a healthy build as broken.

So the probe now finishes the job it started and asks the engine for the answer too: `viewpos`
(cg_consolecmds.cpp, registered in both engines) prints `<map> (x y z) : yaw` straight from
`cg.refdef.vieworg`. Hold W between two of those and the distance is a direct measurement that no
amount of ambient animation can fake or hide. The pixel heuristic is kept only as a fallback and
is labelled `(pixels only)` when it is what decided.

**The control gate still has to come first, and this proved why.** Run against JK2 without enough
rounds to clear `kejim_post`'s ~70s opening camera, `viewpos` reported **2499 units** of
"movement" -- the scripted camera flying through the level while the player had no control at all.
Distance alone would have printed a confident YES. Because `!ctrl` is checked before the distance,
it printed `UNCONFIRMED (never reached player control -- raise [rounds])`, which was exactly
right; with `[rounds] 70` the same map then reported `YES (engine: moved 126.0 units)`.

Both games, current build: **JKA 280.0 units, JK2 126.0 units, MOVED: YES** -- and savegame
round-trip (save -> reload the page -> load) **PASS** for both.

## Verification status after the gamma and cinematic work (2026-08-19)

Everything re-run on the rebuilt binaries, because the gamma change touches renderer
initialisation and had to be shown not to disturb anything else.

| check | JKA | JK2 |
|---|---|---|
| build | 0 errors, 0 warnings | 0 errors, 0 warnings |
| boot console | 0 errors, 0 warnings | 0 errors, 4 retail-content warnings |
| campaign sweep | **34/34 maps**, heap flat at 768.0MB | **26/26 maps** |
| cinematics | **14/14** decoded, animated, audible | **15/15** decoded, animated, audible |
| movement (engine `viewpos`) | **YES**, 280.0 units | **YES**, 126.0 units |
| savegame round-trip | **PASS** | **PASS** |
| 8-minute soak | STABLE, +1.9%, 0 leak | STABLE, +1.9%, 0 leak |
| audio backend | cursor advancing, peak 1.00 | cursor advancing, peak 0.86 |
| Brightness slider | works live (21.5 -> 46.4) | works live (16.0 -> 51.5) |

Across the whole 34-map JKA campaign the engine emitted exactly **two** distinct complaints:
`WARNING: reused image gfx/sprites/y_grass_tall with mixed glWrapClampMode parm`, which is retail
content referencing one image with two clamp modes and is printed by the original too, and the
long-standing informational `glGetError() = 0x500` documented above (retail ships
`r_ignoreGLErrors "1"`, so nothing ever reads it on the desktop either).

## Ghoul2 characters and entity rendering, finally measured (2026-08-19)

`verify-character.mjs` was the only thing covering characters, and it asserted nothing -- it wrote
three screenshots, printed their byte sizes and exited 0 whatever happened, and its map detection
was the old kind that reports `map t1_sour NOT-DETECTED` on a healthy boot (console-check.mjs was
fixed for that by matching a `loaded \d+ faces` marker; verify-character.mjs never was). Its
header still described "the MDS character-render fixes" and defaulted to the RTCW map `escape1`:
it was carried over from the Wolfenstein work and never adapted to the JK engines. So "do
characters load and render" was open.

`verify-models.mjs` answers both halves from engine state, and **`verify-character.mjs` has been
deleted** -- a harness that asserts nothing is worse than no harness, because the suite then looks
like it covers something it does not.

**Did they load?** `modellist` (R_Modellist_f) walks `tr.models` and prints one line per model,
labelling failures `MOD_BAD`. Ghoul2 is identifiable by extension: `.glm` mesh (MOD_MDXM), `.gla`
skeleton (MOD_MDXA). JKA yavin1 loads 26 meshes and 5 skeletons; JK2 artus_mine likewise.

**MOD_BAD is not a failure, and asserting on it was wrong.** Every MOD_BAD line either game
produced was checked against the mounted retail pk3s -- all ten of them
(`models/players/player/model.glm`, `models/weapons2/noweap/noweap_w.glm`,
`models/players/mouse/lower.mdr`, and so on) are present in **no retail pk3 at all**. The engine
probes for optional assets, misses, and caches the miss; a desktop install does exactly the same.
They are listed (a *new* one appearing would be worth knowing) but never failed on.

**Are they drawn?** This took three instruments, and the two failures are the interesting part.

* *Frozen-frame pixel A/B* (the cvar-ab technique): unusable on these maps. t1_sour reported an
  80.3% "entity contribution" against a 79.8% noise floor; yavin1 22.2% against 29.7%. The scene
  drifts on its own by as much as the cvar changes it, and `timescale 0.01` did not hold it
  either -- 23.8% drift between two idle captures. The first version printed **PASS** off those
  numbers, which is worse than failing. The residual is a gate now, not a footnote.
* *`r_speeds 1`*: every line, once per frame, read `1/1 shdrs/srfs 0 leafs 4 vrts 2/2 tris` -- one
  quad. `R_PerformanceCounters` (tr_cmds.cpp:107) prints and *then* memsets, immediately before
  `RB_ExecuteRenderCommands`; when the 3D batch has already been flushed by `R_SyncRenderThread`
  earlier in the frame, the print only ever covers the trailing 2D flush.
* *GL draw calls per frame* -- the instrument soak.mjs already uses. Exact, per-frame, and nothing
  ambient can imitate it.

Result, toggling `r_drawentities` on a settled scene:

| | entities on | entities off | from entities |
|---|---|---|---|
| JKA `yavin1` | 271.6 draws/frame | 119.3 | **152.2** |
| JK2 `artus_mine` | 99.7 draws/frame | 83.5 | **16.2** |

### `CA_ACTIVE` does not mean the world is on screen

The sharpest lesson, and it has now bitten three different probes. Measured with soak.mjs on JKA
yavin1: draws/frame sits at **2** -- one quad, at 125fps -- for the first **ninety seconds** while
the opening scripted sequence runs, and only then jumps to 204. Sampling 12s after `CA_ACTIVE`
measured that blank window and concluded "entities are not reaching the renderer" on a build that
was fine. JK2's `kejim_post` has the same shape behind its ~70s text crawl, which is also why the
movement probe needs `[rounds] 70` there.

A bare threshold is not enough either: kejim_post crossed ">20 draws/frame" at 31 while still in
its opening, and at that moment entities-off measured 2 -- the world itself was not being drawn.
The probe now waits for the draw rate to **plateau** (two consecutive readings within 20%) before
measuring anything, and says so in its output.

One genuine map quirk this surfaced, worth not misreading: on `kejim_post` the settled scene is 31
draws/frame and drops to 2 with entities off, i.e. the world contributes almost nothing -- the
opening view is very nearly all culled. `artus_mine` on the same build gives the normal profile
(83.5 world + 16.2 entities), which is what shows the world path is healthy.

## Combat/death and the menu layer, and a false alarm I should not have raised (2026-08-19)

Two subsystems closed, and one wrong conclusion recorded in full because the way it went wrong is
more useful than the result.

### Death and respawn: `verify-combat.mjs`

Nothing in the suite ever applied damage, so the whole G_Damage -> player_die -> respawn/reload
chain had never run in a browser. The probe gives the player everything, kills them with the game
module's own `kill` client command, and watches engine state.

Preconditions matter more than the assertion here, and each one was added because its absence made
a result meaningless:

* **Does the cheat channel even work?** `god` replies "godmode ON" through `gi.SendServerCommand`,
  so it proves console -> CL_ForwardCommandToServer -> ClientCommand end to end. Without it a
  silent `kill` is ambiguous between broken death and a command that never arrived. (It is toggled
  twice so it ends OFF; `Cmd_Kill_f` clears FL_GODMODE itself anyway.)
* **Is the view actually the player's?** On JKA t1_sour, with no input at all, `viewpos` moved
  **2950 units in ten seconds** -- the opening camera, still flying long after the draw rate had
  plateaued. Any "the position changed, so they respawned" claim measured in that window is
  measuring the camera. The probe now waits for viewpos to hold still (drift < 32 units over 5s)
  and refuses to report at all if it never does.

Both games pass twice consecutively: view settled to 0.0 units drift, `kill` relocates the player
far beyond that control, the client returns to CA_ACTIVE, no errors.

### Menus: `verify-menu.mjs`

The UI was the last subsystem with no coverage -- every other probe boots with `+devmap` and
treats the menu as an obstacle. `idt3_client_state` already returns
`cls.state | (cls.keyCatchers << 8)`, and KEYCATCH_UI is bit 1, so who owns input is readable
directly with no pixel guessing.

Both games, on the real player path (boot to main menu -> `devmap` -> play):

| | JKA `t1_sour` | JK2 `artus_mine` |
|---|---|---|
| main menu at boot | keyCatchers=2, state=1 | keyCatchers=2, state=1 |
| in gameplay | keyCatchers=0 | keyCatchers=0 |
| ESC opens in-game menu | yes (screen changes 89%) | yes (85%) |
| ESC closes it | yes | yes |
| `uimenu` opens it | yes | yes |
| still works after a 2nd map load | yes | yes |

### The false alarm: "the pause menu is broken" -- it is not

For a while I had this recorded as a confirmed, serious defect: ESC and `uimenu` both did nothing
after the first map load of a session, in both games, reproducibly. The reasoning was sound as far
as it went. `UI_SetActiveMenu` (ui_atoms.cpp) opens with

```c
if (cls.state != CA_DISCONNECTED && !ui.SG_GameAllowedToSaveHere(qtrue))
    return;
```

which ends in the game module's `GameAllowedToSaveHere() == (!in_camera && !killPlayerTimer)`, and
`in_camera` is a cgame static that nothing in the original ever resets -- because on PC the module
is a DLL reloaded per map and starts false for free. That is exactly the shape of the two real
bugs already fixed this way (`num_roffs`, `MiscEnts`), so it looked like a third.

Three things disproved it:

1. Switching to a plain `dlopen` -- removing the duplicate instances entirely -- changed nothing.
   So the duplicate-instance story was not the mechanism.
2. Adding `in_camera = false; killPlayerTimer = 0;` to `InitGame()` made it *worse*: the first map
   load started failing too. A "fix" that breaks the working case is not fixing the thing.
3. The decisive one: the same build, with the same flags, **failed one run and passed the next**.
   The behaviour was never deterministic; I had been reading a flaky signal as a reproducible one
   because every run I had looked at happened to land the same way.

What is actually going on: the engine refuses the in-game menu whenever a scripted camera is
active, deliberately, and `t1_sour` runs its opening script in *segments*. The view can sit
perfectly still -- 0.0 units of drift over five seconds -- while a camera is still logically
running, so "the view settled" is not the same question as "the game will let you pause". A single
ESC press at an arbitrary moment therefore answers a coin flip.

The probe now does what a player does: presses ESC again. On JKA t1_sour it takes **17 presses**
(about 85 seconds) before the opening script releases and the menu opens; on JK2 artus_mine, 3.
Only a menu that never opens across the whole window is a failure. Both engine experiments were
reverted -- the game modules and `Sys_GetGameAPI` are exactly as they were.

The lesson is the one this log keeps relearning in new clothes: a probe that samples a system at
one arbitrary instant will eventually report the engine's correct behaviour as a bug. Every
gate added this session -- draw-rate plateau, viewpos settling, ESC retries -- exists because a
single-shot reading lied.

## Scripted level transitions — the campaign's own path between maps (2026-08-19)

`map-sweep.mjs` loads maps back to back with `map`, and that is emphatically **not** how the
campaign moves between levels. `SV_Map_f` does `Cvar_Set(sCVARNAME_PLAYERSAVE, "")` on purpose,
with a comment saying so: typing `map` must not preserve weapons and ammo from a level you never
really exited. The real path is a `target_level_change` entity -> `G_ChangeMap()` (g_utils.cpp) ->
the `maptransition` / `loadtransition` console commands -> `SV_MapTransition_f`, which calls
`SV_Player_EndOfLevelSave()` first. So thirty-four map loads per sweep had never once exercised
the transition machinery or the state hand-off.

`verify-transition.mjs` drives the engine's own commands and reads the engine's own answers:

* **which map is loaded** — `viewpos` prints `maps/<name>.bsp (x y z) : yaw`, so it is what the
  client is rendering, not what we asked for;
* **what was carried** — `SV_Player_EndOfLevelSave` serialises the player into the `playersave`
  and `playerammo` cvars, and `cvarlist <name>` prints them back as `<flags> <name> "<value>"`.
  Field 2 of `playersave` is `stats[STAT_WEAPONS]` (sv_ccmds.cpp).

| | JKA | JK2 |
|---|---|---|
| transition | `t1_sour` -> `t1_danger` | `kejim_post` -> `kejim_base` |
| engine reports arriving on | t1_danger | kejim_base |
| weapons carried | **16383** (all, from `give all`) | **16383** |
| ammo carried | `0 100 300 300 400 10 999 10 5 5` | same |
| then a plain `map` | `t1_fatal`, weapons **3** | `artus_mine`, weapons **8197** |

Both halves matter. Without the plain-`map` contrast the first assertion proves nothing — it would
pass whether or not the transition did anything.

### Two wrong assertions on the way, both mine

**"playersave must be empty after a plain map."** It is cleared by `SV_Map_f`, but the engine
repopulates it during the new level, so by the time the map has settled it reads
`100 100 3 ...` again. Testing emptiness therefore failed a working engine. The content is what
distinguishes the two paths — 16383 carried versus a default spawn — so that is what is asserted.

**A ">20 draws/frame" floor for "playable".** JK2's `kejim_base` settles at **14** and
`kejim_post` at **31**, because those opening views are almost entirely culled; the probe called a
perfectly good transition "never reached playable gameplay" while the engine was reporting the
right map and the carried inventory sat in `playersave`. The floor that is actually justified is
**2**: a client drawing nothing at all measures exactly 2 draws/frame — one screen quad — as
measured on JKA yavin1 during its ninety-second opening sequence. Anything above that is a real,
if sparse, scene.

## Coverage, restated (2026-08-19)

The completion bar used from here on: **a subsystem counts as verified when a harness asserts on
engine-reported state, not on pixels.** By that bar the suite now covers:

| subsystem | harness | asserts on |
|---|---|---|
| build | build-jka.sh / build-jk2.sh | 0 errors, 0 warnings |
| boot + console hygiene | console-check.mjs | engine log ring |
| campaign map loading | map-sweep.mjs | per-map load/active, heap, wasm table |
| long-session stability | soak.mjs | fps trend, heap, table, draws/frame |
| RoQ cinematics | verify-cinematic.mjs | CA_CINEMATIC, frame change, audio cursor |
| movement | verify-jk-move.mjs | `viewpos` displacement |
| savegames | verify-jk-save.mjs | save file survives reload, load reaches gameplay |
| models + Ghoul2 + entity rendering | verify-models.mjs | `modellist`, GL draws/frame with r_drawentities |
| damage / death / respawn | verify-combat.mjs | `god` reply, `viewpos`, cls.state |
| menus / UI | verify-menu.mjs | `cls.keyCatchers` (KEYCATCH_UI) |
| scripted level transitions | verify-transition.mjs | `viewpos` map name, `playersave`/`playerammo` cvars |
| gamma / Brightness | (in-tree, measured) | composited luma vs a no-change control |
| audio backend | audio-test.mjs | AudioContext play cursor + peak |

Deliberately out of scope, with reasons recorded above: multiplayer (neither GPL drop ships an MP
tree — JKA has only `starwars.vcproj`, JK2 only `starwars.dsp`/`game.dsp`, and CLAUDE.md scopes
net work to M4 Wolf:ET + RTCW-MP), force feedback (a Win32 binary blob, off by default in retail),
and dynamic glow (the engine's own hardware gate declines it, exactly as it did on a GeForce 2).

The one recurring theme worth carrying forward: **every gate in these harnesses exists because a
single-shot reading lied.** Draw-rate plateau, viewpos settling, ESC retries, warm-up window
discards, composited-output sampling — each was added after a probe confidently reported correct
engine behaviour as a bug, or the reverse. When a new probe disagrees with the engine, suspect the
probe first; that has been right every time so far.

## Final campaign runs, and the warnings checked rather than waved through (2026-08-19)

Both campaigns re-run end to end on the binaries as they stand:

| | JKA | JK2 |
|---|---|---|
| maps | **34/34 OK, 0 FAILED** | **26/26 OK, 0 FAILED** |
| wasm heap | flat 768.0MB throughout | flat 768.0MB throughout |
| function table | +~60/map (documented, module re-instantiation) | 8312 -> 9887 over 26 maps, same rate |
| distinct engine complaints | 2 | 17 |

Boot: JKA 0 errors / 0 warnings; JK2 0 errors and 4 warnings.

**The complaints were verified, not assumed.** "Retail content is just like that" is the easy
answer and it is worth exactly nothing unless checked -- if those files existed in the pk3s and
the port could not find them, it would be a virtual-filesystem bug wearing the same message. So
every named asset was looked up in the mounted retail archives:

```
gfx/2d/crosshairj              ABSENT from every pk3
icons/w_icon_turret            ABSENT from every pk3
icons/w_icon_turret_na         ABSENT from every pk3
textures/tests/floor02_alphac  ABSENT from every pk3
scripts/yavin_canyon/fly_overs4.IBI    ABSENT from every pk3
scripts/yavin_courtyard/console.IBI    ABSENT from every pk3
gfx/hud/w_icon_atst            PRESENT (w_icon_atst.tga)
gfx/hud/w_icon_atstside        PRESENT (w_icon_atstside.tga)
```

The two that are PRESENT are not "could not find" warnings at all -- they are
`reused image ... with mixed glWrapClampMode parm`, i.e. one image referenced by two shaders with
different clamp settings, which is a content-authoring issue and not a lookup failure.
`item_shield doesn't have a spawn function` is likewise literal: there is no `item_shield` spawn
entry in the game source, so a map referencing it gets exactly that message on any platform. The
port therefore finds everything that exists and complains only about what does not -- which is the
behaviour a desktop install has.

This is the same standard applied earlier to the `MOD_BAD` model list, where all ten entries also
turned out to be absent-from-retail probes. Both times the check was cheap and both times it
turned an assumption into a fact; the outcome would have been a real bug report if either had
come back PRESENT.

## The per-map module leak: root cause found, fix rejected, one real bug fixed (2026-08-19)

The `+60 wasm function-table entries per map load` growth has been documented here for a while,
along with an unresolved contradiction: replacing `idt3_dlopen_fresh()` with a plain `dlopen`
removes the growth entirely, JKA seemed fine, but **JK2 could not load the same map twice** and it
failed "silently". That contradiction is now closed on every point.

### It was never silent -- nobody was listening

`map-sweep.mjs` drains the engine's log ring. The failure never touched it, because it was a
**JavaScript-level exception**, not an engine error. Capturing `Runtime.exceptionThrown` over CDP
showed the client stalling at `CA_CONNECTED` with an uncaught `RuntimeError`, and rebuilding the
side module with `--profiling-funcs` turned the anonymous `$func1904` frames into names:

```
RuntimeError: memory access out of bounds
  CNavigator::GetNearestNode(gentity_s*, int, int, int)
  NAV_FindClosestWaypointForPoint(float*)
  CP_FindCombatPointWaypoints()
  InitGame(char const*, char const*, int, ...)
  SV_InitGameProgs -> SV_SpawnServer -> Cmd_ExecuteString -> Cbuf_Execute
```

### The bug: `CNavigator::Free()` leaves a vector full of dangling pointers

```c
void CNavigator::Free( void ) {
    node_v::iterator ni;
    STL_ITERATE( ni, m_nodes ) { delete (*ni); }   // ... and that is the whole function
}
```

It deletes every `CNode` and never clears `m_nodes`. On PC that is harmless *by luck*:
`NAV_Shutdown()` runs from `ShutdownGame()` and the game DLL is unloaded immediately afterwards,
so the vector dies with it. A side module that is never unloaded keeps the dangling pointers --
and `Load()` **appends** (`STL_INSERT`) rather than replacing, so the next map ends up indexing the
previous map's freed nodes. `GetNearestNode` then does `m_nodes[id]->GetPosition(...)` on freed
memory. `m_edgeLookupMap` is filled the same way.

Fixed: `Free()` now clears both containers -- exactly the state a module reload gives on PC. This
is kept regardless of the dlopen question, because it is a genuine use-after-free.

With it, JK2 under plain `dlopen` completed **26/26 maps with the function table pinned at 8312**
for the whole campaign (previously 8312 -> 9887).

### ...and the fix was still rejected

Two measurements killed it:

* **JKA, full campaign under plain `dlopen`: 17 of 34 maps FAILED.** The earlier "JKA survived 8x
  t1_sour" was one map repeated, not a campaign, and it did not generalise at all.
* JK2's in-game menu stopped opening after a map reload once re-instantiation was removed.

So `idt3_dlopen_fresh()` stays, and the table growth stays with it as a *bounded, measured* cost:
+60 entries per map load, with wasm linear memory flat at 768.0MB across a whole campaign. Trading
half a working campaign for a smaller function table is not a trade.

What is now known, and was not before: the growth is not the disease, it is the treatment. The
engines rely on module unload for cleanup in more places than the three found so far
(`num_roffs`, `MiscEnts`, and now `CNavigator::m_nodes`). Anyone attacking this again should start
by hunting the remaining ones with `--profiling-funcs` and CDP exception capture, which is what
finally made this one visible in minutes rather than sessions.


## OPEN: JK2's in-game menu after a second map load is intermittent

This entry has been wrong twice, in opposite directions, and the measurements are recorded so the
next person does not make it a third time.

* First it was reported as **verified working**, on the strength of one passing sample.
* Then, after three consecutive failures, it was reported as **failing consistently**.

Neither is true. Across six samples on the shipping build (`artus_mine`, `verify-menu.mjs` with
`SECOND_MAP=1`): **2 pass, 4 fail**. The first map load of a session opens the in-game menu
reliably, after ~3 ESC presses. After a second map load in the same session it sometimes opens and
sometimes never does -- and "never" survives a **60-attempt, ~5-minute** retry window, so it is not
merely slow.

### What is established

`save` run at the moment the menu is refused produces **no output at all**. That is the tell:
`SG_WriteSavegame` starts with

```c
if ( !qbAutosave && !SG_GameAllowedToSaveHere(qfalse) ) return qfalse;   // silent
```

so silence means the predicate is false, i.e. `in_camera || killPlayerTimer` is genuinely true.
The same predicate is what `UI_SetActiveMenu` consults, so the menu refusal is the engine doing
exactly what it is written to do. The question is not why the menu refuses -- it is why a camera
is still logically active five minutes after a map reload, when the same map's first load released
it in seconds.

### Ruled out, each by measurement rather than argument

* **Module-loading strategy.** Reproduces identically under `idt3_dlopen_fresh` and plain `dlopen`.
* **The `CNavigator::Free()` use-after-free fix.** Removed it, rebuilt, still reproduces.
* **`in_camera` / `killPlayerTimer` themselves.** Resetting both from `InitGame()` -- via a
  cgame-side helper restoring static-init state, deliberately not `CGCam_Disable()` (which starts a
  bar fade, reassigns `g_entities[0].contents` and sends a "cts" server command, none of which
  belongs at map init) -- did not fix it. That change was reverted rather than left in on a hunch.

### Where to look next

The flag is set by `CGCam_Enable` and cleared by `CGCam_Disable`, both driven by the map's ICARUS
script. `ShutdownGame` does call `ICARUS_Shutdown()`, so the suspicion is script-engine state that
survives it and leaves the second run of the opening sequence unable to reach its camera-disable
step. The intermittency points at a race rather than a hard stale value.

JKA passes the same test repeatedly (17 ESC presses on the first load, then fine after the
reload), so whatever this is, it is JK2-specific.

### What the diagnostic finally showed

A temporary `idt3dbg` client command was added to the game module to print the two halves of the
predicate, then removed again. In a failing second load it reports:

```
IDT3DBG in_camera=1 killPlayerTimer=0
```

while `viewpos` sits at the ordinary player spawn (`3176 -3056 1186`, yaw 10) -- the same position
a passing run reports. So a camera is flagged **on** with nothing actually driving the view: the
menu refusal is the engine correctly honouring `GameAllowedToSaveHere()`, and the real fault is
that `in_camera` is left set.

Two further things are now established, both negative and both worth not repeating:

* **The flag is set AFTER `InitGame`.** Resetting `in_camera` (and zeroing `client_camera`) from
  `InitGame()` via a cgame-side helper -- retried under the shipping `idt3_dlopen_fresh` config,
  with the 24-retry probe rather than the single-press one that produced earlier false readings --
  still measured `in_camera=1` at the point of refusal, twice in a row. So this is not the stale
  static it looks like; something enables the camera during the second load and never disables it.
  The change was reverted rather than left in: an engine divergence that fixes nothing is a cost.
* **The engine log is byte-identical between a passing and a failing second load**, apart from
  timing numbers -- same `CL_InitCGame`, same `...loaded 20989 faces`, same `Com_TouchMemory`, same
  `viewpos`. Whatever differs is not logged.

Combined with the intermittency (2 pass / 4 fail over six samples, and "fail" surviving a
60-attempt ~5-minute window), the shape is a **race in the opening cutscene's completion** on a
second load: the sequence enables the camera and its disable step is sometimes never reached.
`CGCam_Enable` / `CGCam_Disable` are driven by the map's ICARUS script; `ICARUS_Shutdown()` was
audited and does release entity resources, clear `ICARUS_BufferList` and `ICARUS_EntList`, and
delete the instance, and the `icarus/` sources carry no file-scope statics -- so the obvious
candidate there is already ruled out.

Reproduce with: `SECOND_MAP=1 node shared/wasm-build/verify-menu.mjs 8793 artus_mine`
(add `ESC_TRIES=60` for the long window).

### Root cause located: the opening cutscene never ends on a same-map reload

Instrumenting `CGCam_Enable` / `CGCam_Disable` (temporarily; removed afterwards) made the whole
thing legible in one line. A failing session, `artus_mine` loaded twice:

```
ENABLE  t=0       DISABLE t=26391      <- load 1: the opening cutscene runs and ENDS
ENABLE  t=31141   DISABLE t=41257      <- the probe's own cam_enable/cam_disable contract test
ENABLE  t=0       DISABLE t=135708     <- load 2: starts, and never ends
                                          (that disable is the probe's cam_disable, 135s later)
```

A passing session of the same test shows `ENABLE t=0 / DISABLE t=26440` on the second load -- the
cutscene completes normally. Nothing else differs. `CGCam_Disable` is never called by the camera
itself; only the map's ICARUS script (or the `cam_disable` console command) calls it, so the script
is not reaching its camera-disable step.

**Consequences when it fires, all measured:**

* `in_camera=1`, `killPlayerTimer=0` (temporary in-module diagnostic)
* the pause menu is refused -- correctly, per `GameAllowedToSaveHere()`
* **the player cannot move: 0.0 units** holding W, against 336 units in a healthy session
* the engine's own `cam_disable` clears it and restores both menu and movement immediately, and
  nothing re-asserts the flag -- so no cutscene is actually running by then

**The contract itself is sound**, verified deterministically rather than by inference:
`cam_enable` -> ESC refused (`keyCatchers=0`); `cam_disable` -> ESC opens the menu
(`keyCatchers=2`). A set `in_camera` is necessary and sufficient.

### Scope: this does NOT break the campaign

Worth stating plainly, because a stuck cutscene that locks the player sounds campaign-ending and
is not:

| second load | result |
|---|---|
| `maptransition` to the next level (the campaign's own path) | player **in control, 336 units**, inventory carried (weapons 16383) |
| `devmap` a **different** map | cutscene completes (`ENABLE t=82839 / DISABLE t=97647`), menu fine |
| `devmap` the **same** map again | intermittently never completes -- player and menu locked |

So it is reachable by a console `map`/`devmap` of the level you are already on, not by playing
through. Reproduce with `SECOND_MAP=1 node shared/wasm-build/verify-menu.mjs 8793 artus_mine`
(`SECOND_MAP_NAME=<other>` to contrast).

### Two fixes attempted and reverted, both ineffective

* `in_camera = false` from `InitGame()` -- still measured `in_camera=1` afterwards.
* the same reset from `CG_Init()`, cgame's own per-map entry point, chosen because `InitGame` runs
  on the `ge` instance which need not be the live cgame instance under `idt3_dlopen_fresh` -- also
  still measured `in_camera=1`.

Both were reverted. The flag is set *after* both entry points, by the map's own script starting its
cutscene; the bug is that the script does not finish it. Clearing the flag earlier cannot fix that,
and a watchdog that force-clears a camera nobody asked it to clear would be inventing behaviour the
original does not have. Left open, with the mechanism pinned down to a single missing script step.

### A probe bug this turned up

The movement check initially reported `0.0 units` on a *healthy* session -- because it ran while
the menu was open, so W went to the UI rather than the player. It is now guarded on the menu being
closed. Same lesson as the rest of this log: an instrument that is not thinking about the state it
samples in will manufacture a defect.

### Third fix attempted and rejected: stale camera timestamps

The camera event log showed one structural difference between the two paths:

```
devmap <same map again>    ENABLE t=0        <- cg.time restarted
devmap <different map>     ENABLE t=82839    <- cg.time carried on
```

`client_camera` holds absolute cg.time deadlines (`move_time`, `pan_time`, `next_roff_time`), and
on PC the struct starts zeroed every map because the DLL is reloaded. The hypothesis was that with
cg.time back at 0, deadlines left from the previous run (up to ~41000) sit in the future, so the
gated camera operation never completes and the script waits on it forever. It also explained the
intermittency and why it is same-map only.

It is wrong. Zeroing the whole `client_camera` block (plus `in_camera`) from `CG_Init` -- cgame's
own per-map entry point, on the live instance -- still produced a locked session on the second
sample. Reverted.

So three hypothesis-driven fixes have now been tried and rejected on evidence:

| attempt | where | result |
|---|---|---|
| `in_camera = false` | `InitGame()` | still `in_camera=1` afterwards |
| `in_camera = false` | `CG_Init()` | still `in_camera=1` afterwards |
| `in_camera` + whole `client_camera` zeroed | `CG_Init()` | still locks |

The common thread: everything that runs at map-init time is too early. The flag is set *after*
those points by the map's own script, and the fault is that the script never runs its matching
`camera disable`. Clearing state before the script starts cannot fix a script that does not
finish.

**Stopping here deliberately, not because the trail is cold.** The next step is instrumenting the
ICARUS sequencer/task manager to see which task is left pending when the camera never releases --
`icarus/Sequencer.cpp` and `TaskManager.cpp`, whose state lives in the per-map `ICARUS_Instance`
rather than in any file-scope static (already checked). That is a deeper dive than the remaining
value justifies for a defect that:

* cannot be reached by playing the campaign -- `maptransition` to the next level arrives with the
  player in control (336 units) and inventory carried;
* requires a console `map`/`devmap` of the level you are already standing in;
* is intermittent even then;
* and has a one-command recovery (`cam_disable`) that fully restores menu and movement.

Everything needed to resume is here: the reproduction, the measured signature, the proven
contract, and three eliminated hypotheses.

## CORRECTION, and a severity upgrade: the stuck cutscene DOES affect campaign progression

The scope table above -- "this does NOT break the campaign", with `maptransition` shown as healthy
at 336 units -- was **wrong, and wrong for the reason this log keeps recording: it rested on a
single passing sample.**

Re-measured properly on `kejim_post -> kejim_base`, the campaign's own transition path:

| | result |
|---|---|
| samples | 1 in control, 4 locked |
| view drift before testing | 0.0 units / 5s (fully settled -- not a still-running camera move) |
| movement, all four directions | `w=0 s=0 a=0 d=0` |
| after `cam_disable` | **336.0 units** -- freed immediately |

So the player arrives at the next level and cannot move at all, in any direction, with the view
completely still; clearing the camera flag releases them. It is the same defect as the same-map
reload, reached through normal play.

Two probe faults had been masking this, both now fixed and both the same mistake in different
clothes:

* **Testing movement before the arrival cutscene could legitimately end.** A plateaued draw rate
  says the world is being drawn, not that the player has control -- exactly the trap documented for
  three other probes in this log. `verify-transition.mjs` now waits for `viewpos` to hold still
  (<32 units over 5s) before testing, the same gate `verify-combat.mjs` uses.
* **Testing only W.** `viewpos` cannot tell "locked" from "facing a wall", and an arrival spawn can
  easily be nose-first into geometry. It now tries W, S, A and D and accepts movement in any
  direction.

With both gates in place the result is unambiguous, and the earlier single 336-unit reading was a
run where the cutscene happened to complete.

### Status

This is the most serious open defect in either port: **JK2 frequently strands the player on level
transitions.** It has a one-command recovery (`cam_disable`) and the mechanism is pinned to a
single missing script step -- the map's ICARUS script never reaching its `camera disable` -- with
three map-init-time fixes already eliminated because they all run before the script sets the flag.

JKA shows no equivalent behaviour.

The next step is unchanged but now clearly worth taking: instrument `icarus/Sequencer.cpp` /
`TaskManager.cpp` to identify which task is left pending when the camera never releases.

### Controls applied, and the result stands

Two things that could have made this a false alarm were checked:

* **Host contention.** The first failing samples ran with up to 28 stale headless Chrome processes
  alive, and script timing is exactly the kind of thing that could distort. Re-run twice with the
  browser table cleared first: `w=0 s=0 a=0 d=0`, then `cam_disable` -> 336.0 units, both times.
  Not contention.
* **Is it JK2-specific?** JKA, same harness, same gates, `t1_sour -> t1_danger`: view settled,
  **478.3 units, player in control**, weapons 16383 carried, and a following plain `map` correctly
  drops to weapons 3. JKA is unaffected.

Tally on `kejim_post -> kejim_base`: **1 in control, 6 locked** across contended and clean runs.

This is the most serious defect found in either port, and unlike everything else in this log it is
reachable by simply playing: finish a level, arrive at the next one, and the player often cannot
move until `cam_disable` is typed at the console. Everything needed to continue is recorded above
-- reproduction, signature, proven contract, three eliminated fixes, and the next instrumentation
step (`icarus/Sequencer.cpp` / `TaskManager.cpp`, to find the pending task).

### Refined with the engine's own script trace

`g_ICARUSDebug 3` (a shipped CVAR_CHEAT that logs script execution) made the arrival sequence
visible, and it both sharpened the diagnosis and exposed one more fault in the probe:

```
maps/kejim_base.bsp (0 0 6) : 0          x8   <- the player is at the world ORIGIN
maps/kejim_base.bsp (416 792 60) : -180        <- placed, once scripts/kejim_base/start ran
INFO: 34900 Script scripts/kejim_base/ambush executed by target_scriptrunner run_ambush
maps/kejim_base.bsp (80 792 60) : -180         <- 336 units, after cam_disable
```

**The probe fault:** `(0 0 6)` is the origin -- the player is not placed yet -- and a player at the
origin is perfectly *still*, so the "view settled" gate passed and movement was tested before there
was anyone to move. `verify-transition.mjs` now refuses to treat an origin reading as a placed
player and says so.

**The verdict did not change.** With the corrected gate the player stays at `(0 0 6)` for the full
120-second window and then moves 336 units the moment `cam_disable` is issued. That is consistent
with `CGCam_Enable`'s own comment -- "Player zero not allowed to do anything" -- so the camera is
holding the player, exactly as designed, and the fault remains that nothing releases it.

JKA through the same corrected gate: player placed at `-3881 -2584 1244`, settled, **471.3 units,
in control**, weapons 16383 carried, plain `map` correctly dropping to 3. Unaffected.

### Next lead, concrete: the two clocks disagree after a transition

Running the arrival with the engine's own `g_ICARUSDebug 4` (WL_DEBUG = 4; the earlier attempt at
3 was one level too low to print wait commands) captured the script's own wait trace:

```
^4DEBUG: ambush_io(150):   wait("fire");   [409050]
^4DEBUG: ambush_st2(297):  wait( 3000 );   [409850]
^4DEBUG: shoot_glass(162): wait( 3000 );   [409850]
```

The bracketed number is `task->GetTimeStamp()`, i.e. `Q3_GetTime()` == **`level.time`**, reading
~409,000 ms on a map that had just been loaded. The camera events from the same session report
`cg.time = 0` at `CGCam_Enable`. So after a transition the game clock and the client clock are far
apart, and anything that sets a deadline in one and tests it in the other cannot work. On PC both
start near zero together on every map, so a mix-up like that would never show.

Where to look first:

* `SV_SpawnServer` does `memset(&sv, 0, sizeof(sv))` then `sv.time = 1000`, and
  `SV_InitGameProgs` passes that straight through:
  `ge->Init( ..., sv.time, com_frameTime, Com_Milliseconds(), ... )` (sv_game.cpp:498).
  So `level.time` is *supposed* to restart at ~1000 on every map. The trace says it does not.
* Two ICARUS wait forms can hang forever, and both are worth checking against that clock:
  `wait( <ms> )` completes only when `timestamp + dwtime < I_GetTime()`, and `wait( "<group>" )`
  returns `TASK_FAILED` with `completed = false` -- re-queuing itself every frame -- whenever
  `GetTaskGroup()` cannot find the named group (TaskManager.cpp:1059).

That is the first thing to measure next time: print `level.time` at the top of `InitGame` and at
the first `CGCam_Enable` on both the first and second map of a session, in JK2 and JKA. If
`level.time` really is carrying across maps in JK2, that is very likely the whole defect, and it is
a much smaller thing to fix than the script engine.

## CORRECTION: the transition lock is NOT the stuck camera, and the mechanism is unknown

Everything above that attributes the level-transition lock to `in_camera` is **withdrawn**. The
observation is real; the explanation was not.

**What is solidly established**, from a run that issues no commands at all and therefore cannot
perturb what it measures:

```
left origin after     : NEVER (>263s)
movement by direction : w=0 s=0 a=0 d=0
after cam_disable     : 336.0 units
```

After `maptransition kejim_post -> kejim_base` the player sits at `(0 0 6)` -- the world origin,
i.e. never placed -- for over four minutes of pure observation, cannot move in any direction, and
then moves 336 units the moment `cam_disable` is typed. That is reproducible and it is JK2-only:
JKA through the identical harness reports the player placed at `-3881 -2584 1244`, settled, **471.3
units, in control**.

**Why the camera explanation fails.** `CMD_CGCam_Disable` does three things -- `CGCam_Disable()`,
`CGCam_SetFade()`, and `player_locked = qfalse` -- so "cam_disable fixes it" identifies the
*group*, not the member. Taking them in turn:

* `player_locked` is assigned `qfalse` in exactly two places and **is never set true anywhere in
  the codebase** (Q3_Interface.cpp:6392 defines it `qfalse`). It cannot be the cause.
* `in_camera` requires `CGCam_Enable`, and instrumenting both entry points showed a `DISABLE` (the
  probe's own `cam_disable`) with no `ENABLE` in the captured window. That is suggestive but *not*
  conclusive, because the log ring is capped at 2000 lines and a map-1 `ENABLE` can scroll out
  before the dump. Recorded as unresolved rather than decided.

**Hypotheses eliminated by measurement, so nobody repeats them:**

| hypothesis | how it died |
|---|---|
| `level.time` fails to reset across maps | printed it: `levelTime=1000 level.time=1000` on **both** maps |
| the two clocks diverge | the 409,000 ms figure was map 2's own clock after several minutes of probe settle loops -- ordinary |
| `player_locked` stuck true | nothing in the source ever sets it true |
| `in_camera` stale from map 1 | resetting it at `InitGame()` and again at `CG_Init()` changed nothing |
| stale `client_camera` deadlines vs a restarted `cg.time` | zeroing the whole struct at `CG_Init()` changed nothing |
| module-loading strategy | reproduces identically under `idt3_dlopen_fresh` and plain `dlopen` |
| the `CNavigator::Free()` use-after-free | removed the fix, rebuilt, still reproduces |

**Method note, because it cost more than any hypothesis did.** Four separate conclusions in this
investigation had to be retracted, and every one came from an instrument that was not thinking
about the state it sampled in:

* a movement check that ran with the menu open, so W went to the UI -- reported `0.0 units` on a
  healthy player;
* a "view settled" gate that accepted a player parked at the world origin as *still*;
* a movement check that only pressed W, unable to tell "locked" from "facing a wall";
* a trace dump taken at the end of a run, by which time the arrival script had scrolled out of the
  ring, leaving a later script's ordinary timestamps to be misread as a clock that had not reset.

Two conclusions were also drawn from runs whose **build had silently failed** (`errs: 714`), so the
old module was under test. Check `build.errs` is zero before believing any result that follows a
source edit.

**Status: open, mechanism unknown, JK2 only.** The next honest step is to determine whether
`CGCam_Enable` fires at all on either map, using a sink that cannot overflow -- write the events
straight to a file through the platform layer rather than the capped console ring.

## FIXED: a cinematic camera left running when the level ends (2026-08-19)

The transition lock is solved, and the answer came from fixing the *instrument*, not from a new
hypothesis. Capturing the engine log **uncapped** -- `index.html` funnels `Module.print` into a
ring capped at 2000 lines that shifts, so the arrival sequence was always gone by the time a probe
dumped it -- made the whole thing visible in six lines:

```
DEBUG: cinematic1_script(558): camera( ENABLE ); [1850]              <- on kejim_post
DEBUG: cinematic1_script(558): camera( MOVE, <4092 -1724 63>, ... );
maps/kejim_post.bsp (4092 -1724 63) : 212                            <- the view IS the camera
==== ShutdownGame ====                                                <- level ends mid-cinematic
Server: kejim_base
...no camera( ENABLE ) and no camera( DISABLE ) ever again
```

The level ends while the cinematic is still playing, so the ICARUS script that would have run
`camera( DISABLE )` dies with the level and `in_camera` is never cleared. On PC that costs nothing:
the game+cgame DLL is unloaded and reloaded per map, so the flag returns to its static initialiser
for free. Our side module persists, so it carries into the next level, which then behaves as though
a cutscene were playing -- `CGCam_Enable`'s own *"Player zero not allowed to do anything"* keeps the
player unplaced at the world origin, and `GameAllowedToSaveHere() == (!in_camera &&
!killPlayerTimer)` refuses the pause menu for the rest of the session.

**This is the fourth instance of one pattern in this port** -- `num_roffs`, `NumMiscEnts`, entity
ICARUS state, and now `in_camera`. Every one is "the original relies on module unload for cleanup,
and we have to do it explicitly."

The fix restores the static-init value at `CG_Init`, cgame's own per-map entry point. Deliberately
*not* `CGCam_Disable()`: that is the runtime "a cutscene just ended" path and would start a bar
fade, reassign `g_entities[0].contents` and send a `cts` server command, none of which belongs at
init. A level that legitimately opens on a cutscene sets the flag again moments later.

Applied to **both** engines. JKA has the identical `in_camera` static in `cg_camera.cpp`, the
identical predicate at `g_savegame.cpp:1236`, and the same persisting module; it was never observed
to trip on `t1_sour -> t1_danger`, but that is a property of the map pair tested, not of the engine.

### Measured

| | before | after |
|---|---|---|
| JK2 `kejim_post -> kejim_base` | 1 pass / 6 fail; player at origin **>264s**, immobile w/s/a/d | **4/4 pass**, `left origin after: 1s`, 336 units |
| JK2 same-map reload, pause menu | 2 pass / 4 fail | **2/2 pass** |
| JKA `t1_sour -> t1_danger` | 471 units (already passing) | 468 units, weapons 16383, pass |

### Two of my own conclusions this overturned

* **Withdrawing the camera attribution was wrong.** "No `CGCam_Enable` was logged" was the capped
  ring dropping it, not evidence of absence. The lesson is the one this log keeps relearning: an
  instrument that silently discards data manufactures conclusions in both directions.
* **The `CG_Init` reset was called "ineffective" twice.** Both trials were against the *same-map
  reload*; it had never been tried against the transition path. Not a repeated failure -- an
  untested case.

### Standing rule earned here

Check `build.errs` is zero before believing any result that follows a source edit. Two conclusions
in this investigation came from runs whose build had silently failed (`errs: 714`), so the previous
module was under test.

## CORRECTION to the fix itself: it is one line, and it is Raven's own

The `CG_Init` reset described above was replaced. Comparing the two engines' `CG_Shutdown` -- the
function whose own comment reads *"Called before every level change or subsystem restart"* --
settles where this belongs:

```c
// JK2 (this drop)                 // JKA (the later engine)
void CG_Shutdown( void )           void CG_Shutdown( void )
{                                  {
                                       in_camera = false;      <-- present only here
    FX_Free();                         FX_Free();
}                                  }
```

The functions are otherwise identical, comment included. **Raven fixed this bug in JKA; the JK2
drop predates the fix.** So the change is that single line, in that function, and nothing else.

Two consequences:

* **JKA is back to pristine.** The reset added to JKA's `CG_Init` was pure redundant divergence --
  the shipped code already clears the flag, which is exactly why JKA never tripped this in any
  test. Removed. The asymmetry that looked like a mystery all session (JK2 fails, JKA does not) was
  simply that one engine has the line.
* **JK2 gets the line where its author put it**, rather than a bespoke reset at a different entry
  point chosen by guesswork.

Re-verified after relocating: `kejim_post -> kejim_base` **3/3 pass**, `left origin after: 1s`,
336 units each time.

**A judgment call flagged for review.** That line was identified by reading JKA's source. The hard
rule in CLAUDE.md bars copying from **iortcw, OpenJK and ET:Legacy** -- community ports -- and both
`games/jka` and `games/jk2` here are pristine Raven GPL drops, so this reads as the same vendor's
own later fix rather than a third-party patch. It is called out explicitly so a reviewer can take
the stricter reading; the fallback would be the `CG_Init` reset, which works but sits in the wrong
place for the wrong reason.

## Verification after the `CG_Shutdown` fix (2026-08-19)

Everything re-run against the relocated one-line fix, not the earlier `CG_Init` version.

| check | JKA | JK2 |
|---|---|---|
| build (engine + game module) | 0 errors, 0 warnings | 0 errors, 0 warnings |
| boot console | 0 errors, 0 warnings | 0 errors, 4 retail-content warnings |
| campaign sweep | **34/34 OK** | **26/26 OK** |
| level transition | 468 units, in control, weapons 16383 | **3/3 pass**, origin left in 1s, 336 units |
| cinematics (video + audio) | **14/14** | **15/15** |
| savegame round-trip | PASS | PASS |
| movement (engine `viewpos`) | 281 units | 138 units |

The cinematic sweeps matter here specifically: the fix touches camera state on level change, and
`CGCam_*` is the same subsystem the RoQ player's `CA_CINEMATIC` path sits beside. Both games play
every shipped video, decoding and audible, unchanged.

### Final engine-change inventory

Five changes across both trees, every one `__EMSCRIPTEN__`-guarded:

| file | change | why |
|---|---|---|
| jka `cg_main.cpp` | `CG_ResetMiscEnts()` | misc-model cache survives map load |
| jka `g_main.cpp` | `.ROF` cache reset | `num_roffs` survives map load |
| jk2 `cg_main.cpp` | `in_camera = false` in `CG_Shutdown` | the line JKA ships and JK2 does not |
| jk2 `g_main.cpp` | `.ROF` cache reset | same as JKA |
| jk2 `g_navigator.cpp` | `CNavigator::Free()` use-after-free | deletes nodes, never clears the vector |

**Four of the five are one bug wearing different clothes**: the original relies on the game DLL
being unloaded per map to reset its statics, and a persisting wasm side module never gets that for
free. `num_roffs`, `NumMiscEnts`, `in_camera` are the three statics; the navigator use-after-free is
the same assumption seen from the other end -- harmless on PC only because the DLL unloads
immediately afterwards.

That pattern is the single most useful thing to know when porting one of these engines. Anything
that is only correct because a library gets unloaded is a defect here, and it will present as
"works on the first map, misbehaves on the second."

## Still open, and separate: same-map console reload

The `CG_Shutdown` line fixes the *transition* defect and does not touch this one. Measured against
the relocated fix: `devmap artus_mine` twice in one session gives **1 pass / 2 fail** on the pause
menu, unchanged from before.

They are genuinely different faults, and the camera traces distinguish them:

| | transition (`maptransition A -> B`) | same-map (`devmap A` twice) |
|---|---|---|
| trace | `camera( ENABLE )` on map A, level ends mid-cinematic, no `DISABLE` | `ENABLE t=0` on the **second** load, no `DISABLE` |
| flag | carried over from the previous level | set fresh on the new one |
| fixed by clearing state at level change | **yes** | no -- the flag is set after that point |

An earlier "2/2 pass" reported for the same-map case was two samples of a bug that had been failing
two-in-four; it was luck, not evidence, and is retracted. Sample counts for intermittent faults
have to be set by the failure rate, not by convenience -- the third such retraction in this
investigation and by far the most avoidable.

**Severity: low.** It requires typing `devmap <the level you are already standing in>` at the
console. It is not reachable by playing the campaign, which is verified clean end to end on both
games. Recovery is `cam_disable`.

Instrumentation for the next attempt is already in place: `verify-menu.mjs` now captures the engine
log **uncapped** (the capped ring hid the transition cause twice) and honours `EXTRA_ARGS`, so
`EXTRA_ARGS="+set g_ICARUSDebug 4" SECOND_MAP=1 node shared/wasm-build/verify-menu.mjs 8793
artus_mine` writes a full script trace to `$LOGFILE`. What is wanted from it is the second load's
intro script: which command it reaches before the camera stops being disabled.

### What the uncapped log shows for the same-map case

Three instrumented runs (`EXTRA_ARGS="+set g_ICARUSDebug 4"`), two passing and one failing, with
the full trace kept. The failing run is immediately distinguishable by size: **313 log lines
against 486**.

The state going *into* the reload is identical -- same script, same command, 50 ms apart:

```
PASS  ^4DEBUG: t63(273): wait( 35000 ); [26600]
FAIL  ^4DEBUG: t63(273): wait( 35000 ); [26550]
```

The divergence is entirely inside the second load:

| after the second `Server: artus_mine` | PASS | FAIL |
|---|---|---|
| NPC `BSET_SPAWN` scripts | ~200 lines, running normally at `[1550]` | **none at all** |
| what appears instead | -- | `INFO: target_scriptrunner cinematic4_script used by kyle` |
| anything after that | the level plays | **silence for the rest of the run** |

So on a failing reload the level never finishes bringing its entities up -- `artus_mine/kill_me`,
`artus_mine/prisoner1` and the rest never execute their spawn scripts -- and a cinematic
scriptrunner fires instead. That is consistent with everything measured downstream: a camera
enabled by a cutscene that the level never got far enough to finish, hence no `camera( DISABLE )`,
hence `in_camera` stuck, hence the pause menu refused.

Note it is *not* the same fault as the transition defect, which was a flag surviving a level
change. Here the flag is set fresh, by a script that runs when it should not.

The next question is why `cinematic4_script` is "used by kyle" on a fresh load at all -- a
`target_scriptrunner` fires on a trigger, and the player should not be standing in one at spawn.
Worth checking whether the player is being restored to the previous session's position instead of
`info_player_start` on `devmap`.

### Narrowed to three lines, all of which fail silently

On a failing second load the script is *attempted* and never *runs*:

```
PASS  INFO: target_scriptrunner cinematic4_script used by kyle
      INFO: cinematic4_script attempting to run bSet BSET_USE (cinematics/cinematic4)
      INFO: 1600 Script scripts/cinematics/cinematic4 executed by target_scriptrunner   <-- present
      ... 8 camera( ... ) commands follow

FAIL  INFO: target_scriptrunner cinematic4_script used by kyle
      INFO: cinematic4_script attempting to run bSet BSET_USE (cinematics/cinematic4)
      (nothing -- no "executed by", zero camera( commands, and ICARUS never logs again)
```

`ICARUS_RunScript` (g_ICARUS.cpp) can only fail three ways, and **every one returns silently**:

```c
if ( ent->sequencer == NULL ) return false;                 // its Com_Printf is commented out
len = ICARUS_GetScript( name, &buf );
if ( len == 0 ) return false;                               // silent
if S_FAILED( ent->sequencer->Run( buf, len ) ) return false; // silent
```

That silence is why this defect took so long to corner: a script can fail to run in three distinct
ways and say nothing. Restoring a diagnostic on those paths is worth doing on its own merits,
independently of this bug.

One candidate ruled out immediately: `ICARUS_BufferList` is
`map<string, pscript_t*, less<string>>`, so the script cache is keyed by string *content*. The
`find( (char *) name )` calls look like the classic pointer-keyed-cache bug and are not.

**Sampling status.** Post-fix the same-map case measures **7 pass / 3 fail over 10 runs** -- an
intermittent race of roughly 30%, unchanged in character by the `CG_Shutdown` fix (which addresses
a different fault). Catching it under instrumentation is a matter of enough samples; four
consecutive passes proved only that four runs passed.

### CORRECTION: after the fix, the same-map failure is no longer the `in_camera` predicate

The `CG_Shutdown` fix changed this defect's failure *mode*, which invalidates the description above.

Before the fix, running `save` at the moment the menu was refused produced **no output at all** --
`SG_WriteSavegame` returns silently when the predicate is false, which is how `in_camera` was
identified as the blocker. After the fix, the same probe at the same moment reports:

```
save at that moment  : ^5Saving game "idt3menuprobe2"... | ^5Done.
```

The save **succeeds**. And both callers bottom out in the same place --
`SG_GameAllowedToSaveHere(qboolean inCamera)` uses its argument only to *skip* the extra checks
(server running, not in a video, `sv.state`, map name, health) and then returns
`ge->GameAllowedToSaveHere()` regardless. So a successful save proves that predicate is true, and
therefore proves the menu is **not** being refused by `in_camera` or `killPlayerTimer` any more.

Something else refuses it. `cam_disable` still clears the symptom, but that command does three
things -- `CGCam_Disable()`, `CGCam_SetFade()`, `player_locked = qfalse` -- and `CGCam_Disable()`
additionally restores `g_entities[0].contents` and sends a `cts` server command. Identifying which
of those matters is the open question; the earlier reasoning that "cam_disable fixes it, therefore
in_camera" was never valid and is now positively disproved.

Also newly established, from the uncapped trace: on a failing second load the engine reaches
`G_ActivateBehavior`'s "attempting to run bSet" print and then **produces no further output for the
rest of the session**, while none of the three `ICARUS_RunScript` failure paths (instrumented, then
reverted) fire. Execution never enters that function. The call site carries Raven's own comment:

```c
//FIXME: between here and actually getting into the ICARUS_RunScript function, the stack gets blown!
```

Ruled out along the way: the script cache is keyed by `std::string` content, not by pointer
(`ICARUS_BufferList` is `map<string, pscript_t*, less<string>>`, so the `find( (char *) name )`
calls are not the bug they resemble); and `bs_name` is an entity field, not a `va()` result
aliasing the buffer the call then formats into.

**Sampling, post-fix: 7 pass / 4 fail across 11 runs.** Roughly a third, unchanged in rate.
Severity is unchanged and low: it needs `devmap <the level you are standing in>` at the console and
is not reachable by playing the campaign.

### The likely root: statics split across module instances, measured

`va()` was instrumented to print the address of its `static char string[2][32000]` once per copy.
One session, two map loads:

```
IDT3VA buffer=0x12cfd50     <- the engine (main module)
IDT3VA buffer=0x4b10380     <- game module, instance 1
IDT3VA buffer=0x8b50380     <- game module, instance 2
```

Two things fall out, one of which kills a hypothesis:

* **Engine and game do NOT share `va`'s buffer.** They have separate copies, as on PC. The theory
  that a flat symbol namespace collapses them into one rotating buffer -- which would have made
  every cross-boundary `va()` result corruptible, and looked like a tidy explanation for an
  intermittent fault -- is wrong.
* **The side module gets a fresh set of statics per instantiation.** `idt3_dlopen_fresh()`
  re-instantiates it on every map load, so each load produces another private copy of every static
  in the game module.

That second point matters, because this port has already measured that gameplay stays bound to
**instance #1** while `dlsym` on the new handle reaches instance #2 (see the `CG_ResetMiscEnts`
entry, where `&NumMiscEnts` differed between the reset and the increment). So after a second map
load there are two live copies of every game-module static, and which one a given code path sees
depends on how it was reached.

That is the same root cause as the three defects already fixed here -- `num_roffs`, `NumMiscEnts`,
`in_camera` -- and it is the most probable explanation for the residual same-map fault: a piece of
script or behaviour state written in one instance and read in the other, intermittently, depending
on interleaving.

It also explains why every fix attempted at map-init time failed. Those all write instance N's copy
while the reader may be looking at instance 1's.

**The structural fix is known and already rejected on evidence**: dropping `idt3_dlopen_fresh()` in
favour of a plain `dlopen` removes the duplicate instances entirely -- and costs **17 of 34 JKA
maps**, which is far worse than the defect it would cure. That measurement is recorded above and
has not changed.

So the honest position on this one is: root cause identified with high confidence, the clean fix is
unavailable, and the remaining options are per-symbol resets of the kind already applied three
times -- each needing the specific static identified first. The next step is to find which static
diverges on the failing path, which the address-printing technique above can do directly.

### The fault is timing-sensitive: instrumentation suppresses it

Bracketing the suspect call to separate "`va()` faulted" from "`ICARUS_RunScript` failed":

```c
printf( "IDT3BS pre ptr=%p seq=%p", bs_name, self->sequencer );
const char *idt3p = va( "%s/%s", Q3_SCRIPT_DIR, bs_name );
printf( "IDT3BS post name=%s", idt3p );
ICARUS_RunScript( self, idt3p );
```

Eight consecutive runs passed, every one showing identical, healthy values:

```
IDT3BS pre  ptr=0x1dbd34c seq=0x1bc2d48
IDT3BS post name=scripts/artus_mine/start
```

Against a fault that reproduces roughly one run in three *without* instrumentation, eight
consecutive passes is itself a measurement: **adding `printf` calls to this path suppresses it.**
The same happened with `g_ICARUSDebug 4` enabled (2 pass / 1 fail, where the same build failed
2-of-3 with debug off). That is the signature of a race, not of a deterministic bad pointer, and it
rules out the simplest version of the dangling-`bs_name` theory -- a genuinely invalid pointer
would fault regardless of how much logging surrounds it.

It also means this particular instrument cannot catch this particular bug: observing it changes it.
Catching it needs something that does not add work to the failing path -- recording the pointer
values into a static ring inspected *afterwards*, rather than printing inline.

Running total on the same-map case, post-`CG_Shutdown`-fix and excluding runs invalidated by a CDP
port collision: **15 pass / 4 fail across 19 runs.**

### RESOLVED to a mechanism (2026-08-19): the predicate *is* false at the ESC moment

Measured directly, printing `SG_GameAllowedToSaveHere()` from inside `CL_KeyEvent` at the instant
ESC is pressed, three failing runs:

```
IDT3ESC state=7 catchers=0 ingameCin=0 standby=0
IDT3ESC allowed(qtrue)=0 allowed(qfalse)=0
```

So the chain is settled:

1. ESC reaches the menu code -- `cls.state == CA_ACTIVE`, `keyCatchers == 0`, and
   `CL_IsRunningInGameCinematic() == 0`, so the cinematic branch in `CL_KeyEvent` does **not**
   swallow it. (That branch was a candidate; it is excluded.)
2. `UI_SetActiveMenu( "ingame", NULL )` is entered and returns at its very first line, because
   `ui.SG_GameAllowedToSaveHere(qtrue)` is false.
3. With `inCamera = qtrue` that call skips every other check and reduces to
   `ge->GameAllowedToSaveHere()` == `(!in_camera && !killPlayerTimer)`. So a camera is active when
   ESC is pressed.
4. It cannot be a missing menu: `UI_InGameMenu()` calls `Key_SetCatcher( KEYCATCH_UI )`
   **unconditionally**, so even a failed `Menus_ActivateByName` would leave catchers at 2. They are
   0, which places the exit strictly at step 2.

**Two of this investigation's own errors, corrected.**

*The "save succeeds, so the predicate is true" disproof was invalid.* The probe runs that save
**after** its ESC attempts, so it measured a different moment. The predicate is false during the
ESC window and true later. Using a measurement from one moment to exclude a hypothesis about
another is the same mistake this log records twice already; it cost the `in_camera` explanation a
premature retraction and several rounds chasing `va()`, dangling `bs_name`, and
`ICARUS_RunScript` -- all of which measured clean.

*The `Menus_ActivateByName: Unable to find menu ''` warning is produced by the probe itself*, which
sends `uimenu` with no argument. It is not an engine fault and was nearly reported as the cause.

**What remains open** is narrow: on a same-map `devmap` reload the opening cutscene enables the
camera and, intermittently, never reaches its `camera( DISABLE )`. That is the same *shape* as the
transition defect fixed above but a different *cause* -- there the flag survived a level change,
here it is set fresh by a cutscene that does not finish. The `CG_Shutdown` clear correctly fixes
the first and correctly cannot fix the second.

### Two more mechanisms eliminated, and the address trail that survives

**`CG_SHUTDOWN` is not being skipped.** The guard in `CL_ShutdownCGame` (`if ( !cgvm.entryPoint )
return;`) looked like a perfect explanation for "the fix works on transitions but not on reloads".
Instrumented, it is not: the dispatch sequence is **identical** on passing and failing runs.

```
FAIL  entryPoint = 0, 0, 0, 0x1ee3, 0x1ee3, 0, 0x20b6
PASS  entryPoint = 0, 0, 0, 0x1ee3, 0x1ee3, 0, 0x20b6
```

`CG_SHUTDOWN` is dispatched three times with valid entry points in both. Whatever differs, it is
not whether cgame's shutdown runs.

**The second load runs no camera commands at all.** Counting `camera( ... )` script commands either
side of the map change, three failing runs agreeing exactly:

```
load1 cam=8    load2 cam=0
```

So `in_camera` is **not** set fresh on the second load -- it is carried over from the first. That
kills the "the reload's own cutscene starts and stalls" reading recorded earlier, which had been
inferred from a log whose script tracing was switched off (zero lines because nothing was logging,
not because nothing ran -- a trap worth naming, since it produced a confident wrong conclusion).

**What the addresses do show.** `cgvm.entryPoint` changes across loads, `0x1ee3` -> `0x20b6`: a new
cgame instance. Combined with the three `va()` buffer addresses measured earlier (one engine, two
game-module instances in a two-map session), the picture is consistent: `CG_Shutdown` clears *its*
instance's `in_camera` while `ge->GameAllowedToSaveHere()` reads *another* instance's copy. That is
the same per-instance divergence already documented as the root of `num_roffs`, `NumMiscEnts` and
the transition defect -- and it is why a clear placed at any single entry point can fix one path and
not another.

**Mechanisms eliminated by measurement in this investigation**, so none is retried:

| # | hypothesis | killed by |
|---|---|---|
| 1 | module-loading strategy | reproduces under both `idt3_dlopen_fresh` and plain `dlopen` |
| 2 | `CNavigator::Free()` use-after-free | removed the fix, still reproduces |
| 3 | `in_camera` reset at `InitGame` / `CG_Init` | still measured `in_camera=1` after |
| 4 | stale `client_camera` deadlines vs restarted `cg.time` | zeroing the struct changed nothing |
| 5 | `level.time` not resetting per map | prints `1000` on both maps |
| 6 | shared `va()` buffer across modules | three distinct buffer addresses |
| 7 | dangling `bs_name` / `va()` faulting | `post` marker printed a valid path |
| 8 | dying inside `ICARUS_RunScript` | all four stage markers reach `d-ran` |
| 9 | ESC swallowed by the cinematic branch | `ingameCin=0` at every ESC |
| 10 | `Menus_ActivateByName` failing | the empty-name warning is the *probe's* own `uimenu` |
| 11 | `CG_SHUTDOWN` skipped on reload | identical dispatch on pass and fail |

What is established: `UI_SetActiveMenu` returns at its first line because
`ge->GameAllowedToSaveHere()` is false at the ESC moment, and the `in_camera` behind it is a
carried-over value the shutdown clear did not reach. The remaining work is to identify which
instance's copy the game module reads and clear that one -- the address-printing technique used
throughout does this directly.

### Instance divergence excluded for `in_camera` itself

The address-printing technique that identified `NumMiscEnts` was applied to `in_camera` directly --
printed from the writer (`CG_Shutdown`, where the fix clears it) and from the reader
(`GameAllowedToSaveHere`), in the same session:

```
clear &in_camera=0x46ac20c was=0
read  &in_camera=0x46ac20c val=1
```

**Same address.** So the clear and the read touch the *same* copy, and the per-instance divergence
that explains `num_roffs` and `NumMiscEnts` is **not** what is happening to this variable. Twelfth
mechanism eliminated.

What the same trace shows is that `in_camera` was **already false** when `CG_Shutdown` ran
(`was=0`) and is true later at the same address -- so something sets it after the clear, on a load
that issues no camera script commands at all.

**Limitation, stated because it matters:** passing runs print identical lines, so these samples do
not isolate the failing moment -- they may all come from the first load's legitimate cutscene. The
reader probe is capped at six prints and gated on `in_camera` being set, which is what keeps it off
the hot path, but it needs correlating with the map-change boundary before it can say more. That
correlation is the next measurement, not a conclusion drawn from this one.

Also corrected here: JK2's `GameAllowedToSaveHere()` is simply `return !in_camera;`. The
`(!in_camera && !killPlayerTimer)` form quoted throughout the earlier entries is **JKA's**
(g_savegame.cpp:1236). No conclusion changes -- `killPlayerTimer` was independently excluded -- but
the JK2 predicate is the simpler one, and the comment on the fix has been corrected to match.

### A clean discriminator at last: the flag is set on load 2 in BOTH cases, and only fails to clear

Gating the `in_camera` read probe to load 2 only (a load counter incremented in `CG_Init`), with
headroom well above the observed counts:

| run | blocked reads of `in_camera` during load 2 |
|---|---|
| PASS | **3** -- set briefly, then cleared |
| FAIL | **24** |
| FAIL | **24** |

So the second load *does* set `in_camera` in healthy sessions too; the anomaly is purely that it
never clears. Every earlier framing that treated "the flag is set on load 2" as the bug was
looking at normal behaviour.

**This measurement also had to be fixed before it said anything.** The first version capped prints
at 8 and reported `6 on load 1 / 2 on load 2` -- identical on pass and fail, because 6+2 is the cap.
It was measuring the cap, not the engine. Suspiciously round numbers that match a limit are the
instrument, not the result; that is now the third probe defect in this investigation, after the
`uimenu`-generated "Unable to find menu ''" warning and the runs silently invalidated by a dead dev
server.

**The contradiction still open:** the second load issues **zero** `camera( ... )` script commands
(measured, three runs) yet `in_camera` becomes set there. Something other than a script camera
command sets it. Finding that setter is the next step, and it is a narrow one -- `CGCam_Enable` is
the only writer, so the question is who calls it on a load that runs no camera script.

### The mechanism, settled: the reload's cutscene starts and never disables

Instrumenting the only writer of `in_camera` -- `CGCam_Enable` -- and its counterpart
`CGCam_Disable`, each tagged with a load counter incremented in `CG_Init`. Three failing runs,
byte-identical:

```
IDT3W ENABLE load=1   IDT3W DISABLE load=1     <- map 1's opening cutscene: runs and ends
IDT3W ENABLE load=1   IDT3W DISABLE load=1     <- the probe's own cam_enable/cam_disable test
IDT3W ENABLE load=2                             <- the reload's cutscene starts, and never ends
```

`CGCam_Enable` **is** called on the second load. So the earlier measurement of "zero `camera( ... )`
script commands on load 2" was a **logging artifact** -- the ICARUS debug trace did not capture
them -- and not evidence that the cutscene failed to run. That artifact had been carried through
several entries above as a genuine contradiction; it is retracted here.

With that resolved, the same-map reload defect has exactly the shape of the transition defect fixed
earlier: a cutscene enables the camera and its `camera( DISABLE )` never arrives. The difference is
only *where* the missing disable leaves the flag -- across a level change (fixed by the
`CG_Shutdown` clear, which is Raven's own line) versus within a single load (not fixed, because
there is no level change to clear at).

**Caveat on these three runs:** all three failed, so there is no passing sequence to contrast
against. What a healthy reload's trace looks like -- presumably `ENABLE load=2` followed by
`DISABLE load=2` -- has not been captured, and should be, before treating "the disable never
arrives" as the complete story rather than the most probable reading of three same-outcome samples.

**Next step**, unchanged in kind but now precisely targeted: find why the load-2 cutscene script
stops before its camera-disable step, given that the identical script completes on load 1 in the
same session.

### The probe is ruled out, and the signature is clean

The camera events are now recorded without any I/O on the failing path -- three integer stores into
a static ring, dumped afterwards through an `idt3camdump` console command -- because printing there
made the fault reproduce 9/9 where it is otherwise intermittent.

The probe's own deterministic `cam_enable` / `cam_disable` contract test runs on load 1, shortly
before the reload, and `CMD_CGCam_Disable` does more than clear the flag (it also calls
`CGCam_SetFade` and clears `player_locked`). That made it a real candidate for *causing* the
failure. Removing it entirely (`SKIP_CONTRACT=1`) changes nothing -- 4/4 fail, and the ring reduces
to exactly three events:

```
ENABLE  load=1 t=0
DISABLE load=1 t=26444      <- map 1's opening cutscene: 26.4s, ends normally
ENABLE  load=2 t=0          <- the reload's cutscene: starts, never ends
```

So the harness is not the cause, and the characterisation is as tight as it can be made without
solving it: **the identical script, on the identical map, completes in 26.4 seconds on the first
load and never completes on the second.** Map 1's disable arrives on schedule; map 2's never does,
across a 60-second window (and a 5-minute one tested earlier).

That is the fourth time in this investigation the instrument turned out to be part of the story --
after the probe-generated `Menus_ActivateByName` warning, the runs invalidated by a dead dev server,
and a print cap mistaken for a result. Ruling the harness out explicitly, rather than assuming it
innocent, is why this one can now be stated plainly.

## ROOT CAUSE NAMED: the reload cutscene deadlocks on `wait("KYLE_WALK")`

Counting every ICARUS task-group wait and how many come back incomplete, two failing runs
agreeing:

```
IDT3MISS  count=0 group=(none)          <- no wait ever hits a MISSING group
IDT3STALE stale=0 waits=481             <- 481 timed waits, none with a carried-over timestamp
IDT3GRP   total=3436 incomplete=3349 name=KYLE_WALK
```

The cutscene is blocked on `wait( "KYLE_WALK" )`. `CTaskManager::Wait` re-queues a group wait every
frame until `group->Complete()` returns true, so a group that never completes is an infinite stall
-- 3,349 incomplete evaluations of the same wait. The script therefore never reaches its
`camera( DISABLE )`, `in_camera` stays set, and `UI_SetActiveMenu` returns at its first line. Every
symptom recorded above follows from this one wait.

**The shape is a deadlock, and it explains why only the reload fails.** `KYLE_WALK` is a scripted
walk for the player character. But the same cutscene has already called `CGCam_Enable`, whose own
comment is *"Player zero not allowed to do anything"* -- and the player was measured sitting
unplaced at the world origin `(0 0 6)` for 264 seconds on exactly these runs. A frozen player cannot
finish a walk, and the walk is what would release the camera that froze him.

**A correction to an earlier entry.** The task-group path was recorded above as eliminated. That was
wrong: only the `group == NULL` branch had been measured (`IDT3MISS count=0`). The other branch --
group found, `Complete()` false forever -- was never instrumented, and it is the one that fires.
An elimination is only as wide as the branch the counter actually covers.

Two genuine eliminations do come out of the same run, now unambiguous because 481 timed waits prove
the machinery was exercised: no wait hits a missing group, and no wait carries a timestamp from the
previous map.

### Where to look next

Why the walk cannot complete on a second load when it completes in 26.4s on the first. The
candidates are narrow now: whether the player entity is placed before the cutscene starts, whether
the navgoal the walk targets exists on the reload, and whether `Q3_TaskIDComplete( ent,
TID_MOVE_NAV )` is reachable for an entity the camera has frozen. Note the port already carries a
navigation fix (`CNavigator::Free()` use-after-free), so nav state on reload is a reasonable first
suspect -- though `Navigation Data Cleared` does appear in the shutdown log, and no nav error is
reported.

### The stall is located exactly, and the deadlock theory is refuted

Recording every camera op with a load tag (no I/O on the path), two failing runs identical:

```
load 1:  ENABLE > MOVE > PAN > ZOOM > FOLLOW > DISABLE
load 2:  ENABLE > MOVE > PAN > ZOOM                        <- stops before FOLLOW
```

The reload's cutscene runs normally through MOVE, PAN and ZOOM. It stops at the
`wait( "KYLE_WALK" )` that sits between ZOOM and FOLLOW -- which matches the 3,349 incomplete
evaluations of that group recorded above, and pins the stall to one line of one script.

**This refutes the deadlock explanation given earlier.** That entry argued the cutscene enables the
camera, the camera freezes the player, and the frozen player can never finish the walk that would
release the camera. Load 1 reaches the same wait with the camera *already enabled* -- ENABLE
precedes it in both -- and the walk completes there in 26.4 seconds. So the camera does not prevent
the walk, and the deadlock story is wrong.

It also corrects a reading of `viewpos` from several entries above. `(0 0 6)` was described as the
player stranded at the world origin; `viewpos` prints `cg.refdef.vieworg`, which during a cutscene
is the **camera**. The op trace now shows MOVE does fire on load 2, so that reading was wrong in
both directions -- the camera is not parked at the origin either.

### What the task counters do and do not show

`Q3_TaskIDComplete` was counted by task type:

```
FAIL  movenav call=160 hit=80    PASS  movenav call=50 hit=26
```

Completions fire in both, and the failing run has more only because it runs longer. **These
counters are aggregate across every entity, so they cannot isolate Kyle's walk** -- they neither
confirm nor exclude a movement-completion fault, and are recorded here as inconclusive rather than
as an elimination. Isolating it needs the counter filtered to the player entity, or better, the
pending task inside the KYLE_WALK group identified directly.

### Next

Which task inside the `KYLE_WALK` group stays pending. That is one level below anything measured so
far -- `CTaskGroup` membership rather than the group's completion flag - and it is the last step
between here and a named line of script.

### Down to a single uncompleted task

Reading the stalled `CTaskGroup`'s own members at the moment it reports incomplete
(`m_completedTasks` is public in taskmanager.h -- the `//protected:` above it is commented out):

```
PASS  stalls=1337  done=0 of=1  pendingTaskId=1
FAIL  stalls=3359  done=0 of=1  pendingTaskId=137
```

Two things fall out.

**Stalling is normal.** The passing run stalls on this same wait 1,337 times before proceeding --
a group wait re-queues every frame until its task completes, so a high stall count is the
mechanism working, not the fault. Any earlier reading that treated repeated stalls as the anomaly
was wrong; only the failure to *finish* distinguishes the two.

**The group holds exactly one task** (`of=1`) and it is never marked complete (`done=0`). So the
chain now terminates precisely: `CTaskGroup::MarkTaskComplete()` is never reached for that id,
which means `CTaskManager::Completed( id )` is never called with it, which means
`Q3_TaskIDComplete( ent, TID_MOVE_NAV )` either does not fire for that entity or fires carrying a
different id than the group is waiting on.

Aggregate counters recorded earlier (`movenav call=160 hit=80`) do not settle which, because they
count every entity. The next measurement is narrow and obvious: log the ids passed to
`CTaskManager::Completed()` and compare them against the pending id.

### A process failure worth recording

The batch before this one produced two useless runs. The Python patch that was supposed to update
the probe hit an `AssertionError` and exited *before* editing anything, but the surrounding shell
carried on and ran both measurement rounds against the unmodified probe -- which was still calling
a console command that had been reverted, so it faithfully reported `(no reply)`.

This is the same shape as the two runs trusted earlier whose *build* had silently failed, and the
fix is the same: a failed preparation step must stop the pipeline rather than let measurement
proceed on stale code. `build.errs` is already checked for the compile side; the probe edit now
asserts per line so a mismatch fails loudly instead of silently no-op'ing.

## ROOT CAUSE: the reload's wait holds a task id from the previous load's numbering

Recording every id passed to `CTaskManager::Completed()` alongside the stalled group's pending id,
across nine runs (five passing, one failing in the same batch, plus six more failing):

| | pending id | Completed() calls | pending id ever completed |
|---|---|---|---|
| PASS x5 | **1** | 296 | **6 times** |
| FAIL    | **137** (135 in two runs) | 325 | **0** |

`firstIds` in every run reads `0 1 2 3 4 5 6 7 0 1 3 0`. So the second load issues **low, freshly
numbered** task ids, while a failing run's `KYLE_WALK` group is waiting on **137** -- an id from the
*previous* load's numbering. Nothing the new map ever completes can match it, so the group never
completes, the script never reaches `camera( DISABLE )`, `in_camera` stays set, and
`UI_SetActiveMenu` returns at its first line.

This is not a timing fault. It is stale state carried across the map load -- the same family as the
four fixes already committed (`num_roffs`, `NumMiscEnts`, `in_camera`, and the navigator
use-after-free), all of which exist because the original relies on a DLL unload that a persistent
wasm side module never performs.

Two source facts make it possible: `CTaskManager::AddTaskGroup()` **reuses a group by name** if one
already exists, and `ICARUS_Shutdown()` frees per-entity ICARUS state only for entities marked
`inuse`.

### One hypothesis tested and rejected

The obvious suspect was the player entity being skipped by that `inuse` check, leaving Kyle's task
manager (and his `KYLE_WALK` group) alive across the load. Measured at shutdown, six failing runs:

```
IDT3SD shutdowns=1 ent0InUse=1 ent0HadSequencer=1
```

Entity 0 is `inuse` and holds a sequencer, so `ICARUS_FreeEnt()` *is* called for it. The player's
state is freed correctly and the stale id survives anyway.

That relocates the search rather than ending it: the group is owned by whichever entity's task
manager the script runs on, and the cutscene runs on a `target_scriptrunner`, not on Kyle. Only
entity 0 was checked. The next measurement is the same `inuse` / sequencer check across **all**
entities at shutdown, and specifically for the scriptrunner that owns `cinematics/cinematic4`.

### Why the sampling matters here

The same instrumented build produced 3/3 pass in one batch and 6/6 fail in the next. Earlier
instrumented builds ran 9/9 fail. The fault is genuinely intermittent and any batch small enough to
be convenient is small enough to mislead -- which is exactly how a "2/2 pass" was once recorded in
this log as a fix that was not one.

## RETRACTION: the "task id from the previous load" root cause was wrong

The entry above titled *"ROOT CAUSE: the reload's wait holds a task id from the previous load's
numbering"* is **withdrawn**. It was committed and pushed before the measurement behind it was
sound.

**The flaw.** The recorder stored only the **first 64** ids passed to `CTaskManager::Completed()`,
while a run makes **325** such calls. So `pendingIdSeenInCompleted=0` meant *"not among the first
64"*, not *"never completed"*. The conclusion drawn from it -- that the wait referenced an id from
the previous load while the new load issued fresh low ids -- did not follow.

Two facts already in hand should have blocked it at the time:

* `CTaskManager::Init()` sets `m_GUID = 0` for every manager and `Create()` is a plain `new`, so id
  137 is exactly as consistent with *the 137th task of this load*;
* the shutdown audit measured `skipped=8 skippedWithIcarus=0 freed=159` -- **no** entity retains
  ICARUS state across the map load, which is the only way carry-over could have happened.

**Re-measured with full coverage** (every call counted, no window):

```
FAIL  pending=137  matches=77  calls=325  maxId=136  stalls=3349
FAIL  pending=135  matches=76  calls=323  maxId=134  stalls=3352
```

`maxId` is always **exactly one below** `pending`. So the pending task is simply the **last id
minted in that same load**, and every id below it completes normally. There is no stale numbering
and no id-space mismatch.

### What is actually established

The final task created for the cutscene is never completed. Everything before it completes; it
alone does not. `KYLE_WALK` holds that one task (`done=0 of=1`), so the group never completes, the
script never reaches `camera( DISABLE )`, and `in_camera` stays set.

So the question returns, correctly framed this time and one level narrower than before: **why does
the last task minted for the reload's cutscene never receive its completion**, when the identical
script completes it in 26.4s on the first load.

### Process note

This is the fifth time in this investigation that an instrument rather than the engine produced a
"finding", and the first where the conclusion had already been committed. The others were caught
before publication: a probe-generated menu warning, runs invalidated by a dead dev server, a print
cap mistaken for a result, and a stale probe run after a failed patch. The rule that would have
caught this one: **a counter with a capacity limit must report whether it hit that limit**, and a
search over a bounded sample must never be phrased as a search over the whole population.

## The stuck task identified: a ROFF playback that never completes

Recording both ends of the completion handshake -- every `Q3_TaskIDSet` and every
`Q3_TaskIDComplete` that finds a pending task -- four failing runs:

```
SET n=143 lastId=137 ent=644 type=4      (type 4 = TID_MOVE_NAV)
CMP n=101 lastId=135 ent=644
```

Entity **644** is handed MOVE_NAV task **137** -- exactly the id the group waits on -- and the last
completion that same entity signals is **135**. So the task is issued correctly, to the right
entity, and its completion simply never arrives. Nothing is mismatched or misrouted; one specific
scripted movement never finishes.

**Entity 644 is not Kyle.** From the script trace it is `cinematic4_ravensclaw` -- the Raven's Claw.
The group name `KYLE_WALK` is just a label the script author reused; the task stuck inside it
belongs to the ship:

```
cinematic4_ravensclaw(644): play( "PLAY_ROFF", "roff/cinematic4_claw_hover" );
cinematic4_ravensclaw(644): wait("HOVER");
cinematic4_ravensclaw(644): wait("roff");
```

So the thing that never completes is a **ROFF playback** -- and ROFF is the subsystem this port
already had to repair once. `InitGame()` carries a `.ROF` cache reset (`num_roffs`) added because
the count climbed across map loads until MAX_ROFFS was hit, after which every further `.ROF` was
refused and *scripted cameras and movers stopped working*. That is a description of this defect's
symptom, which makes the existing reset the first thing to re-examine: whether it is sufficient,
whether anything else in `g_roff.cpp` carries state across a load, and whether a ROFF already
playing when the level ends leaves the entity's playback state stale.

### Chain of reasoning, now complete end to end

1. `devmap` the current level; the reload's cutscene runs ENABLE > MOVE > PAN > ZOOM.
2. It reaches `wait( "KYLE_WALK" )` and stops -- 3,349 incomplete evaluations of that one wait.
3. The group holds exactly one task (`done=0 of=1`), MOVE_NAV id 137 on entity 644.
4. Entity 644 is the Raven's Claw, whose task is a ROFF playback (`cinematic4_claw_hover`).
5. That playback never signals completion, so the group never completes.
6. The script never reaches `camera( DISABLE )`, so `in_camera` stays set.
7. `UI_SetActiveMenu` returns at its first line, so ESC does nothing and the pause menu never opens.

Every link is measured rather than inferred, and the earlier claims about stale task numbering and
about a camera/player deadlock are both retracted above.

### G_Roff is not the stall: the playback is never armed

Counting each of `G_Roff`'s three early returns plus its tick and completion paths, four failing
runs:

```
noTime=3163513  notYet=0  noCache=0  tick=3153  done=77
```

Two hypotheses die here, including the one this section was written to confirm:

* **`notYet=0`** -- no entity ever has `next_roff_time > level.time`. `next_roff_time` is an
  absolute `level.time` value and `level.time` restarts at 1000 each map, so a carried-over
  timestamp would park playback in the future indefinitely. That was the expected answer given the
  four stale-state bugs already fixed in this port. It does not happen.
* **`noCache=0`** -- `G_LoadRoff()` never fails, so the `.ROF` cache is healthy and the existing
  `num_roffs` reset is doing its job. The "MAX_ROFFS exhausted" theory that motivated looking here
  is also out.

Meanwhile `tick=3153` and `done=77`: ROFF playback advances and completes normally dozens of times
during the same failing run. The subsystem works.

That leaves the first branch. `noTime` counts every call where `next_roff_time == 0` -- mostly
entities with no ROFF at all, so the raw figure is noise -- but the Raven's Claw must be among them,
because it is neither ticking nor completing. Its playback is **never armed**: `play( "PLAY_ROFF",
"roff/cinematic4_claw_hover" )` is issued by the script (the trace shows it) and `next_roff_time`
never becomes non-zero.

So the fault is in the ROFF **start** path, not the playback loop. The next measurement is narrow:
instrument the `PLAY_ROFF` handler (`Q3_Play` / the roff-start entry in Q3_Interface.cpp) for entity
644 and record whether it is reached, and what it does with `next_roff_time`.

**Method note.** This is now the third consecutive round where the measurement contradicted the
hypothesis it was built to test -- stale task numbering, then the camera/player deadlock, now the
stale ROFF timestamp. Each was plausible from the surrounding evidence and each was wrong. The
counters cost a rebuild and a few minutes; the guesses would have cost a bad fix.

## CORRECTION and mechanism: the ROFF loops, and each restart orphans the awaited task

The entry above stating the Raven's Claw playback is "never armed" is **withdrawn**. It was drawn
from `G_Roff`'s aggregate counters, which are dominated by the hundreds of entities that have no
ROFF at all and therefore say nothing about any single one. Filtering every branch to entity 644:

```
calls=3383  noTime=226  notYet=0  noCache=0  tick=3157  done=77  lastCtr=3
```

The Claw **is** armed (226 idle calls before arming, out of 3,383), ticks 3,157 times, and its ROFF
**completes 77 times** during the very run that hangs. Nothing about its playback is stuck.

That is the fourth conclusion in this investigation taken from a counter that could not support it,
after the 64-entry truncation retracted earlier. The rule stands and now has a second clause: a
sample bounded in *size* must not be described as the whole population, and a sample aggregated
across *subjects* must not be described as one subject.

### What the numbers actually show

`done=77` with `lastCtr` sitting at 2-34 means the ROFF is **looping** -- finishing and restarting
throughout. The script drives that, visible in the trace roughly every two seconds:

```
play( "PLAY_ROFF", "roff/cinematic4_claw_hover" ); [13650]
play( "PLAY_ROFF", "roff/cinematic4_claw_hover" ); [15650]
play( "PLAY_ROFF", "roff/cinematic4_claw_hover" ); [17650]
play( "PLAY_ROFF", "roff/cinematic4_claw_hover" ); [19650]
```

And `Q3_Play`'s PLAY_ROFF branch does this on **every** call, unconditionally:

```c
ent->roff_ctr = 0;
Q3_TaskIDSet( ent, TID_MOVE_NAV, taskID );     // overwrites whatever was pending
ent->next_roff_time = level.time;
```

`Q3_TaskIDComplete( ent, TID_MOVE_NAV )` completes whatever id is stored *at that moment*. So when
a new PLAY_ROFF lands before the previous playback finishes, the earlier task id is overwritten and
can never be completed by anything -- there is only one slot per task type. Task **137**, the one
`KYLE_WALK` waits on, is orphaned exactly that way, while the 77 completions all belong to ids
issued after it.

This is a race in the shipped design rather than a porting defect per se: one `taskID[TID_MOVE_NAV]`
slot, a script that restarts the same ROFF on a timer, and a wait bound to one particular
invocation. On the first load the awaited invocation happens to finish before the next restart
overwrites it; on the reload the timing differs and it does not. That is consistent with the
intermittency (roughly one run in three) and with the fault being unreachable by normal play, where
the level is entered once.

### What this implies for a fix

Nothing here points at a stale-state bug to clear, so the resets that fixed `num_roffs`,
`NumMiscEnts` and `in_camera` have no analogue. The candidates are narrower and each needs
weighing against the "strictly original sources" rule: not overwriting a pending task id while one
is outstanding, or completing the outgoing id when PLAY_ROFF replaces it. Both change shipped
behaviour and could alter script semantics elsewhere, so neither should be applied without
understanding why the same script survives its first run.

## RETRACTION: the "orphaned by restart" mechanism is also wrong

The entry above is withdrawn. It argued that a repeated `PLAY_ROFF` overwrites `taskID[TID_MOVE_NAV]`
and strands the previous id, because there is only one slot per task type. `Q3_TaskIDSet` already
handles that case, with a comment saying so:

```c
static void Q3_TaskIDSet( gentity_t *ent, taskID_t taskType, int taskID )
{
    if ( taskType < TID_CHAN_VOICE || taskType >= NUM_TIDS ) return;

    //Might be stomping an old task, so complete and clear previous task if there was one
    Q3_TaskIDComplete( ent, taskType );

    ent->taskID[taskType] = taskID;
}
```

The outgoing task is completed before the slot is reused. The fix candidates proposed in that entry
-- "do not overwrite a pending id" and "complete the outgoing id" -- were for a bug that is not
there; the second is already the shipped behaviour.

One genuine gap survives from that reading, and it is narrower: `Q3_TaskIDComplete` only completes
when `Q3_TaskIDPending()` is true, which requires **both** `ent->sequencer` and `ent->taskManager`
to be non-NULL. A stomp occurring while either is missing would silently drop the old task. That is
a condition to measure, not a conclusion.

### Standing back: what is measured, and what is not

Five mechanism claims have now been published and retracted in this investigation -- stale task
numbering, a camera/player deadlock, a stale ROFF timestamp, playback never armed, and orphaning by
restart. Each was plausible from the evidence to hand and each was refuted by the next measurement.
That rate is itself the most important finding in this section, and the honest response is to stop
proposing mechanisms until one is measured end to end.

**Established by measurement, and not contradicted since:**

* `devmap` of the current level intermittently (~1 run in 3) leaves the in-game menu unopenable.
* ESC reaches `UI_SetActiveMenu` with `CA_ACTIVE`, no key-catcher, and no in-game cinematic flag.
* It returns at its first line because `ge->GameAllowedToSaveHere()` -- in JK2 simply
  `return !in_camera;` -- is false.
* `in_camera` is set because the reload's cutscene ran `ENABLE > MOVE > PAN > ZOOM` and stopped
  before `FOLLOW`/`DISABLE`.
* It stopped at `wait( "KYLE_WALK" )`: 3,349 incomplete evaluations of that one group wait.
* The group holds exactly one task, `done=0 of=1`, MOVE_NAV id 137 on entity 644.
* Entity 644 is `cinematic4_ravensclaw`; the task is a ROFF playback.
* That entity's playback is healthy: armed, 3,157 ticks, 77 completions in the same failing run.
* `Q3_TaskIDSet` completes the outgoing task before reusing the slot.

**Not established:** why id 137 specifically never completes, and why the first load of the same map
with the same script always does.

## Bisecting the conditions, after five failed mechanism guesses

Having published and retracted five mechanisms in a row, the approach changed: stop proposing how
the fault works and start measuring *where* it happens. Same-map reload (`SECOND_MAP=1`) run
against several maps:

| map | same-map reload |
|---|---|
| `pit` | PASS 2/2 |
| `valley` | PASS 2/2 |
| `artus_topside` | PASS 2/2 |
| `artus_mine` | FAIL ~1 in 3 |
| `kejim_post` | **FAIL 2/2** |

Two useful results.

**`kejim_post` is a reliable reproducer.** That matters more than any single hypothesis: most of the
retractions in this investigation trace to drawing conclusions from small samples of a one-in-three
fault. With a map that fails every time, two runs mean something.

**`artus_topside` passes reliably.** So this is not "any JK2 map" and not "any map with a script" --
there is a real difference between two campaign maps of the same game, one failing every time and
one passing every time. That difference is inspectable in their content rather than guessable.

### A claim not to repeat

An earlier draft of this section read the `camera events: 0` column for `pit`/`valley` as evidence
those maps have no opening cutscene. That inference is void: `g_ICARUSDebug` was not enabled for
that batch, so camera lines would not have been logged for **any** map in it, including the ones
that failed. The PASS/FAIL split is sound; the cutscene explanation is not established, and the
claim that the defect requires a cutscene map remains unproven.

### Harness limits found the hard way

Two batches were lost to the measurement setup rather than the engine, both self-inflicted:

* `g_ICARUSDebug 4` on `kejim_post` -- a map that opens with a ~70-second crawl -- floods the
  uncapped log capture until `JSON.stringify` on the array stalls. The run hung ~20 minutes and had
  to be killed. The flooding risk was already noted in this log before being walked into.
* A `timeout 400` added to prevent a repeat was **below the run's honest cost**: `kejim_post` needs
  17 ESC presses to clear its intro on the first load alone, and the timeout truncated healthy runs
  mid-reload, producing empty output that looked like a probe failure.

A timeout has to be set from a measured run, not from an assumption about how long the work should
take.
