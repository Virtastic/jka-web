## What this changes

<!-- One or two sentences. If it changes engine behaviour, say what the symptom was. -->

## Checklist

The first three are the rules this project is strictest about — see CONTRIBUTING.md.

- [ ] **No code copied from OpenJK, iortcw or ET:Legacy.** Reading them for understanding is
      fine; this port is built only from Raven's original drop.
- [ ] Engine sources under `games/jka/` are **not reformatted or retabbed** — the diff against
      the pristine import is the port, and whitespace churn destroys it.
- [ ] Any engine change is guarded (`__EMSCRIPTEN__`) where it would otherwise alter native
      behaviour, and carries an in-code comment explaining *why*.
- [ ] Claims about engine behaviour are backed by a **measurement with a positive control** —
      a null result only counts if the instrument is proven live in the same session.
- [ ] **No game data** (`.pk3`, `.sav`) added, and no retail asset committed.
- [ ] Docs updated if behaviour changed (`docs/WASM_ADAPTATIONS.md` for the engineering log).

## How this was verified

<!-- Which harness, which map, what you saw. "Boots to the menu" is not verification of a
     gameplay change. -->
