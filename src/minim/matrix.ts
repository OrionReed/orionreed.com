// 2D affine matrices in SVG/Canvas convention. Plain object struct
// `{a, b, c, d, e, f}` representing
//
//   | a c e |
//   | b d f |
//   | 0 0 1 |
//
// Composition is left-to-right (the SVG `transform="A B C"` order):
// `multiply(A, B)` produces a matrix that applies A *after* B when
// transforming a point — i.e. `Mp = A·B·p`.

import { aabb, type AABB, type Vec } from "./bounds";

export interface Matrix2D {
  a: number; b: number;
  c: number; d: number;
  e: number; f: number;
}

export const identity = (): Matrix2D =>
  ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export const fromTranslate = (x: number, y: number): Matrix2D =>
  ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

export const fromScale = (x: number, y: number): Matrix2D =>
  ({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });

export const fromRotate = (angle: number): Matrix2D => {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
};

export const isIdentity = (m: Matrix2D): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

/** `multiply(a, b)` = the matrix that applies `b` first, then `a`. */
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

/** Loose AABB enclosing the four transformed corners of `b`. Returns
 *  `b` unchanged when `m` is the identity. */
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

/** Compose a Shape transform: translate × pivoted rotate × pivoted
 *  scale. Equivalent to the SVG transform list
 *  `translate(t) translate(pivot) rotate(r) scale(s) translate(-pivot)`. */
export function compose(t: Vec, r: number, s: Vec, pivot: Vec): Matrix2D {
  const hasTrans = t.x !== 0 || t.y !== 0;
  const hasRot = r !== 0;
  const hasScale = s.x !== 1 || s.y !== 1;
  if (!hasTrans && !hasRot && !hasScale) return identity();

  let m = hasTrans ? fromTranslate(t.x, t.y) : identity();
  if (hasRot || hasScale) {
    m = multiply(m, fromTranslate(pivot.x, pivot.y));
    if (hasRot) m = multiply(m, fromRotate(r));
    if (hasScale) m = multiply(m, fromScale(s.x, s.y));
    m = multiply(m, fromTranslate(-pivot.x, -pivot.y));
  }
  return m;
}

export const toString = (m: Matrix2D): string =>
  `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
