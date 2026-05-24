// relate.ts — re-orientable bidirectional relation between cells.
//
// `relate(a, b, fwd, bwd)` declares an invertible relation: writes to
// `a` propagate to `b` as `fwd(a)`, and writes to `b` propagate to
// `a` as `bwd(b)`. Either side can be the driver — the engine routes
// each individual write outward from the kicked cell using
// `writeBack`, which excludes the currently-active reactive node from
// propagation, structurally eliminating the self-trigger loop.
//
// This is the propagator-network shape on top of signals. The
// underlying mechanism is the same alien-signals push/pull DAG; what's
// new is that *either* cell can be the root of a per-write traversal.
// Multi-root writes — the alga case — without iterative relaxation,
// without sacrificing the topological-walk speed.
//
// Termination contract:
//   - Iso (`bwd ∘ fwd = id`) and lossy-but-idempotent pairs terminate
//     in one round-trip via the engine's `===` short-circuit.
//   - Drift-prone pairs (e.g., `fwd(a) = a * (1 + ε)`) loop
//     indefinitely, same as today's manual `sync(a, drifty)` pattern.
//     This is structural; the runtime can't paper over genuine
//     non-convergence without an iteration budget.

import { effect, type Signal, type WritableBrand } from "./signal";

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
  const e1 = effect(() => {
    const va = aSig.value;
    bSig.writeBack(fwd(va));
  });
  const e2 = effect(() => {
    const vb = bSig.value;
    aSig.writeBack(bwd(vb));
  });
  return {
    dispose() {
      e1();
      e2();
    },
  };
}
