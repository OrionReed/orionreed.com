// factories.ts — free constraint factories that return `Relation` values.
//
// Each factory returns a plain object with a `bind(c)` method (returns
// a disposer) and any number of `Signal` fields exposing mutable
// parameters. Pass them to a cluster via `c.add(rel)`:
//
//   const c = constraints({ iterations: 24 });
//   c.add(distance(a, b, 100));
//   const [r1, r2] = c.add(spring(b, c, 60, 200), gap(a, c, 30));
//
// Mutable parameters are exposed as `Signal<number>` fields directly
// (e.g. `r.rest.value = 50`). Either pass a number (wrapped in a
// fresh signal) or your own signal (used directly so external
// mutations and UI bindings flow through):
//
//   const len = signal(100);
//   const r = c.add(distance(a, b, len));
//   len.value = 50;        // ← re-solves with new rest length
//   r.rest.value = 75;     // ← also works (same underlying signal)
//
// The runtime contract on every cell-signal arg is "value class
// declares the `pack` trait"; checked by `c._bind` when bind runs.
//
// Solver caveats:
//
// - **Multi-solution constraints can branch-flip** under fast drags
//   that cross critical points (no branch tracking).
// - **Infeasible configurations saturate, not explode** (`λ` capped
//   at `LAMBDA_MAX`).
// - **Duplicate cells hurt** in `generic` (e.g. `[A, B, B, C]`):
//   the FD path treats duplicated slots as independent. Use
//   `rightAngle(A, B, C)` instead of `perpendicular(A, B, B, C)`.

import { type Signal, type Writable } from "../signals";
import { param } from "../signals/settle-utils";
import { type Constraints, type Relation } from "./cluster";
import {
  BoundsTerm,
  DistanceTerm,
  EqTerm,
  GenericTerm,
  LensNumTerm,
  type ResidualFn,
  SoftTargetTerm,
  Strength,
} from "./terms";

export { Strength };

// biome-ignore lint/suspicious/noExplicitAny: Signal value type is checked at runtime via the pack trait
type S = Signal<any>;

// ─── Pin (the only "structural" relation) ────────────────────────────

/** Pin a signal in place: while attached, its solver cell has mass 0
 *  (kinematic). Removing the relation restores the prior mass.
 *
 *    c.add(pin(O1));                       // static pin
 *    c.addWhile(h.dragging, pin(sig));     // conditional pin */
export function pin(sig: S): Relation {
  return {
    bind(c: Constraints) {
      const id = c._bind(sig);
      const prev = c.solver.massOf(id);
      c.solver.setMass(id, 0);
      return () => c.solver.setMass(id, prev);
    },
  };
}

// ─── Equalities, distances, springs ──────────────────────────────────

/** Hard equality `a = b`. Cell dims must match. */
export function eq(a: S, b: S): Relation {
  return {
    bind(c) {
      const f = new EqTerm(c.solver, c._bind(a), c._bind(b));
      c.solver.addTerm(f);
      return () => c.solver.removeTerm(f);
    },
  };
}

/** Distance constraint `‖b − a‖ = rest`.
 *
 *  Default is HARD (augmented-Lagrangian); pass `stiffness` for a
 *  soft variant — the constraint becomes a Hooke spring with finite
 *  stiffness. Both `rest` and `stiffness` are mutable signals on
 *  the returned relation:
 *
 *    c.add(distance(a, b, 100));                           // hard
 *    const r = c.add(distance(a, b, 100, { stiffness: 200 })); // spring
 *    r.rest.value = 80;                                    // mutate length
 *    r.stiffness?.value = 500;                             // mutate stiffness */
export interface DistanceRelation extends Relation {
  readonly rest: Writable<Signal<number>>;
  /** Only present when the constraint was created with finite
   *  stiffness (i.e., as a spring). */
  readonly stiffness?: Writable<Signal<number>>;
}

export function distance(
  a: S,
  b: S,
  rest: number | Writable<Signal<number>>,
  opts?: { stiffness?: number | Writable<Signal<number>> },
): DistanceRelation {
  const rest_ = param(rest);
  const hard = opts?.stiffness === undefined;
  const stiff_ = hard ? undefined : param(opts.stiffness!);
  return {
    rest: rest_,
    stiffness: stiff_,
    bind(c) {
      const f = new DistanceTerm(c.solver, c._bind(a), c._bind(b), rest_, hard, stiff_);
      c.solver.addTerm(f);
      return () => c.solver.removeTerm(f);
    },
  };
}

/** Soft distance constraint — alias for `distance(a, b, rest, { stiffness })`. */
export function spring(
  a: S,
  b: S,
  rest: number | Writable<Signal<number>>,
  stiffness: number | Writable<Signal<number>>,
): DistanceRelation {
  return distance(a, b, rest, { stiffness });
}

/** Scalar relation `b = fwd(a)` between two `Num` signals. */
export function lensNum(a: S, b: S, fwd: (x: number) => number): Relation {
  return {
    bind(c) {
      const f = new LensNumTerm(c.solver, c._bind(a), c._bind(b), fwd);
      c.solver.addTerm(f);
      return () => c.solver.removeTerm(f);
    },
  };
}

// ─── Inequalities ────────────────────────────────────────────────────

/** Hard 1D range `lo ≤ x ≤ hi`. `r.lo` / `r.hi` are mutable signals. */
export function clamp(
  x: S,
  lo: number | Writable<Signal<number>>,
  hi: number | Writable<Signal<number>>,
): Relation & { lo: Writable<Signal<number>>; hi: Writable<Signal<number>> } {
  const lo_ = param(lo);
  const hi_ = param(hi);
  return {
    lo: lo_,
    hi: hi_,
    bind(c) {
      const f = new BoundsTerm(c.solver, c._bind(x), lo_, hi_);
      c.solver.addTerm(f);
      return () => c.solver.removeTerm(f);
    },
  };
}

/** Hard minimum distance: `‖b − a‖ ≥ minDist`. */
export function gap(a: S, b: S, minDist: number): Relation {
  return generic(
    [a, b],
    1,
    (pos, out) => {
      const dx = pos[1]![0]! - pos[0]![0]!;
      const dy = pos[1]![1]! - pos[0]![1]!;
      out[0]! = Math.hypot(dx, dy) - minDist;
    },
    { lambdaMax: [0] },
  );
}

/** Soft long-range repulsion: pushes two points apart with force
 *  `stiffness · (range − ‖b − a‖)` while they're closer than `range`,
 *  dropping to zero outside. */
export function repel(a: S, b: S, range: number, stiffness: number): Relation {
  return generic(
    [a, b],
    1,
    (pos, out) => {
      const dx = pos[1]![0]! - pos[0]![0]!;
      const dy = pos[1]![1]! - pos[0]![1]!;
      out[0]! = Math.hypot(dx, dy) - range;
    },
    { hard: false, stiffness, lambdaMax: [0] },
  );
}

/** Hard rectangular containment: keep a `Vec` inside the AABB
 *  `[xLo, xHi] × [yLo, yHi]`. */
export function inside(P: S, xLo: number, yLo: number, xHi: number, yHi: number): Relation {
  return generic(
    [P],
    4,
    (pos, out) => {
      const p = pos[0]!;
      out[0]! = p[0]! - xLo;
      out[1]! = xHi - p[0]!;
      out[2]! = p[1]! - yLo;
      out[3]! = yHi - p[1]!;
    },
    { lambdaMax: [0, 0, 0, 0] },
  );
}

/** Hard inequality `a ≤ b`. */
export function leq(a: S, b: S): Relation {
  return generic(
    [a, b],
    1,
    (pos, out) => {
      out[0]! = pos[1]![0]! - pos[0]![0]!;
    },
    { lambdaMax: [0] },
  );
}

/** Hard inequality `a ≥ b`. */
export function geq(a: S, b: S): Relation {
  return leq(b, a);
}

// ─── Soft target ─────────────────────────────────────────────────────

/** Pull `cell` toward `target` with finite stiffness. */
export function softTarget(cell: S, target: ArrayLike<number>, stiffness: number): Relation {
  return {
    bind(c) {
      const f = new SoftTargetTerm(c.solver, c._bind(cell), target, stiffness);
      c.solver.addTerm(f);
      return () => c.solver.removeTerm(f);
    },
  };
}

// ─── General-purpose FD constraint ───────────────────────────────────

/** Custom constraint with `rows` residual outputs computed by `fn`. */
export function generic(
  cells: readonly S[],
  rows: number,
  fn: ResidualFn,
  opts?: { fdStep?: number; hard?: boolean; stiffness?: number; lambdaMax?: readonly number[] },
): Relation {
  return {
    bind(c) {
      const f = new GenericTerm(
        c.solver,
        cells.map(s => c._bind(s)),
        rows,
        fn,
        opts,
      );
      c.solver.addTerm(f);
      if (opts?.lambdaMax) {
        for (let i = 0; i < opts.lambdaMax.length && i < rows; i++) {
          f.lambdaMax[i]! = opts.lambdaMax[i]!;
        }
      }
      return () => c.solver.removeTerm(f);
    },
  };
}

// ─── Sketchpad primitives via `generic` ──────────────────────────────

/** Interior angle ABC = θ. */
export function angle(A: S, B: S, C: S, theta: number): Relation {
  return generic([A, B, C], 1, (pos, out) => {
    const a = pos[0]!,
      b = pos[1]!,
      cc = pos[2]!;
    const ux = a[0]! - b[0]!,
      uy = a[1]! - b[1]!;
    const vx = cc[0]! - b[0]!,
      vy = cc[1]! - b[1]!;
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
export function parallel(A: S, B: S, C: S, D: S): Relation {
  return generic([A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!,
      b = pos[1]!,
      cc = pos[2]!,
      d = pos[3]!;
    const ux = b[0]! - a[0]!,
      uy = b[1]! - a[1]!;
    const vx = d[0]! - cc[0]!,
      vy = d[1]! - cc[1]!;
    out[0]! = ux * vy - uy * vx;
  });
}

/** Lines AB ⟂ CD: dot product = 0. */
export function perpendicular(A: S, B: S, C: S, D: S): Relation {
  return generic([A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!,
      b = pos[1]!,
      cc = pos[2]!,
      d = pos[3]!;
    const ux = b[0]! - a[0]!,
      uy = b[1]! - a[1]!;
    const vx = d[0]! - cc[0]!,
      vy = d[1]! - cc[1]!;
    out[0]! = ux * vx + uy * vy;
  });
}

/** Right angle at B between segments AB and BC. */
export function rightAngle(A: S, B: S, C: S): Relation {
  return generic([A, B, C], 1, (pos, out) => {
    const a = pos[0]!,
      b = pos[1]!,
      cc = pos[2]!;
    const ux = b[0]! - a[0]!,
      uy = b[1]! - a[1]!;
    const vx = cc[0]! - b[0]!,
      vy = cc[1]! - b[1]!;
    out[0]! = ux * vx + uy * vy;
  });
}

/** Soft 3-point bending resistance at vertex B. */
export function bend(A: S, B: S, C: S, stiffness: number = Strength.MEDIUM): Relation {
  return generic(
    [A, B, C],
    1,
    (pos, out) => {
      const a = pos[0]!,
        b = pos[1]!,
        cc = pos[2]!;
      const ux = b[0]! - a[0]!,
        uy = b[1]! - a[1]!;
      const vx = cc[0]! - b[0]!,
        vy = cc[1]! - b[1]!;
      out[0]! = ux * vy - uy * vx;
    },
    { hard: false, stiffness },
  );
}

/** Point P on line AB. */
export function collinear(P: S, A: S, B: S): Relation {
  return generic([P, A, B], 1, (pos, out) => {
    const p = pos[0]!,
      a = pos[1]!,
      b = pos[2]!;
    const ux = p[0]! - a[0]!,
      uy = p[1]! - a[1]!;
    const vx = b[0]! - a[0]!,
      vy = b[1]! - a[1]!;
    out[0]! = ux * vy - uy * vx;
  });
}

/** Point P on a circle of given center and radius. */
export function onCircle(P: S, center: S, radius: number): Relation {
  return generic([P, center], 1, (pos, out) => {
    const p = pos[0]!,
      cc = pos[1]!;
    const dx = p[0]! - cc[0]!,
      dy = p[1]! - cc[1]!;
    out[0]! = Math.hypot(dx, dy) - radius;
  });
}

/** Equal distance: ‖A − B‖ = ‖C − D‖. */
export function equalDist(A: S, B: S, C: S, D: S): Relation {
  return generic([A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!,
      b = pos[1]!,
      cc = pos[2]!,
      d = pos[3]!;
    const ab = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
    const cd = Math.hypot(cc[0]! - d[0]!, cc[1]! - d[1]!);
    out[0]! = ab - cd;
  });
}

/** Midpoint: M = (A + B) / 2. */
export function midpoint(M: S, A: S, B: S): Relation {
  return generic([M, A, B], 2, (pos, out) => {
    const m = pos[0]!,
      a = pos[1]!,
      b = pos[2]!;
    out[0]! = 2 * m[0]! - a[0]! - b[0]!;
    out[1]! = 2 * m[1]! - a[1]! - b[1]!;
  });
}
