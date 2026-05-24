// factories.ts — free constraint factories that return `Relation` values.
//
// Each factory is a free function that constructs a `Relation` —
// plain data + an attach/detach lifecycle. Pass them to a cluster
// via `c.add(rel)`:
//
//   const c = constraints({ iterations: 24 });
//   c.add(distance(a, b, 100));
//   const [r1, r2] = c.add(spring(b, c, 60, 200), gap(a, c, 30));
//
// Mutable parameters: factories that take a numeric arg also accept
// a `Signal<number>`. Either form gives a relation whose underlying
// param can be mutated reactively — the cluster's settle re-fires
// on parameter changes and the inner solve picks up the new value:
//
//   const len = signal(100);
//   const r = c.add(distance(a, b, len));
//   len.value = 50;        // ← re-solves with new rest length
//   r.rest = 75;           // ← also works (writes to the same signal)
//
// The runtime contract on every cell-signal arg is "value class
// declares the `pack` trait"; this is checked by `c._bind` when the
// relation is attached. We accept `Signal<any>` rather than a more
// typed `Signal<unknown>` because TS treats the `setter` slot as
// contravariant, which makes `Writable<Num>` unassignable to
// `Signal<unknown>`.
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

import { type Signal } from "../signals";
import { param } from "../signals/settle-utils";
import {
  type Constraints,
  defineRelation,
  type Relation,
} from "./cluster";
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
export function eq(a: S, b: S): Relation {
  return defineRelation([a, b], c => {
    const f = new EqForce(c.solver, c._bind(a), c._bind(b));
    c.solver.addForce(f);
    return f;
  });
}

/** Hard distance constraint `‖b − a‖ = rest`. The returned relation
 *  exposes a mutable `rest` (number or signal) — write `r.rest = 50`
 *  or pass a `Signal<number>` and mutate that. */
export interface DistanceRelation extends Relation {
  /** Current rest length. Writes propagate to the underlying signal,
   *  triggering the next solve in the normal reactive flow. */
  rest: number;
  /** The underlying rest-length signal — for binding to UI controls
   *  or composing with derived signals. */
  readonly restSignal: Signal<number>;
}

export function distance(a: S, b: S, rest: number | Signal<number>): DistanceRelation {
  const restSig = param(rest);
  let force: DistanceForce | undefined;
  return {
    members: [a as S, b as S, restSig as S],
    get rest() {
      return restSig.value;
    },
    set rest(v: number) {
      restSig.value = v;
    },
    restSignal: restSig,
    attach(c) {
      force = new DistanceForce(c.solver, c._bind(a), c._bind(b), restSig);
      c.solver.addForce(force);
    },
    detach(c) {
      if (force !== undefined) {
        c.solver.removeForce(force);
        force = undefined;
      }
    },
  };
}

/** Soft distance constraint with finite stiffness (Hooke spring).
 *  Same mutable-`rest` shape as `distance`. */
export interface SpringRelation extends DistanceRelation {}

export function spring(
  a: S,
  b: S,
  rest: number | Signal<number>,
  stiffness: number,
): SpringRelation {
  const restSig = param(rest);
  let force: DistanceForce | undefined;
  return {
    members: [a as S, b as S, restSig as S],
    get rest() {
      return restSig.value;
    },
    set rest(v: number) {
      restSig.value = v;
    },
    restSignal: restSig,
    attach(c) {
      force = new DistanceForce(c.solver, c._bind(a), c._bind(b), restSig, false, stiffness);
      c.solver.addForce(force);
    },
    detach(c) {
      if (force !== undefined) {
        c.solver.removeForce(force);
        force = undefined;
      }
    },
  };
}

/** Scalar relation `b = fwd(a)` between two `Num` signals. */
export function lensNum(a: S, b: S, fwd: (x: number) => number): Relation {
  return defineRelation([a, b], c => {
    const f = new LensNumForce(c.solver, c._bind(a), c._bind(b), fwd);
    c.solver.addForce(f);
    return f;
  });
}

// ─── Inequalities ────────────────────────────────────────────────────

/** Hard 1D range `lo ≤ x ≤ hi`. Both bounds are mutable via the
 *  returned relation's `lo` / `hi` setters or via passed signals. */
export interface BoundsRelation extends Relation {
  lo: number;
  hi: number;
  readonly loSignal: Signal<number>;
  readonly hiSignal: Signal<number>;
}

export function clamp(
  x: S,
  lo: number | Signal<number>,
  hi: number | Signal<number>,
): BoundsRelation {
  const loSig = param(lo);
  const hiSig = param(hi);
  let force: BoundsForce | undefined;
  return {
    members: [x as S, loSig as S, hiSig as S],
    get lo() {
      return loSig.value;
    },
    set lo(v: number) {
      loSig.value = v;
    },
    get hi() {
      return hiSig.value;
    },
    set hi(v: number) {
      hiSig.value = v;
    },
    loSignal: loSig,
    hiSignal: hiSig,
    attach(c) {
      force = new BoundsForce(c.solver, c._bind(x), loSig, hiSig);
      c.solver.addForce(force);
    },
    detach(c) {
      if (force !== undefined) {
        c.solver.removeForce(force);
        force = undefined;
      }
    },
  };
}

/** Hard minimum distance: `‖b − a‖ ≥ minDist`. Used for non-overlapping
 *  circles, body-body separation, etc. */
export function gap(a: S, b: S, minDist: number): Relation {
  return generic(
    [a, b],
    1,
    (pos, out) => {
      const dx = pos[1]![0]! - pos[0]![0]!;
      const dy = pos[1]![1]! - pos[0]![1]!;
      out[0]! = Math.hypot(dx, dy) - minDist;
    },
    { fmax: [0] },
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
    { hard: false, stiffness, fmax: [0] },
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
    { fmax: [0, 0, 0, 0] },
  );
}

/** Hard inequality `a ≤ b` between two scalar cells. */
export function leq(a: S, b: S): Relation {
  return generic(
    [a, b],
    1,
    (pos, out) => {
      out[0]! = pos[1]![0]! - pos[0]![0]!;
    },
    { fmax: [0] },
  );
}

/** Hard inequality `a ≥ b`. */
export function geq(a: S, b: S): Relation {
  return leq(b, a);
}

// ─── Soft target ─────────────────────────────────────────────────────

/** Pull `cell` toward `target` with finite stiffness. */
export function softTarget(cell: S, target: ArrayLike<number>, stiffness: number): Relation {
  return defineRelation([cell], c => {
    const f = new SoftTargetForce(c.solver, c._bind(cell), target, stiffness);
    c.solver.addForce(f);
    return f;
  });
}

// ─── General-purpose FD constraint ───────────────────────────────────

/** Custom constraint with `rows` residual outputs computed by `fn`. */
export function generic(
  cells: readonly S[],
  rows: number,
  fn: ResidualFn,
  opts?: { fdStep?: number; hard?: boolean; stiffness?: number; fmax?: readonly number[] },
): Relation {
  return defineRelation(cells, c => {
    const f = new GenericForce(
      c.solver,
      cells.map(s => c._bind(s)),
      rows,
      fn,
      opts,
    );
    c.solver.addForce(f);
    if (opts?.fmax) {
      for (let i = 0; i < opts.fmax.length && i < rows; i++) {
        f.fmax[i]! = opts.fmax[i]!;
      }
    }
    return f;
  });
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

/** Soft 3-point bending resistance at vertex B (cross product
 *  toward zero ⇒ A, B, C collinear). */
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
