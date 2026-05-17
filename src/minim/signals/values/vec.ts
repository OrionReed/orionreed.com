// vec.ts — reactive 2D point.

import { Signal, value, type Val } from "../signal";
import { LINEAR, LERP, METRIC, EQUALS } from "../traits";
import { BaseChain, derived, field, bindFields } from "../derive";
import { defineTrait, type LerpMethods } from "../lerp";
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

export class Vec extends Signal<Value> {
  constructor(v: Value = { x: 0, y: 0 }) { super(v); }

  add(b: Val<Value>) { return derived(Vec, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return derived(Vec, () => sub(this.value, value(b))); }
  scale(k: Val<number>) { return derived(Vec, () => scale(this.value, value(k))); }
  lerp(b: Val<Value>, t: Val<number>) {
    return derived(Vec, () => lerp(this.value, value(b), value(t)));
  }

  get x() { return field(this, "x", Num); }
  get y() { return field(this, "y", Num); }

  get magnitude() { return this._mag ??= derived(Num, () => Math.hypot(this.value.x, this.value.y)); }
  private _mag?: Num;

  derive(fn: (c: Chain) => Chain) {
    return derived(Vec, () => fn(new Chain(this.value)).value);
  }
}
export interface Vec extends LerpMethods<Value> {}

class Chain extends BaseChain<Value> {
  add(b: Val<Value>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<Value>) { this.value = sub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<Value>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
}

defineTrait(Vec, LINEAR, { add, sub, scale });
defineTrait(Vec, LERP,   lerp);
defineTrait(Vec, METRIC, metric);
defineTrait(Vec, EQUALS, equals);

/** Construct a Vec; per-axis Val<number> args bind the corresponding lens. */
export const vec = (x: Val<number> = 0, y: Val<number> = 0): Vec => {
  const v = new Vec();
  bindFields(v, { x, y });
  return v;
};
