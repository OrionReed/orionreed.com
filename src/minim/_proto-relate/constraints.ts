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

import { Signal, type Val, valFn } from "./signal";
import { hardPin, relate, type Relation } from "./relate";
import { Num } from "./values/num";
import { Vec } from "./values/vec";
import type { Writable } from "./writable";

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
export function parallel(
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
export function angle(
  A: PointInput,
  B: PointInput,
  C: PointInput,
  theta: Val<number>,
): Relation {
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
