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
  box,
  generic,
  lensNum,
  num,
  NumCell,
  Solver,
  vec,
} from "../index";

describe("AVBD value types — scalars (dim=1)", () => {
  it("Num cells with lensNum: b = 2a", () => {
    const a = num(3);
    const b = num(0);
    a.mass = 0;
    const s = new Solver({ iterations: 10 });
    s.addCell(a);
    s.addCell(b);
    lensNum(s, a, b, x => 2 * x);
    s.step();
    expect(b.value).toBeCloseTo(6, 3);
  });

  it("scalar sum constraint: a₁ + a₂ + … + aₙ = K", () => {
    // Many-cell linear constraints converge slower under AVBD than
    // per-pair constraints — Gauss-Seidel sees a single residual
    // scalar across all cells; each iter only updates one cell's
    // position toward satisfying it. Workaround: more iters, or
    // split into per-pair sub-constraints.
    const N = 5;
    const cells: NumCell[] = [];
    for (let i = 0; i < N; i++) cells.push(num(i + 1));
    const s = new Solver({ iterations: 50 });
    for (const c of cells) s.addCell(c);
    generic(s, cells, 1, (pos, out) => {
      let sum = 0;
      for (const p of pos) sum += p[0]!;
      out[0]! = sum - 100;
    });
    for (let i = 0; i < 30; i++) s.step();
    let total = 0;
    for (const c of cells) total += c.value;
    expect(total).toBeCloseTo(100, 1);
    for (let i = 0; i < N; i++) {
      expect(cells[i]!.value).toBeGreaterThan(i + 1);
    }
  });
});

describe("AVBD value types — Box (dim=4: x, y, w, h)", () => {
  it("two boxes sharing an edge: A.right = B.left", () => {
    const A = box(0, 0, 5, 3);
    const B = box(10, 0, 4, 3);
    A.mass = 0;
    const s = new Solver({ iterations: 10 });
    s.addCell(A);
    s.addCell(B);
    generic(s, [A, B], 1, (pos, out) => {
      const a = pos[0]!,
        b = pos[1]!;
      out[0]! = b[0]! - (a[0]! + a[2]!);
    });
    s.step();
    s.step();
    expect(B.value.x).toBeCloseTo(5, 2);
    expect(B.value.y).toBeCloseTo(0, 3);
    expect(B.value.w).toBeCloseTo(4, 3);
    expect(B.value.h).toBeCloseTo(3, 3);
  });

  it("aspect-ratio constraint: w / h = 16/9", () => {
    const b = box(0, 0, 100, 100);
    const s = new Solver({ iterations: 20 });
    s.addCell(b);
    generic(s, [b], 1, (pos, out) => {
      const v = pos[0]!;
      out[0]! = 9 * v[2]! - 16 * v[3]!;
    });
    for (let i = 0; i < 5; i++) s.step();
    expect(b.value.w / b.value.h).toBeCloseTo(16 / 9, 2);
  });
});

describe("AVBD value types — cyclic / wraparound angles", () => {
  it("two angles within π of each other (smallest signed difference)", () => {
    const a = num(Math.PI / 4);
    const b = num(-Math.PI / 4);
    a.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    generic(s, [a, b], 1, (pos, out) => {
      const x = pos[0]![0]!;
      const y = pos[1]![0]!;
      let diff = y - x;
      diff -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
      out[0]! = diff;
    });
    for (let i = 0; i < 10; i++) s.step();
    let diff = b.value - a.value;
    diff -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
    expect(Math.abs(diff)).toBeLessThan(0.05);
  });
});

describe("AVBD value types — mixed dimensions in same cluster", () => {
  it("scalar (length) + vec (point) coupled by a constraint", () => {
    const L = num(3);
    const P = vec(5, 0);
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
    expect(Math.hypot(P.x, P.y)).toBeCloseTo(3, 2);

    P.value = { x: 0, y: 5 };
    for (let i = 0; i < 5; i++) s.step();
    expect(Math.hypot(P.x, P.y)).toBeCloseTo(3, 2);
  });

  it("scalar gain wired to two scalar signals: out = gain × in", () => {
    const gain = num(2);
    const inp = num(5);
    const out = num(0);
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
    expect(out.value).toBeCloseTo(10, 2);

    inp.mass = 1;
    out.mass = 0;
    out.value = 7;
    for (let i = 0; i < 10; i++) s.step();
    expect(inp.value).toBeCloseTo(3.5, 2);
  });
});
