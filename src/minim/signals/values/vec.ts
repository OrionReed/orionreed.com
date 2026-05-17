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

/** Unit vector along `v`; `(0, 0)` stays `(0, 0)`. */
export const normalize = (v: Value): Value => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};
/** 90° CCW rotation (y-down: rotates left): `(x, y) → (y, -x)`. */
export const perp = (v: Value): Value => ({ x: v.y, y: -v.x });

export class Vec extends Signal<Value> {
  constructor(v: Value = { x: 0, y: 0 }) { super(v); }

  /** Type guard — `true` for any Vec cell (writable or derived). */
  static is(v: unknown): v is Vec { return v instanceof Vec; }
  /** Currently identical to `is(v)` — in the new system every Vec cell
   *  is writable (derived ones reactively update on parent change). */
  static isWritable(v: unknown): v is Vec { return v instanceof Vec; }

  add(b: Val<Value>) { return derived(Vec, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return derived(Vec, () => sub(this.value, value(b))); }
  scale(k: Val<number>) { return derived(Vec, () => scale(this.value, value(k))); }
  lerp(b: Val<Value>, t: Val<number>) {
    return derived(Vec, () => lerp(this.value, value(b), value(t)));
  }

  // ── Cardinal-direction shorthands (y-down convention) ────────────
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

/** Vec from polar coords (radius, angle in radians). Reactive if any
 *  arg is reactive. With three args, offsets from `center`. */
export function polar(r: Val<number>, a: Val<number>): Vec;
export function polar(center: Val<Value>, r: Val<number>, a: Val<number>): Vec;
export function polar(
  rOrCenter: Val<number> | Val<Value>,
  aOrR: Val<number>,
  a?: Val<number>,
): Vec {
  const out = new Vec();
  if (a === undefined) {
    out.bind(() => {
      const rv = value(rOrCenter as Val<number>);
      const av = value(aOrR);
      return { x: rv * Math.cos(av), y: rv * Math.sin(av) };
    });
  } else {
    out.bind(() => {
      const c = value(rOrCenter as Val<Value>);
      const rv = value(aOrR);
      const av = value(a);
      return { x: c.x + rv * Math.cos(av), y: c.y + rv * Math.sin(av) };
    });
  }
  return out;
}
