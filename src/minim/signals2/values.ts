// values.ts — built-in value types: Num, Vec, Color, Box, Transform.
//
// Each is a class extending Signal. Methods return the same type for
// fluent chaining. Trait slots (`[LINEAR]`, `[LERP]`, etc.) are stamped
// on the prototype after the class declaration.
//
// `namespace X` + `class X` merging carries the plain-value shape
// (`X.Value`) alongside the reactive class.
//
// Two chain styles, observationally equivalent:
//   vec.add(b).scale(2)                 N Computeds, fluent on signals
//   vec.derive(c => c.add(b).scale(2))  1 Computed, fluent on Chain

import {
  Signal, value, batch,
  type Computed,
  type Val,
} from "./signal";
import {
  LINEAR, LERP, METRIC, EQUALS,
  type Linear, type Lerp, type Metric, type Equals,
} from "./traits";
import { Chain, derived, field } from "./derive";
import {
  lerpImpl, physicsImpl,
  type LerpMethods, type PhysicsMethods,
} from "./animations";

// ════════════════════════════════════════════════════════════════════
// Num — primitive number
// ════════════════════════════════════════════════════════════════════

const numLinear: Linear<number> = {
  add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k,
};
const numLerp: Lerp<number> = (a, b, t) => a + (b - a) * t;
const numMetric: Metric<number> = (a, b) => Math.abs(a - b);
const numEquals: Equals<number> = (a, b) => a === b;

class NumChain extends Chain<number> {
  add(b: Val<number>) { this.value += value(b); return this; }
  sub(b: Val<number>) { this.value -= value(b); return this; }
  scale(k: Val<number>) { this.value *= value(k); return this; }
  clamp(lo: Val<number>, hi: Val<number>) {
    const v = this.value, l = value(lo), h = value(hi);
    this.value = v < l ? l : v > h ? h : v;
    return this;
  }
}

export class Num extends Signal<number> {
  constructor(v: number = 0) { super(v); }

  add(b: Val<number>) { return derived(Num, () => this.value + value(b)); }
  sub(b: Val<number>) { return derived(Num, () => this.value - value(b)); }
  scale(k: Val<number>) { return derived(Num, () => this.value * value(k)); }
  clamp(lo: Val<number>, hi: Val<number>) {
    return derived(Num, () => {
      const v = this.value, l = value(lo), h = value(hi);
      return v < l ? l : v > h ? h : v;
    });
  }

  derive(fn: (c: NumChain) => NumChain) {
    return derived(Num, () => fn(new NumChain(this.value)).value);
  }
}

// `interface X` declaration-merging adds methods at the type level;
// `Object.assign` installs them at runtime. Both adjacent.
export interface Num extends LerpMethods<number>, PhysicsMethods<number> {}

Num.prototype[LINEAR] = numLinear;
Num.prototype[LERP]   = numLerp;
Num.prototype[METRIC] = numMetric;
Num.prototype[EQUALS] = numEquals;
Object.assign(Num.prototype, lerpImpl, physicsImpl);

/** Construct a Num; reactive sources follow live via `.bind()`. */
export const num = (v: Val<number> = 0): Num => {
  const n = new Num();
  n.bind(v);
  return n;
};

// ════════════════════════════════════════════════════════════════════
// Vec — 2D point
// ════════════════════════════════════════════════════════════════════

export namespace Vec {
  export type Value = { x: number; y: number };
}

const vAdd = (a: Vec.Value, b: Vec.Value): Vec.Value => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: Vec.Value, b: Vec.Value): Vec.Value => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: Vec.Value, k: number): Vec.Value => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: Vec.Value, b: Vec.Value, t: number): Vec.Value => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});
const vMetric = (a: Vec.Value, b: Vec.Value) => Math.hypot(a.x - b.x, a.y - b.y);
const vEquals: Equals<Vec.Value> = (a, b) => a === b || (a.x === b.x && a.y === b.y);

class VecChain extends Chain<Vec.Value> {
  add(b: Val<Vec.Value>) { this.value = vAdd(this.value, value(b)); return this; }
  sub(b: Val<Vec.Value>) { this.value = vSub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = vScale(this.value, value(k)); return this; }
  lerp(b: Val<Vec.Value>, t: Val<number>) { this.value = vLerp(this.value, value(b), value(t)); return this; }
}

export class Vec extends Signal<Vec.Value> {
  constructor(v: Vec.Value = { x: 0, y: 0 }) { super(v); }

  add(b: Val<Vec.Value>) { return derived(Vec, () => vAdd(this.value, value(b))); }
  sub(b: Val<Vec.Value>) { return derived(Vec, () => vSub(this.value, value(b))); }
  scale(k: Val<number>) { return derived(Vec, () => vScale(this.value, value(k))); }
  lerp(b: Val<Vec.Value>, t: Val<number>) { return derived(Vec, () => vLerp(this.value, value(b), value(t))); }

  // Per-axis projections: typed Num lenses.
  get x() { return field(this, "x", Num); }
  get y() { return field(this, "y", Num); }

  get magnitude() {
    return this._mag ??= derived(Num, () => Math.hypot(this.value.x, this.value.y));
  }
  private _mag?: Num;

  derive(fn: (c: VecChain) => VecChain) {
    return derived(Vec, () => fn(new VecChain(this.value)).value);
  }
}

export interface Vec extends LerpMethods<Vec.Value>, PhysicsMethods<Vec.Value> {}

Vec.prototype[LINEAR] = { add: vAdd, sub: vSub, scale: vScale };
Vec.prototype[LERP]   = vLerp;
Vec.prototype[METRIC] = vMetric;
Vec.prototype[EQUALS] = vEquals;
Object.assign(Vec.prototype, lerpImpl, physicsImpl);

/** Construct a Vec; per-axis reactive args bind the corresponding lens. */
export const vec = (x: Val<number> = 0, y: Val<number> = 0): Vec => {
  const v = new Vec();
  // batch: avoid transient `{x: rx, y: 0}` if v is observed mid-build.
  batch(() => { v.x.bind(x); v.y.bind(y); });
  return v;
};

// ════════════════════════════════════════════════════════════════════
// Color — RGBA
// ════════════════════════════════════════════════════════════════════

export namespace Color {
  export type Value = { r: number; g: number; b: number; a: number };
}

const cAdd = (a: Color.Value, b: Color.Value): Color.Value =>
  ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a });
const cSub = (a: Color.Value, b: Color.Value): Color.Value =>
  ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a });
const cScale = (a: Color.Value, k: number): Color.Value =>
  ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k });
const cLerp = (a: Color.Value, b: Color.Value, t: number): Color.Value => ({
  r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t,
});
const cEquals: Equals<Color.Value> = (a, b) =>
  a === b || (a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a);

class ColorChain extends Chain<Color.Value> {
  add(b: Val<Color.Value>) { this.value = cAdd(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = cScale(this.value, value(k)); return this; }
  lerp(b: Val<Color.Value>, t: Val<number>) { this.value = cLerp(this.value, value(b), value(t)); return this; }
}

export class Color extends Signal<Color.Value> {
  constructor(v: Color.Value = { r: 0, g: 0, b: 0, a: 1 }) { super(v); }

  add(b: Val<Color.Value>) { return derived(Color, () => cAdd(this.value, value(b))); }
  scale(k: Val<number>) { return derived(Color, () => cScale(this.value, value(k))); }
  lerp(b: Val<Color.Value>, t: Val<number>) { return derived(Color, () => cLerp(this.value, value(b), value(t))); }

  get luminance() {
    return this._lum ??= derived(Num, () => {
      const c = this.value;
      return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    });
  }
  private _lum?: Num;

  derive(fn: (c: ColorChain) => ColorChain) {
    return derived(Color, () => fn(new ColorChain(this.value)).value);
  }
}

// Color has [LERP] so .to() is available; no [METRIC] so no spring/toward.
export interface Color extends LerpMethods<Color.Value> {}

Color.prototype[LINEAR] = { add: cAdd, sub: cSub, scale: cScale };
Color.prototype[LERP]   = cLerp;
Color.prototype[EQUALS] = cEquals;
Object.assign(Color.prototype, lerpImpl);

export const rgb = (r: number, g: number, b: number) => new Color({ r, g, b, a: 1 });
export const rgba = (r: number, g: number, b: number, a: number) => new Color({ r, g, b, a });

// ════════════════════════════════════════════════════════════════════
// Box — rectangle
// ════════════════════════════════════════════════════════════════════

export namespace Box {
  export type Value = { x: number; y: number; w: number; h: number };
}

const bAdd = (a: Box.Value, b: Box.Value): Box.Value =>
  ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
const bSub = (a: Box.Value, b: Box.Value): Box.Value =>
  ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
const bScale = (a: Box.Value, k: number): Box.Value =>
  ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
const bLerp = (a: Box.Value, b: Box.Value, t: number): Box.Value => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});
const bEquals: Equals<Box.Value> = (a, b) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

class BoxChain extends Chain<Box.Value> {
  add(b: Val<Box.Value>) { this.value = bAdd(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = bScale(this.value, value(k)); return this; }
  lerp(b: Val<Box.Value>, t: Val<number>) { this.value = bLerp(this.value, value(b), value(t)); return this; }
  expand(n: Val<number>) {
    const b = this.value, nv = value(n);
    this.value = { x: b.x - nv, y: b.y - nv, w: b.w + 2 * nv, h: b.h + 2 * nv };
    return this;
  }
}

export class Box extends Signal<Box.Value> {
  constructor(v: Box.Value = { x: 0, y: 0, w: 0, h: 0 }) { super(v); }

  expand(n: Val<number>) {
    return derived(Box, () => {
      const b = this.value, nv = value(n);
      return { x: b.x - nv, y: b.y - nv, w: b.w + 2 * nv, h: b.h + 2 * nv };
    });
  }

  get area() {
    return this._area ??= derived(Num, () => this.value.w * this.value.h);
  }
  private _area?: Num;

  derive(fn: (c: BoxChain) => BoxChain) {
    return derived(Box, () => fn(new BoxChain(this.value)).value);
  }
}

export interface Box extends LerpMethods<Box.Value> {}

Box.prototype[LINEAR] = { add: bAdd, sub: bSub, scale: bScale };
Box.prototype[LERP]   = bLerp;
Box.prototype[EQUALS] = bEquals;
Object.assign(Box.prototype, lerpImpl);

export const box = (x: number, y: number, w: number, h: number) => new Box({ x, y, w, h });

// ════════════════════════════════════════════════════════════════════
// Transform — composite
// ════════════════════════════════════════════════════════════════════

export namespace Transform {
  export type Value = {
    translate: Vec.Value;
    scale: Vec.Value;
    origin: Vec.Value;
    rotate: number;
    opacity: number;
  };
  /** Per-field reactive init: each field accepts Val<T>. */
  export type Init = { [K in keyof Value]?: Val<Value[K]> };
}

const trAdd = (a: Transform.Value, b: Transform.Value): Transform.Value => ({
  translate: vAdd(a.translate, b.translate),
  scale: vAdd(a.scale, b.scale),
  origin: vAdd(a.origin, b.origin),
  rotate: a.rotate + b.rotate,
  opacity: a.opacity + b.opacity,
});
const trLerp = (a: Transform.Value, b: Transform.Value, t: number): Transform.Value => ({
  translate: vLerp(a.translate, b.translate, t),
  scale: vLerp(a.scale, b.scale, t),
  origin: vLerp(a.origin, b.origin, t),
  rotate: a.rotate + (b.rotate - a.rotate) * t,
  opacity: a.opacity + (b.opacity - a.opacity) * t,
});
const trEquals: Equals<Transform.Value> = (a, b) =>
  a === b || (
    vEquals(a.translate, b.translate) && vEquals(a.scale, b.scale) &&
    vEquals(a.origin, b.origin) && a.rotate === b.rotate && a.opacity === b.opacity
  );

const TR_DEFAULT: Transform.Value = {
  translate: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 },
  rotate: 0, opacity: 1,
};

class TrChain extends Chain<Transform.Value> {
  add(b: Val<Transform.Value>) { this.value = trAdd(this.value, value(b)); return this; }
  lerp(b: Val<Transform.Value>, t: Val<number>) {
    this.value = trLerp(this.value, value(b), value(t)); return this;
  }
}

export class Transform extends Signal<Transform.Value> {
  constructor(v: Transform.Value = TR_DEFAULT) { super(v); }

  add(b: Val<Transform.Value>) { return derived(Transform, () => trAdd(this.value, value(b))); }
  lerp(b: Val<Transform.Value>, t: Val<number>) {
    return derived(Transform, () => trLerp(this.value, value(b), value(t)));
  }

  get translate() { return field(this, "translate", Vec); }
  get scale() { return field(this, "scale", Vec); }
  get origin() { return field(this, "origin", Vec); }
  get rotate() { return field(this, "rotate", Num); }
  get opacity() { return field(this, "opacity", Num); }

  derive(fn: (c: TrChain) => TrChain) {
    return derived(Transform, () => fn(new TrChain(this.value)).value);
  }
}

export interface Transform extends LerpMethods<Transform.Value> {}

Transform.prototype[LERP]   = trLerp;
Transform.prototype[EQUALS] = trEquals;
Object.assign(Transform.prototype, lerpImpl);

/** Construct a Transform. Each field accepts Val<T> — plain, signal, or thunk. */
export const transform = (init?: Transform.Init): Transform => {
  const tr = new Transform();
  if (init) {
    batch(() => {
      for (const k in init) {
        const v = init[k as keyof Transform.Init];
        if (v !== undefined) tr[k as keyof Transform.Init].bind(v as never);
      }
    });
  }
  return tr;
};

// ════════════════════════════════════════════════════════════════════
// mean<T> — generic via [LINEAR]
// ════════════════════════════════════════════════════════════════════

import { computed } from "./signal";
import { requireLinear } from "./traits";

/** Reactive arithmetic mean. Requires `[LINEAR]` on the first cell. */
export function mean<T>(...cells: Signal<T>[]): Computed<T> {
  if (cells.length === 0) throw new Error("mean: need ≥1 cell");
  const linear = requireLinear(cells[0]);
  const n = cells.length;
  const invN = 1 / n;
  return computed(() => {
    let acc = cells[0].value;
    for (let i = 1; i < n; i++) acc = linear.add(acc, cells[i].value);
    return linear.scale(acc, invN);
  });
}
