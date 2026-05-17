// num.ts — reactive scalar number primitive.

import { Signal, value, type Val } from "../signal";
import { LINEAR, LERP, METRIC, EQUALS } from "../traits";
import { BaseChain, derived } from "../derive";
import { defineTrait, type LerpMethods } from "../lerp";

export type Value = number;

export const add = (a: Value, b: Value) => a + b;
export const sub = (a: Value, b: Value) => a - b;
export const scale = (a: Value, k: number) => a * k;
export const lerp = (a: Value, b: Value, t: number) => a + (b - a) * t;
export const metric = (a: Value, b: Value) => Math.abs(a - b);
export const equals = (a: Value, b: Value) => a === b;

export class Num extends Signal<Value> {
  constructor(v: Value = 0) { super(v); }

  add(b: Val<Value>) { return derived(Num, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return derived(Num, () => sub(this.value, value(b))); }
  scale(k: Val<number>) { return derived(Num, () => scale(this.value, value(k))); }
  clamp(lo: Val<Value>, hi: Val<Value>) {
    return derived(Num, () => {
      const v = this.value, l = value(lo), h = value(hi);
      return v < l ? l : v > h ? h : v;
    });
  }

  derive(fn: (c: Chain) => Chain) {
    return derived(Num, () => fn(new Chain(this.value)).value);
  }
}
export interface Num extends LerpMethods<Value> {}

class Chain extends BaseChain<Value> {
  add(b: Val<Value>) { this.value += value(b); return this; }
  sub(b: Val<Value>) { this.value -= value(b); return this; }
  scale(k: Val<number>) { this.value *= value(k); return this; }
  clamp(lo: Val<Value>, hi: Val<Value>) {
    const v = this.value, l = value(lo), h = value(hi);
    this.value = v < l ? l : v > h ? h : v;
    return this;
  }
}

defineTrait(Num, LINEAR, { add, sub, scale });
defineTrait(Num, LERP,   lerp);
defineTrait(Num, METRIC, metric);
defineTrait(Num, EQUALS, equals);

/** Construct a Num; reactive source follows live via `.bind()`. */
export const num = (v: Val<Value> = 0): Num => {
  const n = new Num();
  n.bind(v);
  return n;
};
