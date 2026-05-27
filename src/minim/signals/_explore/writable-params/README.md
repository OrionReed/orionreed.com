# Writable Parameters — Exploration

**Status:** EXPERIMENT. Nothing here is exported from `@minim`.

## The question

Lens factories today take `Val<T>` (read-only) for their parameters. The
hypothesis: we can promote `Val<T>` to `Writable<...>` for any parameter
without:

- Adding new types (writability propagates from the receiver, as today).
- Adding new footgun classes (no new way to spell a cycle).
- Breaking glitch-freedom or composition laws (PG + GP preserved).

The previous chat traced the design at the whiteboard level. This folder
tests it at the engine level using the production `Signal` / `Cls.lens`
machinery from `../../signal.ts` — no new engine code.

## Files

- `wp.ts` — the new helper layer: `w(sig)` brand, plus per-shape
  factories (`numAddW`, `vecRightW`, `clampStretch`, etc.).
- `_test/basics.test.ts` — vec-with-slack and the minimal cases.
- `_test/composition.test.ts` — chained writable params, cascades.
- `_test/aliasing.test.ts` — diamond / shared-cell write semantics.
- `_test/footguns.test.ts` — hunt for non-local reasoning breaks.
- `_test/types.test.ts` — TS-level writability inference invariants.
- `FINDINGS.md` — what we learned. WRITE THIS LAST.

## How to read the results

Each test file should ideally end with a one-line `// VERDICT:` comment
on each section: *safe*, *surprising-but-sound*, *footgun*. The
`FINDINGS.md` aggregates these.
