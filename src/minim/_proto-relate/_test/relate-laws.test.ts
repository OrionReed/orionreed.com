// relate-laws.test.ts — well-behavedness criteria for relations.
//
// These are the analog of "glitch-free" for the constraint engine.
// Each `describe` block targets one criterion (CR1..CR8 from
// relate.ts's header). Together they form the rigour story for
// shipping relations as a first-class primitive.
//
// Strategy: where exact equality holds (point arithmetic with no
// floating-point drift, e.g. eq, midpoint), assert exactly. For
// numerical solving (dist, angle), assert up to ε. Each assertion is
// labelled with the criterion it tests.

import { describe, expect, it } from "vitest";
import { dist, eq, midpoint, onLine, pinPoint, point } from "../constraints";
import { batch, num } from "../index";
import { clusterSize, relate } from "../relate";

const EPS = 1e-6;

// ─── CR1 — Confluence ────────────────────────────────────────────────

describe("CR1 — Confluence (write order independence within a batch)", () => {
  it("pythagoras: write a then b vs b then a in same batch ⇒ same final state", () => {
    const setup = () => {
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
      return { a, b, c };
    };

    const r1 = setup();
    batch(() => {
      r1.a.value = 6;
      r1.b.value = 8;
    });

    const r2 = setup();
    batch(() => {
      r2.b.value = 8;
      r2.a.value = 6;
    });

    expect(r1.a.value).toBeCloseTo(r2.a.value, 8);
    expect(r1.b.value).toBeCloseTo(r2.b.value, 8);
    expect(r1.c.value).toBeCloseTo(r2.c.value, 8);
  });

  it("equilateral triangle: drag A.x then A.y vs A.y then A.x ⇒ same configuration", () => {
    const setup = () => {
      const A = point(num(0), num(0));
      const B = point(num(1), num(0));
      const C = point(num(0.5), num(Math.sqrt(3) / 2));
      dist(A, B, 1);
      dist(B, C, 1);
      dist(C, A, 1);
      pinPoint(B); // pin B so the figure is determined
      return { A, B, C };
    };

    const r1 = setup();
    batch(() => {
      r1.A.x.value = 3;
      r1.A.y.value = 1;
    });

    const r2 = setup();
    batch(() => {
      r2.A.y.value = 1;
      r2.A.x.value = 3;
    });

    expect(r1.C.x.value).toBeCloseTo(r2.C.x.value, 6);
    expect(r1.C.y.value).toBeCloseTo(r2.C.y.value, 6);
  });
});

// ─── CR2 — Consistency post-flush ────────────────────────────────────

describe("CR2 — Consistency (post-flush ‖residual‖ ≤ tol)", () => {
  it("after any single user write, all relations satisfied", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    const py = relate({
      cells: [a, b, c],
      residual: ([a, b, c], out) => {
        out[0] = a! * a! + b! * b! - c! * c!;
      },
      m: 1,
    });
    a.value = 7;
    expect(py.residual.value).toBeLessThan(EPS);
    b.value = 11;
    expect(py.residual.value).toBeLessThan(EPS);
    c.value = 20; // c² = 400, want a² + b² = 400
    expect(py.residual.value).toBeLessThan(EPS);
  });

  it("composed cluster: post-flush every relation satisfied", () => {
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(0.5), num(0.866));
    const rAB = dist(A, B, 1);
    const rBC = dist(B, C, 1);
    const rCA = dist(C, A, 1);

    A.x.value = 5;
    expect(rAB.residual.value).toBeLessThan(EPS);
    expect(rBC.residual.value).toBeLessThan(EPS);
    expect(rCA.residual.value).toBeLessThan(EPS);
  });
});

// ─── CR3 — Steady-state stability ────────────────────────────────────

describe("CR3 — Steady-state stability (no drift on idle reads)", () => {
  it("repeated reads of same cells yield same values", () => {
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
    a.value = 7;
    const c1 = c.value;
    for (let i = 0; i < 50; i++) {
      expect(c.value).toBe(c1);
      expect(b.value).toBe(b.peek());
    }
  });

  it("repeated reads of relation residual stay stable", () => {
    const a = num(0);
    const b = num(0);
    const r = relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    a.value = 5;
    const r1 = r.residual.value;
    for (let i = 0; i < 100; i++) expect(r.residual.value).toBe(r1);
  });
});

// ─── CR4 — Bounded propagation ───────────────────────────────────────

describe("CR4 — Bounded propagation (always terminates)", () => {
  it("over-constrained system: solver returns at least-squares optimum within budget", () => {
    // Two cells, three mutually-inconsistent constraints. The solver
    // is unpinned (initial-construction solve) and should land at the
    // least-squares optimum (x=2 for the system below).
    const x = num(0);
    relate({
      cells: [x],
      residual: ([v], out) => {
        out[0] = v! - 1;
        out[1] = v! - 2;
        out[2] = v! - 3;
      },
      m: 3,
    });
    expect(Number.isFinite(x.value)).toBe(true);
    expect(x.value).toBeCloseTo(2, 3); // mean of {1,2,3}

    // Now: writing to the pinned cell forces x=10. The cluster has
    // no free var to relax the residual; solver returns immediately.
    // Assertion: doesn't hang, x stays at 10 (pinned).
    const start = performance.now();
    x.value = 10;
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(x.value).toBe(10);
  });

  it("complex but solvable cluster terminates in bounded time", () => {
    // 10-element chain of distance constraints.
    const pts = Array.from({ length: 10 }, (_, i) => point(num(i), num(0)));
    for (let i = 0; i + 1 < pts.length; i++) {
      dist(pts[i]!, pts[i + 1]!, 1);
    }
    pinPoint(pts[0]!);
    const start = performance.now();
    pts[5]!.x.value = 7;
    pts[5]!.y.value = 3;
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});

// ─── CR5 — Determinism ───────────────────────────────────────────────

describe("CR5 — Determinism (same inputs ⇒ same outputs)", () => {
  it("identical setup + writes ⇒ identical solved values", () => {
    const setup = () => {
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
      return { a, b, c };
    };
    const r1 = setup();
    r1.a.value = 6;
    const r2 = setup();
    r2.a.value = 6;
    expect(r1.b.value).toBe(r2.b.value);
    expect(r1.c.value).toBe(r2.c.value);
  });

  it("same composed system + same drag ⇒ same final figure", () => {
    const setup = () => {
      const A = point(num(0), num(0));
      const B = point(num(1), num(0));
      const C = point(num(0.5), num(0.866));
      dist(A, B, 1);
      dist(B, C, 1);
      dist(C, A, 1);
      pinPoint(B);
      return { A, B, C };
    };
    const r1 = setup();
    r1.A.x.value = 4;
    const r2 = setup();
    r2.A.x.value = 4;
    expect(r1.A.x.value).toBe(r2.A.x.value);
    expect(r1.A.y.value).toBe(r2.A.y.value);
    expect(r1.C.x.value).toBe(r2.C.x.value);
    expect(r1.C.y.value).toBe(r2.C.y.value);
  });
});

// ─── CR6 — Locality ──────────────────────────────────────────────────

describe("CR6 — Locality (writes only affect transitively-connected cells)", () => {
  it("write to cell in cluster A does not perturb cells in cluster B", () => {
    // Cluster A: a1, a2 with a1 + a2 = 0
    const a1 = num(1);
    const a2 = num(-1);
    relate({
      cells: [a1, a2],
      residual: ([x, y], out) => {
        out[0] = x! + y!;
      },
      m: 1,
    });
    // Cluster B: b1, b2 with b1 - b2 = 0
    const b1 = num(7);
    const b2 = num(7);
    relate({
      cells: [b1, b2],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    expect(clusterSize(a1)).toBe(2);
    expect(clusterSize(b1)).toBe(2);

    a1.value = 5;
    // a2 must adjust to -5; b1 and b2 must NOT.
    expect(a2.value).toBeCloseTo(-5, 6);
    expect(b1.value).toBe(7);
    expect(b2.value).toBe(7);
  });

  it("isolated num (no relation) is unaffected by other clusters", () => {
    const lone = num(42);
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    a.value = 100;
    expect(lone.value).toBe(42);
  });
});

// ─── CR7 — Composition closure ───────────────────────────────────────

describe("CR7 — Composition closure (relations on shared cells = one cluster)", () => {
  it("two relations sharing one cell merge their clusters", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    relate({
      cells: [b, c],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    expect(clusterSize(a)).toBe(3);
    expect(clusterSize(b)).toBe(3);
    expect(clusterSize(c)).toBe(3);
    a.value = 5;
    expect(b.value).toBeCloseTo(5);
    expect(c.value).toBeCloseTo(5);
  });

  it("conjunction: stacking constraints on shared cells preserves earlier ones", () => {
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
    // Both: a = b AND a + b = 10 ⇒ a = b = 5.
    expect(a.value).toBeCloseTo(5, 6);
    expect(b.value).toBeCloseTo(5, 6);
  });
});

// ─── CR8 — Lens-law-like behaviour ───────────────────────────────────

describe("CR8 — Lens laws on well-determined clusters", () => {
  it("PutGet: writing v then reading the same cell returns v (when over-determined cluster has freedom there)", () => {
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
    a.value = 9;
    expect(a.value).toBe(9); // user-pinned, unchanged
  });

  it("GetPut: writing what was just read leaves the cluster unchanged", () => {
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
    const a0 = a.value;
    const b0 = b.value;
    const c0 = c.value;
    a.value = a0;
    expect(b.value).toBeCloseTo(b0, 9);
    expect(c.value).toBeCloseTo(c0, 9);
  });

  it("PutPut: a then b ≡ just b (in terms of final cluster state)", () => {
    const setup = () => {
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
      return { a, b, c };
    };
    // Sequence 1: write a=7, then a=11.
    const r1 = setup();
    r1.a.value = 7;
    r1.a.value = 11;
    // Sequence 2: write a=11 only.
    const r2 = setup();
    r2.a.value = 11;
    // Note: outside a batch, sequence 1 has TWO solver passes — first
    // pinning a=7 (b,c reflow), second pinning a=11 (b,c reflow from
    // *post-first-pass* state). This generally diverges from "just
    // write 11" unless solver is order-invariant in this regime.
    //
    // For the constraint a²+b²=c², the second pass starts from
    // (a=11, b≈f(7), c≈g(7)) and pulls toward (a=11, *, *). Newton
    // converges to *some* solution — typically not the one starting
    // from (a=11, b=4, c=5).
    //
    // PutPut here is asserted only WITHIN A BATCH (where exactly one
    // solve runs and pin = {a}).
    expect(r1.b.value).not.toBeCloseTo(r2.b.value, 4); // EXPECTED DIVERGENCE
    // The within-batch version DOES satisfy PutPut:
    const r3 = setup();
    batch(() => {
      r3.a.value = 7;
      r3.a.value = 11;
    });
    expect(r3.a.value).toBe(11);
    expect(r3.b.value).toBeCloseTo(r2.b.value, 6);
    expect(r3.c.value).toBeCloseTo(r2.c.value, 6);
  });
});

// ─── Cluster identification (instrumentation) ────────────────────────

describe("Cluster identification — disjoint vs merged", () => {
  it("equilateral triangle relations form one 6-cell cluster", () => {
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(0.5), num(0.866));
    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, A, 1);
    expect(clusterSize(A.x)).toBe(6);
    expect(clusterSize(C.y)).toBe(6);
  });

  it("two disjoint constraints yield two clusters", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    const d = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    relate({
      cells: [c, d],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    expect(clusterSize(a)).toBe(2);
    expect(clusterSize(c)).toBe(2);
  });
});

// Sanity void
void onLine;
void midpoint;
void eq;
