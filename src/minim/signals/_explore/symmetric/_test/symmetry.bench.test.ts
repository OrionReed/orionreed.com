// symmetry.bench.test.ts — verify the design constraint.
//
// CONSTRAINT (stated by the user)
//   The backward pass should be ≤ forward pass cost. If forward is
//   cheaper than backward, that's evidence the design is wrong.
//
// THIS BENCH measures, for each engine variant, the per-cell cost
// of forward vs backward propagation through the SAME N-deep
// identity-lens chain.
//
// Variants:
//   - CANONICAL FUSED:    `lens()` uses _fuse → collapses N layers
//                         to 1 closure. Best-case canonical.
//   - CANONICAL EXPLICIT: `Signal.install` with raw closures, no
//                         fusion. Apples-to-apples vs symmetric.
//   - MERGE PROTOTYPE:    Direction A+B (signal/index.ts in merge).
//   - SYMMETRIC:          Direction C, pivot model. A bwd write walks
//                         up applying `put`, commits the source via the
//                         forward write path, then the SINGLE forward
//                         propagate refreshes views. Eager outside a
//                         batch (matches alien per-write semantics);
//                         coalesced inside a batch.
//
// Workload variants tell different parts of the story:
//
//   PURE WRITES:        Writes only, no reads. Eager cascade to the
//                       source per write; views recompute lazily.
//   1-WRITE + 1-READ:   Most common UI shape. Each cycle pays the
//                       put-walk (commit source) + lazy fwd resolve.
//   10-WRITES + 1-READ: Write-heavy (animations). Unbatched ⇒ each
//                       write cascades (alien semantics). Batch to
//                       coalesce.
//   BATCHED:            Explicit batch() block with 10 writes. Writes
//                       coalesce (last-write-wins per cell).

import { describe, it } from "vitest";
import * as canonical from "../../../index";
import { Signal as CanonSignal } from "../../../signal";
import * as mergeProto from "../../merge";
import * as sym from "../index";

const N_OPS = 50_000;
const CHAIN = 5;

/** Canonical fused chain: each `.lens()` call collapses via `_fuse`
 *  so the entire N-deep chain becomes ONE cell with composed
 *  fwd/bwd closures. Hot in current codebase. */
function buildCanonFused(n: number): canonical.Signal<number> {
  const root = canonical.signal(0);
  let cell: canonical.Signal<number> = root;
  for (let i = 0; i < n; i++) {
    cell = canonical.lens(
      cell,
      (v) => v as number,
      (t: number) => t,
    ) as canonical.Signal<number>;
  }
  return cell;
}

/** Canonical NON-fused chain: each layer is a real cell built via
 *  Signal.install (raw closures, no _fuse). Apples-to-apples with
 *  the symmetric prototype's explicit N-cell chain. */
function buildCanonExplicit(n: number): {
  root: canonical.Signal<number>;
  tip: canonical.Signal<number>;
} {
  const root = canonical.signal(0);
  let cell: canonical.Signal<number> = root;
  for (let i = 0; i < n; i++) {
    const p = cell;
    cell = CanonSignal.install(
      CanonSignal as new (...args: never[]) => CanonSignal<number>,
      () => p.value as number,
      (v: number) => {
        (p as { value: number }).value = v;
      },
    );
  }
  return { root, tip: cell };
}

/** Fair apples-to-apples canonical chain: each cell applies an identity
 *  transform fn in BOTH directions, exactly mirroring the symmetric lens
 *  shape (`() => fwd(parent.value)` / `(t) => bwd(t)`). Isolates the
 *  per-layer transform-call cost from any engine difference. */
function buildCanonExplicitFn(n: number): {
  root: canonical.Signal<number>;
  tip: canonical.Signal<number>;
} {
  const id = (v: number): number => v;
  const root = canonical.signal(0);
  let cell: canonical.Signal<number> = root;
  for (let i = 0; i < n; i++) {
    const p = cell;
    cell = CanonSignal.install(
      CanonSignal as new (...args: never[]) => CanonSignal<number>,
      () => id(p.value as number),
      (v: number) => {
        (p as { value: number }).value = id(v);
      },
    );
  }
  return { root, tip: cell };
}

function timed(label: string, fn: () => void): number {
  // Warm up the JIT, then take the MIN of several measured runs.
  // Min is the robust microbench estimator: it filters GC pauses,
  // scheduler interrupts, and other one-sided noise that inflate the
  // mean. Single-run timing on this machine swings >2× — useless for
  // grounding micro-decisions.
  for (let w = 0; w < 5; w++) fn();
  let ms = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 8; r++) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    if (t1 - t0 < ms) ms = t1 - t0;
  }
  console.info(
    `  ${label.padEnd(72)}  ${ms.toFixed(2).padStart(8)}ms  ${((ms * 1e6) / N_OPS).toFixed(0).padStart(4)} ns/op`,
  );
  return ms;
}

// ─── Forward propagation cost ───────────────────────────────────
//
// Build an N-deep identity-lens chain. Each lens is `v => v` in
// fwd and `t => t` in bwd. Time many root.value = i; void tip.value
// cycles.

describe("BWD ≤ FWD: 5-deep identity chain", () => {
  it("CANONICAL FUSED: fwd cascade (1 fused cell)", () => {
    const cell = buildCanonFused(CHAIN);
    void cell.value;
    timed("canonical (FUSED)  FWD  (root.value=i; void tip.value) ×N", () => {
      // can't write root directly since it's hidden; use cell.value=i instead.
      // Actually we want fwd test, so we need root handle. Skip this variant
      // for FWD; only relevant for BWD.
      for (let i = 0; i < N_OPS; i++) void cell.value;
    });
  });

  it("CANONICAL EXPLICIT: fwd cascade", () => {
    const { root, tip } = buildCanonExplicit(CHAIN);
    void tip.value;
    timed("canonical (EXPLICIT) FWD  (root.value=i; void tip.value) ×N", () => {
      for (let i = 0; i < N_OPS; i++) {
        (root as { value: number }).value = i;
        void tip.value;
      }
    });
  });

  it("MERGE PROTO: fwd cascade", () => {
    const root = mergeProto.num(0);
    let cell: mergeProto.Num = root;
    for (let i = 0; i < CHAIN; i++) {
      // identity arithmetic lens via add(0)
      cell = cell.add(0);
    }
    void cell.value;
    timed("merge proto FWD  (root.value=i; void tip.value) ×N", () => {
      for (let i = 0; i < N_OPS; i++) {
        root.value = i;
        void cell.value;
      }
    });
  });

  it("CANONICAL EXPLICIT+fn: fwd cascade (identity transform per layer)", () => {
    const { root, tip } = buildCanonExplicitFn(CHAIN);
    void tip.value;
    timed("canonical (EXPLICIT+fn) FWD  (root.value=i; void tip.value) ×N", () => {
      for (let i = 0; i < N_OPS; i++) {
        (root as { value: number }).value = i;
        void tip.value;
      }
    });
  });

  it("SYMMETRIC: fwd cascade", () => {
    const root = sym.signal(0);
    let cell: sym.Signal<number> = root;
    for (let i = 0; i < CHAIN; i++) {
      cell = sym.Signal.lens(
        cell,
        (v) => v,
        (t) => t,
      );
    }
    void cell.value;
    timed("symmetric  FWD  (root.value=i; void tip.value) ×N", () => {
      for (let i = 0; i < N_OPS; i++) {
        root.value = i;
        void cell.value;
      }
    });
  });
});

// ─── Forward: pure COMPUTED chain (no lens, no install) ─────────
// Isolates the forward engine from lens/install construction. If the
// symmetric and canonical computed chains match, the forward engine is
// at parity and any lens-chain delta is the bidirectional-cell cost.

describe("FWD parity: 5-deep COMPUTED chain", () => {
  it("CANONICAL derive chain", () => {
    const root = canonical.signal(0);
    let cell: canonical.Signal<number> = root;
    for (let i = 0; i < CHAIN; i++) {
      const p = cell;
      cell = canonical.derive(() => (p.value as number) + 1);
    }
    void cell.value;
    timed("canonical  computed-chain FWD ×N", () => {
      for (let i = 0; i < N_OPS; i++) {
        (root as { value: number }).value = i;
        void cell.value;
      }
    });
  });

  it("SYMMETRIC computed chain", () => {
    const root = sym.signal(0);
    let cell: sym.Signal<number> = root;
    for (let i = 0; i < CHAIN; i++) {
      const p = cell;
      cell = sym.computed(() => p.value + 1);
    }
    void cell.value;
    timed("symmetric  computed-chain FWD ×N", () => {
      for (let i = 0; i < N_OPS; i++) {
        root.value = i;
        void cell.value;
      }
    });
  });
});

// ─── Backward propagation cost ──────────────────────────────────

describe("BWD ≤ FWD: 5-deep identity chain — backward pass", () => {
  it("CANONICAL FUSED: bwd cascade (1 fused closure)", () => {
    const cell = buildCanonFused(CHAIN);
    void cell.value;
    timed("canonical (FUSED)  BWD  (tip.value=i) ×N", () => {
      for (let i = 0; i < N_OPS; i++) (cell as { value: number }).value = i;
    });
  });

  it("CANONICAL EXPLICIT: bwd cascade", () => {
    const { tip } = buildCanonExplicit(CHAIN);
    void tip.value;
    timed("canonical (EXPLICIT) BWD  (tip.value=i) ×N", () => {
      for (let i = 0; i < N_OPS; i++) (tip as { value: number }).value = i;
    });
  });

  it("MERGE PROTO: bwd cascade", () => {
    const root = mergeProto.num(0);
    let cell: mergeProto.Num = root;
    for (let i = 0; i < CHAIN; i++) {
      cell = cell.add(0);
    }
    void cell.value;
    timed("merge proto BWD  (tip.value=i) ×N", () => {
      for (let i = 0; i < N_OPS; i++) cell.value = i;
    });
  });

  it("CANONICAL EXPLICIT+fn: bwd cascade (identity transform per layer)", () => {
    const { tip } = buildCanonExplicitFn(CHAIN);
    void tip.value;
    timed("canonical (EXPLICIT+fn) BWD  (tip.value=i) ×N", () => {
      for (let i = 0; i < N_OPS; i++) (tip as { value: number }).value = i;
    });
  });

  it("SYMMETRIC: bwd cascade", () => {
    const root = sym.signal(0);
    let cell: sym.Signal<number> = root;
    for (let i = 0; i < CHAIN; i++) {
      cell = sym.Signal.lens(
        cell,
        (v) => v,
        (t) => t,
      );
    }
    void cell.value;
    timed("symmetric  BWD  (tip.value=i) ×N", () => {
      for (let i = 0; i < N_OPS; i++) cell.value = i;
    });
  });
});

// ─── Coalescing payoff ──────────────────────────────────────────
//
// Multiple writes in a batch should coalesce. Symmetric should
// dramatically beat eager-dispatch designs here.

describe("BWD coalescing: 10 writes/batch on 5-deep chain", () => {
  const BATCHES = N_OPS / 10;

  it("CANONICAL FUSED: batched", () => {
    const cell = buildCanonFused(CHAIN);
    void cell.value;
    timed("canonical (FUSED)  10-batched BWD writes ×N/10", () => {
      for (let b = 0; b < BATCHES; b++) {
        canonical.batch(() => {
          for (let i = 0; i < 10; i++) (cell as { value: number }).value = i;
        });
      }
    });
  });

  it("CANONICAL EXPLICIT: batched", () => {
    const { tip } = buildCanonExplicit(CHAIN);
    void tip.value;
    timed("canonical (EXPLICIT) 10-batched BWD writes ×N/10", () => {
      for (let b = 0; b < BATCHES; b++) {
        canonical.batch(() => {
          for (let i = 0; i < 10; i++) (tip as { value: number }).value = i;
        });
      }
    });
  });

  it("MERGE PROTO: batched", () => {
    const root = mergeProto.num(0);
    let cell: mergeProto.Num = root;
    for (let i = 0; i < CHAIN; i++) {
      cell = cell.add(0);
    }
    void cell.value;
    timed("merge proto 10-batched BWD writes ×N/10", () => {
      for (let b = 0; b < BATCHES; b++) {
        mergeProto.batch(() => {
          for (let i = 0; i < 10; i++) cell.value = i;
        });
      }
    });
  });

  it("SYMMETRIC: batched", () => {
    const root = sym.signal(0);
    let cell: sym.Signal<number> = root;
    for (let i = 0; i < CHAIN; i++) {
      cell = sym.Signal.lens(
        cell,
        (v) => v,
        (t) => t,
      );
    }
    void cell.value;
    timed("symmetric  10-batched BWD writes ×N/10", () => {
      for (let b = 0; b < BATCHES; b++) {
        sym.batch(() => {
          for (let i = 0; i < 10; i++) cell.value = i;
        });
      }
    });
  });
});

// ─── Write-THEN-read patterns ───────────────────────────────────
//
// A bwd write commits the source (put-walk); the following read
// re-derives the views forward (get-walk). So a write+read pays ~2N
// transforms — the principled cost for state-based lenses, where a
// view is always `get(source)` and never a stashed bwd value.

describe("write-then-read: 5-deep chain, 1 write + 1 read per iter", () => {
  it("CANONICAL EXPLICIT", () => {
    const { tip } = buildCanonExplicit(CHAIN);
    void tip.value;
    timed("canonical EXPLICIT 1-write + 1-read ×N", () => {
      for (let i = 0; i < N_OPS; i++) {
        (tip as { value: number }).value = i;
        void tip.value;
      }
    });
  });

  it("CANONICAL EXPLICIT+fn", () => {
    const { tip } = buildCanonExplicitFn(CHAIN);
    void tip.value;
    timed("canonical EXPLICIT+fn 1-write + 1-read ×N", () => {
      for (let i = 0; i < N_OPS; i++) {
        (tip as { value: number }).value = i;
        void tip.value;
      }
    });
  });

  it("SYMMETRIC", () => {
    const root = sym.signal(0);
    let cell: sym.Signal<number> = root;
    for (let i = 0; i < CHAIN; i++) {
      cell = sym.Signal.lens(
        cell,
        (v) => v,
        (t) => t,
      );
    }
    void cell.value;
    timed("symmetric  1-write + 1-read ×N", () => {
      for (let i = 0; i < N_OPS; i++) {
        cell.value = i;
        void cell.value;
      }
    });
  });
});

describe("write-MANY-then-read: 10 writes followed by 1 read", () => {
  const ITER = N_OPS / 10;

  it("CANONICAL EXPLICIT (no batch — each write cascades)", () => {
    const { tip } = buildCanonExplicit(CHAIN);
    void tip.value;
    timed("canonical EXPLICIT 10w+1r (no batch) ×N/10", () => {
      for (let b = 0; b < ITER; b++) {
        for (let i = 0; i < 10; i++) (tip as { value: number }).value = i;
        void tip.value;
      }
    });
  });

  it("CANONICAL EXPLICIT+fn (no batch)", () => {
    const { tip } = buildCanonExplicitFn(CHAIN);
    void tip.value;
    timed("canonical EXPLICIT+fn 10w+1r (no batch) ×N/10", () => {
      for (let b = 0; b < ITER; b++) {
        for (let i = 0; i < 10; i++) (tip as { value: number }).value = i;
        void tip.value;
      }
    });
  });

  it("SYMMETRIC (unbatched — each write cascades, alien semantics)", () => {
    const root = sym.signal(0);
    let cell: sym.Signal<number> = root;
    for (let i = 0; i < CHAIN; i++) {
      cell = sym.Signal.lens(
        cell,
        (v) => v,
        (t) => t,
      );
    }
    void cell.value;
    timed("symmetric  10w+1r (no batch) ×N/10", () => {
      for (let b = 0; b < ITER; b++) {
        for (let i = 0; i < 10; i++) cell.value = i;
        void cell.value;
      }
    });
  });
});

// ─── Direct signal write (no chain, no merge) ───────────────────
// Baseline: how cheap is the engine when nothing is in the way?

describe("baseline: direct signal write", () => {
  it("CANONICAL", () => {
    const s = canonical.signal(0);
    timed("canonical  direct signal write ×N", () => {
      for (let i = 0; i < N_OPS; i++) s.value = i;
    });
  });

  it("MERGE PROTO", () => {
    const s = mergeProto.num(0);
    timed("merge proto direct signal write ×N", () => {
      for (let i = 0; i < N_OPS; i++) s.value = i;
    });
  });

  it("SYMMETRIC", () => {
    const s = sym.signal(0);
    timed("symmetric  direct signal write ×N", () => {
      for (let i = 0; i < N_OPS; i++) s.value = i;
    });
  });
});
