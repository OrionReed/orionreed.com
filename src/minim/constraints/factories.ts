// constraints.ts — signal-aware factories on `Cluster`, reusing
// the AVBD solver's `Force` subclasses. Each factory binds the
// passed `Signal`s through `cluster.bind(sig)` to obtain cell
// ids, constructs the `*Force`, and registers it with the solver.

import {
  BoundsForce,
  DistanceForce,
  EqForce,
  GenericForce,
  LensNumForce,
  type ResidualFn,
  SoftTargetForce,
  Strength,
} from "./forces";
import type { Signal } from "../signals";
import { Cluster } from "./cluster";

export { Strength };

// biome-ignore lint/suspicious/noExplicitAny: variance escape; runtime contract is "Signal carrying pack trait"
export type Bindable = Signal<any>;

export function eq(c: Cluster, a: Bindable, b: Bindable): EqForce {
  const f = new EqForce(c.solver, c.bind(a), c.bind(b));
  c.solver.addForce(f);
  return f;
}

export function distance(c: Cluster, a: Bindable, b: Bindable, rest: number): DistanceForce {
  const f = new DistanceForce(c.solver, c.bind(a), c.bind(b), rest);
  c.solver.addForce(f);
  return f;
}

export function spring(
  c: Cluster,
  a: Bindable,
  b: Bindable,
  rest: number,
  stiffness: number,
): DistanceForce {
  const f = new DistanceForce(c.solver, c.bind(a), c.bind(b), rest, false, stiffness);
  c.solver.addForce(f);
  return f;
}

export function lensNum(
  c: Cluster,
  a: Bindable,
  b: Bindable,
  fwd: (x: number) => number,
): LensNumForce {
  const f = new LensNumForce(c.solver, c.bind(a), c.bind(b), fwd);
  c.solver.addForce(f);
  return f;
}

export function clamp(c: Cluster, x: Bindable, lo: number, hi: number): BoundsForce {
  const f = new BoundsForce(c.solver, c.bind(x), lo, hi);
  c.solver.addForce(f);
  return f;
}

export function leq(c: Cluster, a: Bindable, b: Bindable): GenericForce {
  const f = generic(c, [a, b], 1, (pos, out) => {
    out[0]! = pos[1]![0]! - pos[0]![0]!;
  });
  f.fmax[0]! = 0;
  return f;
}

export function geq(c: Cluster, a: Bindable, b: Bindable): GenericForce {
  return leq(c, b, a);
}

export function softTarget(
  c: Cluster,
  cell: Bindable,
  target: ArrayLike<number>,
  stiffness: number,
): SoftTargetForce {
  const f = new SoftTargetForce(c.solver, c.bind(cell), target, stiffness);
  c.solver.addForce(f);
  return f;
}

export function generic(
  c: Cluster,
  cells: readonly Bindable[],
  rows: number,
  fn: ResidualFn,
  opts?: { fdStep?: number; hard?: boolean; stiffness?: number },
): GenericForce {
  const f = new GenericForce(c.solver, cells.map(s => c.bind(s)), rows, fn, opts);
  c.solver.addForce(f);
  return f;
}

/** Synonym for `clamp`. */
export function bounded(c: Cluster, x: Bindable, lo: number, hi: number): BoundsForce {
  return clamp(c, x, lo, hi);
}

// ─── Sketchpad primitives via `generic` ──────────────────────────────

export function angle(c: Cluster, A: Bindable, B: Bindable, C: Bindable, theta: number): GenericForce {
  return generic(c, [A, B, C], 1, (pos, out) => {
    const a = pos[0]!, b = pos[1]!, cc = pos[2]!;
    const ux = a[0]! - b[0]!, uy = a[1]! - b[1]!;
    const vx = cc[0]! - b[0]!, vy = cc[1]! - b[1]!;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-12 || lv < 1e-12) {
      out[0]! = 0;
      return;
    }
    const cosA = (ux * vx + uy * vy) / (lu * lv);
    const cur = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
    out[0]! = cur - theta;
  });
}

export function parallel(c: Cluster, A: Bindable, B: Bindable, C: Bindable, D: Bindable): GenericForce {
  return generic(c, [A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!, b = pos[1]!, cc = pos[2]!, d = pos[3]!;
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!;
    const vx = d[0]! - cc[0]!, vy = d[1]! - cc[1]!;
    out[0]! = ux * vy - uy * vx;
  });
}

export function perpendicular(c: Cluster, A: Bindable, B: Bindable, C: Bindable, D: Bindable): GenericForce {
  return generic(c, [A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!, b = pos[1]!, cc = pos[2]!, d = pos[3]!;
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!;
    const vx = d[0]! - cc[0]!, vy = d[1]! - cc[1]!;
    out[0]! = ux * vx + uy * vy;
  });
}

export function collinear(c: Cluster, P: Bindable, A: Bindable, B: Bindable): GenericForce {
  return generic(c, [P, A, B], 1, (pos, out) => {
    const p = pos[0]!, a = pos[1]!, b = pos[2]!;
    const ux = p[0]! - a[0]!, uy = p[1]! - a[1]!;
    const vx = b[0]! - a[0]!, vy = b[1]! - a[1]!;
    out[0]! = ux * vy - uy * vx;
  });
}

export function onCircle(c: Cluster, P: Bindable, center: Bindable, radius: number): GenericForce {
  return generic(c, [P, center], 1, (pos, out) => {
    const p = pos[0]!, cc = pos[1]!;
    const dx = p[0]! - cc[0]!, dy = p[1]! - cc[1]!;
    out[0]! = Math.hypot(dx, dy) - radius;
  });
}

export function equalDist(c: Cluster, A: Bindable, B: Bindable, C: Bindable, D: Bindable): GenericForce {
  return generic(c, [A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!, b = pos[1]!, cc = pos[2]!, d = pos[3]!;
    const ab = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
    const cd = Math.hypot(cc[0]! - d[0]!, cc[1]! - d[1]!);
    out[0]! = ab - cd;
  });
}

export function midpoint(c: Cluster, M: Bindable, A: Bindable, B: Bindable): GenericForce {
  return generic(c, [M, A, B], 2, (pos, out) => {
    const m = pos[0]!, a = pos[1]!, b = pos[2]!;
    out[0]! = 2 * m[0]! - a[0]! - b[0]!;
    out[1]! = 2 * m[1]! - a[1]! - b[1]!;
  });
}
