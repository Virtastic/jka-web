# Security policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue. Use GitHub's
**Report a vulnerability** button under the Security tab of this repository, which opens a private
advisory visible only to the maintainers.

Include what you were doing, what happened, and enough detail to reproduce it. You will get an
acknowledgement; if the issue is confirmed, the fix and the advisory are published together.

## In scope

- The **browser shell** in `play/` — the launcher, the game page, and how they handle data you point
  them at.
- The **WebAssembly engine build** in `shared/wasm-build/` — the platform layer, and anywhere
  untrusted input (a pk3, a savegame, a demo file) reaches engine code.
- The optional **Cloud Locker backend** in `cloud/` — authentication, the upload allowlist, quota
  enforcement, and presigned-URL handling.

## Out of scope

- **Bugs inherited from the original 2003 engine sources that are not reachable in the browser
  build.** The port's threat model is a sandboxed browser tab: no listen server, no multiplayer
  transport, and no filesystem access outside the Emscripten VFS and IndexedDB. Memory-safety bugs
  in the original C++ are real, but they are contained by the WebAssembly sandbox, and this project
  does not treat every one of them as a vulnerability.
- **Game data you supply.** Your own pk3 archives are read locally; the port does not vouch for
  content you give it.

## Notes for reviewers

`docs/SECURITY.md` holds a written pre-publication audit — secret scanning across history,
third-party binary review, and the data-handling posture. `THIRD-PARTY-LICENSES.md` records which
third-party components are actually compiled into the WebAssembly binary, which is usually the first
question when triaging a CVE in a bundled library.
