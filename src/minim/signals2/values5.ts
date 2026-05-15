// values5.ts — Num, Vec, Color, Box, Matrix2D, Transform for cell5.
// Same source-of-truth pattern: declare functions once, ref in both
// `methods:` (lifted) and `traits:` (generic dispatch).

import { struct, type Cell, computed } from "./cell5";

// ── Num ─────────────────────────────────────────────────────────────

const nAdd = (a: number, b: number) => a + b;
const nSub = (a: number, b: number) => a - b;
const nScale = (a: number, k: number) => a * k;
const nLerp = (a: number, b: number, t: number) => a + (b - a) * t;
const nMetric = (a: number, b: number) => Math.abs(a - b);

export const Num = struct({
  tag: "Num",
  value: 0 as number,
  methods: { add: nAdd, sub: nSub, scale: nScale, lerp: nLerp, abs: (a: number) => Math.abs(a) },
  traits: { linear: { add: nAdd, sub: nSub, scale: nScale }, lerp: nLerp, metric: nMetric },
});

// ── Vec ─────────────────────────────────────────────────────────────

export interface V { x: number; y: number }

const vAdd   = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vSub   = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const vLerp  = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const vMetric = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);
const vPerp  = (a: V): V => ({ x: -a.y, y: a.x });

export const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: { add: vAdd, sub: vSub, scale: vScale, lerp: vLerp, perp: vPerp },
  getters: {
    magnitude(this: Cell<V>) {
      const self = this;
      return computed(() => Math.hypot(self().x, self().y));
    },
  },
  traits: { linear: { add: vAdd, sub: vSub, scale: vScale }, lerp: vLerp, metric: vMetric },
});

export const vec = (x: number, y: number) => Vec({ x, y });

// ── Color ───────────────────────────────────────────────────────────

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

export const Color = struct({
  tag: "Color",
  value: { r: 0, g: 0, b: 0, a: 1 } as Color,
  methods: { add: cAdd, sub: cSub, scale: cScale, lerp: cLerp },
  traits: { linear: { add: cAdd, sub: cSub, scale: cScale }, lerp: cLerp },
});

export const rgb = (r: number, g: number, b: number) => Color({ r, g, b, a: 1 });

// ── Box ─────────────────────────────────────────────────────────────

export interface Box { x: number; y: number; w: number; h: number }

const bAdd = (a: Box, b: Box): Box => ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
const bSub = (a: Box, b: Box): Box => ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
const bScale = (a: Box, k: number): Box => ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
const bLerp = (a: Box, b: Box, t: number): Box => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});

export const Box = struct({
  tag: "Box",
  value: { x: 0, y: 0, w: 0, h: 0 } as Box,
  methods: { add: bAdd, sub: bSub, scale: bScale, lerp: bLerp,
    expand: (b: Box, n: number): Box => ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n }) },
  traits: { linear: { add: bAdd, sub: bSub, scale: bScale }, lerp: bLerp },
});

// ── Transform ───────────────────────────────────────────────────────

export interface Tr {
  translate: V; scale: V; rotate: number; opacity: number;
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

export const Transform = struct({
  tag: "Transform",
  value: {
    translate: Vec,
    scale:     Vec.with({ x: 1, y: 1 }),
    rotate:    0,
    opacity:   1,
  },
  // No `scale` method — would shadow the field.
  methods: { add: trAdd, sub: trSub, lerp: trLerp },
  traits: { linear: { add: trAdd, sub: trSub, scale: trScale }, lerp: trLerp },
});
