// Matrix2D: 6-field validation. Compare to scene/matrix.ts (176 lines).
//
// All ops here are self-returning (M → M) or scalar (M → number). The
// cross-struct cases — "transform a point" / "transform an AABB" —
// live on Vec and AABB respectively as `.in(matrix)` ops. This reads
// naturally ("the point in this frame") and keeps the framework's
// op-category split clean.

import { struct } from "./struct";

export type M = { a: number; b: number; c: number; d: number; e: number; f: number };

export const Matrix2D = struct<M>("Matrix2D", { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  .construct(
    (a: number, b: number, c: number, d: number, e: number, f: number): M => ({
      a, b, c, d, e, f,
    }),
  )
  .equals(
    (m, n) =>
      m.a === n.a && m.b === n.b && m.c === n.c &&
      m.d === n.d && m.e === n.e && m.f === n.f,
  )
  .ops({
    multiply: (a, b: M): M => ({
      a: a.a * b.a + a.c * b.b,
      b: a.b * b.a + a.d * b.b,
      c: a.a * b.c + a.c * b.d,
      d: a.b * b.c + a.d * b.d,
      e: a.a * b.e + a.c * b.f + a.e,
      f: a.b * b.e + a.d * b.f + a.f,
    }),
    invert: (m): M => {
      const det = m.a * m.d - m.b * m.c;
      const inv = 1 / det;
      return {
        a: m.d * inv,
        b: -m.b * inv,
        c: -m.c * inv,
        d: m.a * inv,
        e: (m.c * m.f - m.d * m.e) * inv,
        f: (m.b * m.e - m.a * m.f) * inv,
      };
    },
  })
  .scalars({
    determinant: (m): number => m.a * m.d - m.b * m.c,
  })
  .build();

/** Sugar — single-purpose constructors. */
export const translate = (x: number, y: number) =>
  Matrix2D.signal({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

export const matrixScale = (sx: number, sy: number) =>
  Matrix2D.signal({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });

export const matrixRotate = (angle: number) => {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return Matrix2D.signal({ a: c, b: s, c: -s, d: c, e: 0, f: 0 });
};
