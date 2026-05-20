// vec.ts — reactive 2D point.

import { Signal, value, type Val } from "../signal";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../traits";
import { derived, field } from "../derive";
import { tween, type Tween } from "../lerp";
import { type Easing } from "../../core";
import { Num } from "./num";

export interface Value { x: number; y: number }

export const add = (a: Value, b: Value): Value => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Value, b: Value): Value => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Value, k: number): Value => ({ x: a.x * k, y: a.y * k });
export const lerp = (a: Value, b: Value, t: number): Value => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});
export const metric = (a: Value, b: Value) => Math.hypot(a.x - b.x, a.y - b.y);
export const equals = (a: Value, b: Value) => a === b || (a.x === b.x && a.y === b.y);

/** Unit vector along `v`; `(0, 0)` stays `(0, 0)`. */
export const normalize = (v: Value): Value => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};
/** 90° CCW rotation (y-down: rotates left): `(x, y) → (y, -x)`. */
export const perp = (v: Value): Value => ({ x: v.y, y: -v.x });

const linearImpl: Linear<Value> = { add, sub, scale };

export class Vec extends Signal<Value> {
  constructor(v: Value = { x: 0, y: 0 }) { super(v); }

  // Trait slots — on prototype, copied by viewClassFor.
  get [LINEAR](): Linear<Value> { return linearImpl; }
  [LERP](a: Value, b: Value, t: number) { return lerp(a, b, t); }
  [METRIC](a: Value, b: Value) { return metric(a, b); }
  [EQUALS](a: Value, b: Value) { return equals(a, b); }

  /** Tween-builder, implied by [LERP]. */
  to(target: Value, dur: Val<number>, ease?: Easing): Tween<Value> {
    return tween(this, target, dur, ease);
  }

  add(b: Val<Value>) { return derived(Vec, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return derived(Vec, () => sub(this.value, value(b))); }
  scale(k: Val<number>) { return derived(Vec, () => scale(this.value, value(k))); }
  lerp(b: Val<Value>, t: Val<number>) {
    return derived(Vec, () => lerp(this.value, value(b), value(t)));
  }

  up(n: Val<number>)    { return derived(Vec, () => ({ x: this.value.x,            y: this.value.y - value(n) })); }
  down(n: Val<number>)  { return derived(Vec, () => ({ x: this.value.x,            y: this.value.y + value(n) })); }
  left(n: Val<number>)  { return derived(Vec, () => ({ x: this.value.x - value(n), y: this.value.y })); }
  right(n: Val<number>) { return derived(Vec, () => ({ x: this.value.x + value(n), y: this.value.y })); }

  /** Add an offset by (dx, dy). Sugar for `.add({x:dx, y:dy})`. */
  offset(dx: Val<number>, dy: Val<number>) {
    return derived(Vec, () => ({ x: this.value.x + value(dx), y: this.value.y + value(dy) }));
  }
  /** Reactive unit-vector along this; `(0,0)` maps to `(0,0)`. */
  normalize() { return derived(Vec, () => normalize(this.value)); }
  /** 90° CCW rotation (y-down → rotates left). */
  perp() { return derived(Vec, () => perp(this.value)); }
  /** Euclidean distance to `other` as a reactive Num. */
  distance(other: Val<Value>) {
    return derived(Num, () => metric(this.value, value(other)));
  }

  get x() { return field(this, "x", Num); }
  get y() { return field(this, "y", Num); }

  get magnitude() { return this._mag ??= derived(Num, () => Math.hypot(this.value.x, this.value.y)); }
  private _mag?: Num;

  derive(fn: (c: VecChain) => VecChain) {
    return derived(Vec, () => fn(new VecChain(this.value)).value);
  }
}

export class VecChain {
  value: Value;
  constructor(v: Value) { this.value = v; }
  add(b: Val<Value>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<Value>) { this.value = sub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<Value>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
  up(n: Val<number>)    { this.value = { x: this.value.x,            y: this.value.y - value(n) }; return this; }
  down(n: Val<number>)  { this.value = { x: this.value.x,            y: this.value.y + value(n) }; return this; }
  left(n: Val<number>)  { this.value = { x: this.value.x - value(n), y: this.value.y }; return this; }
  right(n: Val<number>) { this.value = { x: this.value.x + value(n), y: this.value.y }; return this; }
  offset(dx: Val<number>, dy: Val<number>) {
    this.value = { x: this.value.x + value(dx), y: this.value.y + value(dy) }; return this;
  }
  normalize() { this.value = normalize(this.value); return this; }
  perp() { this.value = perp(this.value); return this; }
}

/** Construct a Vec; per-axis Val<number> args bind the corresponding lens. */
export const vec = (x: Val<number> = 0, y: Val<number> = 0): Vec => {
  const v = new Vec();
  v.x.bind(x);
  v.y.bind(y);
  return v;
};

/** Reactive Vec at polar offset from `center`: `center + (r·cos a, r·sin a)`.
 *  All three args may be reactive. For polar around origin pass
 *  `{ x: 0, y: 0 }` (a Vec literal). */
export const polar = (
  center: Val<Value>,
  r: Val<number>,
  a: Val<number>,
): Vec => {
  const out = new Vec();
  out.bind(() => {
    const c = value(center);
    const rv = value(r);
    const av = value(a);
    return { x: c.x + rv * Math.cos(av), y: c.y + rv * Math.sin(av) };
  });
  return out;
};
