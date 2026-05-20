// vec.ts — reactive 2D point (r2 v2).
//
// Per-instance memoization: `.x`, `.y`, `.magnitude` all flow through
// `this.memo(key, factory)`. No more `_mag?` slot, no per-class
// FIELD_CACHE Symbol. Same observable behavior, one mechanism.

import { Reactive, computed, value, type Val } from "../reactive";
import { type Linear, type Traits } from "../traits";
import { field } from "../field";
import { Num } from "./num";

export interface VecValue { x: number; y: number }

export const add = (a: VecValue, b: VecValue): VecValue => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: VecValue, b: VecValue): VecValue => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: VecValue, k: number): VecValue => ({ x: a.x * k, y: a.y * k });
export const lerp = (a: VecValue, b: VecValue, t: number): VecValue => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});
export const metric = (a: VecValue, b: VecValue) => Math.hypot(a.x - b.x, a.y - b.y);
export const equals = (a: VecValue, b: VecValue) => a === b || (a.x === b.x && a.y === b.y);

/** Unit vector along `v`; `(0, 0)` stays `(0, 0)`. */
export const normalize = (v: VecValue): VecValue => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};

/** 90° CCW rotation (y-down: rotates left): `(x, y) → (y, -x)`. */
export const perp = (v: VecValue): VecValue => ({ x: v.y, y: -v.x });

export class Vec extends Reactive<VecValue> {
  static traits: Required<Traits<VecValue>> = {
    linear: { add, sub, scale },
    lerp,
    metric,
    equals,
  };

  constructor(v: VecValue = { x: 0, y: 0 }) { super(v); }

  add(b: Val<VecValue>) { return computed(() => add(this.value, value(b)), Vec); }
  sub(b: Val<VecValue>) { return computed(() => sub(this.value, value(b)), Vec); }
  scale(k: Val<number>) { return computed(() => scale(this.value, value(k)), Vec); }
  lerp(b: Val<VecValue>, t: Val<number>) {
    return computed(() => lerp(this.value, value(b), value(t)), Vec);
  }

  up(n: Val<number>)    { return computed(() => ({ x: this.value.x,            y: this.value.y - value(n) }), Vec); }
  down(n: Val<number>)  { return computed(() => ({ x: this.value.x,            y: this.value.y + value(n) }), Vec); }
  left(n: Val<number>)  { return computed(() => ({ x: this.value.x - value(n), y: this.value.y            }), Vec); }
  right(n: Val<number>) { return computed(() => ({ x: this.value.x + value(n), y: this.value.y            }), Vec); }

  offset(dx: Val<number>, dy: Val<number>) {
    return computed(() => ({ x: this.value.x + value(dx), y: this.value.y + value(dy) }), Vec);
  }
  normalize() { return computed(() => normalize(this.value), Vec); }
  perp() { return computed(() => perp(this.value), Vec); }
  distance(other: Val<VecValue>) {
    return computed(() => metric(this.value, value(other)), Num);
  }

  get x(): Num { return this.memo("x", () => field(this, "x", Num)); }
  get y(): Num { return this.memo("y", () => field(this, "y", Num)); }

  get magnitude(): Num {
    return this.memo("magnitude", () =>
      computed(() => Math.hypot(this.value.x, this.value.y), Num));
  }

  derive(fn: (c: VecChain) => VecChain) {
    return computed(() => fn(new VecChain(this.value)).value, Vec);
  }
}

export interface Vec { readonly constructor: typeof Vec }

export class VecChain {
  value: VecValue;
  constructor(v: VecValue) { this.value = v; }
  add(b: Val<VecValue>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<VecValue>) { this.value = sub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<VecValue>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
  up(n: Val<number>)    { this.value = { x: this.value.x,            y: this.value.y - value(n) }; return this; }
  down(n: Val<number>)  { this.value = { x: this.value.x,            y: this.value.y + value(n) }; return this; }
  left(n: Val<number>)  { this.value = { x: this.value.x - value(n), y: this.value.y            }; return this; }
  right(n: Val<number>) { this.value = { x: this.value.x + value(n), y: this.value.y            }; return this; }
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
  center: Val<VecValue>,
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
