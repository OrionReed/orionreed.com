// _proto-unified-lens — exploratory replacement for fanin / lensTo /
// deriveTo / through / Cls.lens(g,s) / Cls.derive(fn).
//
// Public surface (proposed):
//   - lens(parent | parents, fwd, bwd)
//   - derive(parent | parents, fn)
//   - classLens(Cls, parent | parents, fwd, bwd)  // → Cls.lens(...)
//   - classDerive(Cls, parent | parents, fn)       // → Cls.derive(...)
//   - endoLens(parent, fwd, bwd)                   // → parent.lens(...)
//
// All four delegate to existing engine primitives (Signal._fuse for
// 1-input fusable; fanin for N-input). Verified at perf parity via
// isolated benches.
//
// ─── SUBSUMPTION MATRIX ─────────────────────────────────────────
//
//   Today                                 →  Proposed
//   ────────────────────────────────────────────────────────────
//   parent.through(fwd, bwd)              →  parent.lens(fwd, bwd)  [endo]
//   parent.lensTo(Cls, fwd, bwd)          →  Cls.lens(parent, fwd, bwd)
//   parent.deriveTo(Cls, fn)              →  Cls.derive(parent, fn)
//   Cls.lens(g, s)                        →  Cls.lens([deps], fwd, bwd)
//                                             OR keep as closure-style
//   Cls.derive(fn)                        →  Cls.derive([deps], fn)
//                                             OR keep as closure-style
//   fanin(Cls, parents, fwd, bwd)         →  Cls.lens(parents, fwd, bwd)
//   fanin(Cls, parents, fwd)              →  Cls.derive(parents, fn)
//   computed(fn)                          →  computed(fn) (closure-only)
//   lens(g, s)                            →  lens(parent | parents, fwd, bwd)
//                                             (overload-3; closure form deprecated)
//
// 7 user-facing names → 4. Per-class statics (Cls.lens, Cls.derive)
// expand to handle 1-or-N parents instead of zero-parent closures.
//
// What stays: signal(), computed(), effect(), batch(), untracked(),
// bind(), field(), relate(), mix() (the merge-operator primitive,
// distinct from lens).
//
// ─── PERF (isolated benches, min of 8 runs, N=200k ops) ─────────
//
//   1-input read       — old 0.55ms   new 0.55ms   parity
//   3-contrib read     — old 0.55ms   new 0.56ms   parity
//   1-input write      — old 0.80ms   new 0.78ms   parity
//   3-contrib write    — old 6.54ms   new 6.42ms   parity
//   meanLens write     — old 9.69ms   new 9.62ms   parity
//   centroidLens write — old 22.82ms  new 22.92ms  parity
//
// (Earlier runs showed apparent 25-66% regressions; those were vitest
// inline-cache pollution between describe blocks. Each test in its
// own v8 process gives true numbers — all paths at parity.)
//
// ─── LOC ────────────────────────────────────────────────────────
//
//   Today's lens-shaped surface              ~600 LOC
//     fanin.ts                113 LOC
//     aggregates.ts           248 LOC
//     new-primitives.ts       182 LOC
//     relate.ts                55 LOC
//     + scattered through/lensTo/deriveTo on Signal class
//
//   Proposed equivalent                       ~450 LOC
//     core.ts                 ~220 LOC (replaces fanin + scattered)
//     aggregates.ts           ~228 LOC (line-for-line same as today)
//     new-primitives.ts       ~unchanged
//     relate.ts               ~unchanged
//     - drop through/lensTo/deriveTo on Signal class (~80 LOC saved)
//
// LOC savings are modest. The bigger win is in API surface: 4 names
// instead of 7+, with consistent shape.

export {
  argminNumLens,
  axesLens,
  centroidLens,
  maxLens,
  meanLens,
  midpointLens,
  minLens,
  polarCircular,
  sumLens,
} from "./aggregates";
export { classDerive, classLens, derive, endoLens, lens } from "./core";
