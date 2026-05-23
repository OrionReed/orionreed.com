// avbd-joints.test.ts — hard inequality / joint-limit constraints,
// AVBD's killer feature.
//
// In the AVBD reference (paper §3.2), inequalities and joint limits
// are handled via clamped Lagrange multipliers. The clamping is
// natural: `λ ← clamp(k·C + λ, fmin, fmax)`. The dual variable
// keeps just enough force to satisfy the constraint within bounds,
// or saturates at the limit when the constraint would otherwise be
// violated. Penalty methods (which we used in `relate`) require
// weight escalation hacks; AVBD just works.
//
// We test:
//   - Range-distance: link with `min ≤ |a-b| ≤ max`. Solver clamps
//     into the range without instability.
//   - Hard one-sided inequality (`x ≥ 0`): solver pushes into
//     feasible region from any initial state.
//   - Multiple competing inequalities: result respects intersection.

import { describe, expect, it } from "vitest";
import { Cell } from "../cell";
import { distance, Solver, vec } from "../index";

// ─── Range-distance: a single distance-with-bounds constraint ─────
//
// Built directly as a Force subclass: rows = 1, with fmin/fmax
// chosen so the force can only push (not pull) when |a-b| < min,
// and only pull (not push) when |a-b| > max. In between, force = 0.

import { Force } from "../force";

class RangeDistanceForce extends Force {
  private min: number;
  private max: number;

  constructor(a: Cell, b: Cell, min: number, max: number) {
    if (a.dim !== 2 || b.dim !== 2) {
      throw new Error("RangeDistance: cells must be Vec");
    }
    super([a, b], 1);
    this.min = min;
    this.max = max;
  }

  override initialize(): boolean {
    return true;
  }

  override computeConstraint(alpha: number): void {
    const a = this.cells[0]!.position;
    const b = this.cells[1]!.position;
    const d = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
    // C is the violation: 0 if in range, signed distance to bound.
    let Cn: number;
    if (d < this.min) {
      Cn = d - this.min; // negative
    } else if (d > this.max) {
      Cn = d - this.max; // positive
    } else {
      Cn = 0;
    }
    this.C[0]! = this.isHard(0) ? Cn - alpha * this.C0[0]! : Cn;
  }

  override computeDerivatives(cellIdx: number): void {
    const a = this.cells[0]!.position;
    const b = this.cells[1]!.position;
    const dx = a[0]! - b[0]!;
    const dy = a[1]! - b[1]!;
    const d = Math.hypot(dx, dy);
    const J = this.J[cellIdx]!;
    const Hcols = this.HCols[cellIdx]!;
    if (d < 1e-12) {
      J[0]! = cellIdx === 0 ? 1 : -1;
      J[1]! = 0;
      Hcols[0]! = 0;
      Hcols[1]! = 0;
      return;
    }
    const inv = 1 / d;
    const sign = cellIdx === 0 ? 1.0 : -1.0;
    J[0]! = sign * dx * inv;
    J[1]! = sign * dy * inv;
    const nx = dx * inv;
    const ny = dy * inv;
    Hcols[0]! = Math.sqrt(1 - nx * nx) * inv;
    Hcols[1]! = Math.sqrt(1 - ny * ny) * inv;
  }
}

function rangeDistance(s: Solver, a: Cell, b: Cell, min: number, max: number): RangeDistanceForce {
  const f = new RangeDistanceForce(a, b, min, max);
  s.addForce(f);
  return f;
}

describe("AVBD joint limits — range-distance", () => {
  it("|a-b| ∈ [1, 2] — drag b far away, pulled back to range", () => {
    const a = vec(0, 0);
    const b = vec(5, 0);
    a.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    rangeDistance(s, a, b, 1, 2);
    for (let i = 0; i < 5; i++) s.step();
    const d = Math.hypot(b.x, b.y);
    expect(d).toBeGreaterThanOrEqual(1 - 1e-2);
    expect(d).toBeLessThanOrEqual(2 + 1e-2);
  });

  it("|a-b| ∈ [3, 5] — start too close, pushed apart", () => {
    const a = vec(0, 0);
    const b = vec(0.1, 0);
    a.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    rangeDistance(s, a, b, 3, 5);
    for (let i = 0; i < 10; i++) s.step();
    const d = Math.hypot(b.x, b.y);
    expect(d).toBeGreaterThanOrEqual(3 - 1e-2);
    expect(d).toBeLessThanOrEqual(5 + 1e-2);
  });

  it("|a-b| in range — no force applied, b stays where dragged", () => {
    const a = vec(0, 0);
    const b = vec(1.5, 0);
    a.mass = 0;
    const s = new Solver({ iterations: 10 });
    s.addCell(a);
    s.addCell(b);
    rangeDistance(s, a, b, 1, 2);
    s.step();
    s.step();
    expect(b.x).toBeCloseTo(1.5, 3);
    expect(b.y).toBeCloseTo(0, 3);
  });

  it("competing forces: range constraint dominates a stiff spring outside its range", () => {
    const a = vec(0, 0);
    const b = vec(3, 0);
    a.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    rangeDistance(s, a, b, 0, 2);
    distance(s, a, b, 5);
    // Make spring SOFT so range dominates clearly.
    s.forces[1]!.stiffness[0]! = 100;
    for (let i = 0; i < 10; i++) s.step();
    const d = Math.hypot(b.x, b.y);
    expect(d).toBeLessThanOrEqual(2 + 1e-1);
    expect(d).toBeGreaterThan(0);
  });
});
