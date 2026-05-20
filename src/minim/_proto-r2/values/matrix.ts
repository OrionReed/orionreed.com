// matrix.ts — reactive 2D affine matrix (SVG/Canvas convention).
//
// Sparse-trait stress test: Matrix has structural equality only — no
// linear/lerp/metric trait. Matrices don't have a useful linear-combine
// (the algebraic sense of "linear" in `Linear<T>` doesn't fit for
// matrices since you'd want matrix multiplication, not element-wise add)
// and naïve element-wise lerp doesn't decompose properly. Caller wants
// matrix interpolation? Decompose to Transform first.
//
// 6 fields means 6 field lenses — biggest field count we've put through
// the system. Stresses the `memo()` cache shape and shows the trade-off
// at the upper edge of "value type as POJO".

import { Signal, computed, value, type Val, type SignalOptions } from "../signal";
import { type TraitDict } from "../traits";
import { field } from "../field";
import { Num } from "./num";
import type { VecValue } from "./vec";

export interface MatrixValue {
  a: number; b: number; c: number; d: number; e: number; f: number;
}
type BoxValueLocal = { x: number; y: number; w: number; h: number };

export const identity = (): MatrixValue =>
  ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export const fromTranslate = (x: number, y: number): MatrixValue =>
  ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

export const fromScale = (x: number, y: number): MatrixValue =>
  ({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });

export const fromRotate = (angle: number): MatrixValue => {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
};

export const isIdentity = (m: MatrixValue): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

export const equals = (m: MatrixValue, n: MatrixValue): boolean =>
  m === n || (
    m.a === n.a && m.b === n.b && m.c === n.c &&
    m.d === n.d && m.e === n.e && m.f === n.f
  );

export function multiply(a: MatrixValue, b: MatrixValue): MatrixValue {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

export function invert(m: MatrixValue): MatrixValue {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) throw new Error("Matrix not invertible");
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
}

export const determinant = (m: MatrixValue): number => m.a * m.d - m.b * m.c;

export const transformPoint = (m: MatrixValue, p: VecValue): VecValue =>
  ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

export function transformBox(m: MatrixValue, b: BoxValueLocal): BoxValueLocal {
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

export function compose(t: VecValue, r: number, s: VecValue, pivot: VecValue): MatrixValue {
  const sx = Math.abs(s.x) < SCALE_EPS ? (s.x < 0 ? -SCALE_EPS : SCALE_EPS) : s.x;
  const sy = Math.abs(s.y) < SCALE_EPS ? (s.y < 0 ? -SCALE_EPS : SCALE_EPS) : s.y;
  let m = fromTranslate(t.x, t.y);
  m = multiply(m, fromTranslate(pivot.x, pivot.y));
  if (r !== 0) m = multiply(m, fromRotate(r));
  if (sx !== 1 || sy !== 1) m = multiply(m, fromScale(sx, sy));
  m = multiply(m, fromTranslate(-pivot.x, -pivot.y));
  return m;
}

export const toMatrixString = (m: MatrixValue): string =>
  `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;

export class Matrix extends Signal<MatrixValue> {
  // Sparse trait dict: only `equals`. No linear (matrices don't add
  // meaningfully element-wise for transforms), no lerp (interpolate the
  // decomposed Transform instead), no metric.
  static traits: TraitDict<MatrixValue> & { equals: typeof equals } = { equals };

  constructor(v: MatrixValue = identity(), opts?: SignalOptions<MatrixValue>) {
    super(v, opts);
  }

  multiply(b: Val<MatrixValue>) {
    return computed(() => multiply(this.value, value(b)), Matrix);
  }
  invert() {
    return computed(() => invert(this.value), Matrix);
  }

  get a(): Num { return this.memo("a", () => field(this, "a", Num)); }
  get b(): Num { return this.memo("b", () => field(this, "b", Num)); }
  get c(): Num { return this.memo("c", () => field(this, "c", Num)); }
  get d(): Num { return this.memo("d", () => field(this, "d", Num)); }
  get e(): Num { return this.memo("e", () => field(this, "e", Num)); }
  get f(): Num { return this.memo("f", () => field(this, "f", Num)); }

  get determinant(): Num {
    return this.memo("determinant", () =>
      computed(() => determinant(this.value), Num));
  }

  derive(fn: (c: MatrixChain) => MatrixChain) {
    return computed(() => fn(new MatrixChain(this.value)).value, Matrix);
  }
}

export interface Matrix { readonly constructor: typeof Matrix }

export class MatrixChain {
  value: MatrixValue;
  constructor(v: MatrixValue) { this.value = v; }
  multiply(b: Val<MatrixValue>) {
    this.value = multiply(this.value, value(b)); return this;
  }
  invert() { this.value = invert(this.value); return this; }
}

/** Construct a Matrix; per-component reactive args bind via field lens. */
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
