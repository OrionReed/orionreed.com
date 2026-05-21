// transform.ts — reactive 2D transform.
//
// Nested field lenses (`.translate` → `Vec`). The name-collision
// pattern of r2 (`Transform.scale` is a Vec axis lens) becomes
// straightforward here: `scale` field overrides the invertible
// `scale(k)` method.

import {
  Signal, computed, lens as lensFactory, value,
  type Val, type SignalOptions, type Of,
} from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { applyOp1, type Op } from "../ops";
import { type Writable } from "../writable";
import { Num } from "./num";
import {
  Vec,
  add as vAdd, sub as vSub, scale as vScale, lerp as vLerp,
  metric as vMetric, equals as vEquals,
} from "./vec";

type V = {
  translate: Of<Vec>;
  scale: Of<Vec>;
  origin: Of<Vec>;
  rotate: number;
  opacity: number;
};

export const DEFAULT: V = {
  translate: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  rotate: 0,
  opacity: 1,
};

export const add = (a: V, b: V): V => ({
  translate: vAdd(a.translate, b.translate),
  scale:     vAdd(a.scale,     b.scale),
  origin:    vAdd(a.origin,    b.origin),
  rotate:    a.rotate + b.rotate,
  opacity:   a.opacity + b.opacity,
});
export const sub = (a: V, b: V): V => ({
  translate: vSub(a.translate, b.translate),
  scale:     vSub(a.scale,     b.scale),
  origin:    vSub(a.origin,    b.origin),
  rotate:    a.rotate - b.rotate,
  opacity:   a.opacity - b.opacity,
});
export const scale = (a: V, k: number): V => ({
  translate: vScale(a.translate, k),
  scale:     vScale(a.scale,     k),
  origin:    vScale(a.origin,    k),
  rotate:    a.rotate * k,
  opacity:   a.opacity * k,
});
export const lerp = (a: V, b: V, t: number): V => ({
  translate: vLerp(a.translate, b.translate, t),
  scale:     vLerp(a.scale,     b.scale,     t),
  origin:    vLerp(a.origin,    b.origin,    t),
  rotate:    a.rotate + (b.rotate - a.rotate) * t,
  opacity:   a.opacity + (b.opacity - a.opacity) * t,
});
export const equals = (a: V, b: V) =>
  a === b || (
    vEquals(a.translate, b.translate) && vEquals(a.scale, b.scale) &&
    vEquals(a.origin, b.origin) && a.rotate === b.rotate && a.opacity === b.opacity
  );
export const metric = (a: V, b: V) =>
  vMetric(a.translate, b.translate) + vMetric(a.scale, b.scale) +
  vMetric(a.origin,    b.origin)    + Math.abs(a.rotate  - b.rotate) +
  Math.abs(a.opacity - b.opacity);

const linearImpl: Linear<V> = { add, sub, scale };

const addOp: Op<V, [V]> = { fwd: add, bwd: sub };
const subOp: Op<V, [V]> = { fwd: sub, bwd: add };

export class Transform extends Signal<V> {
  static traits: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };
  /** Only `add`/`sub` are invertible eager methods. Scalar `scale` lives
   *  here as a Vec field lens (`.scale`), not a method — to scalar-multiply
   *  a Transform, build a custom Lens via `Transform.lens` or compose via
   *  field writes. */
  static invertibles = ["add", "sub"] as const;
  constructor(v: V = DEFAULT, opts?: SignalOptions<V>) { super(v, opts) }

  add(b: Val<V>): Transform { return applyOp1(this, addOp, b, Transform) }
  sub(b: Val<V>): Transform { return applyOp1(this, subOp, b, Transform) }
  lerp(b: Val<V>, t: Val<number>): Transform {
    return computed(() => lerp(this.value, value(b), value(t)), Transform);
  }

  get translate(): Vec { return this.field("translate", Vec) }
  get scale(): Vec     { return this.field("scale",     Vec) }
  get origin(): Vec    { return this.field("origin",    Vec) }
  get rotate(): Num    { return this.field("rotate",    Num) }
  get opacity(): Num   { return this.field("opacity",   Num) }

  static derive(fn: () => V): Transform { return computed(fn, Transform) }
  static lens(get: () => V, set: (v: V) => void): Writable<Transform> {
    return lensFactory(get, set, Transform) as unknown as Writable<Transform>;
  }
  static is(v: unknown): v is Transform { return v instanceof Transform }
}
export interface Transform {
  readonly constructor: typeof Transform;
  get value(): V;
}

export type TransformInit = { [K in keyof V]?: Val<V[K]> };

export function transform(init?: TransformInit): Writable<Transform> {
  const tr = new Transform() as Writable<Transform>;
  if (init) {
    if (init.translate !== undefined) tr.translate.bind(init.translate);
    if (init.scale     !== undefined) tr.scale.bind(init.scale);
    if (init.origin    !== undefined) tr.origin.bind(init.origin);
    if (init.rotate    !== undefined) tr.rotate.bind(init.rotate);
    if (init.opacity   !== undefined) tr.opacity.bind(init.opacity);
  }
  return tr;
}
