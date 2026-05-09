// 2D affine matrices in SVG/Canvas convention:
//
//   | a c e |
//   | b d f |
//   | 0 0 1 |
//
// `multiply(A, B)` applies B first then A — i.e. `Mp = A·B·p`,
// matching SVG's `transform="A B C"` order.

import { aabb, type AABB, type Vec } from "./bounds";

export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const identity = (): Matrix2D => ({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
});

export const fromTranslate = (x: number, y: number): Matrix2D => ({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: x,
  f: y,
});

export const fromScale = (x: number, y: number): Matrix2D => ({
  a: x,
  b: 0,
  c: 0,
  d: y,
  e: 0,
  f: 0,
});

export const fromRotate = (angle: number): Matrix2D => {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
};

export const isIdentity = (m: Matrix2D): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

export function multiply(a: Matrix2D, b: Matrix2D): Matrix2D {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

export function invert(m: Matrix2D): Matrix2D {
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

export const transformPoint = (m: Matrix2D, p: Vec): Vec => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

/** Loose AABB enclosing the four transformed corners of `b`. */
export function transformAABB(m: Matrix2D, b: AABB): AABB {
  if (isIdentity(m)) return b;
  const x0 = b.x;
  const y0 = b.y;
  const x1 = b.x + b.w;
  const y1 = b.y + b.h;
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
  return aabb(minX, minY, maxX - minX, maxY - minY);
}

// Smallest scale magnitude the matrix output is allowed to carry —
// anything closer to zero clamps up. Firefox's SVG compositor leaks GPU
// layer textures unboundedly when an animated transform is exactly
// singular (det = 0). Empirically any non-zero magnitude is enough to
// dodge it; `1e-8` is sub-pixel for any conceivable shape but still
// firmly above the equality test on the consumer side. Likely related
// to https://bugzilla.mozilla.org/show_bug.cgi?id=1316003 (open since
// 2016 — animated transform/opacity can cause unbounded memory).
const SCALE_EPS = 1e-8;

/** Shape transform: translate × pivoted rotate × pivoted scale.
 *  Equivalent to `translate(t) translate(pivot) rotate(r) scale(s)
 *  translate(-pivot)`.
 *
 *  Invariant: never emits a singular (non-invertible) matrix — `s.x`
 *  and `s.y` are clamped away from zero (`|s.x| < SCALE_EPS` → ±EPS,
 *  preserving sign). Both for downstream math (`invert`, hit-testing)
 *  and to sidestep the Firefox-compositor leak above.
 *
 *  Fast paths for the common animation cases (no scale, no rotate, etc.)
 *  avoid the chain-of-multiplies general path — closed form, ~3× faster
 *  per call. The transform effect runs once per shape per frame, so
 *  shaving microseconds here scales linearly with shape count. */
export function compose(t: Vec, r: number, s: Vec, pivot: Vec): Matrix2D {
  // Clamp by magnitude, not equality — a tween from 1 → 0 passes
  // through small floats on its way to zero. Equality-clamping `=== 0`
  // would let those slip past and re-emit singular-ish matrices.
  const sx =
    Math.abs(s.x) < SCALE_EPS ? (s.x < 0 ? -SCALE_EPS : SCALE_EPS) : s.x;
  const sy =
    Math.abs(s.y) < SCALE_EPS ? (s.y < 0 ? -SCALE_EPS : SCALE_EPS) : s.y;

  const hasTrans = t.x !== 0 || t.y !== 0;
  const hasRot = r !== 0;
  const hasScale = sx !== 1 || sy !== 1;
  if (!hasTrans && !hasRot && !hasScale) return identity();

  // Pure translate.
  if (!hasRot && !hasScale) {
    return { a: 1, b: 0, c: 0, d: 1, e: t.x, f: t.y };
  }

  // Translate + pivoted rotate (no scale) — orbit/spin hot path.
  if (hasRot && !hasScale) {
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return {
      a: cos,
      b: sin,
      c: -sin,
      d: cos,
      e: t.x + pivot.x - cos * pivot.x + sin * pivot.y,
      f: t.y + pivot.y - sin * pivot.x - cos * pivot.y,
    };
  }

  // Translate + pivoted scale (no rotate) — bounceIn/zoomOut hot path.
  if (hasScale && !hasRot) {
    return {
      a: sx,
      b: 0,
      c: 0,
      d: sy,
      e: t.x + pivot.x * (1 - sx),
      f: t.y + pivot.y * (1 - sy),
    };
  }

  // General path: rotate + scale (or both).
  let m = hasTrans ? fromTranslate(t.x, t.y) : identity();
  m = multiply(m, fromTranslate(pivot.x, pivot.y));
  if (hasRot) m = multiply(m, fromRotate(r));
  if (hasScale) m = multiply(m, fromScale(sx, sy));
  m = multiply(m, fromTranslate(-pivot.x, -pivot.y));
  return m;
}

/** Comma-separated form — works as both an SVG `transform` attribute
 *  AND a CSS `transform` value (CSS requires commas). */
export const toString = (m: Matrix2D): string =>
  `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
