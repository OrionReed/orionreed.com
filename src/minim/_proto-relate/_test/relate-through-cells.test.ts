// relate-through-cells.test.ts — engine-level `Signal#through` lens
// cells participating in clusters.
//
// The engine's `through(fwd, bwd)` returns a writable lens whose
// reads compute `fwd(source)` and writes call `bwd` to update the
// source. The lens is its own Signal — it has its own slot in
// `xScratch` if added to a cluster, decoupled from its source's
// slot.
//
// This file documents what works today and what breaks. Subsequent
// work: auto-inject implicit `b = fwd(a)` relations so lens cells
// participate correctly in clusters.

import { describe, expect, it } from "vitest";
import { num } from "../index";
import { clusterHealth, relate } from "../relate";

describe("Through-lens cells in clusters — current state", () => {
  it("ONLY source in cluster: lens reads correctly post-solve", () => {
    // The standard pattern: cluster contains the SOURCE, lens is
    // observed externally. Solver perturbs source's slot; lens
    // reads through to source via getter; everything is consistent.
    const a = num(0);
    const aDouble = a.through(
      x => 2 * x,
      y => y / 2,
    );
    relate({
      cells: [a],
      residual: ([va], out) => {
        out[0] = (va as number) - 5;
      },
      m: 1,
    });
    expect(a.value).toBeCloseTo(5);
    expect(aDouble.value).toBeCloseTo(10); // lens reads through
  });

  it("ONLY lens in cluster: writes propagate to source via bwd", () => {
    // Cluster contains the LENS. Writes through the lens setter
    // update the source.
    const a = num(0);
    const aDouble = a.through(
      x => 2 * x,
      y => y / 2,
    );
    relate({
      cells: [aDouble],
      residual: ([va], out) => {
        out[0] = (va as number) - 8;
      },
      m: 1,
    });
    expect(aDouble.value).toBeCloseTo(8);
    expect(a.value).toBeCloseTo(4); // bwd ran via setter at write-back
  });

  it("BOTH source and lens in cluster: should work transparently", () => {
    // The hard case: both `a` and `aDouble` are cluster cells, with
    // an *external* relation involving them (e.g., pythagoras
    // a² + (2a)² = c²). The solver must keep them in lockstep
    // during Newton's perturbation steps.
    //
    // With auto-injected lens relations, we expect this to converge
    // to a correct solution and report close-to-zero Newton iters
    // for the lens portion.
    const a = num(0.5);
    const aDouble = a.through(
      x => 2 * x,
      y => y / 2,
    );
    const c = num(0);
    // Pythagoras: a² + aDouble² = c²; with aDouble=2a: 5a² = c².
    relate({
      cells: [a, aDouble, c],
      residual: ([va, vb, vc], out) => {
        const A = va as number;
        const B = vb as number;
        const C = vc as number;
        out[0] = A * A + B * B - C * C;
      },
      m: 1,
    });
    a.value = 3;
    // Expected: a=3, aDouble=6, c² = 9+36 = 45, c=√45≈6.708.
    expect(a.value).toBeCloseTo(3);
    expect(aDouble.value).toBeCloseTo(6, 3);
    expect(c.value ** 2).toBeCloseTo(45, 2);
  });

  it("lens chain: a → b → c, all cells in cluster, drag a", () => {
    const a = num(0);
    const b = a.through(
      x => 2 * x,
      y => y / 2,
    );
    const c = b.through(
      x => x + 5,
      y => y - 5,
    );
    relate({
      cells: [a, b, c],
      residual: () => {}, // No constraints — just topology.
      m: 0,
    });
    a.value = 3;
    // b = 2*3 = 6, c = 6 + 5 = 11. (b.through composes onto a, with
    // fwd = (b's f) ∘ (a→b), so c._throughOf.parent = a, fwd = x=>2x+5).
    expect(b.value).toBeCloseTo(6);
    expect(c.value).toBeCloseTo(11);
  });
});
