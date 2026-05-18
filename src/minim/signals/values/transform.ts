// transform.ts — reactive 2D affine-style composite
// (translate / scale / origin / rotate / opacity).

import { Signal, value, type Val } from "../signal";
import { LINEAR, LERP, METRIC, EQUALS } from "../traits";
import { BaseChain, derived, field, bindFields, type ReactiveInit } from "../derive";
import { defineTrait, type LerpMethods } from "../lerp";
import { Num } from "./num";
import {
  Vec,
  add as vAdd,
  sub as vSub,
  scale as vScale,
  lerp as vLerp,
  metric as vMetric,
  equals as vEquals,
  type Value as VecShape,
} from "./vec";

export interface Value {
  translate: VecShape;
  scale: VecShape;
  origin: VecShape;
  rotate: number;
  opacity: number;
}
export type Init = ReactiveInit<Value>;

export const DEFAULT: Value = {
  translate: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  rotate: 0,
  opacity: 1,
};

export const add = (a: Value, b: Value): Value => ({
  translate: vAdd(a.translate, b.translate),
  scale: vAdd(a.scale, b.scale),
  origin: vAdd(a.origin, b.origin),
  rotate: a.rotate + b.rotate,
  opacity: a.opacity + b.opacity,
});
export const sub = (a: Value, b: Value): Value => ({
  translate: vSub(a.translate, b.translate),
  scale: vSub(a.scale, b.scale),
  origin: vSub(a.origin, b.origin),
  rotate: a.rotate - b.rotate,
  opacity: a.opacity - b.opacity,
});
export const scale = (a: Value, k: number): Value => ({
  translate: vScale(a.translate, k),
  scale: vScale(a.scale, k),
  origin: vScale(a.origin, k),
  rotate: a.rotate * k,
  opacity: a.opacity * k,
});
export const lerp = (a: Value, b: Value, t: number): Value => ({
  translate: vLerp(a.translate, b.translate, t),
  scale: vLerp(a.scale, b.scale, t),
  origin: vLerp(a.origin, b.origin, t),
  rotate: a.rotate + (b.rotate - a.rotate) * t,
  opacity: a.opacity + (b.opacity - a.opacity) * t,
});
export const equals = (a: Value, b: Value) =>
  a === b || (
    vEquals(a.translate, b.translate) && vEquals(a.scale, b.scale) &&
    vEquals(a.origin, b.origin) && a.rotate === b.rotate && a.opacity === b.opacity
  );
/** Piecewise sum of axis distances. Used by `spring`/`toward` settle-checks. */
export const metric = (a: Value, b: Value) =>
  vMetric(a.translate, b.translate) +
  vMetric(a.scale,     b.scale) +
  vMetric(a.origin,    b.origin) +
  Math.abs(a.rotate  - b.rotate) +
  Math.abs(a.opacity - b.opacity);

/** Op surface — closed-on-Transform operations. Implemented by
 *  reactive `Transform` and the mutating `Chain`.
 *
 *  Note: scalar `scale(k)` is intentionally **not** here. `transform.scale`
 *  is the per-axis Vec lens (`tr.scale.value = {x:2,y:2}`); scalar
 *  multiplication of the whole Transform is the [LINEAR] trait, accessed
 *  via `tr.derive(c => c.scale(k))` or `requireLinear(tr).scale(v, k)`. */
interface TransformOps<R> {
  add(b: Val<Value>): R;
  sub(b: Val<Value>): R;
  lerp(b: Val<Value>, t: Val<number>): R;
}

export class Transform extends Signal<Value> implements TransformOps<Transform> {
  constructor(v: Value = DEFAULT) { super(v); }

  add(b: Val<Value>) { return derived(Transform, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return derived(Transform, () => sub(this.value, value(b))); }
  lerp(b: Val<Value>, t: Val<number>) {
    return derived(Transform, () => lerp(this.value, value(b), value(t)));
  }

  get translate() { return field(this, "translate", Vec); }
  get scale() { return field(this, "scale", Vec); }
  get origin() { return field(this, "origin", Vec); }
  get rotate() { return field(this, "rotate", Num); }
  get opacity() { return field(this, "opacity", Num); }

  derive(fn: (c: Chain) => Chain) {
    return derived(Transform, () => fn(new Chain(this.value)).value);
  }
}
export interface Transform extends LerpMethods<Value> {}

class Chain extends BaseChain<Value> implements TransformOps<Chain> {
  add(b: Val<Value>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<Value>) { this.value = sub(this.value, value(b)); return this; }
  /** Scalar multiply (only available in Chain to avoid clashing with
   *  the `transform.scale` axis lens on the reactive class). */
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<Value>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
}

defineTrait(Transform, LINEAR, { add, sub, scale });
defineTrait(Transform, LERP,   lerp);
defineTrait(Transform, METRIC, metric);
defineTrait(Transform, EQUALS, equals);

/** Construct a Transform; per-field Val<T> args bind axes via lenses. */
export const transform = (init?: Init): Transform => {
  const tr = new Transform();
  if (init) bindFields(tr, init);
  return tr;
};
