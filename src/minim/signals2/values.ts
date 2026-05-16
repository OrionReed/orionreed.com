// values.ts — hand-written value types.
//
// Each value-type is a class extending Signal. Methods return the same
// type for fluent chaining (vec.add(b).scale(2)). Static traits enable
// generic dispatch via classOf/traitsOf/requireTraits.
//
// Two ways to use methods reactively:
//
//   1. Method chain:      vec.add(b).scale(2)               N Computeds
//   2. derive(c => …):    vec.derive(c => c.add(b).scale(2)) 1 Computed
//
// Both are observationally equivalent. Pick (2) for deep chains.
//
// Per-class `derive` is declared on each value-type class, so the
// chain parameter `c` is properly typed (e.g. VecChain) inside the
// lambda. There is no Signal.prototype.derive — derive is a value-
// type concern.

import {
  Signal, Computed, Lens, value,
  type Val, type CommonTraits, type Linear, type Lerp, type Metric, type Equals,
} from "./engine";
import { Chain, derived, typedField, typedLensClass } from "./derive";

// ════════════════════════════════════════════════════════════════════
// Num — primitive number
// ════════════════════════════════════════════════════════════════════

const numLinear: Linear<number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  scale: (a, k) => a * k,
};
const numLerp: Lerp<number> = (a, b, t) => a + (b - a) * t;
const numMetric: Metric<number> = (a, b) => Math.abs(a - b);
const numEquals: Equals<number> = (a, b) => a === b;

class NumChain extends Chain<number> {
  add(b: Val<number>): this { this.value += value(b); return this; }
  sub(b: Val<number>): this { this.value -= value(b); return this; }
  scale(k: Val<number>): this { this.value *= value(k); return this; }
  clamp(lo: Val<number>, hi: Val<number>): this {
    const v = this.value, l = value(lo), h = value(hi);
    this.value = v < l ? l : v > h ? h : v;
    return this;
  }
}

export class Num extends Signal<number> {
  static traits: CommonTraits<number> = {
    linear: numLinear, lerp: numLerp, metric: numMetric, equals: numEquals,
  };
  static add = numLinear.add;
  static sub = numLinear.sub;
  static scale = numLinear.scale;
  static lerp = numLerp;

  constructor(v: Val<number> = 0) { super(v); }

  // Reactive methods — chainable.
  add(b: Val<number>): Num { return derived(Num, () => this.value + value(b)); }
  sub(b: Val<number>): Num { return derived(Num, () => this.value - value(b)); }
  scale(k: Val<number>): Num { return derived(Num, () => this.value * value(k)); }
  clamp(lo: Val<number>, hi: Val<number>): Num {
    return derived(Num, () => {
      const v = this.value, l = value(lo), h = value(hi);
      return v < l ? l : v > h ? h : v;
    });
  }

  // Fluent reactive chain. Single Computed, regardless of depth.
  derive(fn: (c: NumChain) => NumChain): Num {
    return derived(Num, () => fn(new NumChain(this.value)).value);
  }
}

export const num = (v: Val<number> = 0): Num => new Num(v);

// ════════════════════════════════════════════════════════════════════
// Vec — 2D point
// ════════════════════════════════════════════════════════════════════

export interface V { x: number; y: number }

const vAdd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});
const vMetric = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);
const vEquals: Equals<V> = (a, b) => a === b || (a.x === b.x && a.y === b.y);

class VecChain extends Chain<V> {
  add(b: Val<V>): this { this.value = vAdd(this.value, value(b)); return this; }
  sub(b: Val<V>): this { this.value = vSub(this.value, value(b)); return this; }
  scale(k: Val<number>): this { this.value = vScale(this.value, value(k)); return this; }
  lerp(b: Val<V>, t: Val<number>): this { this.value = vLerp(this.value, value(b), value(t)); return this; }
}

export class Vec extends Signal<V> {
  static traits: CommonTraits<V> = {
    linear: { add: vAdd, sub: vSub, scale: vScale },
    lerp: vLerp, metric: vMetric, equals: vEquals,
  };
  static add = vAdd;
  static sub = vSub;
  static scale = vScale;
  static lerp = vLerp;
  static metric = vMetric;

  constructor(v: Val<V> = { x: 0, y: 0 }) { super(v); }

  add(b: Val<V>): Vec { return derived(Vec, () => vAdd(this.value, value(b))); }
  sub(b: Val<V>): Vec { return derived(Vec, () => vSub(this.value, value(b))); }
  scale(k: Val<number>): Vec { return derived(Vec, () => vScale(this.value, value(k))); }
  lerp(b: Val<V>, t: Val<number>): Vec { return derived(Vec, () => vLerp(this.value, value(b), value(t))); }

  // Per-axis projections — typed Num lenses, no casts at call site.
  get x(): Num { return typedField(this, "x", NumLens); }
  get y(): Num { return typedField(this, "y", NumLens); }

  get magnitude(): Num {
    return this._mag ??= derived(Num, () => Math.hypot(this.value.x, this.value.y));
  }
  private _mag?: Num;

  derive(fn: (c: VecChain) => VecChain): Vec {
    return derived(Vec, () => fn(new VecChain(this.value)).value);
  }
}

const NumLens = typedLensClass<number, Num>(Num);

export const vec = (x: Val<number> = 0, y: Val<number> = 0): Vec =>
  new Vec({ x: value(x), y: value(y) });

// ════════════════════════════════════════════════════════════════════
// Color — RGBA
// ════════════════════════════════════════════════════════════════════

export interface C { r: number; g: number; b: number; a: number }

const cAdd = (a: C, b: C): C => ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a });
const cSub = (a: C, b: C): C => ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a });
const cScale = (a: C, k: number): C => ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k });
const cLerp = (a: C, b: C, t: number): C => ({
  r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t,
});
const cEquals: Equals<C> = (a, b) =>
  a === b || (a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a);

class ColorChain extends Chain<C> {
  add(b: Val<C>): this { this.value = cAdd(this.value, value(b)); return this; }
  scale(k: Val<number>): this { this.value = cScale(this.value, value(k)); return this; }
  lerp(b: Val<C>, t: Val<number>): this { this.value = cLerp(this.value, value(b), value(t)); return this; }
}

export class Color extends Signal<C> {
  static traits: CommonTraits<C> = {
    linear: { add: cAdd, sub: cSub, scale: cScale },
    lerp: cLerp, equals: cEquals,
  };
  static add = cAdd;
  static lerp = cLerp;

  constructor(v: Val<C> = { r: 0, g: 0, b: 0, a: 1 }) { super(v); }

  add(b: Val<C>): Color { return derived(Color, () => cAdd(this.value, value(b))); }
  scale(k: Val<number>): Color { return derived(Color, () => cScale(this.value, value(k))); }
  lerp(b: Val<C>, t: Val<number>): Color { return derived(Color, () => cLerp(this.value, value(b), value(t))); }

  get luminance(): Num {
    return this._lum ??= derived(Num, () => {
      const c = this.value;
      return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    });
  }
  private _lum?: Num;

  derive(fn: (c: ColorChain) => ColorChain): Color {
    return derived(Color, () => fn(new ColorChain(this.value)).value);
  }
}

export const rgb = (r: number, g: number, b: number): Color => new Color({ r, g, b, a: 1 });
export const rgba = (r: number, g: number, b: number, a: number): Color => new Color({ r, g, b, a });

// ════════════════════════════════════════════════════════════════════
// Box — rectangle
// ════════════════════════════════════════════════════════════════════

export interface B { x: number; y: number; w: number; h: number }

const bAdd = (a: B, b: B): B => ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
const bSub = (a: B, b: B): B => ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
const bScale = (a: B, k: number): B => ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
const bLerp = (a: B, b: B, t: number): B => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});
const bEquals: Equals<B> = (a, b) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

class BoxChain extends Chain<B> {
  add(b: Val<B>): this { this.value = bAdd(this.value, value(b)); return this; }
  scale(k: Val<number>): this { this.value = bScale(this.value, value(k)); return this; }
  lerp(b: Val<B>, t: Val<number>): this { this.value = bLerp(this.value, value(b), value(t)); return this; }
  expand(n: Val<number>): this {
    const b = this.value, nv = value(n);
    this.value = { x: b.x - nv, y: b.y - nv, w: b.w + 2 * nv, h: b.h + 2 * nv };
    return this;
  }
}

export class Box extends Signal<B> {
  static traits: CommonTraits<B> = {
    linear: { add: bAdd, sub: bSub, scale: bScale }, lerp: bLerp, equals: bEquals,
  };
  static add = bAdd;
  static scale = bScale;
  static lerp = bLerp;

  constructor(v: Val<B> = { x: 0, y: 0, w: 0, h: 0 }) { super(v); }

  expand(n: Val<number>): Box {
    return derived(Box, () => {
      const b = this.value, nv = value(n);
      return { x: b.x - nv, y: b.y - nv, w: b.w + 2 * nv, h: b.h + 2 * nv };
    });
  }

  get area(): Num {
    return this._area ??= derived(Num, () => this.value.w * this.value.h);
  }
  private _area?: Num;

  derive(fn: (c: BoxChain) => BoxChain): Box {
    return derived(Box, () => fn(new BoxChain(this.value)).value);
  }
}

export const box = (x: number, y: number, w: number, h: number): Box =>
  new Box({ x, y, w, h });

// ════════════════════════════════════════════════════════════════════
// Transform — composite
// ════════════════════════════════════════════════════════════════════

export interface Tr {
  translate: V; scale: V; origin: V; rotate: number; opacity: number;
}

const trAdd = (a: Tr, b: Tr): Tr => ({
  translate: vAdd(a.translate, b.translate),
  scale: vAdd(a.scale, b.scale),
  origin: vAdd(a.origin, b.origin),
  rotate: a.rotate + b.rotate,
  opacity: a.opacity + b.opacity,
});
const trLerp = (a: Tr, b: Tr, t: number): Tr => ({
  translate: vLerp(a.translate, b.translate, t),
  scale: vLerp(a.scale, b.scale, t),
  origin: vLerp(a.origin, b.origin, t),
  rotate: a.rotate + (b.rotate - a.rotate) * t,
  opacity: a.opacity + (b.opacity - a.opacity) * t,
});
const trEquals: Equals<Tr> = (a, b) =>
  a === b || (
    vEquals(a.translate, b.translate) &&
    vEquals(a.scale, b.scale) &&
    vEquals(a.origin, b.origin) &&
    a.rotate === b.rotate &&
    a.opacity === b.opacity
  );

const TR_DEFAULT: Tr = { translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, rotate: 0, opacity: 1 };

class TrChain extends Chain<Tr> {
  add(b: Val<Tr>): this { this.value = trAdd(this.value, value(b)); return this; }
  lerp(b: Val<Tr>, t: Val<number>): this { this.value = trLerp(this.value, value(b), value(t)); return this; }
}

export class Transform extends Signal<Tr> {
  static traits: CommonTraits<Tr> = { lerp: trLerp, equals: trEquals };
  static add = trAdd;
  static lerp = trLerp;

  constructor(v: Val<Tr> = TR_DEFAULT) { super(v); }

  add(b: Val<Tr>): Transform { return derived(Transform, () => trAdd(this.value, value(b))); }
  lerp(b: Val<Tr>, t: Val<number>): Transform { return derived(Transform, () => trLerp(this.value, value(b), value(t))); }

  // Typed nested fields — Vec/Num backed by typed lenses, no casts.
  get translate(): Vec { return typedField(this, "translate", VecLens); }
  get scale(): Vec { return typedField(this, "scale", VecLens); }
  get origin(): Vec { return typedField(this, "origin", VecLens); }
  get rotate(): Num { return typedField(this, "rotate", NumLens); }
  get opacity(): Num { return typedField(this, "opacity", NumLens); }

  derive(fn: (c: TrChain) => TrChain): Transform {
    return derived(Transform, () => fn(new TrChain(this.value)).value);
  }
}

const VecLens = typedLensClass<V, Vec>(Vec);

export const transform = (init?: Partial<Tr>): Transform =>
  new Transform(init ? { ...TR_DEFAULT, ...init } : TR_DEFAULT);

// ════════════════════════════════════════════════════════════════════
// mean<T> — generic op via traits
// ════════════════════════════════════════════════════════════════════

import { computed, requireTraits } from "./engine";

/** Reactive arithmetic mean of N cells of the same type T. */
export function mean<T>(...cells: Signal<T>[]): Computed<T> {
  if (cells.length === 0) throw new Error("mean: need ≥1 cell");
  const { linear } = requireTraits(cells[0], "linear");
  const n = cells.length;
  const invN = 1 / n;
  return computed(() => {
    let acc = cells[0].value;
    for (let i = 1; i < n; i++) acc = linear.add(acc, cells[i].value);
    return linear.scale(acc, invN);
  });
}
