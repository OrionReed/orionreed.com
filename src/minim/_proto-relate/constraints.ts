// constraints.ts — geometric primitive library, Sketchpad-style.
//
// Constraint factories accept first-class signals as cells — Vec
// instances, raw Nums, etc. — without any wrapping. The relation
// runtime handles per-class packing transparently: a Vec cell
// occupies 2 slots in the solver, a Num cell occupies 1.
//
// This file used to expose a `point()` wrapper that consumers had to
// pass around. With native composite-cell support in `relate.ts`,
// the wrapper is gone — pass `Vec` instances directly.
//
// Building blocks:
//   - `eq(a, b)`              — a = b
//   - `dist(P, Q, L)`         — |PQ| = L  (Vecs or per-axis Nums)
//   - `equalDist(P,Q, R,S)`   — |PQ| = |RS|
//   - `midpoint(M, A, B)`     — M = (A+B) / 2
//   - `centroid(C, ...Pts)`   — C is mean of N points
//   - `onCircle(P, c, r)`     — |P - c| = r
//   - `onLine(P, A, B)`       — P collinear with A,B
//   - `parallel(AB, CD)`      — AB ∥ CD
//   - `perpendicular(AB,CD)`  — AB ⊥ CD
//   - `angle(A, B, C, θ)`     — interior ∠ABC = θ
//   - `reflectThrough(P', P, A, B)` — P' = mirror of P across AB
//
// Hard pins:
//   - `pin(numCell, target?)` — fix a Num at its current/specified value
//   - `pinPoint(vec, target?)` — fix a Vec at its current/specified position

import { hardPin, type Relation, relate, Strength } from "./relate";
import { Signal, type Val, valFn } from "./signal";
import { Num } from "./values/num";
import { Vec } from "./values/vec";
import type { Writable } from "./writable";

export { Strength };

// ─── Public types ────────────────────────────────────────────────────

type V = { x: number; y: number };
type NumCell = Writable<Num>;
type VecCell = Writable<Vec>;

/** A point input — either a Vec instance (preferred), or a pair of
 *  Num cells for per-axis decomposition. Constraint factories
 *  dispatch based on which form was passed. */
export type PointInput = VecCell | { x: NumCell; y: NumCell };

/** Helpers for the rare case of bundling two raw Nums into a
 *  Point-shaped object (when you want per-axis cluster cells rather
 *  than a composite Vec cell). Most callers should pass a Vec
 *  directly. */
export function point(v: VecCell): VecCell;
export function point(x: NumCell, y: NumCell): { x: NumCell; y: NumCell };
export function point(arg1: VecCell | NumCell, arg2?: NumCell): PointInput {
  if (arg2 === undefined) return arg1 as VecCell;
  return { x: arg1 as NumCell, y: arg2 };
}

// ─── Helpers ─────────────────────────────────────────────────────────

const TINY = 1e-12;

function num(v: Val<number>): () => number {
  return valFn(v);
}

/** Resolve a PointInput to its current {x, y} read. Used by
 *  residual functions to read the point's components transparently
 *  whether it's a Vec cell or a {x, y} Num bundle. */
function readP(input: PointInput, packed: readonly unknown[], idx: number): V {
  if (input instanceof Vec) {
    return packed[idx] as V;
  }
  // Num bundle: two consecutive entries in `packed`.
  const x = packed[idx] as number;
  const y = packed[idx + 1] as number;
  return { x, y };
}

/** Build the cell list and "stride" (1 for Vec, 2 for Nums) of each
 *  point input. Used internally so primitives don't have to
 *  decompose manually. */
function pointCells(input: PointInput): { cells: (VecCell | NumCell)[]; stride: number } {
  if (input instanceof Vec) {
    return { cells: [input as VecCell], stride: 1 };
  }
  return { cells: [input.x, input.y], stride: 2 };
}

// ─── Primitives ──────────────────────────────────────────────────────

/** Equality: `a = b`. */
export function eq(a: NumCell, b: NumCell): Relation {
  return relate({
    name: "eq",
    cells: [a, b],
    residual: ([x, y], out) => {
      out[0] = x! - y!;
    },
    m: 1,
  });
}

/** Distance: `|PQ| = L`. P and Q can be Vec instances or two-Num
 *  bundles. L can be a literal, thunk, or Num. */
export function dist(P: PointInput, Q: PointInput, L: Val<number>): Relation {
  const Pc = pointCells(P);
  const Qc = pointCells(Q);
  const cells: (VecCell | NumCell)[] = [...Pc.cells, ...Qc.cells];
  // L as a Num joins the cluster; literal/thunk captured by closure.
  const Lcell = L instanceof Signal ? (L as NumCell) : undefined;
  if (Lcell !== undefined) cells.push(Lcell);
  const Lf = num(L);
  const pIdx = 0;
  const qIdx = Pc.cells.length;
  const lIdx = Pc.cells.length + Qc.cells.length;
  return relate({
    name: "dist",
    cells,
    residual: (vals, out) => {
      const p = readP(P, vals, pIdx);
      const q = readP(Q, vals, qIdx);
      const L_ = Lcell !== undefined ? (vals[lIdx] as number) : Lf();
      out[0] = Math.hypot(p.x - q.x, p.y - q.y) - L_;
    },
    m: 1,
  });
}

/** Equal distances: `|PQ| = |RS|`. */
export function equalDist(P: PointInput, Q: PointInput, R: PointInput, S: PointInput): Relation {
  const Pc = pointCells(P);
  const Qc = pointCells(Q);
  const Rc = pointCells(R);
  const Sc = pointCells(S);
  const cells = [...Pc.cells, ...Qc.cells, ...Rc.cells, ...Sc.cells];
  const pIdx = 0;
  const qIdx = pIdx + Pc.cells.length;
  const rIdx = qIdx + Qc.cells.length;
  const sIdx = rIdx + Rc.cells.length;
  return relate({
    name: "equalDist",
    cells,
    residual: (vals, out) => {
      const p = readP(P, vals, pIdx);
      const q = readP(Q, vals, qIdx);
      const r = readP(R, vals, rIdx);
      const s = readP(S, vals, sIdx);
      out[0] = Math.hypot(p.x - q.x, p.y - q.y) - Math.hypot(r.x - s.x, r.y - s.y);
    },
    m: 1,
  });
}

/** Midpoint: `M = (A + B) / 2`. */
export function midpoint(M: PointInput, A: PointInput, B: PointInput): Relation {
  const Mc = pointCells(M);
  const Ac = pointCells(A);
  const Bc = pointCells(B);
  const cells = [...Mc.cells, ...Ac.cells, ...Bc.cells];
  const mIdx = 0;
  const aIdx = mIdx + Mc.cells.length;
  const bIdx = aIdx + Ac.cells.length;
  return relate({
    name: "midpoint",
    cells,
    residual: (vals, out) => {
      const m = readP(M, vals, mIdx);
      const a = readP(A, vals, aIdx);
      const b = readP(B, vals, bIdx);
      out[0] = 2 * m.x - (a.x + b.x);
      out[1] = 2 * m.y - (a.y + b.y);
    },
    m: 2,
  });
}

/** Centroid: `C = mean(P_i)`. */
export function centroid(C: PointInput, ...pts: PointInput[]): Relation {
  const Cc = pointCells(C);
  const ptCellLists = pts.map(pointCells);
  const cells = [...Cc.cells, ...ptCellLists.flatMap(l => l.cells)];
  const cIdx = 0;
  const ptIdxStart = Cc.cells.length;
  const ptOffsets: number[] = [];
  let off = ptIdxStart;
  for (const list of ptCellLists) {
    ptOffsets.push(off);
    off += list.cells.length;
  }
  const n = pts.length;
  return relate({
    name: "centroid",
    cells,
    residual: (vals, out) => {
      const c = readP(C, vals, cIdx);
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        const p = readP(pts[i]!, vals, ptOffsets[i]!);
        sx += p.x;
        sy += p.y;
      }
      out[0] = n * c.x - sx;
      out[1] = n * c.y - sy;
    },
    m: 2,
  });
}

/** P lies on the circle of radius `r` centred at `c`. */
export function onCircle(P: PointInput, c: PointInput, r: Val<number>): Relation {
  const Pc = pointCells(P);
  const Cc = pointCells(c);
  const cells: (VecCell | NumCell)[] = [...Pc.cells, ...Cc.cells];
  const Rcell = r instanceof Signal ? (r as NumCell) : undefined;
  if (Rcell !== undefined) cells.push(Rcell);
  const Rf = num(r);
  const pIdx = 0;
  const cIdx = Pc.cells.length;
  const rIdx = Pc.cells.length + Cc.cells.length;
  return relate({
    name: "onCircle",
    cells,
    residual: (vals, out) => {
      const p = readP(P, vals, pIdx);
      const cc = readP(c, vals, cIdx);
      const r_ = Rcell !== undefined ? (vals[rIdx] as number) : Rf();
      out[0] = Math.hypot(p.x - cc.x, p.y - cc.y) - r_;
    },
    m: 1,
  });
}

/** P lies on the line through A and B (collinearity). */
export function onLine(P: PointInput, A: PointInput, B: PointInput): Relation {
  const Pc = pointCells(P);
  const Ac = pointCells(A);
  const Bc = pointCells(B);
  const cells = [...Pc.cells, ...Ac.cells, ...Bc.cells];
  const pIdx = 0;
  const aIdx = pIdx + Pc.cells.length;
  const bIdx = aIdx + Ac.cells.length;
  return relate({
    name: "onLine",
    cells,
    residual: (vals, out) => {
      const p = readP(P, vals, pIdx);
      const a = readP(A, vals, aIdx);
      const b = readP(B, vals, bIdx);
      out[0] = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
    },
    m: 1,
  });
}

/** AB ∥ CD: 2D cross-product of direction vectors equals zero. */
export function parallel(A: PointInput, B: PointInput, C: PointInput, D: PointInput): Relation {
  const Ac = pointCells(A);
  const Bc = pointCells(B);
  const Cc = pointCells(C);
  const Dc = pointCells(D);
  const cells = [...Ac.cells, ...Bc.cells, ...Cc.cells, ...Dc.cells];
  const aIdx = 0;
  const bIdx = aIdx + Ac.cells.length;
  const cIdx = bIdx + Bc.cells.length;
  const dIdx = cIdx + Cc.cells.length;
  return relate({
    name: "parallel",
    cells,
    residual: (vals, out) => {
      const a = readP(A, vals, aIdx);
      const b = readP(B, vals, bIdx);
      const c = readP(C, vals, cIdx);
      const d = readP(D, vals, dIdx);
      out[0] = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
    },
    m: 1,
  });
}

/** AB ⊥ CD: dot product equals zero. */
export function perpendicular(
  A: PointInput,
  B: PointInput,
  C: PointInput,
  D: PointInput,
): Relation {
  const Ac = pointCells(A);
  const Bc = pointCells(B);
  const Cc = pointCells(C);
  const Dc = pointCells(D);
  const cells = [...Ac.cells, ...Bc.cells, ...Cc.cells, ...Dc.cells];
  const aIdx = 0;
  const bIdx = aIdx + Ac.cells.length;
  const cIdx = bIdx + Bc.cells.length;
  const dIdx = cIdx + Cc.cells.length;
  return relate({
    name: "perpendicular",
    cells,
    residual: (vals, out) => {
      const a = readP(A, vals, aIdx);
      const b = readP(B, vals, bIdx);
      const c = readP(C, vals, cIdx);
      const d = readP(D, vals, dIdx);
      out[0] = (b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y);
    },
    m: 1,
  });
}

/** Interior angle ∠ABC equals θ. */
export function angle(A: PointInput, B: PointInput, C: PointInput, theta: Val<number>): Relation {
  const Ac = pointCells(A);
  const Bc = pointCells(B);
  const Cc = pointCells(C);
  const cells: (VecCell | NumCell)[] = [...Ac.cells, ...Bc.cells, ...Cc.cells];
  const Tcell = theta instanceof Signal ? (theta as NumCell) : undefined;
  if (Tcell !== undefined) cells.push(Tcell);
  const Tf = num(theta);
  const aIdx = 0;
  const bIdx = aIdx + Ac.cells.length;
  const cIdx = bIdx + Bc.cells.length;
  const tIdx = cIdx + Cc.cells.length;
  return relate({
    name: "angle",
    cells,
    residual: (vals, out) => {
      const a = readP(A, vals, aIdx);
      const b = readP(B, vals, bIdx);
      const c = readP(C, vals, cIdx);
      const ux = a.x - b.x;
      const uy = a.y - b.y;
      const vx = c.x - b.x;
      const vy = c.y - b.y;
      const lu = Math.hypot(ux, uy);
      const lv = Math.hypot(vx, vy);
      if (lu < TINY || lv < TINY) {
        out[0] = 0;
        return;
      }
      const cos = (ux * vx + uy * vy) / (lu * lv);
      const cs = cos > 1 ? 1 : cos < -1 ? -1 : cos;
      const t_ = Tcell !== undefined ? (vals[tIdx] as number) : Tf();
      out[0] = Math.acos(cs) - t_;
    },
    m: 1,
  });
}

/** P' = reflection of P across the line through A and B. */
export function reflectThrough(
  P_: PointInput,
  P: PointInput,
  A: PointInput,
  B: PointInput,
): Relation {
  const Pc_ = pointCells(P_);
  const Pc = pointCells(P);
  const Ac = pointCells(A);
  const Bc = pointCells(B);
  const cells = [...Pc_.cells, ...Pc.cells, ...Ac.cells, ...Bc.cells];
  const ppIdx = 0;
  const pIdx = ppIdx + Pc_.cells.length;
  const aIdx = pIdx + Pc.cells.length;
  const bIdx = aIdx + Ac.cells.length;
  return relate({
    name: "reflectThrough",
    cells,
    residual: (vals, out) => {
      const pp = readP(P_, vals, ppIdx);
      const p = readP(P, vals, pIdx);
      const a = readP(A, vals, aIdx);
      const b = readP(B, vals, bIdx);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const mx = (p.x + pp.x) / 2 - a.x;
      const my = (p.y + pp.y) / 2 - a.y;
      const ppx = pp.x - p.x;
      const ppy = pp.y - p.y;
      out[0] = mx * dy - my * dx;
      out[1] = ppx * dx + ppy * dy;
    },
    m: 2,
  });
}

// ─── Pin (hard, scaffolding) ─────────────────────────────────────────

/** Hard-pin a Num cell at its current value (or `target` if given).
 *  Solver overrides user writes; the cell stays put. */
export function pin(cell: NumCell, target?: Val<number>): { dispose(): void } {
  const v = target !== undefined ? num(target) : cell.peek();
  const dispose = hardPin(cell, typeof v === "function" ? v : v);
  return { dispose };
}

/** Hard-pin a 2D point at its current location (or `target` if
 *  given). For Vec cells, hard-pins the Vec as a single composite
 *  cell. For Num bundles, pins each axis separately. Either way
 *  the cell(s) become immobile to solver and user writes alike. */
export function pinPoint(
  p: PointInput,
  target?: { x: Val<number>; y: Val<number> },
): { dispose(): void } {
  if (p instanceof Vec) {
    // Composite hard pin — the runtime supports it via the Vec
    // packer.
    if (target !== undefined) {
      const fx = num(target.x);
      const fy = num(target.y);
      const dispose = hardPin(p as VecCell, () => ({ x: fx(), y: fy() }));
      return { dispose };
    }
    const initial = p.peek();
    const dispose = hardPin(p as VecCell, initial);
    return { dispose };
  }
  // Num bundle.
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

// ─── Inequality constraints (penalty form) ───────────────────────────
//
// Inequality `a ≤ b` is encoded as residual `max(0, a - b)`: zero
// when satisfied, linearly increasing when violated. The squared LSQ
// objective makes this C¹ at the boundary. For "must be satisfied"
// semantics, use `weight: Strength.REQUIRED`.
//
// Limitation: like Cassowary's stay constraints, these are SOFT in
// our system unless given REQUIRED weight. Hard inequality
// satisfaction (always-satisfied) requires Cassowary-style slack
// variables and a simplex inner solver — not yet implemented.

/** Inequality options. `weight` defaults to `MEDIUM`. Pass
 *  `hard: true` to enable the escalation outer loop and treat the
 *  inequality as a true hard constraint (best-effort: cluster will
 *  bump weight up to 5× until the residual falls below tol or
 *  budget is exhausted). */
export interface InequalityOpts {
  weight?: number;
  hard?: boolean;
}

function inequalityOpts(arg: number | InequalityOpts | undefined): {
  weight: number;
  hard: boolean;
} {
  if (typeof arg === "number") return { weight: arg, hard: false };
  return { weight: arg?.weight ?? Strength.MEDIUM, hard: arg?.hard ?? false };
}

/** `a ≤ b`. Residual `max(0, a - b)`, zero when satisfied. */
export function leq(
  a: NumCell,
  b: NumCell,
  opts: number | InequalityOpts = Strength.MEDIUM,
): Relation {
  const { weight, hard } = inequalityOpts(opts);
  return relate({
    name: "leq",
    cells: [a, b],
    residual: ([va, vb], out) => {
      const d = (va as number) - (vb as number);
      out[0] = d > 0 ? d : 0;
    },
    m: 1,
    weight,
    hard,
  });
}

/** `a ≥ b`. Residual `max(0, b - a)`. */
export function geq(
  a: NumCell,
  b: NumCell,
  opts: number | InequalityOpts = Strength.MEDIUM,
): Relation {
  return leq(b, a, opts);
}

/** `lo ≤ x ≤ hi`. Implemented as two `leq` relations. Returns a
 *  bundle so consumers can `dispose()` both at once. */
export function bounded(
  x: NumCell,
  lo: NumCell | number,
  hi: NumCell | number,
  opts: number | InequalityOpts = Strength.MEDIUM,
): { lo: Relation; hi: Relation; dispose(): void } {
  const { weight, hard } = inequalityOpts(opts);
  const loRel =
    typeof lo === "number"
      ? relate({
          name: "boundedLo",
          cells: [x],
          residual: ([v], out) => {
            const d = lo - (v as number);
            out[0] = d > 0 ? d : 0;
          },
          m: 1,
          weight,
          hard,
        })
      : leq(lo, x, opts);
  const hiRel =
    typeof hi === "number"
      ? relate({
          name: "boundedHi",
          cells: [x],
          residual: ([v], out) => {
            const d = (v as number) - hi;
            out[0] = d > 0 ? d : 0;
          },
          m: 1,
          weight,
          hard,
        })
      : leq(x, hi, opts);
  return {
    lo: loRel,
    hi: hiRel,
    dispose() {
      loRel.dispose();
      hiRel.dispose();
    },
  };
}

// ─── Layout primitives (Cassowary-style) ─────────────────────────────

/** `align(axis, ...cells)`: all cells share the same value along
 *  the given axis. For Vec cells, axis is "x" or "y"; for Num
 *  cells, just chains them with eq.
 *
 *  This is N-1 equality constraints — a chain of `eq(cells[i], cells[i+1])`.
 *  Cluster identification merges them into one cluster automatically. */
export function alignNum(...cells: NumCell[]): Relation[] {
  const out: Relation[] = [];
  for (let i = 1; i < cells.length; i++) {
    out.push(
      relate({
        name: "alignNum",
        cells: [cells[i - 1]!, cells[i]!],
        residual: ([a, b], o) => {
          o[0] = (a as number) - (b as number);
        },
        m: 1,
      }),
    );
  }
  return out;
}

/** `alignVec(axis, ...vecs)`: align all vecs on a single axis. */
export function alignVec(axis: "x" | "y", ...vecs: VecCell[]): Relation[] {
  const out: Relation[] = [];
  for (let i = 1; i < vecs.length; i++) {
    const ai = i - 1;
    const bi = i;
    out.push(
      relate({
        name: `alignVec.${axis}`,
        cells: [vecs[ai]!, vecs[bi]!],
        residual: ([va, vb], o) => {
          const a = va as { x: number; y: number };
          const b = vb as { x: number; y: number };
          o[0] = a[axis] - b[axis];
        },
        m: 1,
      }),
    );
  }
  return out;
}

/** `space(a, b, gap)` along the x-axis: `b.x = a.x + gap`. For Vec
 *  cells; horizontal layout. */
export function space(a: VecCell, b: VecCell, gap: Val<number>): Relation {
  const gf = num(gap);
  const cells: (VecCell | NumCell)[] = [a, b];
  if (gap instanceof Signal) cells.push(gap as NumCell);
  const gIdx = 2;
  return relate({
    name: "space",
    cells,
    residual: (vals, out) => {
      const va = vals[0] as { x: number; y: number };
      const vb = vals[1] as { x: number; y: number };
      const g = gap instanceof Signal ? (vals[gIdx] as number) : gf();
      out[0] = vb.x - va.x - g;
    },
    m: 1,
  });
}

/** `equalSpacing(axis, ...cells)`: each consecutive gap is equal.
 *  Useful for "distribute evenly" UI. Implements N-2 equations:
 *  `cells[i+1] - cells[i] = cells[i+2] - cells[i+1]`. */
export function equalSpacing(axis: "x" | "y", ...vecs: VecCell[]): Relation[] {
  const out: Relation[] = [];
  for (let i = 0; i + 2 < vecs.length; i++) {
    out.push(
      relate({
        name: `equalSpacing.${axis}`,
        cells: [vecs[i]!, vecs[i + 1]!, vecs[i + 2]!],
        residual: ([va, vb, vc], o) => {
          const a = va as { x: number; y: number };
          const b = vb as { x: number; y: number };
          const c = vc as { x: number; y: number };
          o[0] = b[axis] - a[axis] - (c[axis] - b[axis]);
        },
        m: 1,
      }),
    );
  }
  return out;
}

// ─── More geometric primitives (Sketchpad completeness) ──────────────

/** Two circles externally tangent: `|c1 - c2| = r1 + r2`. */
export function tangentCircles(
  c1: PointInput,
  r1: Val<number>,
  c2: PointInput,
  r2: Val<number>,
): Relation {
  const C1c = pointCells(c1);
  const C2c = pointCells(c2);
  const cells: (VecCell | NumCell)[] = [...C1c.cells, ...C2c.cells];
  const r1Cell = r1 instanceof Signal ? (r1 as NumCell) : undefined;
  const r2Cell = r2 instanceof Signal ? (r2 as NumCell) : undefined;
  if (r1Cell !== undefined) cells.push(r1Cell);
  if (r2Cell !== undefined) cells.push(r2Cell);
  const r1f = num(r1);
  const r2f = num(r2);
  const c1Idx = 0;
  const c2Idx = C1c.cells.length;
  const r1Idx = c2Idx + C2c.cells.length;
  const r2Idx = r1Idx + (r1Cell !== undefined ? 1 : 0);
  return relate({
    name: "tangentCircles",
    cells,
    residual: (vals, out) => {
      const C1v = readP(c1, vals, c1Idx);
      const C2v = readP(c2, vals, c2Idx);
      const R1 = r1Cell !== undefined ? (vals[r1Idx] as number) : r1f();
      const R2 = r2Cell !== undefined ? (vals[r2Idx] as number) : r2f();
      out[0] = Math.hypot(C1v.x - C2v.x, C1v.y - C2v.y) - (R1 + R2);
    },
    m: 1,
  });
}

/** Line through (A, B) tangent to circle of radius `r` at `c`:
 *  perpendicular distance from c to line AB equals r. */
export function tangentLineCircle(
  A: PointInput,
  B: PointInput,
  c: PointInput,
  r: Val<number>,
): Relation {
  const Ac = pointCells(A);
  const Bc = pointCells(B);
  const Cc = pointCells(c);
  const cells: (VecCell | NumCell)[] = [...Ac.cells, ...Bc.cells, ...Cc.cells];
  const rCell = r instanceof Signal ? (r as NumCell) : undefined;
  if (rCell !== undefined) cells.push(rCell);
  const rf = num(r);
  const aIdx = 0;
  const bIdx = aIdx + Ac.cells.length;
  const cIdx = bIdx + Bc.cells.length;
  const rIdx = cIdx + Cc.cells.length;
  return relate({
    name: "tangentLineCircle",
    cells,
    residual: (vals, out) => {
      const a = readP(A, vals, aIdx);
      const b = readP(B, vals, bIdx);
      const cc = readP(c, vals, cIdx);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < TINY) {
        out[0] = 0;
        return;
      }
      // Perpendicular distance from cc to line AB.
      const dist = ((cc.x - a.x) * dy - (cc.y - a.y) * dx) / len;
      const R = rCell !== undefined ? (vals[rIdx] as number) : rf();
      out[0] = Math.abs(dist) - R;
    },
    m: 1,
  });
}

/** `(c, r)` is the circumcircle of triangle ABC: each vertex on the
 *  circle. Three equality constraints; one of them is redundant for
 *  generic triangles, but the LSQ solve handles redundancy fine. */
export function circumcircle(
  c: PointInput,
  r: Val<number>,
  A: PointInput,
  B: PointInput,
  C: PointInput,
): { rA: Relation; rB: Relation; rC: Relation; dispose(): void } {
  const rA = onCircle(A, c, r);
  const rB = onCircle(B, c, r);
  const rC = onCircle(C, c, r);
  return {
    rA,
    rB,
    rC,
    dispose() {
      rA.dispose();
      rB.dispose();
      rC.dispose();
    },
  };
}

/** Line (A, B) is the perpendicular bisector of segment (P, Q):
 *  passes through midpoint of PQ, perpendicular to PQ.
 *
 *  Two equations: `M = (P+Q)/2 lies on line AB` (collinearity),
 *  and `AB perpendicular to PQ`. */
export function perpendicularBisector(
  A: PointInput,
  B: PointInput,
  P: PointInput,
  Q: PointInput,
): Relation {
  const Ac = pointCells(A);
  const Bc = pointCells(B);
  const Pc = pointCells(P);
  const Qc = pointCells(Q);
  const cells = [...Ac.cells, ...Bc.cells, ...Pc.cells, ...Qc.cells];
  const aIdx = 0;
  const bIdx = aIdx + Ac.cells.length;
  const pIdx = bIdx + Bc.cells.length;
  const qIdx = pIdx + Pc.cells.length;
  return relate({
    name: "perpendicularBisector",
    cells,
    residual: (vals, out) => {
      const a = readP(A, vals, aIdx);
      const b = readP(B, vals, bIdx);
      const p = readP(P, vals, pIdx);
      const q = readP(Q, vals, qIdx);
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      // (M - A) × (B - A) = 0 (collinear)
      out[0] = (mx - a.x) * (b.y - a.y) - (my - a.y) * (b.x - a.x);
      // (B - A) · (Q - P) = 0 (perpendicular)
      out[1] = (b.x - a.x) * (q.x - p.x) + (b.y - a.y) * (q.y - p.y);
    },
    m: 2,
  });
}

// ─── Soft pull-toward (physics-style) ────────────────────────────────

/** Soft pull on a Num toward `target`, with given strength. Residual
 *  is `v - target`; LSQ contribution is `weight × (v - target)²` —
 *  the same shape as a quadratic potential energy. Use WEAK strength
 *  for "rest position" hints (joints prefer this angle), MEDIUM for
 *  preferences, STRONG for near-hard targets. */
export function softNum(
  cell: NumCell,
  target: Val<number>,
  weight: number = Strength.WEAK,
): Relation {
  const cells: NumCell[] = [cell];
  if (target instanceof Signal) cells.push(target as NumCell);
  const tf = num(target);
  return relate({
    name: "softNum",
    cells,
    residual: (vals, out) => {
      const v = vals[0] as number;
      const t = target instanceof Signal ? (vals[1] as number) : tf();
      out[0] = v - t;
    },
    m: 1,
    weight,
  });
}

/** Soft pull on a Vec toward `target`, same semantics as `softNum`.
 *  Useful for "this point wants to be at gravity's pull location"
 *  in mass-spring physics, or "this layout element prefers this
 *  position" in soft-constraint UI. */
export function softVec(
  cell: VecCell,
  target: V | (() => V),
  weight: number = Strength.WEAK,
): Relation {
  const tf = typeof target === "function" ? target : () => target;
  return relate({
    name: "softVec",
    cells: [cell],
    residual: ([v], out) => {
      const vv = v as V;
      const t = tf();
      out[0] = vv.x - t.x;
      out[1] = vv.y - t.y;
    },
    m: 2,
    weight,
  });
}

// ─── Rigid body grouping ─────────────────────────────────────────────

/** N points moving as a rigid body — preserves all O(N²) pairwise
 *  distances. For N points this expands to N·(N-1)/2 distance
 *  constraints, which is fine for small groups (5-10 points) but
 *  scales O(N²) in the constraint count. For large rigid groups,
 *  use `rigidViaSpine` (TODO) which uses ~2N constraints via a
 *  spanning tree. */
export function rigid(...points: PointInput[]): Relation[] {
  const out: Relation[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      const av = a instanceof Vec ? a.peek() : { x: a.x.peek(), y: a.y.peek() };
      const bv = b instanceof Vec ? b.peek() : { x: b.x.peek(), y: b.y.peek() };
      const L = Math.hypot(av.x - bv.x, av.y - bv.y);
      out.push(dist(a, b, L));
    }
  }
  return out;
}
