// matrix.ts — reactive 2D affine matrix (SVG/Canvas convention).
//
// Sparse-trait stress test: only `equals` declared. Matrices have no
// useful element-wise linear combine and naïve element-wise lerp
// doesn't decompose, so `spring`/`tween`/`mean` etc. reject Matrix at
// compile time (no linear/lerp/metric).
//
// Two clearly-invertible ops: `multiply(b)` (inverse is multiply by
// `invert(b)`) and `invert()` (its own inverse).

import { Signal, computed, value, type Val, type SignalOptions, type Of } from "../signal";
import { type TraitDict } from "../traits";
import { type Op, applyOp0, applyOp1, Chain } from "../ops";
import { Num } from "./num";
import { Vec } from "./vec";

type V = { a: number; b: number; c: number; d: number; e: number; f: number };
type BoxV = { x: number; y: number; w: number; h: number };

export const identity = (): V => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
export const fromTranslate = (x: number, y: number): V => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
export const fromScale = (x: number, y: number): V => ({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
export const fromRotate = (angle: number): V => {
  const s = Math.sin(angle); const c = Math.cos(angle);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
};

export const isIdentity = (m: V): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

export const equals = (m: V, n: V): boolean =>
  m === n || (m.a === n.a && m.b === n.b && m.c === n.c && m.d === n.d && m.e === n.e && m.f === n.f);

export function multiply(a: V, b: V): V {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

export function invert(m: V): V {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) throw new Error("Matrix not invertible");
  const inv = 1 / det;
  return {
    a:  m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d:  m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
}

export const determinant = (m: V): number => m.a * m.d - m.b * m.c;

export const transformPoint = (m: V, p: Of<Vec>): Of<Vec> =>
  ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

export function transformBox(m: V, b: BoxV): BoxV {
  if (isIdentity(m)) return b;
  const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
  const ax = m.a * x0 + m.c * y0 + m.e;
  const ay = m.b * x0 + m.d * y0 + m.f;
  const bx = m.a * x1 + m.c * y0 + m.e;
  const by = m.b * x1 + m.d * y0 + m.f;
  const cx = m.a * x1 + m.c * y1 + m.e;
  const cy = m.b * x1 + m.d * y1 + m.f;
  const dx = m.a * x0 + m.c * y1 + m.e;
  const dy = m.b * x0 + m.d * y1 + m.f;
  return {
    x: Math.min(ax, bx, cx, dx),
    y: Math.min(ay, by, cy, dy),
    w: Math.max(ax, bx, cx, dx) - Math.min(ax, bx, cx, dx),
    h: Math.max(ay, by, cy, dy) - Math.min(ay, by, cy, dy),
  };
}

const SCALE_EPS = 1e-7;

export function compose(t: Of<Vec>, r: number, s: Of<Vec>, pivot: Of<Vec>): V {
  const sx = Math.abs(s.x) < SCALE_EPS ? (s.x < 0 ? -SCALE_EPS : SCALE_EPS) : s.x;
  const sy = Math.abs(s.y) < SCALE_EPS ? (s.y < 0 ? -SCALE_EPS : SCALE_EPS) : s.y;
  let m = fromTranslate(t.x, t.y);
  m = multiply(m, fromTranslate(pivot.x, pivot.y));
  if (r !== 0) m = multiply(m, fromRotate(r));
  if (sx !== 1 || sy !== 1) m = multiply(m, fromScale(sx, sy));
  m = multiply(m, fromTranslate(-pivot.x, -pivot.y));
  return m;
}

export const toMatrixString = (m: V): string =>
  `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;

// ─── Invertible ops ────────────────────────────────────────────────

const multiplyOp: Op<V, [V]> = {
  fwd: multiply,
  bwd: (n, b) => multiply(n, invert(b)),
};
const invertOp: Op<V, []> = { fwd: invert, bwd: invert };

export class Matrix extends Signal<V> {
  static traits: TraitDict<V> & { equals: typeof equals } = { equals };

  constructor(v: V = identity(), opts?: SignalOptions<V>) { super(v, opts); }

  // ── Invertible ──
  multiply(b: Val<V>): Matrix { return applyOp1(this, multiplyOp, b, Matrix); }
  invert(): Matrix { return applyOp0(this, invertOp, Matrix); }

  get a(): Num { return this.field("a", Num); }
  get b(): Num { return this.field("b", Num); }
  get c(): Num { return this.field("c", Num); }
  get d(): Num { return this.field("d", Num); }
  get e(): Num { return this.field("e", Num); }
  get f(): Num { return this.field("f", Num); }

  // ── Non-invertible ──
  get determinant(): Num {
    return this.memo("determinant", () =>
      computed(() => determinant(this.value), Num));
  }

  derive(fn: (c: MatrixChain) => MatrixChain): Matrix {
    return fn(new MatrixChain()).toLens(this, Matrix);
  }
}

export interface Matrix { readonly constructor: typeof Matrix }

export class MatrixChain extends Chain<V> {
  multiply(b: Val<V>): this { return this.push1(multiplyOp, b); }
  invert(): this { return this.push0(invertOp); }
}

export const matrix = (
  a: Val<number> = 1, b: Val<number> = 0,
  c: Val<number> = 0, d: Val<number> = 1,
  e: Val<number> = 0, f: Val<number> = 0,
): Matrix => {
  const m = new Matrix();
  m.a.bind(a); m.b.bind(b); m.c.bind(c);
  m.d.bind(d); m.e.bind(e); m.f.bind(f);
  return m;
};
