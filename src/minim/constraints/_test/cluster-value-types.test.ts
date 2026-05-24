// avbd-value-types.test.ts — beyond Vec. The solver works on any
// `Pack`-trait-carrying signal: 1D `Num`, 2D `Vec`, 4D `Box`,
// 4D `Color`, plus mixed-dim clusters. Cyclic values (angles)
// just need a manually-wrapped residual.

import { describe, expect, it } from "vitest";
import { box, num, vec } from "../../signals";
import { constraints, generic, lensNum } from "../index";

describe("AVBD value types — scalars (dim=1)", () => {
  it("Num cells with lensNum: b = 2a", () => {
    const a = num(3);
    const b = num(0);
    const s = constraints({ iterations: 10 });
    s.add(lensNum(a, b, x => 2 * x));
    s.pin(a);
    a.value = 3.0001;
    expect(b.value).toBeCloseTo(6, 1);
  });

  it("scalar sum constraint: a₁ + a₂ + … + aₙ = K", () => {
    // Many-cell linear constraints converge slower under AVBD than
    // per-pair constraints — Gauss-Seidel sees a single residual
    // scalar across all cells; each iter only updates one cell's
    // position toward satisfying it. Workaround: more iters, or
    // split into per-pair sub-constraints.
    const N = 5;
    const cells = [];
    for (let i = 0; i < N; i++) cells.push(num(i + 1));
    const s = constraints({ iterations: 50 });
    s.add(
      generic(cells, 1, (pos, out) => {
        let sum = 0;
        for (const p of pos) sum += p[0]!;
        out[0]! = sum - 100;
      }),
    );
    cells[0]!.value = 1.0001; // trigger
    let total = 0;
    for (const c of cells) total += c.value;
    expect(total).toBeCloseTo(100, 0);
    for (let i = 0; i < N; i++) {
      expect(cells[i]!.value).toBeGreaterThan(i + 1);
    }
  });
});

describe("AVBD value types — Box (dim=4: x, y, w, h)", () => {
  it("two boxes sharing an edge: A.right = B.left", () => {
    const A = box(0, 0, 5, 3);
    const B = box(10, 0, 4, 3);
    const s = constraints({ iterations: 10 });
    s.add(
      generic([A, B], 1, (pos, out) => {
        const a = pos[0]!,
          b = pos[1]!;
        out[0]! = b[0]! - (a[0]! + a[2]!);
      }),
    );
    s.pin(A);
    A.value = { x: 0.0001, y: 0, w: 5, h: 3 };
    expect(B.value.x).toBeCloseTo(5, 1);
    expect(B.value.y).toBeCloseTo(0, 3);
    expect(B.value.w).toBeCloseTo(4, 3);
    expect(B.value.h).toBeCloseTo(3, 3);
  });

  it("aspect-ratio constraint: w / h = 16/9", () => {
    const b = box(0, 0, 100, 100);
    const s = constraints({ iterations: 20 });
    s.add(
      generic([b], 1, (pos, out) => {
        const v = pos[0]!;
        out[0]! = 9 * v[2]! - 16 * v[3]!;
      }),
    );
    b.value = { x: 0, y: 0, w: 100.0001, h: 100 };
    expect(b.value.w / b.value.h).toBeCloseTo(16 / 9, 1);
  });
});

describe("AVBD value types — cyclic / wraparound angles", () => {
  it("two angles within π of each other (smallest signed difference)", () => {
    const a = num(Math.PI / 4);
    const b = num(-Math.PI / 4);
    const s = constraints({ iterations: 30 });
    s.add(
      generic([a, b], 1, (pos, out) => {
        const x = pos[0]![0]!;
        const y = pos[1]![0]!;
        let diff = y - x;
        diff -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
        out[0]! = diff;
      }),
    );
    s.pin(a);
    a.value = Math.PI / 4 + 0.0001;
    let diff = b.value - a.value;
    diff -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
    expect(Math.abs(diff)).toBeLessThan(0.05);
  });
});

describe("AVBD value types — mixed dimensions in same cluster", () => {
  it("scalar (length) + vec (point) coupled by a constraint", () => {
    const L = num(3);
    const P = vec(5, 0);
    const s = constraints({ iterations: 20 });
    s.add(
      generic([L, P], 1, (pos, out) => {
        const l = pos[0]![0]!;
        const p = pos[1]!;
        out[0]! = Math.hypot(p[0]!, p[1]!) - l;
      }),
    );
    s.pin(L);
    L.value = 3.0001;
    expect(Math.hypot(P.value.x, P.value.y)).toBeCloseTo(3, 1);
  });

  it("scalar gain wired to two scalar signals: out = gain × in", () => {
    const gain = num(2);
    const inp = num(5);
    const out = num(0);
    const s = constraints({ iterations: 20 });
    s.add(
      generic([gain, inp, out], 1, (pos, residual) => {
        residual[0]! = pos[2]![0]! - pos[0]![0]! * pos[1]![0]!;
      }),
    );
    s.pin(gain);
    s.pin(inp);
    inp.value = 5.0001;
    expect(out.value).toBeCloseTo(10, 1);
  });
});
