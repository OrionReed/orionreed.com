// num.ts — reactive scalar number (r2 v2).
//
// Pattern preserved from prod:
//   - Eager methods: `n.add(b)` allocates one computed Num per call.
//   - Chain form: `n.derive(c => c.add(b).scale(k))` fuses into a single
//     computed. Same observable outcome, lower overhead.
//
// What's new vs r2-v1:
//   - Trait dispatch via `static traits = {…}` (one declaration, no symbols).
//   - Value type suffixed (`NumValue`) so consumers don't rename on import.
//   - `computed(fn, Cls)` arg order.

import { Reactive, computed, value, type Val } from "../reactive";
import { type Linear, type Traits } from "../traits";

export type NumValue = number;

export const add = (a: NumValue, b: NumValue) => a + b;
export const sub = (a: NumValue, b: NumValue) => a - b;
export const scale = (a: NumValue, k: number) => a * k;
export const lerp = (a: NumValue, b: NumValue, t: number) => a + (b - a) * t;
export const metric = (a: NumValue, b: NumValue) => Math.abs(a - b);
export const equals = (a: NumValue, b: NumValue) => a === b;

const linearImpl: Linear<NumValue> = { add, sub, scale };

export class Num extends Reactive<NumValue> {
  static traits: Required<Traits<NumValue>> = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
  };

  constructor(v: NumValue = 0) { super(v); }

  add(b: Val<NumValue>) { return computed(() => add(this.value, value(b)), Num); }
  sub(b: Val<NumValue>) { return computed(() => sub(this.value, value(b)), Num); }
  scale(k: Val<number>) { return computed(() => scale(this.value, value(k)), Num); }
  clamp(lo: Val<NumValue>, hi: Val<NumValue>) {
    return computed(() => {
      const v = this.value, l = value(lo), h = value(hi);
      return v < l ? l : v > h ? h : v;
    }, Num);
  }

  derive(fn: (c: NumChain) => NumChain) {
    return computed(() => fn(new NumChain(this.value)).value, Num);
  }
}

// Re-type `constructor` on instances so `HasLinear<T>` etc. constraints
// can see the static `traits` dict through `inst.constructor.traits`.
// TS interface-merging is the standard workaround for the fact that
// `Object.prototype.constructor` is typed as `Function` by default.
export interface Num { readonly constructor: typeof Num }

export class NumChain {
  value: NumValue;
  constructor(v: NumValue) { this.value = v; }
  add(b: Val<NumValue>) { this.value += value(b); return this; }
  sub(b: Val<NumValue>) { this.value -= value(b); return this; }
  scale(k: Val<number>) { this.value *= value(k); return this; }
  clamp(lo: Val<NumValue>, hi: Val<NumValue>) {
    const v = this.value, l = value(lo), h = value(hi);
    this.value = v < l ? l : v > h ? h : v;
    return this;
  }
}

/** Construct a Num; reactive source follows live via `.bind()`. */
export const num = (v: Val<NumValue> = 0): Num => {
  const n = new Num();
  n.bind(v);
  return n;
};
