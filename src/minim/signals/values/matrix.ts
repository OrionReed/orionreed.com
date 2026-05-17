// matrix.ts — reactive 2D affine matrix (SVG/Canvas convention).
//
//   | a c e |
//   | b d f |
//   | 0 0 1 |
//
// `multiply(A, B)` is `A·B` — B applies first (SVG `transform` order).

import { Signal, value, type Val } from "../signal";
import { EQUALS } from "../traits";
import { BaseChain, derived, field, bindFields } from "../derive";
import { defineTrait } from "../lerp";
import { Num } from "./num";
import { type Value as VecValue } from "./vec";

export interface Value {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

// Plain Box shape (kept local to avoid a circular import with `./box`).
type BoxValue = { x: number; y: number; w: number; h: number };

// ── Pure math ──────────────────────────────────────────────────────

export const identity = (): Value =>
  ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export const fromTranslate = (x: number, y: number): Value =>
  ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

export const fromScale = (x: number, y: number): Value =>
  ({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });

export const fromRotate = (angle: number): Value => {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
};

export const isIdentity = (m: Value): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

export const equals = (m: Value, n: Value): boolean =>
  m === n || (
    m.a === n.a && m.b === n.b && m.c === n.c &&
    m.d === n.d && m.e === n.e && m.f === n.f
  );

export function multiply(a: Value, b: Value): Value {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

export function invert(m: Value): Value {
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

export const determinant = (m: Value): number => m.a * m.d - m.b * m.c;

export const transformPoint = (m: Value, p: VecValue): VecValue =>
  ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

/** Loose Box enclosing the four transformed corners; identity short-circuits. */
export function transformBox(m: Value, b: BoxValue): BoxValue {
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
  const minX = Math.min(ax, bx, cx, dx);
  const maxX = Math.max(ax, bx, cx, dx);
  const minY = Math.min(ay, by, cy, dy);
  const maxY = Math.max(ay, by, cy, dy);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Clamp scale magnitude away from zero. Firefox's SVG compositor leaks
// GPU layer textures when an animated transform is exactly singular
// (det = 0); any non-zero magnitude dodges it. `1e-7` is sub-pixel.
// Related: https://bugzilla.mozilla.org/show_bug.cgi?id=1316003
const SCALE_EPS = 1e-7;

/** Shape transform: `T(t) T(p) R(r) S(s) T(-p)`. Scales clamped away
 *  from zero (Firefox compositor leak on singular matrices). Fast paths
 *  for no-scale / no-rotate. */
export function compose(t: VecValue, r: number, s: VecValue, pivot: VecValue): Value {
  const sx = Math.abs(s.x) < SCALE_EPS ? (s.x < 0 ? -SCALE_EPS : SCALE_EPS) : s.x;
  const sy = Math.abs(s.y) < SCALE_EPS ? (s.y < 0 ? -SCALE_EPS : SCALE_EPS) : s.y;

  const hasTrans = t.x !== 0 || t.y !== 0;
  const hasRot = r !== 0;
  const hasScale = sx !== 1 || sy !== 1;
  if (!hasTrans && !hasRot && !hasScale) return identity();

  if (!hasRot && !hasScale) {
    return { a: 1, b: 0, c: 0, d: 1, e: t.x, f: t.y };
  }
  if (hasRot && !hasScale) {
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return {
      a: cos, b: sin, c: -sin, d: cos,
      e: t.x + pivot.x - cos * pivot.x + sin * pivot.y,
      f: t.y + pivot.y - sin * pivot.x - cos * pivot.y,
    };
  }
  if (hasScale && !hasRot) {
    return {
      a: sx, b: 0, c: 0, d: sy,
      e: t.x + pivot.x * (1 - sx),
      f: t.y + pivot.y * (1 - sy),
    };
  }

  let m = hasTrans ? fromTranslate(t.x, t.y) : identity();
  m = multiply(m, fromTranslate(pivot.x, pivot.y));
  if (hasRot) m = multiply(m, fromRotate(r));
  if (hasScale) m = multiply(m, fromScale(sx, sy));
  m = multiply(m, fromTranslate(-pivot.x, -pivot.y));
  return m;
}

/** Comma-separated — valid as both SVG `transform` and CSS `transform`. */
export const toString = (m: Value): string =>
  `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;

// ── Reactive class ─────────────────────────────────────────────────

export class Matrix2D extends Signal<Value> {
  constructor(v: Value = identity()) { super(v); }

  multiply(b: Val<Value>) { return derived(Matrix2D, () => multiply(this.value, value(b))); }
  invert() { return derived(Matrix2D, () => invert(this.value)); }

  get a() { return field(this, "a", Num); }
  get b() { return field(this, "b", Num); }
  get c() { return field(this, "c", Num); }
  get d() { return field(this, "d", Num); }
  get e() { return field(this, "e", Num); }
  get f() { return field(this, "f", Num); }

  get determinant() { return this._det ??= derived(Num, () => determinant(this.value)); }
  private _det?: Num;

  derive(fn: (c: Chain) => Chain) {
    return derived(Matrix2D, () => fn(new Chain(this.value)).value);
  }
}

class Chain extends BaseChain<Value> {
  multiply(b: Val<Value>) { this.value = multiply(this.value, value(b)); return this; }
  invert() { this.value = invert(this.value); return this; }
}

defineTrait(Matrix2D, EQUALS, equals);

/** Construct a Matrix2D; reactive per-component args bind the lens. */
export const matrix = (
  a: Val<number> = 1, b: Val<number> = 0,
  c: Val<number> = 0, d: Val<number> = 1,
  e: Val<number> = 0, f: Val<number> = 0,
): Matrix2D => {
  const m = new Matrix2D();
  bindFields(m, { a, b, c, d, e, f });
  return m;
};
