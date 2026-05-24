// relate.ts — re-orientable bidirectional relation between two cells.
//
// `relate(a, b, fwd, bwd)` declares an invertible relation: writes to
// `a` propagate to `b` as `fwd(a)`, and writes to `b` propagate to
// `a` as `bwd(b)`. Either side can be the driver.
//
// Implemented as two `settle` nodes (one per direction). Each
// settle's body self-excludes its own writes, so the writer side
// doesn't re-fire itself. The OTHER settle observes the write and
// fires (as a separate node) for the reverse roundtrip — this gives
// fixpoint semantics for lossy contractive pairs (`bwd ∘ fwd ≠ id`)
// while terminating via the engine's `===` short-circuit when the
// roundtrip stabilises.
//
// Termination contract:
//   - Iso (`bwd ∘ fwd = id`): one round-trip; the second write is
//     `===`-equal to the previous and propagation stops.
//   - Lossy contractive pairs: converge to the fixpoint of bwd∘fwd.
//   - Drift-prone pairs (`fwd(a) = a + 1`, etc.): would loop
//     indefinitely. Same caveat as before — the runtime can't paper
//     over genuine non-convergence without an iteration budget.

import { settle, type Signal, type WritableBrand } from "./signal";

/** Handle returned by `relate` — disposable bidirectional binding. */
export interface RelateHandle {
  dispose(): void;
}

/** Declare a bidirectional relation: `b = fwd(a)`, `a = bwd(b)`.
 *  Either side can be written; the other follows. */
export function relate<A, B>(
  a: Signal<A> & WritableBrand,
  b: Signal<B> & WritableBrand,
  fwd: (a: A) => B,
  bwd: (b: B) => A,
): RelateHandle {
  const aSig = a as Signal<A>;
  const bSig = b as Signal<B>;
  // Forward-only and backward-only settlers. The fwd settler reads a,
  // writes b; the bwd settler reads b, writes a. Each self-excludes
  // (settle's auto-self-exclusion); the other observes and ping-pongs
  // until `===` short-circuits.
  const fwdHandle = settle(_dirty => {
    bSig.value = fwd(aSig.value);
  });
  const bwdHandle = settle(_dirty => {
    aSig.value = bwd(bSig.value);
  });
  return {
    dispose() {
      fwdHandle.dispose();
      bwdHandle.dispose();
    },
  };
}
