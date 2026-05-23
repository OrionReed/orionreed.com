// avbd-value-types.test.ts — beyond Vec. AVBD's Cell type takes
// any DOF count, so 1D Nums, 4D Boxes (x,y,w,h), 4D Colors (r,g,b,a),
// even higher-dim cells work out of the box. Test that the solver
// handles them correctly, and that mixed-dim clusters work too.
//
// Cyclic values (angles) are interesting — the constraint function
// must wrap correctly so that 2π is the same as 0. We show one
// pattern.

import { describe, expect, it } from "vitest";
import {
  Cell,
  distance,
  eq,
  generic,
  lensNum,
  Solver,
} from "../index";

describe("AVBD value types — scalars (dim=1)", () => {
  it("Num cells with lensNum: b = 2a", () => {
    const a = new Cell(1, [3]);
    const b = new Cell(1, [0]);
    a.mass = 0;
    const s = new Solver({ iterations: 10 });
    s.addCell(a);
    s.addCell(b);
    lensNum(s, a, b, x => 2 * x);
    s.step();
    expect(b.position[0]!).toBeCloseTo(6, 3);
  });

  it("scalar sum constraint: a₁ + a₂ + … + aₙ = K", () => {
    // 5 scalars with target sum 100. With mass=1 regularisation
    // toward initial values, AVBD finds the feasible point closest
    // to the warm-start.
    //
    // Note: many-cell linear constraints converge SLOWER under
    // AVBD than per-pair constraints — Gauss-Seidel sees a single
    // residual scalar across all 5 cells; each iter only updates
    // one cell's position toward satisfying it. This is a real
    // characteristic of the algorithm. Workaround: more iters,
    // or split into per-pair sub-constraints.
    const N = 5;
    const cells: Cell[] = [];
    for (let i = 0; i < N; i++) cells.push(new Cell(1, [i + 1]));
    const s = new Solver({ iterations: 50 });
    for (const c of cells) s.addCell(c);
    generic(s, cells, 1, (pos, out) => {
      let sum = 0;
      for (const p of pos) sum += p[0]!;
      out[0]! = sum - 100;
    });
    for (let i = 0; i < 30; i++) s.step();
    let total = 0;
    for (const c of cells) total += c.position[0]!;
    expect(total).toBeCloseTo(100, 1);
    // All cells moved upward (residual was negative initially).
    for (let i = 0; i < N; i++) {
      expect(cells[i]!.position[0]!).toBeGreaterThan(i + 1);
    }
  });
});

describe("AVBD value types — Box (dim=4: x, y, w, h)", () => {
  it("two boxes sharing an edge: A.right = B.left", () => {
    // Box A: [0, 0, 5, 3]. Box B: [10, 0, 4, 3].
    // Constrain B.left = A.right ⇒ B.x = A.x + A.w.
    // Pin A. B should slide left to (5, 0, 4, 3).
    const A = new Cell(4, [0, 0, 5, 3]);
    const B = new Cell(4, [10, 0, 4, 3]);
    A.mass = 0;
    const s = new Solver({ iterations: 10 });
    s.addCell(A);
    s.addCell(B);
    generic(s, [A, B], 1, (pos, out) => {
      const a = pos[0]!,
        b = pos[1]!;
      // Constraint: B.x − (A.x + A.w) = 0.
      out[0]! = b[0]! - (a[0]! + a[2]!);
    });
    s.step();
    s.step();
    expect(B.position[0]!).toBeCloseTo(5, 2);
    // Other components untouched (regularised toward inertial).
    expect(B.position[1]!).toBeCloseTo(0, 3);
    expect(B.position[2]!).toBeCloseTo(4, 3);
    expect(B.position[3]!).toBeCloseTo(3, 3);
  });

  it("aspect-ratio constraint: w / h = 16/9", () => {
    const box = new Cell(4, [0, 0, 100, 100]);
    const s = new Solver({ iterations: 20 });
    s.addCell(box);
    generic(s, [box], 1, (pos, out) => {
      const b = pos[0]!;
      // 9w − 16h = 0.
      out[0]! = 9 * b[2]! - 16 * b[3]!;
    });
    for (let i = 0; i < 5; i++) s.step();
    expect(box.position[2]! / box.position[3]!).toBeCloseTo(16 / 9, 2);
  });
});

describe("AVBD value types — cyclic / wraparound angles", () => {
  it("two angles within π of each other (smallest signed difference)", () => {
    // Two scalar angles α, β; constrain β − α = 0 modulo 2π.
    // The trick: residual = wrap(β − α, [-π, π)). The solver sees
    // a smooth residual once values are within π, and the
    // constraint becomes equivalent to equality.
    const a = new Cell(1, [Math.PI / 4]);
    const b = new Cell(1, [-Math.PI / 4]);
    a.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    generic(s, [a, b], 1, (pos, out) => {
      const x = pos[0]![0]!;
      const y = pos[1]![0]!;
      // Wrap difference to (-π, π].
      let diff = y - x;
      diff -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
      out[0]! = diff;
    });
    for (let i = 0; i < 10; i++) s.step();
    // β should converge to α (mod 2π).
    let diff = b.position[0]! - a.position[0]!;
    diff -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
    expect(Math.abs(diff)).toBeLessThan(0.05);
  });
});

describe("AVBD value types — mixed dimensions in same cluster", () => {
  it("scalar (length) + vec (point) coupled by a constraint", () => {
    // Length L (Num) and point P (Vec). Constraint: |P| = L.
    // Pin L, the point should stay at distance L from origin.
    const L = new Cell(1, [3]);
    const P = new Cell(2, [5, 0]);
    L.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(L);
    s.addCell(P);
    generic(s, [L, P], 1, (pos, out) => {
      const l = pos[0]![0]!;
      const p = pos[1]!;
      out[0]! = Math.hypot(p[0]!, p[1]!) - l;
    });
    for (let i = 0; i < 5; i++) s.step();
    expect(Math.hypot(P.position[0]!, P.position[1]!)).toBeCloseTo(3, 2);

    // Now drag P somewhere else; |P| must still equal 3.
    P.position[0]! = 0;
    P.position[1]! = 5; // |P| = 5, violates
    for (let i = 0; i < 5; i++) s.step();
    expect(Math.hypot(P.position[0]!, P.position[1]!)).toBeCloseTo(3, 2);
  });

  it("scalar gain wired to two scalar signals: out = gain × in", () => {
    // gain (Num), input (Num), output (Num). Pin gain=2, input=5.
    // output should converge to 10. Then unpin output, pin to 7,
    // input should converge to 3.5 if gain is fixed.
    const gain = new Cell(1, [2]);
    const inp = new Cell(1, [5]);
    const out = new Cell(1, [0]);
    gain.mass = 0;
    inp.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(gain);
    s.addCell(inp);
    s.addCell(out);
    generic(s, [gain, inp, out], 1, (pos, residual) => {
      residual[0]! = pos[2]![0]! - pos[0]![0]! * pos[1]![0]!;
    });
    for (let i = 0; i < 5; i++) s.step();
    expect(out.position[0]!).toBeCloseTo(10, 2);

    // Flip pin direction: pin output, free input.
    inp.mass = 1;
    out.mass = 0;
    out.position[0]! = 7;
    for (let i = 0; i < 10; i++) s.step();
    expect(inp.position[0]!).toBeCloseTo(3.5, 2);
  });
});
