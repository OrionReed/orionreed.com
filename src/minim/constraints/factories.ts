// factories.ts — signal-aware constraint factories on `Cluster`.
//
// Each factory binds the passed `Signal`s through `cluster.bind(sig)`
// to obtain cell ids, constructs the corresponding `*Force`, and
// registers it with the solver. The runtime contract on every
// signal arg is "value class declares the `pack` trait"; this is
// checked dynamically by `bind`. We accept `Signal<any>` rather
// than a more typed `Signal<unknown>` because TS treats the
// `setter` slot as contravariant, which makes `Writable<Num>`
// unassignable to `Signal<unknown>`.
//
// Solver caveats worth remembering when authoring scenes:
//
// - **Multi-solution constraints can branch-flip.** Constraints
//   like `onCircle`, `distance`, `equalDist` admit multiple
//   geometrically valid configurations (a circle has two points
//   at any chord distance, two distance constraints can intersect
//   in two places). AVBD's local Newton + warm-start follows the
//   nearest basin of attraction frame-to-frame; under fast drags
//   that cross a critical point, the solver can jump to the
//   alternate solution. There's no branch-tracking layer here.
//
// - **Infeasible configurations saturate, not explode.** When a
//   cluster is dragged into a configuration where no constraint
//   set has a solution, the solver caps `λ` at `LAMBDA_MAX` and
//   the constraint applies its maximum allowable force. Positions
//   stay bounded (see force.ts header).
//
// - **Duplicate cells hurt.** If the same cell appears twice in a
//   `generic` factory's `cells` array (e.g. `[A, B, B, C]`), the
//   FD path treats the two slots as independent and the local
//   Newton LHS misses cross terms. Use `rightAngle(A, B, C)`
//   instead of `perpendicular(A, B, B, C)` and similar.

import type { Signal } from "../signals";
import { Cluster } from "./cluster";
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

export { Strength };

// biome-ignore lint/suspicious/noExplicitAny: Signal value type is checked at runtime via the pack trait
type S = Signal<any>;

// ─── Equalities, distances, springs ──────────────────────────────────

/** Hard equality `a = b`. Cell dims must match. */
export function eq(c: Cluster, a: S, b: S): EqForce {
  const f = new EqForce(c.solver, c.bind(a), c.bind(b));
  c.solver.addForce(f);
  return f;
}

/** Hard distance constraint `‖b − a‖ = rest`. */
export function distance(c: Cluster, a: S, b: S, rest: number): DistanceForce {
  const f = new DistanceForce(c.solver, c.bind(a), c.bind(b), rest);
  c.solver.addForce(f);
  return f;
}

/** Soft distance constraint with finite stiffness (Hooke spring). */
export function spring(c: Cluster, a: S, b: S, rest: number, stiffness: number): DistanceForce {
  const f = new DistanceForce(c.solver, c.bind(a), c.bind(b), rest, false, stiffness);
  c.solver.addForce(f);
  return f;
}

/** Scalar relation `b = fwd(a)` between two `Num` signals. The
 *  inverse is auto-derived via finite differences, so callers only
 *  need to supply the forward map. Useful when `fwd` is awkward to
 *  invert by hand (rational, polynomial, transcendental). */
export function lensNum(c: Cluster, a: S, b: S, fwd: (x: number) => number): LensNumForce {
  const f = new LensNumForce(c.solver, c.bind(a), c.bind(b), fwd);
  c.solver.addForce(f);
  return f;
}

// ─── Inequalities ────────────────────────────────────────────────────

/** Hard 1D range `lo ≤ x ≤ hi`. */
export function clamp(c: Cluster, x: S, lo: number, hi: number): BoundsForce {
  const f = new BoundsForce(c.solver, c.bind(x), lo, hi);
  c.solver.addForce(f);
  return f;
}

/** Hard minimum distance: `‖b − a‖ ≥ minDist`. Used for non-
 *  overlapping circles, body-body separation, etc. The constraint
 *  only ever pushes the points apart — it has no effect when they
 *  are already further than `minDist`. */
export function gap(c: Cluster, a: S, b: S, minDist: number): GenericForce {
  const f = generic(c, [a, b], 1, (pos, out) => {
    const dx = pos[1]![0]! - pos[0]![0]!;
    const dy = pos[1]![1]! - pos[0]![1]!;
    out[0]! = Math.hypot(dx, dy) - minDist;
  });
  f.fmax[0]! = 0;
  return f;
}

/** Soft long-range repulsion: pushes two points apart with force
 *  `stiffness · (range − ‖b − a‖)` while they're closer than
 *  `range`, dropping to zero outside. Inspired by Fruchterman–
 *  Reingold's `F_rep ∝ k²/d` term — the missing ingredient for
 *  graph-layout-style force-directed scenes, where `gap` only
 *  enforces a hard collision distance and leaves nothing to
 *  spread non-touching pairs apart. Use a large `range` (e.g.
 *  the canvas extent) and a small `stiffness` so the repulsion
 *  is gentle far away and ramps up as nodes crowd. */
export function repel(c: Cluster, a: S, b: S, range: number, stiffness: number): GenericForce {
  const f = generic(
    c,
    [a, b],
    1,
    (pos, out) => {
      const dx = pos[1]![0]! - pos[0]![0]!;
      const dy = pos[1]![1]! - pos[0]![1]!;
      out[0]! = Math.hypot(dx, dy) - range;
    },
    { hard: false, stiffness },
  );
  f.fmax[0]! = 0;
  return f;
}

/** Hard rectangular containment: keep a `Vec` inside the AABB
 *  `[xLo, xHi] × [yLo, yHi]`. Encoded as four one-sided inequalities
 *  so the constraint only acts when `P` is on the wrong side of
 *  a wall. */
export function inside(c: Cluster, P: S, xLo: number, yLo: number, xHi: number, yHi: number): GenericForce {
  const f = generic(c, [P], 4, (pos, out) => {
    const p = pos[0]!;
    out[0]! = p[0]! - xLo;
    out[1]! = xHi - p[0]!;
    out[2]! = p[1]! - yLo;
    out[3]! = yHi - p[1]!;
  });
  f.fmax[0]! = 0;
  f.fmax[1]! = 0;
  f.fmax[2]! = 0;
  f.fmax[3]! = 0;
  return f;
}

/** Hard inequality `a ≤ b` between two scalar cells. */
export function leq(c: Cluster, a: S, b: S): GenericForce {
  const f = generic(c, [a, b], 1, (pos, out) => {
    out[0]! = pos[1]![0]! - pos[0]![0]!;
  });
  f.fmax[0]! = 0;
  return f;
}

/** Hard inequality `a ≥ b`. */
export function geq(c: Cluster, a: S, b: S): GenericForce {
  return leq(c, b, a);
}

// ─── Soft target ─────────────────────────────────────────────────────

/** Pull `cell` toward `target` with finite stiffness. */
export function softTarget(c: Cluster, cell: S, target: ArrayLike<number>, stiffness: number): SoftTargetForce {
  const f = new SoftTargetForce(c.solver, c.bind(cell), target, stiffness);
  c.solver.addForce(f);
  return f;
}

// ─── General-purpose FD constraint ───────────────────────────────────

/** Custom constraint with `rows` residual outputs computed by `fn`.
 *  Jacobian and Hessian are auto-derived via central differences
 *  (`fdStep` defaults to 1e-6). The default is hard; pass
 *  `{ stiffness }` for a soft variant. */
export function generic(
  c: Cluster,
  cells: readonly S[],
  rows: number,
  fn: ResidualFn,
  opts?: { fdStep?: number; hard?: boolean; stiffness?: number },
): GenericForce {
  const f = new GenericForce(c.solver, cells.map(s => c.bind(s)), rows, fn, opts);
  c.solver.addForce(f);
  return f;
}

// ─── Sketchpad primitives via `generic` ──────────────────────────────

/** Interior angle ABC = θ. */
export function angle(c: Cluster, A: S, B: S, C: S, theta: number): GenericForce {
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

/** Lines AB ∥ CD: cross product of direction vectors = 0. */
export function parallel(c: Cluster, A: S, B: S, C: S, D: S): GenericForce {
  return generic(c, [A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!, b = pos[1]!, cc = pos[2]!, d = pos[3]!;
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!;
    const vx = d[0]! - cc[0]!, vy = d[1]! - cc[1]!;
    out[0]! = ux * vy - uy * vx;
  });
}

/** Lines AB ⟂ CD: dot product = 0. */
export function perpendicular(c: Cluster, A: S, B: S, C: S, D: S): GenericForce {
  return generic(c, [A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!, b = pos[1]!, cc = pos[2]!, d = pos[3]!;
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!;
    const vx = d[0]! - cc[0]!, vy = d[1]! - cc[1]!;
    out[0]! = ux * vx + uy * vy;
  });
}

/** Right angle at B between segments AB and BC. Pass B once; the
 *  generic FD path needs cells distinct (otherwise the local Newton
 *  LHS misses the cross-coupling between the duplicated cell's
 *  Jacobian columns). */
export function rightAngle(c: Cluster, A: S, B: S, C: S): GenericForce {
  return generic(c, [A, B, C], 1, (pos, out) => {
    const a = pos[0]!, b = pos[1]!, cc = pos[2]!;
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!;
    const vx = cc[0]! - b[0]!, vy = cc[1]! - b[1]!;
    out[0]! = ux * vx + uy * vy;
  });
}

/** Soft 3-point bending resistance at vertex B. Penalizes the cross
 *  product `(B − A) × (C − B)`, which is zero when A, B, C are
 *  collinear — so the constraint pulls toward a straight line through
 *  the three points (rest angle = π). The stiffness controls how
 *  cloth-like (low) versus paper-like (high) the structure feels.
 *  Used in cloth and rope sims to give bending resistance on top of
 *  edge-length springs. */
export function bend(c: Cluster, A: S, B: S, C: S, stiffness: number = Strength.MEDIUM): GenericForce {
  return generic(
    c,
    [A, B, C],
    1,
    (pos, out) => {
      const a = pos[0]!, b = pos[1]!, cc = pos[2]!;
      const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!;
      const vx = cc[0]! - b[0]!, vy = cc[1]! - b[1]!;
      out[0]! = ux * vy - uy * vx;
    },
    { hard: false, stiffness },
  );
}

/** Point P on line AB. */
export function collinear(c: Cluster, P: S, A: S, B: S): GenericForce {
  return generic(c, [P, A, B], 1, (pos, out) => {
    const p = pos[0]!, a = pos[1]!, b = pos[2]!;
    const ux = p[0]! - a[0]!, uy = p[1]! - a[1]!;
    const vx = b[0]! - a[0]!, vy = b[1]! - a[1]!;
    out[0]! = ux * vy - uy * vx;
  });
}

/** Point P on a circle of given center and radius. */
export function onCircle(c: Cluster, P: S, center: S, radius: number): GenericForce {
  return generic(c, [P, center], 1, (pos, out) => {
    const p = pos[0]!, cc = pos[1]!;
    const dx = p[0]! - cc[0]!, dy = p[1]! - cc[1]!;
    out[0]! = Math.hypot(dx, dy) - radius;
  });
}

/** Equal distance: ‖A − B‖ = ‖C − D‖. */
export function equalDist(c: Cluster, A: S, B: S, C: S, D: S): GenericForce {
  return generic(c, [A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!, b = pos[1]!, cc = pos[2]!, d = pos[3]!;
    const ab = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
    const cd = Math.hypot(cc[0]! - d[0]!, cc[1]! - d[1]!);
    out[0]! = ab - cd;
  });
}

/** Midpoint: M = (A + B) / 2. */
export function midpoint(c: Cluster, M: S, A: S, B: S): GenericForce {
  return generic(c, [M, A, B], 2, (pos, out) => {
    const m = pos[0]!, a = pos[1]!, b = pos[2]!;
    out[0]! = 2 * m[0]! - a[0]! - b[0]!;
    out[1]! = 2 * m[1]! - a[1]! - b[1]!;
  });
}
