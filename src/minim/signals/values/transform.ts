// transform.ts — reactive 2D affine-style composite
// (translate / scale / origin / rotate / opacity).

import { Signal, value, type Val } from "../signal";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../traits";
import { derived, field, type ReactiveInit } from "../derive";
import { tween, type Tween } from "../lerp";
import { type Easing } from "../../core";
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

const linearImpl: Linear<Value> = { add, sub, scale };

export class Transform extends Signal<Value> {
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

  // Trait slots — on prototype.
  get [LINEAR](): Linear<Value> { return linearImpl; }
  [LERP](a: Value, b: Value, t: number) { return lerp(a, b, t); }
  [METRIC](a: Value, b: Value) { return metric(a, b); }
  [EQUALS](a: Value, b: Value) { return equals(a, b); }

  to(target: Value, dur: Val<number>, ease?: Easing): Tween<Value> {
    return tween(this, target, dur, ease);
  }

  derive(fn: (c: TransformChain) => TransformChain) {
    return derived(Transform, () => fn(new TransformChain(this.value)).value);
  }
}

export class TransformChain {
  value: Value;
  constructor(v: Value) { this.value = v; }
  add(b: Val<Value>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<Value>) { this.value = sub(this.value, value(b)); return this; }
  /** Scalar multiply (only available in Chain to avoid clashing with
   *  the `transform.scale` axis lens on the reactive class). */
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<Value>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
}

/** Construct a Transform; per-field Val<T> args bind axes via lenses. */
export const transform = (init?: Init): Transform => {
  const tr = new Transform();
  if (init) {
    if (init.translate !== undefined) tr.translate.bind(init.translate);
    if (init.scale !== undefined) tr.scale.bind(init.scale);
    if (init.origin !== undefined) tr.origin.bind(init.origin);
    if (init.rotate !== undefined) tr.rotate.bind(init.rotate);
    if (init.opacity !== undefined) tr.opacity.bind(init.opacity);
  }
  return tr;
};
