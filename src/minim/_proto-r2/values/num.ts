// num.ts — reactive scalar number (r2 port).
//
// Pattern preserved from production:
//   - Eager methods: `n.add(b)` allocates one computed Num per call.
//   - Chain form: `n.derive(c => c.add(b).scale(k))` fuses into a single
//     computed. Same observable outcome, lower overhead. Identical types.
//
// Math is declared once at module scope; eager methods and the chain
// both call into it.

import { Reactive, computed, value, type Val } from "../reactive";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../traits";

export type Value = number;

export const add = (a: Value, b: Value) => a + b;
export const sub = (a: Value, b: Value) => a - b;
export const scale = (a: Value, k: number) => a * k;
export const lerp = (a: Value, b: Value, t: number) => a + (b - a) * t;
export const metric = (a: Value, b: Value) => Math.abs(a - b);
export const equals = (a: Value, b: Value) => a === b;

const linearImpl: Linear<Value> = { add, sub, scale };

export class Num extends Reactive<Value> {
  constructor(v: Value = 0) { super(v); }

  get [LINEAR](): Linear<Value> { return linearImpl; }
  [LERP](a: Value, b: Value, t: number) { return lerp(a, b, t); }
  [METRIC](a: Value, b: Value) { return metric(a, b); }
  [EQUALS](a: Value, b: Value) { return equals(a, b); }

  add(b: Val<Value>) { return computed(Num, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return computed(Num, () => sub(this.value, value(b))); }
  scale(k: Val<number>) { return computed(Num, () => scale(this.value, value(k))); }
  clamp(lo: Val<Value>, hi: Val<Value>) {
    return computed(Num, () => {
      const v = this.value, l = value(lo), h = value(hi);
      return v < l ? l : v > h ? h : v;
    });
  }

  derive(fn: (c: NumChain) => NumChain) {
    return computed(Num, () => fn(new NumChain(this.value)).value);
  }
}

export class NumChain {
  value: Value;
  constructor(v: Value) { this.value = v; }
  add(b: Val<Value>) { this.value += value(b); return this; }
  sub(b: Val<Value>) { this.value -= value(b); return this; }
  scale(k: Val<number>) { this.value *= value(k); return this; }
  clamp(lo: Val<Value>, hi: Val<Value>) {
    const v = this.value, l = value(lo), h = value(hi);
    this.value = v < l ? l : v > h ? h : v;
    return this;
  }
}

/** Construct a Num; reactive source follows live via `.bind()`. */
export const num = (v: Val<Value> = 0): Num => {
  const n = new Num();
  n.bind(v);
  return n;
};
