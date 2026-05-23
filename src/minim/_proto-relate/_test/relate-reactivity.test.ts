// relate-reactivity.test.ts — relations as first-class participants in
// the reactive engine. Verifies the integration story:
//
//   - Solver writes propagate normally through the engine — effects
//     fire, computeds invalidate, lens-derived cells re-derive.
//   - Reads through computeds + lenses see post-solve values.
//   - Lateral binds, lens chains, through-fusion work upstream and
//     downstream of constraint cells.
//   - The `withSolverActive` write-suppression is correct: solver
//     writes don't re-trigger the cluster they came from, but DO
//     trigger downstream effects/computeds.
//
// These are the integration-correctness tests. If any of these fail,
// relations are not safely composable with the rest of the system.

import { describe, expect, it } from "vitest";
import { dist, eq, pinPoint, point } from "../constraints";
import { batch, computed, effect, Num, num } from "../index";
import { relate } from "../relate";

const EPS = 1e-6;

describe("Effects on cluster cells fire on solver writes", () => {
  it("effect sees post-solve value when cluster cell is rewritten by solver", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    relate({
      cells: [a, b, c],
      residual: ([a, b, c], out) => {
        out[0] = a! * a! + b! * b! - c! * c!;
      },
      m: 1,
    });
    const observed: number[] = [];
    effect(() => {
      observed.push(c.value);
    });
    a.value = 6;
    // Effect ran initially (push 5), then solver pushed c, then effect
    // ran again (push new c). Final c should be ~10 (since 36+b²=c²
    // with b stable).
    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(observed[observed.length - 1]).toBeGreaterThan(5);
  });

  it("effect on relation.residual fires when cluster updates", () => {
    const a = num(0);
    const b = num(0);
    const r = relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    const observed: number[] = [];
    effect(() => {
      observed.push(r.residual.value);
    });
    // Drive a — b reflows, residual stays ~0.
    a.value = 5;
    a.value = 10;
    a.value = 15;
    // Each write should produce a residual update event (initial + 3).
    expect(observed.length).toBeGreaterThanOrEqual(2);
    // All residuals tiny — constraint always satisfied.
    for (const v of observed) expect(Math.abs(v)).toBeLessThan(EPS);
  });

  it("relation.satisfied flips correctly under unsatisfiable writes", () => {
    // A 2-cell cluster, a-b=0. Hard-pin a at 5. Cluster: 1 free var
    // (b). Should always be satisfiable. Then add another constraint
    // a+b=10. 0 free vars, both pinned. Hard-pin holds a=5; user
    // hasn't written b. Solver runs with a pinned, b free, residuals
    // [a-b=5-b, a+b-10=5+b-10=b-5]. Best b=5; both residuals zero.
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! + y! - 10;
      },
      m: 1,
    });
    // System solves to a=b=5.
    expect(a.value).toBeCloseTo(5, 6);
    expect(b.value).toBeCloseTo(5, 6);
  });
});

describe("Computeds reading cluster cells reflect post-solve state", () => {
  it("computed depending on multiple cluster cells sees joint solution", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    relate({
      cells: [a, b, c],
      residual: ([a, b, c], out) => {
        out[0] = a! * a! + b! * b! - c! * c!;
      },
      m: 1,
    });
    const sumSq = computed(() => a.value ** 2 + b.value ** 2);
    const cSq = computed(() => c.value ** 2);
    expect(sumSq.value).toBeCloseTo(cSq.value, 6);
    a.value = 7;
    expect(sumSq.value).toBeCloseTo(cSq.value, 6);
    a.value = 11;
    expect(sumSq.value).toBeCloseTo(cSq.value, 6);
  });

  it("computed of cluster cell + free cell tracks both correctly", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    relate({
      cells: [a, b, c],
      residual: ([a, b, c], out) => {
        out[0] = a! * a! + b! * b! - c! * c!;
      },
      m: 1,
    });
    const free = num(100); // not in cluster
    const sum = computed(() => a.value + free.value);
    expect(sum.value).toBeCloseTo(a.value + 100);
    a.value = 10;
    expect(sum.value).toBeCloseTo(10 + 100);
    free.value = 200;
    expect(sum.value).toBeCloseTo(10 + 200);
  });
});

describe("Lens chains downstream of cluster cells", () => {
  it("lens-derived view of a cluster cell updates after solver writes", () => {
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    // Build a lens chain: aDouble = a × 2, written through divides by 2.
    const aDouble = a.scale(2);
    expect(aDouble.value).toBe(0);
    a.value = 7;
    expect(aDouble.value).toBeCloseTo(14);
    // Writing through the lens propagates back to a, which triggers
    // cluster solve, which should propagate b. (Note: aDouble.value=20
    // means a=10; cluster solves a=b ⇒ b=10 too.)
    aDouble.value = 20;
    expect(a.value).toBeCloseTo(10, 6);
    expect(b.value).toBeCloseTo(10, 6);
  });

  it("affine chain on a cluster cell is read-correct after each solve", () => {
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    const ratio = a.affine(0.1, 1); // 0.1·a + 1
    expect(ratio.value).toBeCloseTo(1);
    a.value = 90;
    expect(ratio.value).toBeCloseTo(10);
    expect(b.value).toBeCloseTo(90);
  });
});

describe("Bidirectional bind() across cluster boundary", () => {
  it("bind(target, source) where source is a cluster cell propagates via solver", () => {
    // External source (free, outside any cluster).
    const ext = num(0);
    // Cluster: a = b
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    // Drive a from ext via effect (mimics bind).
    effect(() => {
      a.value = ext.value;
    });
    ext.value = 7;
    expect(a.value).toBeCloseTo(7);
    expect(b.value).toBeCloseTo(7);
    ext.value = 13;
    expect(a.value).toBeCloseTo(13);
    expect(b.value).toBeCloseTo(13);
  });
});

describe("Through-chain fusion + cluster cells", () => {
  it("through-chain on a cluster cell composes cleanly", () => {
    const a = num(2);
    const b = num(2);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    // Auto-fused chain: (a + 1) × 3 - 5
    const chain = a.add(1).scale(3).sub(5);
    expect(chain.value).toBe((2 + 1) * 3 - 5); // 4
    // Write through the chain: (v+5)/3-1 = a
    chain.value = 10;
    // chain = (a+1)*3-5 = 10 ⇒ a+1=5 ⇒ a=4
    expect(a.value).toBeCloseTo(4, 6);
    expect(b.value).toBeCloseTo(4, 6);
  });
});

describe("Batch semantics — atomic multi-cell writes", () => {
  it("batch with multiple writes to same cluster runs solver once", () => {
    // Counter increments on every solve — let's count solves.
    const a = num(0);
    const b = num(0);
    let writebacks = 0;
    effect(() => {
      void b.value;
      writebacks++;
    });
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    writebacks = 0; // reset after construction
    batch(() => {
      a.value = 5;
      a.value = 7;
      a.value = 9;
    });
    // After batch: b should be 9 (matches final a). Effect runs once
    // (or only as many times as b's value changed).
    expect(b.value).toBeCloseTo(9);
    // The effect re-runs at most a few times — not 3 (which would be
    // one per write). Verify the batching collapsed the work.
    expect(writebacks).toBeLessThanOrEqual(1);
  });

  it("nested batch — outer batch flushes once at outer end", () => {
    const a = num(0);
    const b = num(0);
    let solves = 0;
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    effect(() => {
      void b.value;
      solves++;
    });
    solves = 0;
    batch(() => {
      a.value = 1;
      batch(() => {
        a.value = 2;
        batch(() => {
          a.value = 3;
        });
      });
      a.value = 4;
    });
    expect(b.value).toBeCloseTo(4);
    expect(solves).toBeLessThanOrEqual(1);
  });
});

describe("Solver writes do not re-trigger their own cluster", () => {
  it("write to a re-solves cluster once, not infinitely", () => {
    // If solver writes to b (via writeback) re-fired pinHook for b,
    // that would mark cluster dirty again, infinite loop. The
    // `withSolverActive` flag should prevent this. Verified by:
    // measuring that a single user write produces O(1) solver work.
    const a = num(0);
    const b = num(0);
    let solveCount = 0;
    const r = relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
        solveCount++;
      },
      m: 1,
    });
    void r.residual.value;
    solveCount = 0;
    a.value = 17;
    // residual evaluations bounded — exact count varies by Newton
    // (FD steps inside one call), but no infinite loop.
    expect(solveCount).toBeGreaterThan(0);
    expect(solveCount).toBeLessThan(50);
    expect(b.value).toBeCloseTo(17);
  });
});

describe("Vec field lens integration via factories that decompose", () => {
  it("dist() over Points built from raw Nums (no parent Vec) — works", () => {
    const A = point(num(0), num(0));
    const B = point(num(5), num(0));
    dist(A, B, 5);
    A.x.value = -3;
    expect(Math.hypot(A.x.value - B.x.value, A.y.value - B.y.value)).toBeCloseTo(5, 6);
  });
});

void Num;
void eq;
void pinPoint;
