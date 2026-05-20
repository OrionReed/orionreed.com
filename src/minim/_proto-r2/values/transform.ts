// transform.ts — reactive 2D transform (translate / scale / origin /
// rotate / opacity).
//
// Stresses:
//   - nested-class field lenses (`.translate` returns a `Vec`, not a `Num`)
//   - name collision: `Transform.scale` is the Vec axis lens; scalar
//     `scale(k)` only lives on TransformChain (caller documents this)
//   - full trait set (linear, lerp, metric, equals) on a 5-field
//     composite of mixed inner types
//   - SignalInit<T> for declarative construction:
//       transform({ translate: vec(0,0).bind(...), rotate: 0.3, ... })

import { Signal, computed, value, type Val, type SignalOptions } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { field, type SignalInit } from "../field";
import { Num } from "./num";
import {
  Vec,
  add as vAdd, sub as vSub, scale as vScale, lerp as vLerp,
  metric as vMetric, equals as vEquals,
  type VecValue,
} from "./vec";

export interface TransformValue {
  translate: VecValue;
  scale: VecValue;
  origin: VecValue;
  rotate: number;
  opacity: number;
}

export type TransformInit = SignalInit<TransformValue>;

export const DEFAULT: TransformValue = {
  translate: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  rotate: 0,
  opacity: 1,
};

export const add = (a: TransformValue, b: TransformValue): TransformValue => ({
  translate: vAdd(a.translate, b.translate),
  scale: vAdd(a.scale, b.scale),
  origin: vAdd(a.origin, b.origin),
  rotate: a.rotate + b.rotate,
  opacity: a.opacity + b.opacity,
});
export const sub = (a: TransformValue, b: TransformValue): TransformValue => ({
  translate: vSub(a.translate, b.translate),
  scale: vSub(a.scale, b.scale),
  origin: vSub(a.origin, b.origin),
  rotate: a.rotate - b.rotate,
  opacity: a.opacity - b.opacity,
});
export const scale = (a: TransformValue, k: number): TransformValue => ({
  translate: vScale(a.translate, k),
  scale: vScale(a.scale, k),
  origin: vScale(a.origin, k),
  rotate: a.rotate * k,
  opacity: a.opacity * k,
});
export const lerp = (a: TransformValue, b: TransformValue, t: number): TransformValue => ({
  translate: vLerp(a.translate, b.translate, t),
  scale: vLerp(a.scale, b.scale, t),
  origin: vLerp(a.origin, b.origin, t),
  rotate: a.rotate + (b.rotate - a.rotate) * t,
  opacity: a.opacity + (b.opacity - a.opacity) * t,
});
export const equals = (a: TransformValue, b: TransformValue) =>
  a === b || (
    vEquals(a.translate, b.translate) && vEquals(a.scale, b.scale) &&
    vEquals(a.origin, b.origin) && a.rotate === b.rotate && a.opacity === b.opacity
  );

/** Piecewise sum of axis distances. Used by spring/toward settle checks. */
export const metric = (a: TransformValue, b: TransformValue) =>
  vMetric(a.translate, b.translate) +
  vMetric(a.scale,     b.scale) +
  vMetric(a.origin,    b.origin) +
  Math.abs(a.rotate  - b.rotate) +
  Math.abs(a.opacity - b.opacity);

export class Transform extends Signal<TransformValue> {
  static traits: Required<TraitDict<TransformValue>> = {
    linear: { add, sub, scale } satisfies Linear<TransformValue>,
    lerp,
    metric,
    equals,
  };

  constructor(v: TransformValue = DEFAULT, opts?: SignalOptions<TransformValue>) {
    super(v, opts);
  }

  add(b: Val<TransformValue>) { return computed(() => add(this.value, value(b)), Transform); }
  sub(b: Val<TransformValue>) { return computed(() => sub(this.value, value(b)), Transform); }
  lerp(b: Val<TransformValue>, t: Val<number>) {
    return computed(() => lerp(this.value, value(b), value(t)), Transform);
  }

  // Field lenses — nested types: translate/scale/origin are Vecs.
  // `scale` here is the Vec axis lens, NOT scalar multiplication —
  // that lives on TransformChain only to avoid the collision.
  get translate(): Vec { return this.memo("translate", () => field(this, "translate", Vec)); }
  get scale(): Vec     { return this.memo("scale",     () => field(this, "scale",     Vec)); }
  get origin(): Vec    { return this.memo("origin",    () => field(this, "origin",    Vec)); }
  get rotate(): Num    { return this.memo("rotate",    () => field(this, "rotate",    Num)); }
  get opacity(): Num   { return this.memo("opacity",   () => field(this, "opacity",   Num)); }

  derive(fn: (c: TransformChain) => TransformChain) {
    return computed(() => fn(new TransformChain(this.value)).value, Transform);
  }
}

export interface Transform { readonly constructor: typeof Transform }

export class TransformChain {
  value: TransformValue;
  constructor(v: TransformValue) { this.value = v; }
  add(b: Val<TransformValue>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<TransformValue>) { this.value = sub(this.value, value(b)); return this; }
  /** Scalar multiply (chain-only — `Transform.scale` is the Vec axis lens). */
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<TransformValue>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
}

/** Construct a Transform; per-field reactive args bind via field lens. */
export const transform = (init?: TransformInit): Transform => {
  const tr = new Transform();
  if (init) {
    if (init.translate !== undefined) tr.translate.bind(init.translate);
    if (init.scale     !== undefined) tr.scale.bind(init.scale);
    if (init.origin    !== undefined) tr.origin.bind(init.origin);
    if (init.rotate    !== undefined) tr.rotate.bind(init.rotate);
    if (init.opacity   !== undefined) tr.opacity.bind(init.opacity);
  }
  return tr;
};
