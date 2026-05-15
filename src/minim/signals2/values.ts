// Value types — plain configs through `struct({...})`.
//
// New-style declaration: `defaults` entries can be Types directly. The
// framework reads `translate: Vec` as "field is a Vec, default is
// Vec.defaults"; `scale: Vec.with({x:1, y:1})` lets you override the
// default per-field. No separate `nested:` map.
//
// Other simplifications relative to legacy `signals/values/`:
//   • `equals` is auto-synthesised from field structure — drop the
//     hand-written `(a, b) => a.x === b.x && ...` where it's just
//     structural shallow equality.
//   • `construct: (...) => T` is gone — plain factory functions
//     (`rgb`, `box`, `mat`) take positional args and call `Type({...})`.
//   • `ops` + `scalars` are collapsed into a single `methods` bag.
//
// Compare to legacy `signals/values/transform.ts` (130 LOC, ~70 of
// which is hand-written algebra/lerp/metric/equals): Transform here
// is ~12 LOC. Capabilities compose from the nested types mechanically.

import { struct, cell, type Cell, type RO } from "./cell";

// Local helper: build a derived RO-cell from a getter that reads from
// `self`. Skips the `as unknown as RO<T>` casts that bare `computed()`
// requires — `cell.derived(fn)` returns the right shape already.
function derived<T>(fn: () => T): RO<T> { return cell.derived(fn); }

// ── Num ─────────────────────────────────────────────────────────────

export const Num = struct({
  name: "Num",
  defaults: 0 as number,
  lerp: (a, b, t) => a + (b - a) * t,
  linear: { add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k },
  metric: (a, b) => Math.abs(a - b),
  methods: {
    clamp: (a, lo: number, hi: number) => (a < lo ? lo : a > hi ? hi : a),
    abs: (a) => Math.abs(a),
  },
});

// ── Vec ─────────────────────────────────────────────────────────────

export interface V { x: number; y: number; }

export const Vec = struct({
  name: "Vec",
  defaults: { x: 0, y: 0 } as V,
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  linear: {
    add:   (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
  },
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  methods: {
    perp: (a): V => ({ x: -a.y, y: a.x }),
    normalize: (a): V => {
      const len = Math.hypot(a.x, a.y) || 1;
      return { x: a.x / len, y: a.y / len };
    },
  },
  getters: {
    // `length` is reserved (Function.prototype.length); RESERVED_NAMES
    // throws at struct() time if you try to use it.
    magnitude(this: Cell<V>) {
      const self = this;
      return derived(() => Math.hypot(self().x, self().y));
    },
  },
});

/** Construct a Vec cell from two numbers. */
export const vec = (x: number, y: number) => Vec({ x, y });

// ── Color ───────────────────────────────────────────────────────────

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const Color = struct({
  name: "Color",
  defaults: { r: 0, g: 0, b: 0, a: 1 } as Color,
  // equals auto-synthesised: r === r && g === g && b === b && a === a
  linear: {
    add:   (a, b) => ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a }),
    sub:   (a, b) => ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a }),
    scale: (a, k) => ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k }),
  },
  /** Component-wise lerp in linear RGBA. */
  lerp: (a, b, t) => ({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  }),
  methods: {
    /** Convex combination — like lerp but explicit alpha-combine. */
    blend: (a, b: Color, t: number): Color => ({
      r: a.r * (1 - t) + b.r * t,
      g: a.g * (1 - t) + b.g * t,
      b: a.b * (1 - t) + b.b * t,
      a: Math.max(a.a, b.a),
    }),
    withAlpha: (c, alpha: number): Color => ({ r: c.r, g: c.g, b: c.b, a: alpha }),
    lighten: (c, amount: number): Color => ({
      r: Math.min(1, c.r + amount),
      g: Math.min(1, c.g + amount),
      b: Math.min(1, c.b + amount),
      a: c.a,
    }),
  },
  getters: {
    /** Perceptual luminance ≈ 0..1. Lazy + cached. */
    luminance(this: Cell<Color>) {
      const self = this;
      return derived(() => {
        const c = self();
        return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      });
    },
    /** CSS `rgba(...)` string, reactive. */
    css(this: Cell<Color>) {
      const self = this;
      return derived(() => {
        const c = self();
        return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
      });
    },
  },
});

/** Construct an opaque Color cell from r, g, b in [0, 1]. */
export const rgb = (r: number, g: number, b: number) => Color({ r, g, b, a: 1 });

/** Construct a Color cell from r, g, b, a in [0, 1]. */
export const rgba = (r: number, g: number, b: number, a: number) =>
  Color({ r, g, b, a });

// ── Matrix2D ────────────────────────────────────────────────────────
//
// 2D affine matrices, SVG/Canvas convention:
//
//   | a c e |
//   | b d f |
//   | 0 0 1 |
//
// `multiply(A, B) = A·B` — B applies first, matching SVG `transform`.
//
// Plain-value helpers (`identity`, `fromTranslate`, ...) are exported
// alongside the reactive struct — single source of truth for matrix
// math. The reactive struct's `multiply`/`invert` methods reuse these.

/** Plain 2D affine matrix `{a,b,c,d,e,f}` (SVG/Canvas convention). */
export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const identity = (): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

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

export function multiplyMatrix(a: Matrix2D, b: Matrix2D): Matrix2D {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

export function invertMatrix(m: Matrix2D): Matrix2D {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) throw new Error("Matrix2D not invertible");
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

export const transformPoint = (m: Matrix2D, p: V): V => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

// Forward-declare for transformBox / Box's in-method.
type BoxShape = { x: number; y: number; w: number; h: number };

/** Loose Box enclosing the four transformed corners; identity short-circuits. */
export function transformBox(m: Matrix2D, b: BoxShape): BoxShape {
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
const SCALE_EPS = 1e-7;

/** Shape transform: `T(t) T(p) R(r) S(s) T(-p)`. Scales clamped away
 *  from zero (Firefox compositor leak on singular matrices). Fast paths
 *  for no-scale / no-rotate cases. */
export function composeMatrix(t: V, r: number, s: V, pivot: V): Matrix2D {
  const sx = Math.abs(s.x) < SCALE_EPS ? (s.x < 0 ? -SCALE_EPS : SCALE_EPS) : s.x;
  const sy = Math.abs(s.y) < SCALE_EPS ? (s.y < 0 ? -SCALE_EPS : SCALE_EPS) : s.y;

  const hasTrans = t.x !== 0 || t.y !== 0;
  const hasRot = r !== 0;
  const hasScale = sx !== 1 || sy !== 1;
  if (!hasTrans && !hasRot && !hasScale) return identity();

  if (!hasRot && !hasScale) return { a: 1, b: 0, c: 0, d: 1, e: t.x, f: t.y };

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
  m = multiplyMatrix(m, fromTranslate(pivot.x, pivot.y));
  if (hasRot)   m = multiplyMatrix(m, fromRotate(r));
  if (hasScale) m = multiplyMatrix(m, fromScale(sx, sy));
  m = multiplyMatrix(m, fromTranslate(-pivot.x, -pivot.y));
  return m;
}

/** Comma-separated — valid as both SVG and CSS `transform`. */
export const matrixToString = (m: Matrix2D): string =>
  `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;

export const Matrix2D = struct({
  name: "Matrix2D",
  defaults: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } as Matrix2D,
  // No linear/lerp/metric: matrix algebra isn't a vector-space-over-ℝ.
  // (You CAN add matrices component-wise but it's rarely useful; the
  // composable algebra IS matrix multiplication, which isn't `linear`.)
  // equals auto-synthesised.
  methods: {
    multiply: multiplyMatrix,
    invert: invertMatrix,
    determinant: (m): number => m.a * m.d - m.b * m.c,
  },
});

/** Construct a Matrix2D cell from six numbers. */
export const mat = (
  a: number, b: number, c: number, d: number, e: number, f: number,
) => Matrix2D({ a, b, c, d, e, f });

// ── Box ─────────────────────────────────────────────────────────────

/** Plain `{x, y, w, h}` rectangular region. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Plain Box value constructor. */
export const box = (x: number, y: number, w: number, h: number): Box =>
  ({ x, y, w, h });

/** Expand a box by `n` pixels in every direction. */
export const expandBox = (b: Box, n: number): Box =>
  box(b.x - n, b.y - n, b.w + 2 * n, b.h + 2 * n);

/** Smallest box enclosing all inputs. */
export function unionBox(...bs: Box[]): Box {
  if (bs.length === 0) return box(0, 0, 0, 0);
  let xMin = bs[0].x;
  let yMin = bs[0].y;
  let xMax = xMin + bs[0].w;
  let yMax = yMin + bs[0].h;
  for (let i = 1; i < bs.length; i++) {
    const o = bs[i];
    if (o.x < xMin) xMin = o.x;
    if (o.y < yMin) yMin = o.y;
    if (o.x + o.w > xMax) xMax = o.x + o.w;
    if (o.y + o.h > yMax) yMax = o.y + o.h;
  }
  return box(xMin, yMin, xMax - xMin, yMax - yMin);
}

/** Perimeter point on a Box facing `toward`. Used by default
 *  Shape boundary. */
export function boxEdgeFrom(
  b: Box,
  toward: { x: number; y: number },
): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min(
    dx === 0 ? Infinity : (b.w / 2) / Math.abs(dx),
    dy === 0 ? Infinity : (b.h / 2) / Math.abs(dy),
  );
  return { x: cx + dx * k, y: cy + dy * k };
}

export const Box = struct({
  name: "Box",
  defaults: { x: 0, y: 0, w: 0, h: 0 } as Box,
  // equals auto-synthesised.
  linear: {
    add:   (a, b) => ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h }),
    sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k }),
  },
  lerp: (a, b, t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  }),
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h),
  methods: {
    expand: expandBox,
    union: (a, b: Box): Box => unionBox(a, b),
    in: (b, m: Matrix2D): Box => transformBox(m, b) as Box,
    /** Parametric anchor: `(0,0)` top-left, `(1,1)` bottom-right. */
    at: (b, u: number, v: number): V => ({ x: b.x + u * b.w, y: b.y + v * b.h }),
    /** Point-in-box test. */
    contains: (b, p: V): boolean =>
      p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h,
  },
  getters: {
    /** Area of this box, reactive + cached. */
    area(this: Cell<Box>) {
      const self = this;
      return derived(() => {
        const b = self();
        return b.w * b.h;
      });
    },
    /** Self-reference — lets reactive Box cells satisfy the `BoxLike`
     *  interface (which has `.box: RO<Box>`). Shape/Part hold the Box
     *  as a field; bare reactive Box cells satisfy the same surface
     *  via this self-getter (`b.box === b`). */
    box(this: any) {
      return this;
    },
    /** Centre — `at(0.5, 0.5)`, cached. */
    center(this: Cell<Box>) {
      const self = this;
      return derived(() => {
        const b = self();
        return { x: b.x + 0.5 * b.w, y: b.y + 0.5 * b.h };
      });
    },
    top(this: Cell<Box>) {
      const self = this;
      return derived(() => {
        const b = self();
        return { x: b.x + 0.5 * b.w, y: b.y };
      });
    },
    bottom(this: Cell<Box>) {
      const self = this;
      return derived(() => {
        const b = self();
        return { x: b.x + 0.5 * b.w, y: b.y + b.h };
      });
    },
    left(this: Cell<Box>) {
      const self = this;
      return derived(() => {
        const b = self();
        return { x: b.x, y: b.y + 0.5 * b.h };
      });
    },
    right(this: Cell<Box>) {
      const self = this;
      return derived(() => {
        const b = self();
        return { x: b.x + b.w, y: b.y + 0.5 * b.h };
      });
    },
  },
});

/** Reactive parametric anchor on a Box — sugar over `box.at(u, v)`. */
export const boxAt = (b: { at: (u: number, v: number) => any }, u: number, v: number) =>
  b.at(u, v);

// ── BoxLike — structural surface ────────────────────────────────────
//
// Implemented by reactive `Box` cells AND by shapes/parts that carry
// a `.box` field. Consumers take `BoxLike` and don't care which.

export interface BoxLike {
  readonly box: RO<Box>;
  readonly x: RO<number>;
  readonly y: RO<number>;
  readonly w: RO<number>;
  readonly h: RO<number>;
  readonly center: RO<V>;
  readonly top: RO<V>;
  readonly bottom: RO<V>;
  readonly left: RO<V>;
  readonly right: RO<V>;
  at(u: number, v: number): RO<V>;
}

/** Detect a `BoxLike` value structurally — anything with `box` and
 *  `at`. Accepts both object-shape (Shape/Part instances) and
 *  function-shape (signals2 reactive Box cells, which are callable). */
export function isBox(v: unknown): v is BoxLike {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    "box" in (v as object) &&
    typeof (v as { at?: unknown }).at === "function"
  );
}

// ── Transform ───────────────────────────────────────────────────────

export interface Tr {
  translate: V; rotate: number; scale: V; origin: V; opacity: number;
}

// NEW STYLE: typed-entry defaults. No separate `nested:` map needed.
// The framework reads each entry:
//   - `Vec` (a Type)              → typed field, init = Vec.defaults
//   - `Num.with(1)` (a FieldSpec) → typed field, init overrides default
//   - Plain values                → primitive field, no type
//
// Composite linear/lerp/metric/equals are synthesised from this map.
export const Transform = struct({
  name: "Transform",
  defaults: {
    translate: Vec,                              // typed, init = {x:0, y:0}
    scale: Vec.with({ x: 1, y: 1 }),             // typed, override init
    origin: Vec,                                 // typed
    rotate: Num,                                 // typed, init = 0
    opacity: Num.with(1),                        // typed, override init
  },
  storage: "soa",
});
