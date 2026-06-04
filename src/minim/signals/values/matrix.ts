// matrix.ts — reactive 2D affine matrix (SVG/Canvas convention).
//
// Sparse-trait: only `equals`. Element-wise linear combine / lerp don't
// decompose for matrices, so `spring`/`tween`/`mean` reject Matrix at
// compile time. Two invertibles, both `: this` via `Cell#lens`:
//   - `multiply(b)` — inverse multiplies by `invert(b)`
//   - `invert()`    — its own inverse

import { Cell, type Init, type Inner, reader, type Val, type Writable } from "../signal";
import type { TraitDict } from "../traits";
import { derived, field } from "../writable";
import { Num, num } from "./num";
import type { Vec } from "./vec";

type V = { a: number; b: number; c: number; d: number; e: number; f: number };
type BoxV = { x: number; y: number; w: number; h: number };

export const identity = (): V => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
export const fromTranslate = (x: number, y: number): V => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
export const fromScale = (x: number, y: number): V => ({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
export const fromRotate = (angle: number): V => {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
};

export const isIdentity = (m: V): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

export const equals = (m: V, n: V): boolean =>
  m === n ||
  (m.a === n.a && m.b === n.b && m.c === n.c && m.d === n.d && m.e === n.e && m.f === n.f);

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
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
}

export const determinant = (m: V): number => m.a * m.d - m.b * m.c;

export const transformPoint = (m: V, p: Inner<Vec>): Inner<Vec> => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

export function transformBox(m: V, b: BoxV): BoxV {
  if (isIdentity(m)) return b;
  const x0 = b.x,
    y0 = b.y,
    x1 = b.x + b.w,
    y1 = b.y + b.h;
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

export function compose(t: Inner<Vec>, r: number, s: Inner<Vec>, pivot: Inner<Vec>): V {
  const sx = Math.abs(s.x) < SCALE_EPS ? (s.x < 0 ? -SCALE_EPS : SCALE_EPS) : s.x;
  const sy = Math.abs(s.y) < SCALE_EPS ? (s.y < 0 ? -SCALE_EPS : SCALE_EPS) : s.y;
  let m = fromTranslate(t.x, t.y);
  m = multiply(m, fromTranslate(pivot.x, pivot.y));
  if (r !== 0) m = multiply(m, fromRotate(r));
  if (sx !== 1 || sy !== 1) m = multiply(m, fromScale(sx, sy));
  m = multiply(m, fromTranslate(-pivot.x, -pivot.y));
  return m;
}

export const toMatrixString = (m: V): string => `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;

export class Matrix extends Cell<V> {
  static traits = { equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Matrix.traits;

  constructor(v: V = identity()) {
    super(v, { equals });
  }

  multiply(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => multiply(v, bf()),
      n => multiply(n, invert(bf())),
    );
  }
  invert(): this {
    return this.lens(invert, invert);
  }

  get a() {
    return field(this, "a", Num);
  }
  get b() {
    return field(this, "b", Num);
  }
  get c() {
    return field(this, "c", Num);
  }
  get d() {
    return field(this, "d", Num);
  }
  get e() {
    return field(this, "e", Num);
  }
  get f() {
    return field(this, "f", Num);
  }

  get determinant() {
    return derived(this, "determinant", Num, determinant);
  }
}

/** Writable `Matrix` with entries `(a, b, c, d, e, f)` (SVG/Canvas order).
 *  Each entry is a literal `number` (lifted to a fresh seed) or an existing
 *  `Writable<Num>` (identity passthrough). RO sources are rejected at the
 *  type level — use `Matrix.derive(...)` for reactive RO tracking, or
 *  `cell.value` to snapshot. Lock an entry with `Num.pin(c)`. */
export function matrix(
  a: Init<Num> = 1,
  b: Init<Num> = 0,
  c: Init<Num> = 0,
  d: Init<Num> = 1,
  e: Init<Num> = 0,
  f: Init<Num> = 0,
): Writable<Matrix> {
  if (
    typeof a === "number" &&
    typeof b === "number" &&
    typeof c === "number" &&
    typeof d === "number" &&
    typeof e === "number" &&
    typeof f === "number"
  ) {
    return new Matrix({ a, b, c, d, e, f }) as Writable<Matrix>;
  }
  const aN = num(a);
  const bN = num(b);
  const cN = num(c);
  const dN = num(d);
  const eN = num(e);
  const fN = num(f);
  // The view fully reconstructs all 6 cells (1-arg bwd ⇒ no source read).
  return Matrix.lens(
    [aN, bN, cN, dN, eN, fN] as const,
    ([a, b, c, d, e, f]) => ({ a, b, c, d, e, f }),
    v => [v.a, v.b, v.c, v.d, v.e, v.f],
  );
}
