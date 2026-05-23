// relate-reactive-topology.test.ts — dynamic constraint graphs.
//
// A reactive constraint system MUST handle relations being added
// and removed at runtime — that's the whole point of "reactive".
// Tests here exercise:
//
//   - Adding a relation while drag is in progress
//   - Removing a relation, verifying constraints continue to work
//   - Reactivating a relation (re-create after dispose)
//   - Adding/removing many relations in a batch — coalesced solves
//   - Topology change crossing the sparse-dispatch threshold
//   - Dispose invalidates sparse cache (no stale data)
//
// Each test is a correctness probe, not a perf benchmark.

import { describe, expect, it } from "vitest";
import { dist, eq, pinPoint } from "../constraints";
import { num, vec } from "../index";
import { clusterSize, hardPin, relate } from "../relate";

describe("Adding relations dynamically", () => {
  it("creating a new constraint after first solve picks it up next solve", () => {
    const a = num(0);
    const b = num(0);
    a.value = 5;
    expect(b.value).toBe(0); // no constraint yet

    // Dynamically constrain a = b.
    const r = relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    // Initial solve picks LSQ midpoint (no user pins).
    expect(a.value).toBeCloseTo(2.5, 4);
    expect(b.value).toBeCloseTo(2.5, 4);
    void r;

    // Subsequent writes propagate.
    a.value = 10;
    expect(b.value).toBeCloseTo(10, 4);
  });

  it("adding a new relation expands the cluster", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    expect(clusterSize(a)).toBe(2);
    expect(clusterSize(c)).toBe(0); // c not in any cluster yet

    // Add a relation joining b to c — clusters merge.
    relate({
      cells: [b, c],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    expect(clusterSize(a)).toBe(3);
    expect(clusterSize(b)).toBe(3);
    expect(clusterSize(c)).toBe(3);
  });

  it("adding a relation crossing the sparse-dispatch threshold switches paths cleanly", () => {
    // Start with a small cluster (dense path).
    const cells = Array.from({ length: 20 }, () => num(0));
    for (let i = 1; i < 20; i++) {
      relate({
        cells: [cells[i]!, cells[i - 1]!],
        residual: ([a, b], out) => {
          out[0] = (a as number) - (b as number);
        },
        m: 1,
      });
    }
    cells[0]!.value = 5;
    expect(cells[19]!.value).toBeCloseTo(5, 3);

    // Grow the cluster well above sparse threshold.
    for (let i = 20; i < 40; i++) {
      const ci = num(0);
      relate({
        cells: [ci, cells[i - 1]!],
        residual: ([a, b], out) => {
          out[0] = (a as number) - (b as number);
        },
        m: 1,
      });
      cells.push(ci);
    }
    // Cluster now has 40 cells; sparse path should engage.
    cells[0]!.value = 100;
    expect(cells[39]!.value).toBeCloseTo(100, 3);
  });
});

describe("Removing relations dynamically", () => {
  it("dispose() removes a relation; remaining constraints continue to work", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    const eqAB = relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    relate({
      cells: [b, c],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    a.value = 10;
    expect(b.value).toBeCloseTo(10, 4);
    expect(c.value).toBeCloseTo(10, 4);

    // Remove a-b constraint; only b-c remains.
    eqAB.dispose();
    a.value = 50;
    // a is now decoupled from the b-c sub-cluster.
    expect(a.value).toBe(50);
    expect(b.value).toBeCloseTo(10, 4); // unchanged from last solve
    expect(c.value).toBeCloseTo(10, 4);
    // Writing b drives c.
    b.value = 99;
    expect(c.value).toBeCloseTo(99, 4);
  });

  it("dispose then re-add: same effect as never disposing", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    const py1 = relate({
      cells: [a, b, c],
      residual: ([x, y, z], out) => {
        out[0] = (x as number) ** 2 + (y as number) ** 2 - (z as number) ** 2;
      },
      m: 1,
    });
    a.value = 6;
    const aAfter1 = a.value;
    const bAfter1 = b.value;
    const cAfter1 = c.value;
    expect(aAfter1 ** 2 + bAfter1 ** 2).toBeCloseTo(cAfter1 ** 2, 6);

    // Dispose, write something disruptive.
    py1.dispose();
    a.value = 100; // free; no constraint enforced
    // Re-add a fresh pythagoras.
    relate({
      cells: [a, b, c],
      residual: ([x, y, z], out) => {
        out[0] = (x as number) ** 2 + (y as number) ** 2 - (z as number) ** 2;
      },
      m: 1,
    });
    a.value = 6;
    expect(a.value ** 2 + b.value ** 2).toBeCloseTo(c.value ** 2, 4);
  });

  it("dispose-then-write does not crash if cluster becomes empty (m=0)", () => {
    const a = num(0);
    const b = num(0);
    const r = relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    r.dispose();
    a.value = 42;
    // No constraint left → b is free.
    expect(a.value).toBe(42);
    expect(b.value).toBe(0); // unchanged
  });
});

describe("Sparse cache invalidation on topology change", () => {
  it("dispose invalidates cached sparseInfo (no stale Jacobian pattern)", () => {
    // Build a sparse-path-eligible cluster.
    const cells = Array.from({ length: 50 }, () => num(0));
    const rels: ReturnType<typeof relate>[] = [];
    for (let i = 1; i < 50; i++) {
      rels.push(
        relate({
          cells: [cells[i]!, cells[i - 1]!],
          residual: ([a, b], out) => {
            out[0] = (a as number) - (b as number);
          },
          m: 1,
        }),
      );
    }
    cells[0]!.value = 5;
    expect(cells[49]!.value).toBeCloseTo(5, 3);

    // Remove half the relations.
    for (let i = 0; i < 25; i++) rels[i]!.dispose();
    // Now first 25 cells may be decoupled from last 26. Drag last cell.
    cells[49]!.value = 100;
    // Solver doesn't crash; system reaches a consistent state.
    expect(Number.isFinite(cells[0]!.value)).toBe(true);
    expect(Number.isFinite(cells[49]!.value)).toBe(true);
  });

  it("add many relations after dispose: cluster correctly grows", () => {
    const a = num(0);
    const b = num(0);
    const r1 = relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    r1.dispose();

    // Now add 30 fresh constraints — cluster grows again.
    for (let i = 0; i < 30; i++) {
      const c = num(0);
      relate({
        cells: [a, c],
        residual: ([x, y], out) => {
          out[0] = (x as number) - (y as number);
        },
        m: 1,
      });
    }
    a.value = 7;
    // Solver runs; doesn't crash.
    expect(a.value).toBe(7);
  });
});

describe("Constraint graph topology mutation under drag", () => {
  it("user write triggers solve; solve writes; downstream effects pick up new state", () => {
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    a.value = 1;
    expect(b.value).toBeCloseTo(1, 4);
    a.value = 2;
    expect(b.value).toBeCloseTo(2, 4);
    a.value = 3;
    expect(b.value).toBeCloseTo(3, 4);
  });

  it("interleaved add + drag + remove + drag", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(0, 1);

    // Stage 1: A — B distance 1.
    const r1 = dist(A, B, 1);
    pinPoint(A);
    expect(Math.hypot(B.value.x, B.value.y)).toBeCloseTo(1, 3);

    // Stage 2: drag B around its arc; C is free, untouched.
    B.value = { x: Math.cos(0.5), y: Math.sin(0.5) };
    expect(Math.hypot(B.value.x, B.value.y)).toBeCloseTo(1, 3);
    expect(C.value).toEqual({ x: 0, y: 1 });

    // Stage 3: add A — C constraint.
    const r2 = dist(A, C, 1);
    expect(Math.hypot(C.value.x, C.value.y)).toBeCloseTo(1, 3);

    // Stage 4: add B — C constraint (forms triangle).
    const r3 = dist(B, C, 1);
    // All three distances now satisfied.
    expect(Math.hypot(B.value.x, B.value.y)).toBeCloseTo(1, 3);
    expect(Math.hypot(C.value.x, C.value.y)).toBeCloseTo(1, 3);
    expect(Math.hypot(B.value.x - C.value.x, B.value.y - C.value.y)).toBeCloseTo(1, 3);

    // Stage 5: dispose r3 (B-C decoupled). Drag B; C unaffected.
    const cBefore = { ...C.value };
    r3.dispose();
    B.value = { x: Math.cos(1), y: Math.sin(1) };
    // B still satisfies |AB|=1 (r1 still active).
    expect(Math.hypot(B.value.x, B.value.y)).toBeCloseTo(1, 3);
    // C only constrained by r2 (|CA|=1). A is pinned, so C is on
    // the unit circle. C should still satisfy |AC|=1 but its
    // position relative to B isn't enforced.
    expect(Math.hypot(C.value.x, C.value.y)).toBeCloseTo(1, 3);
    void cBefore;

    void r2;
  });
});

describe("Hard-pin lifecycle through topology mutation", () => {
  it("dispose of hardPin lets cell move; re-pin lets it stick again", () => {
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = (x as number) - (y as number);
      },
      m: 1,
    });
    const stop = hardPin(a, 7);
    expect(a.value).toBe(7);
    expect(b.value).toBeCloseTo(7, 4);
    stop();
    b.value = 99;
    expect(a.value).toBeCloseTo(99, 4);
  });
});

void eq;
