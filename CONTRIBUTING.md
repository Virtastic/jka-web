# Contributing

Contributions are welcome. One rule matters more than the rest, so it comes first.

## The engine sources are a pristine import

`games/jka/` holds Raven's original GPL drop, imported in a single commit. Every browser adaptation
is a separate, reviewable commit on top of it. **The diff of `games/jka` against its import commit
*is* the port** — that is what makes it possible to see exactly what was changed to get this running
in a browser, and to audit it against the original.

So:

- **Do not copy code from OpenJK, iortcw, ET:Legacy or any other fork.** Consult them to understand a
  problem if you like; do not paste from them. This project's value is that it is the original
  sources plus a legible set of changes.
- **Do not reformat, retab or tidy the original sources.** A whitespace commit destroys the diff.
- When you change engine code, say *why* in a comment next to it, not only in the commit message.
  The existing adaptations follow this closely: they explain what the original did, why it does not
  work in a browser, and what was measured.

The one documented exception is that non-redistributable pre-compiled binaries were removed from the
drop; see `THIRD-PARTY-LICENSES.md`.

## Licence

This project is **GPLv2**, matching the engine's grant — version 2, with no "or later" clause for
Raven's code. Contributions are accepted under the same terms. Do not add code that cannot be
distributed under GPLv2.

## Claims need measurements

The engineering log (`docs/WASM_ADAPTATIONS.md`) is written to a standard worth keeping: a fix is
described with the evidence that it works, and a wrong theory that was published gets retracted in
the same file rather than quietly deleted. Two rules earned the hard way:

- **A null result is evidence only if the instrument is proven live.** Run a positive control in the
  same session. Twice in this port a "0" came from a probe that could not print at all.
- **A control must assert that the thing it removed is actually gone**, and print that assertion
  beside the result. `git stash` is a no-op on a change that is already committed.

## Testing

The harnesses drive real headless Chrome over CDP against a real engine build — no mocks:

```sh
source shared/wasm-build/env.sh
shared/wasm-build/build-jka.sh && shared/wasm-build/build-jka-modules.sh
python3 shared/web/server.py jka                       # dev server on :8794
node shared/wasm-build/console-check.mjs 8794 "+set sv_pure 0 +devmap t1_sour"
node shared/wasm-build/verify-icarus-affect.mjs 8794   # ICARUS regression guard
```

Before sending a change that touches engine code, run the campaign sweep (`map-sweep.mjs`) and say in
the pull request what you ran and what it printed.

## Game data

Never commit game data. `.gitignore` is written to prevent it, and the published history has been
checked to confirm none ever was. Retail archives are commercial content and are not
redistributable.
