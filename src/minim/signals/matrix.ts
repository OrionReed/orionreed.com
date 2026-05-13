// 2D affine matrices, SVG/Canvas convention:
//
//   | a c e |
//   | b d f |
//   | 0 0 1 |
//
// `multiply(A, B)` is `A·B` — B applies first, matching SVG `transform`.
//
// Single source of truth for matrix math: plain-value helpers (used in
// Shape's per-frame transform composition) AND the registered `Matrix2D`
// struct (used for reactive matrix signals). The struct's
// `multiply`/`invert` ops reuse the plain-value implementations.

import { struct } from "./struct";
import type { V } from "./vec";

export type Matrix2D = { a: number; b: number; c: number; d: number; e: number; f: number };

// Plain Box shape (kept local to avoid a circular import with `./box`).
type Box = { x: number; y: number; w: number; h: number };

// ── Plain-value helpers ────────────────────────────────────────────

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

export const transformPoint = (m: Matrix2D, p: V): V => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

/** Loose Box enclosing the four transformed corners; identity short-circuits. */
export function transformBox(m: Matrix2D, b: Box): Box {
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
export function compose(t: V, r: number, s: V, pivot: V): Matrix2D {
  // Clamp by magnitude, not equality — tweens crossing zero pass
  // through small floats that equality-clamp would miss.
  const sx =
    Math.abs(s.x) < SCALE_EPS ? (s.x < 0 ? -SCALE_EPS : SCALE_EPS) : s.x;
  const sy =
    Math.abs(s.y) < SCALE_EPS ? (s.y < 0 ? -SCALE_EPS : SCALE_EPS) : s.y;

  const hasTrans = t.x !== 0 || t.y !== 0;
  const hasRot = r !== 0;
  const hasScale = sx !== 1 || sy !== 1;
  if (!hasTrans && !hasRot && !hasScale) return identity();

  if (!hasRot && !hasScale) {
    return { a: 1, b: 0, c: 0, d: 1, e: t.x, f: t.y };
  }

  // Translate + pivoted rotate — orbit/spin hot path.
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

  // Translate + pivoted scale — bounceIn/zoomOut hot path.
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

  let m = hasTrans ? fromTranslate(t.x, t.y) : identity();
  m = multiply(m, fromTranslate(pivot.x, pivot.y));
  if (hasRot) m = multiply(m, fromRotate(r));
  if (hasScale) m = multiply(m, fromScale(sx, sy));
  m = multiply(m, fromTranslate(-pivot.x, -pivot.y));
  return m;
}

/** Comma-separated — valid as both SVG `transform` and CSS `transform`. */
export const toString = (m: Matrix2D): string =>
  `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;

// ── Reactive struct ────────────────────────────────────────────────

export const Matrix2D = struct<Matrix2D>(
  "Matrix2D",
  { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
)
  .construct(
    (a: number, b: number, c: number, d: number, e: number, f: number): Matrix2D => ({
      a, b, c, d, e, f,
    }),
  )
  .equals(
    (m, n) =>
      m.a === n.a && m.b === n.b && m.c === n.c &&
      m.d === n.d && m.e === n.e && m.f === n.f,
  )
  .ops({
    multiply,
    invert,
  })
  .scalars({
    determinant: (m): number => m.a * m.d - m.b * m.c,
  })
  .build();
