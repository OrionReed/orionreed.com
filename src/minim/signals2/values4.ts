// values4.ts — value types ported to cell4 (fused storage + native lens).
//
// Shape per type:
//
//   1. Plain TypeScript interface for the value shape.
//   2. Top-level pure functions (add, sub, scale, lerp, metric, ...).
//      Defined ONCE; referenced from both `methods:` (for ergonomic
//      reactive `cell.add(b)`) and `traits:` (for generic dispatch
//      `Vec.traits.linear.add`).
//   3. The struct({...}) call.
//
// No synthesis, no compose helpers. Composites (Transform) write their
// traits by hand, delegating to the field types' traits.

import { struct, type Cell, type RO } from "./cell4";
import { computed } from "./engine2";

// ────────────────────────────────────────────────────────────────────
// Num — scalar struct, just a number plus capability bag.
// ────────────────────────────────────────────────────────────────────

const numAdd = (a: number, b: number) => a + b;
const numSub = (a: number, b: number) => a - b;
const numScale = (a: number, k: number) => a * k;
const numLerp = (a: number, b: number, t: number) => a + (b - a) * t;
const numMetric = (a: number, b: number) => Math.abs(a - b);

export const Num = struct({
  tag: "Num",
  value: 0 as number,
  methods: {
    add: numAdd, sub: numSub, scale: numScale, lerp: numLerp,
    abs: (a: number) => Math.abs(a),
    clamp: (a: number, lo: number, hi: number) => (a < lo ? lo : a > hi ? hi : a),
  },
  traits: {
    linear: { add: numAdd, sub: numSub, scale: numScale },
    lerp: numLerp,
    metric: numMetric,
  },
});

// ────────────────────────────────────────────────────────────────────
// Vec — 2D vector. Most common value type.
// ────────────────────────────────────────────────────────────────────

export interface V { x: number; y: number }

const vAdd   = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vSub   = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const vLerp  = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const vMetric = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);
const vPerp  = (a: V): V => ({ x: -a.y, y: a.x });
const vNormalize = (a: V): V => {
  const len = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / len, y: a.y / len };
};

export const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: {
    add: vAdd, sub: vSub, scale: vScale, lerp: vLerp,
    perp: vPerp, normalize: vNormalize,
  },
  getters: {
    magnitude(this: Cell<V>) {
      const self = this;
      return computed(() => Math.hypot(self().x, self().y));
    },
  },
  traits: {
    linear: { add: vAdd, sub: vSub, scale: vScale },
    lerp: vLerp,
    metric: vMetric,
  },
});

/** Positional ctor — `vec(1, 2)` ⇒ `Vec({x:1, y:2})`. */
export const vec = (x: number, y: number) => Vec({ x, y });

// ────────────────────────────────────────────────────────────────────
// Color — RGBA in [0, 1].
// ────────────────────────────────────────────────────────────────────

export interface Color { r: number; g: number; b: number; a: number }

const cAdd = (a: Color, b: Color): Color => ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a });
const cSub = (a: Color, b: Color): Color => ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a });
const cScale = (a: Color, k: number): Color => ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k });
const cLerp = (a: Color, b: Color, t: number): Color => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
  a: a.a + (b.a - a.a) * t,
});
const cEquals = (a: Color, b: Color): boolean =>
  a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
const cBlend = (a: Color, b: Color, t: number): Color => ({
  r: a.r * (1 - t) + b.r * t,
  g: a.g * (1 - t) + b.g * t,
  b: a.b * (1 - t) + b.b * t,
  a: Math.max(a.a, b.a),
});
const cWithAlpha = (c: Color, alpha: number): Color => ({ r: c.r, g: c.g, b: c.b, a: alpha });
const cLighten = (c: Color, amount: number): Color => ({
  r: Math.min(1, c.r + amount),
  g: Math.min(1, c.g + amount),
  b: Math.min(1, c.b + amount),
  a: c.a,
});

export const Color = struct({
  tag: "Color",
  value: { r: 0, g: 0, b: 0, a: 1 } as Color,
  methods: {
    add: cAdd, sub: cSub, scale: cScale, lerp: cLerp,
    blend: cBlend, withAlpha: cWithAlpha, lighten: cLighten,
  },
  getters: {
    luminance(this: Cell<Color>) {
      const self = this;
      return computed(() => {
        const c = self();
        return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      });
    },
    css(this: Cell<Color>) {
      const self = this;
      return computed(() => {
        const c = self();
        return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
      });
    },
  },
  traits: {
    linear: { add: cAdd, sub: cSub, scale: cScale },
    lerp: cLerp,
    equals: cEquals,
  },
});

export const rgb = (r: number, g: number, b: number) => Color({ r, g, b, a: 1 });
export const rgba = (r: number, g: number, b: number, a: number) => Color({ r, g, b, a });

// ────────────────────────────────────────────────────────────────────
// Matrix2D — 2D affine matrix. No linear trait (matmul isn't linear).
// ────────────────────────────────────────────────────────────────────

export interface Matrix2D {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export const identity = (): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export const fromTranslate = (x: number, y: number): Matrix2D =>
  ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

export const fromScale = (x: number, y: number): Matrix2D =>
  ({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });

export const fromRotate = (angle: number): Matrix2D => {
  const s = Math.sin(angle); const c = Math.cos(angle);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
};

export const isIdentity = (m: Matrix2D): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

const mMultiply = (a: Matrix2D, b: Matrix2D): Matrix2D => ({
  a: a.a * b.a + a.c * b.b,
  b: a.b * b.a + a.d * b.b,
  c: a.a * b.c + a.c * b.d,
  d: a.b * b.c + a.d * b.d,
  e: a.a * b.e + a.c * b.f + a.e,
  f: a.b * b.e + a.d * b.f + a.f,
});

const mInvert = (m: Matrix2D): Matrix2D => {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) throw new Error("Matrix2D not invertible");
  const inv = 1 / det;
  return {
    a:  m.d * inv, b: -m.b * inv,
    c: -m.c * inv, d:  m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
};

const mDeterminant = (m: Matrix2D): number => m.a * m.d - m.b * m.c;

const mEquals = (a: Matrix2D, b: Matrix2D): boolean =>
  a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.e === b.e && a.f === b.f;

export const Matrix2D = struct({
  tag: "Matrix2D",
  value: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } as Matrix2D,
  methods: {
    multiply: mMultiply, invert: mInvert, determinant: mDeterminant,
  },
  traits: { equals: mEquals },
});

export const mat = (a: number, b: number, c: number, d: number, e: number, f: number) =>
  Matrix2D({ a, b, c, d, e, f });

// ────────────────────────────────────────────────────────────────────
// Box — `{x, y, w, h}` rectangle.
// ────────────────────────────────────────────────────────────────────

export interface Box { x: number; y: number; w: number; h: number }

const bAdd = (a: Box, b: Box): Box => ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
const bSub = (a: Box, b: Box): Box => ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
const bScale = (a: Box, k: number): Box => ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
const bLerp = (a: Box, b: Box, t: number): Box => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});
const bMetric = (a: Box, b: Box): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h);

const bExpand = (b: Box, n: number): Box =>
  ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n });

const bAt = (b: Box, u: number, v: number): V => ({ x: b.x + u * b.w, y: b.y + v * b.h });
const bContains = (b: Box, p: V): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

export const Box = struct({
  tag: "Box",
  value: { x: 0, y: 0, w: 0, h: 0 } as Box,
  methods: {
    add: bAdd, sub: bSub, scale: bScale, lerp: bLerp,
    expand: bExpand, at: bAt, contains: bContains,
  },
  getters: {
    area(this: Cell<Box>) {
      const self = this;
      return computed(() => { const b = self(); return b.w * b.h; });
    },
    center(this: Cell<Box>) {
      const self = this;
      return computed(() => {
        const b = self();
        return { x: b.x + 0.5 * b.w, y: b.y + 0.5 * b.h };
      });
    },
  },
  traits: {
    linear: { add: bAdd, sub: bSub, scale: bScale },
    lerp: bLerp,
    metric: bMetric,
  },
});

export const box = (x: number, y: number, w: number, h: number) => Box({ x, y, w, h });

// ────────────────────────────────────────────────────────────────────
// Transform — composite. Traits written by hand, delegating to Vec.
// ────────────────────────────────────────────────────────────────────

export interface Tr {
  translate: V;
  scale: V;
  rotate: number;
  opacity: number;
}

const trAdd = (a: Tr, b: Tr): Tr => ({
  translate: vAdd(a.translate, b.translate),
  scale:     vAdd(a.scale, b.scale),
  rotate:    a.rotate + b.rotate,
  opacity:   a.opacity + b.opacity,
});
const trSub = (a: Tr, b: Tr): Tr => ({
  translate: vSub(a.translate, b.translate),
  scale:     vSub(a.scale, b.scale),
  rotate:    a.rotate - b.rotate,
  opacity:   a.opacity - b.opacity,
});
const trScale = (a: Tr, k: number): Tr => ({
  translate: vScale(a.translate, k),
  scale:     vScale(a.scale, k),
  rotate:    a.rotate * k,
  opacity:   a.opacity * k,
});
const trLerp = (a: Tr, b: Tr, t: number): Tr => ({
  translate: vLerp(a.translate, b.translate, t),
  scale:     vLerp(a.scale, b.scale, t),
  rotate:    a.rotate + (b.rotate - a.rotate) * t,
  opacity:   a.opacity + (b.opacity - a.opacity) * t,
});
const trMetric = (a: Tr, b: Tr): number => {
  const dt = vMetric(a.translate, b.translate);
  const ds = vMetric(a.scale, b.scale);
  const dr = a.rotate - b.rotate;
  const dop = a.opacity - b.opacity;
  return Math.sqrt(dt * dt + ds * ds + dr * dr + dop * dop);
};

export const Transform = struct({
  tag: "Transform",
  value: {
    translate: Vec,                       // sub-cell lens of Vec type
    scale:     Vec.with({ x: 1, y: 1 }),  // custom default via Type.with()
    rotate:    0,
    opacity:   1,
  },
  // No `scale` method — collides with the `scale` field. Use the static
  // `Transform.scale(tr, k)` or the trait `Transform.traits.linear.scale`.
  methods: {
    add: trAdd, sub: trSub, lerp: trLerp,
  },
  traits: {
    linear: { add: trAdd, sub: trSub, scale: trScale },
    lerp: trLerp,
    metric: trMetric,
  },
});

/** `Object.is`-style structural equality for use with arbitrary value types. */
export type Eq<T> = (a: T, b: T) => boolean;
