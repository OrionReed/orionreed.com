// vec.ts — reactive 2D point (r2 port).
//
// Eager + chain duality preserved. Field lenses (.x, .y) via field().

import { Reactive, computed, value, type Val } from "../reactive";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../traits";
import { field } from "../field";
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

export class Vec extends Reactive<Value> {
  constructor(v: Value = { x: 0, y: 0 }) { super(v); }

  get [LINEAR](): Linear<Value> { return linearImpl; }
  [LERP](a: Value, b: Value, t: number) { return lerp(a, b, t); }
  [METRIC](a: Value, b: Value) { return metric(a, b); }
  [EQUALS](a: Value, b: Value) { return equals(a, b); }

  add(b: Val<Value>) { return computed(Vec, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return computed(Vec, () => sub(this.value, value(b))); }
  scale(k: Val<number>) { return computed(Vec, () => scale(this.value, value(k))); }
  lerp(b: Val<Value>, t: Val<number>) {
    return computed(Vec, () => lerp(this.value, value(b), value(t)));
  }

  up(n: Val<number>)    { return computed(Vec, () => ({ x: this.value.x,            y: this.value.y - value(n) })); }
  down(n: Val<number>)  { return computed(Vec, () => ({ x: this.value.x,            y: this.value.y + value(n) })); }
  left(n: Val<number>)  { return computed(Vec, () => ({ x: this.value.x - value(n), y: this.value.y })); }
  right(n: Val<number>) { return computed(Vec, () => ({ x: this.value.x + value(n), y: this.value.y })); }

  offset(dx: Val<number>, dy: Val<number>) {
    return computed(Vec, () => ({ x: this.value.x + value(dx), y: this.value.y + value(dy) }));
  }
  normalize() { return computed(Vec, () => normalize(this.value)); }
  perp() { return computed(Vec, () => perp(this.value)); }
  distance(other: Val<Value>) {
    return computed(Num, () => metric(this.value, value(other)));
  }

  get x() { return field(this, "x", Num); }
  get y() { return field(this, "y", Num); }

  get magnitude() {
    return this._mag ??= computed(Num, () => Math.hypot(this.value.x, this.value.y));
  }
  private _mag?: Num;

  derive(fn: (c: VecChain) => VecChain) {
    return computed(Vec, () => fn(new VecChain(this.value)).value);
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

/** Reactive Vec at polar offset from `center`: `center + (r·cos a, r·sin a)`. */
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
