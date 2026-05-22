// constraints.ts — Sketchpad-style geometric primitive library.
//
// Each factory returns a `Relation` over the cells you pass in. Relations
// sharing cells form one cluster automatically (via union-find in
// `relate.ts`), so composing them is just calling more factories — no
// declarations of cluster membership, no explicit wiring.
//
// All primitives target writable `Num` cells. For 2D points pass two
// Nums (x, y). The `point()` helper bundles two Nums into a {x, y}
// record for ergonomic call sites; `pin()` / `unpin()` set / clear
// "this cell is held fixed" persistently (vs the per-batch user-pin
// the runtime tracks automatically).
//
// Building blocks:
//   - `eq(a, b)`              — a = b (constant link)
//   - `dist(P, Q, L)`         — |PQ| = L
//   - `equalDist(P,Q, R,S)`   — |PQ| = |RS|
//   - `midpoint(M, A, B)`     — M = (A+B) / 2
//   - `onCircle(P, c, r)`     — |P - c| = r
//   - `onLine(P, A, B)`       — P collinear with A,B
//   - `parallel(AB, CD)`      — AB ∥ CD
//   - `perpendicular(AB,CD)`  — AB ⊥ CD
//   - `angle(A, B, C, θ)`     — interior ∠ABC = θ
//   - `reflectThrough(P', P, A, B)` — P' = reflection of P through line AB
//
// And soft (`encourage`) variants:
//   - `near(P, Q, w)`         — soft nearness with weight w (residual
//                                added to system's least-squares fit)

import { Signal, type Val, valFn, type WritableBrand } from "./signal";
import { hardPin, relate, type Relation } from "./relate";

// ─── Point sugar ─────────────────────────────────────────────────────

export interface Point {
  readonly x: Signal<number> & WritableBrand;
  readonly y: Signal<number> & WritableBrand;
}

/** Bundle two Nums as a Point for ergonomic constraint calls. The
 *  bundle is purely a tuple — no engine identity, no extra cells. */
export function point(
  x: Signal<number> & WritableBrand,
  y: Signal<number> & WritableBrand,
): Point {
  return { x, y };
}

// ─── Helpers ─────────────────────────────────────────────────────────

const TINY = 1e-12;

/** Resolve a `Val<number>` once — used for length/radius parameters
 *  where the value can be a literal, a thunk, or a reactive signal.
 *  The closure is captured at construction; inside the residual, we
 *  dereference per call so reactive parameters work as expected. */
function num(v: Val<number>): () => number {
  return valFn(v);
}

// ─── Primitives ──────────────────────────────────────────────────────

/** Equality: `a = b`. The simplest possible constraint. */
export function eq(a: Point["x"], b: Point["x"]): Relation {
  return relate({
    name: "eq",
    cells: [a, b],
    residual: ([x, y], out) => {
      out[0] = x! - y!;
    },
    m: 1,
  });
}

/** Distance: `|PQ| = L`. `L` may be a literal, a thunk, or a Num
 *  signal. When `L` is a Num, it joins the cluster and writes to it
 *  (e.g. dragging the length) trigger re-solve. Literal/thunk
 *  parameters are captured by closure and won't trigger re-solve when
 *  their backing signals change — this is by design for static
 *  parameters; promote to a Num cell if you want reactive change. */
export function dist(P: Point, Q: Point, L: Val<number>): Relation {
  if (L instanceof Signal) {
    const lc = L as Signal<number> & WritableBrand;
    return relate({
      name: "dist",
      cells: [P.x, P.y, Q.x, Q.y, lc],
      residual: ([px, py, qx, qy, l], out) => {
        out[0] = Math.hypot(px! - qx!, py! - qy!) - l!;
      },
      m: 1,
    });
  }
  const Lf = num(L);
  return relate({
    name: "dist",
    cells: [P.x, P.y, Q.x, Q.y],
    residual: ([px, py, qx, qy], out) => {
      out[0] = Math.hypot(px! - qx!, py! - qy!) - Lf();
    },
    m: 1,
  });
}

/** Equal distances: `|PQ| = |RS|`. No fixed length — the two segments
 *  match each other but their common length is free. */
export function equalDist(P: Point, Q: Point, R: Point, S: Point): Relation {
  return relate({
    name: "equalDist",
    cells: [P.x, P.y, Q.x, Q.y, R.x, R.y, S.x, S.y],
    residual: ([px, py, qx, qy, rx, ry, sx, sy], out) => {
      out[0] = Math.hypot(px! - qx!, py! - qy!) - Math.hypot(rx! - sx!, ry! - sy!);
    },
    m: 1,
  });
}

/** Midpoint: `M = (A + B) / 2`. Fully determined when A and B are
 *  pinned; under-determined (one DOF along AB) when M is pinned. The
 *  solver picks the closest valid (A, B) to current values in that
 *  case — equivalent to "drag M and have A, B follow rigidly." */
export function midpoint(M: Point, A: Point, B: Point): Relation {
  return relate({
    name: "midpoint",
    cells: [M.x, M.y, A.x, A.y, B.x, B.y],
    residual: ([mx, my, ax, ay, bx, by], out) => {
      out[0] = 2 * mx! - (ax! + bx!);
      out[1] = 2 * my! - (ay! + by!);
    },
    m: 2,
  });
}

/** Centroid of N points: `C = (P₁ + … + Pₙ) / N`. */
export function centroid(C: Point, ...pts: Point[]): Relation {
  const cells = [C.x, C.y, ...pts.flatMap(p => [p.x, p.y])];
  const n = pts.length;
  return relate({
    name: "centroid",
    cells,
    residual: (xs, out) => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        sx += xs[2 + i * 2]!;
        sy += xs[2 + i * 2 + 1]!;
      }
      out[0] = n * xs[0]! - sx;
      out[1] = n * xs[1]! - sy;
    },
    m: 2,
  });
}

/** P lies on the circle of radius `r` centred at `c`: `|P − c| = r`. */
export function onCircle(P: Point, c: Point, r: Val<number>): Relation {
  const rf = num(r);
  return relate({
    name: "onCircle",
    cells: [P.x, P.y, c.x, c.y],
    residual: ([px, py, cx, cy], out) => {
      out[0] = Math.hypot(px! - cx!, py! - cy!) - rf();
    },
    m: 1,
  });
}

/** P lies on the line through A and B: `(P-A) × (B-A) = 0`. */
export function onLine(P: Point, A: Point, B: Point): Relation {
  return relate({
    name: "onLine",
    cells: [P.x, P.y, A.x, A.y, B.x, B.y],
    residual: ([px, py, ax, ay, bx, by], out) => {
      // 2D cross product: (P-A) × (B-A) = (px-ax)*(by-ay) - (py-ay)*(bx-ax)
      out[0] = (px! - ax!) * (by! - ay!) - (py! - ay!) * (bx! - ax!);
    },
    m: 1,
  });
}

/** AB ∥ CD: 2D cross product of direction vectors equals zero. */
export function parallel(A: Point, B: Point, C: Point, D: Point): Relation {
  return relate({
    name: "parallel",
    cells: [A.x, A.y, B.x, B.y, C.x, C.y, D.x, D.y],
    residual: ([ax, ay, bx, by, cx, cy, dx, dy], out) => {
      out[0] = (bx! - ax!) * (dy! - cy!) - (by! - ay!) * (dx! - cx!);
    },
    m: 1,
  });
}

/** AB ⊥ CD: dot product of direction vectors equals zero. */
export function perpendicular(A: Point, B: Point, C: Point, D: Point): Relation {
  return relate({
    name: "perpendicular",
    cells: [A.x, A.y, B.x, B.y, C.x, C.y, D.x, D.y],
    residual: ([ax, ay, bx, by, cx, cy, dx, dy], out) => {
      out[0] = (bx! - ax!) * (dx! - cx!) + (by! - ay!) * (dy! - cy!);
    },
    m: 1,
  });
}

/** Interior angle ∠ABC equals θ. Numerically stable for non-degenerate
 *  triangles (|AB|, |BC| > 0). */
export function angle(A: Point, B: Point, C: Point, theta: Val<number>): Relation {
  const tf = num(theta);
  return relate({
    name: "angle",
    cells: [A.x, A.y, B.x, B.y, C.x, C.y],
    residual: ([ax, ay, bx, by, cx, cy], out) => {
      const ux = ax! - bx!;
      const uy = ay! - by!;
      const vx = cx! - bx!;
      const vy = cy! - by!;
      const lu = Math.hypot(ux, uy);
      const lv = Math.hypot(vx, vy);
      if (lu < TINY || lv < TINY) {
        out[0] = 0;
        return;
      }
      const cos = (ux * vx + uy * vy) / (lu * lv);
      // Clamp for numerical stability around ±1.
      const c = cos > 1 ? 1 : cos < -1 ? -1 : cos;
      out[0] = Math.acos(c) - tf();
    },
    m: 1,
  });
}

/** P' = reflection of P across the line through A, B. Concretely:
 *  P' = P + 2·((A-P) · n̂) · n̂ where n̂ is the unit normal to AB.
 *  Implemented as: vector from P to its projection onto AB equals
 *  vector from P' to its projection onto AB, mirrored.
 *
 *  Equivalent residuals:
 *    R₀ = (P+P')·(B-A)/2 - A·(B-A) — midpoint-of(P, P') is on AB
 *    R₁ = (P-P')·n̂ — vector PP' is along the normal
 *  Two equations, fully constrains P' given P, A, B. */
export function reflectThrough(P_: Point, P: Point, A: Point, B: Point): Relation {
  return relate({
    name: "reflectThrough",
    cells: [P_.x, P_.y, P.x, P.y, A.x, A.y, B.x, B.y],
    residual: ([p_x, p_y, px, py, ax, ay, bx, by], out) => {
      const dx = bx! - ax!;
      const dy = by! - ay!;
      // Midpoint of (P, P') projected onto AB minus A.
      const mx = (px! + p_x!) / 2 - ax!;
      const my = (py! + p_y!) / 2 - ay!;
      // Component of PP' perpendicular to AB should be |PP'| (parallel
      // component should be 0 — P and P' have same projection on AB).
      const ppx = p_x! - px!;
      const ppy = p_y! - py!;
      // Constraint 1: midpoint of P, P' lies on AB. Equivalent to
      // cross product (M-A) × (B-A) = 0.
      out[0] = mx * dy - my * dx;
      // Constraint 2: PP' is perpendicular to AB.
      out[1] = ppx * dx + ppy * dy;
    },
    m: 2,
  });
}

// ─── Pin (hard, scaffolding) ─────────────────────────────────────────

/** Hard-pin a cell at `target` (or its current value). The runtime
 *  enforces this value on every solve — user writes are silently
 *  overridden. Returns a dispose handle.
 *
 *  Hard-pin is the right primitive for "this is fixed scaffolding"
 *  (canvas anchors, immobile origins). For soft pull-toward-default
 *  behaviour, use a `relate` with a residual `cell - default = 0`
 *  directly — that participates in least-squares minimisation
 *  alongside the rest. */
export function pin(cell: Point["x"], target?: Val<number>): { dispose(): void } {
  const v = target !== undefined ? num(target) : cell.peek();
  const dispose = hardPin(cell, typeof v === "function" ? v : v);
  return { dispose };
}

/** Hard-pin a Point at its current location (or supplied target). */
export function pinPoint(
  p: Point,
  target?: { x: Val<number>; y: Val<number> },
): { dispose(): void } {
  if (target !== undefined) {
    const fx = num(target.x);
    const fy = num(target.y);
    const dx = hardPin(p.x, fx);
    const dy = hardPin(p.y, fy);
    return {
      dispose() {
        dx();
        dy();
      },
    };
  }
  const dx = hardPin(p.x, p.x.peek());
  const dy = hardPin(p.y, p.y.peek());
  return {
    dispose() {
      dx();
      dy();
    },
  };
}

