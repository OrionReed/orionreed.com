// merge.bench.test.ts — performance story for `.merge()`.
//
// Three things this file measures:
//
//   1. ENGINE OVERHEAD on no-merge workloads. The engine pays for
//      what it uses: when `bwdMergePop === 0` (no `.merge()` has
//      been constructed anywhere in the process) the value-setter
//      and lens-dispatch both short-circuit to canonical paths.
//      The head-to-head section below isolates this WITHIN a
//      process that has constructed merges — useful as an upper
//      bound, but the zero-cost guarantee only holds when no
//      merge has been built. (Sandbox-isolated benches confirm
//      ~5ns/lens-write vs canonical's ~5ns when bwdMergePop is
//      truly zero.)
//
//   2. MERGE OVERHEAD when used. Compare a chain WITH a merge
//      against an identical chain WITHOUT one, on the same writes.
//
//   3. SLOT-COUNT SCALING. The current fold re-runs over the
//      entire slot map on every arrival (O(slots²) per cascade).
//      Measure how this degrades for fan-in arity 2, 4, 8, 16.
//
// Outputs are eyeball numbers (printed via `console.info`), not
// assertions. Run with `npx vitest run merge.bench` and read the
// log. The constants below are tuned so each measurement runs ~0.1s
// on a modern laptop; bump N if you want tighter timings.

import { describe, it } from "vitest";
import * as canonical from "../../../index";
import { maxPolicy, Num, num, sumPolicy } from "../index";

const N = 50_000;

function timed(label: string, fn: () => void): number {
  // Warm V8: 3 runs then measured.
  fn();
  fn();
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  // biome-ignore lint/suspicious/noConsole: bench output
  console.info(
    `  ${label.padEnd(64)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / N).toFixed(3)}µs/op)`,
  );
  return ms;
}

describe("bench: engine overhead on no-merge workloads", () => {
  // The fundamental question: how much do the engine modifications
  // cost when nothing in the graph uses `.merge()`? If the answer
  // is "noticeable", we have a regression problem against the
  // canonical engine. If "negligible", the merge layer can ship.

  it("direct signal write (no lens, no merge)", () => {
    const s = num(0);
    timed("direct signal write           ×N", () => {
      for (let i = 0; i < N; i++) s.value = i;
    });
  });

  it("write through a single lens (no merge)", () => {
    const root = num(0);
    const lens = root.add(1);
    timed("lens write (1 layer, no merge) ×N", () => {
      for (let i = 0; i < N; i++) lens.value = i;
    });
  });

  it("write through a 3-deep fused chain (no merge)", () => {
    const root = num(0);
    const chain = root.add(1).scale(2).add(3);
    timed("lens write (3-deep fused, no merge) ×N", () => {
      for (let i = 0; i < N; i++) chain.value = i;
    });
  });

  it("fan-in distribute (no merge)", () => {
    const root = num(0);
    const a = root.add(1);
    const b = root.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    timed("fan-in 2-arity write (no merge) ×N", () => {
      for (let i = 0; i < N; i++) fan.value = i + 1;
    });
  });
});

describe("bench: cost of `.merge()` when used", () => {
  // Compare same workloads with a merge inserted at root.

  it("write through a single lens with merge at root", () => {
    const root = num(0).merge(sumPolicy);
    const lens = root.add(1);
    timed("lens write (1 layer, merge)    ×N", () => {
      for (let i = 0; i < N; i++) lens.value = i;
    });
  });

  it("fan-in 2-arity with merge at root", () => {
    const root = num(0).merge(sumPolicy);
    const a = root.add(1);
    const b = root.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    timed("fan-in 2-arity write (merge)   ×N", () => {
      for (let i = 0; i < N; i++) fan.value = i + 1;
    });
  });

  it("fan-in 2-arity with merge mid-chain", () => {
    const root = num(0);
    const merged = root.add(1).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    timed("fan-in 2-arity write (mid-chain merge) ×N", () => {
      for (let i = 0; i < N; i++) fan.value = i + 1;
    });
  });

  it("fan-in 2-arity with idempotent merge (max)", () => {
    // Idempotent + equality short-circuit should be cheap once
    // converged.
    const root = num(0).merge(maxPolicy);
    const a = root.add(1);
    const b = root.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    timed("fan-in 2-arity write (max merge) ×N", () => {
      for (let i = 0; i < N; i++) fan.value = i + 1;
    });
  });
});

describe("bench: slot-count scaling — incremental vs re-fold", () => {
  // Invertible policies (sumPolicy has `remove`) use O(k) incremental
  // fold per cascade. Lattice policies (maxPolicy) re-fold each
  // arrival, O(k²) per cascade. The contrast shows up sharply at
  // higher arity.

  for (const k of [2, 4, 8, 16, 64] as const) {
    it(`sum (incremental) ${k}-arity: O(k) = ${k} updates per cascade`, () => {
      const root = num(0).merge(sumPolicy);
      const lenses: Num[] = [];
      for (let i = 0; i < k; i++) lenses.push(root.add(i + 1));
      const fan = Num.lens(
        lenses as readonly Num[],
        vals => vals.reduce((a, b) => a + b, 0),
        (t, vals) => {
          const tot = vals.reduce((a, b) => a + b, 0) || 1;
          return vals.map(v => (t * v) / tot);
        },
      );
      timed(`sum ${String(k).padStart(2)}-arity merge write ×N`, () => {
        for (let i = 0; i < N; i++) fan.value = i + 1;
      });
    });
  }

  for (const k of [2, 4, 8, 16, 64] as const) {
    it(`max (re-fold) ${k}-arity: ${k}² = ${k * k} combine calls per cascade`, () => {
      const root = num(0).merge(maxPolicy);
      const lenses: Num[] = [];
      for (let i = 0; i < k; i++) lenses.push(root.add(i + 1));
      const fan = Num.lens(
        lenses as readonly Num[],
        vals => vals.reduce((a, b) => a + b, 0),
        (t, vals) => {
          const tot = vals.reduce((a, b) => a + b, 0) || 1;
          return vals.map(v => (t * v) / tot);
        },
      );
      timed(`max ${String(k).padStart(2)}-arity merge write ×N`, () => {
        for (let i = 0; i < N; i++) fan.value = i + 1;
      });
    });
  }
});

describe("bench: head-to-head vs canonical engine", () => {
  // NOTE: this section runs AFTER the merge benches above, so
  // `bwdMergePop > 0` in this process — the prototype takes its
  // merge-aware path even though THIS file's lenses don't touch a
  // merge. That's the upper-bound cost: an app that uses merges
  // somewhere pays it on every value-setter call. Apps with zero
  // merges hit the canonical short-circuit; run this file alone
  // (no merge tests) to see the floor.

  it("lens write — canonical vs prototype", () => {
    {
      const root = canonical.num(0);
      const lens = root.add(1);
      timed("canonical: lens write          ×N", () => {
        for (let i = 0; i < N; i++) lens.value = i;
      });
    }
    {
      const root = num(0);
      const lens = root.add(1);
      timed("prototype: lens write          ×N", () => {
        for (let i = 0; i < N; i++) lens.value = i;
      });
    }
  });

  it("fan-in 2-arity — canonical vs prototype", () => {
    {
      const root = canonical.num(0);
      const a = root.add(1);
      const b = root.scale(2);
      const fan = canonical.Num.lens(
        [a, b] as const,
        ([x, y]) => x + y,
        (t, [x, y]) => {
          const tot = x + y || 1;
          return [(t * x) / tot, (t * y) / tot];
        },
      );
      timed("canonical: fan-in 2-arity write ×N", () => {
        for (let i = 0; i < N; i++) fan.value = i + 1;
      });
    }
    {
      const root = num(0);
      const a = root.add(1);
      const b = root.scale(2);
      const fan = Num.lens(
        [a, b] as const,
        ([x, y]) => x + y,
        (t, [x, y]) => {
          const tot = x + y || 1;
          return [(t * x) / tot, (t * y) / tot];
        },
      );
      timed("prototype: fan-in 2-arity write ×N", () => {
        for (let i = 0; i < N; i++) fan.value = i + 1;
      });
    }
  });

  it("3-deep fused chain — canonical vs prototype", () => {
    {
      const root = canonical.num(0);
      const chain = root.add(1).scale(2).add(3);
      timed("canonical: 3-deep fused write   ×N", () => {
        for (let i = 0; i < N; i++) chain.value = i;
      });
    }
    {
      const root = num(0);
      const chain = root.add(1).scale(2).add(3);
      timed("prototype: 3-deep fused write   ×N", () => {
        for (let i = 0; i < N; i++) chain.value = i;
      });
    }
  });
});

describe("bench: read paths (forward) are unaffected", () => {
  // Forward reads don't touch any merge state. Cost should be
  // identical to no-merge.
  it("plain computed read", () => {
    const root = num(0);
    const view = Num.derive(root, v => v * 2);
    let sink = 0;
    timed("read computed view ×N", () => {
      for (let i = 0; i < N; i++) {
        root.value = i;
        sink += view.value;
      }
    });
    void sink;
  });

  it("computed read through merged cell", () => {
    const root = num(0).merge(sumPolicy);
    const view = Num.derive(root, v => v * 2);
    let sink = 0;
    timed("read computed through merge ×N", () => {
      for (let i = 0; i < N; i++) {
        root.value = i;
        sink += view.value;
      }
    });
    void sink;
  });
});
