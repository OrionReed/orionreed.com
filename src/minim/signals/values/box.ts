// box.ts — reactive axis-aligned rectangle.

import { Signal, value, type Val } from "../signal";
import { LINEAR, LERP, EQUALS } from "../traits";
import { BaseChain, derived } from "../derive";
import { defineTrait, type LerpMethods } from "../lerp";
import { Num } from "./num";

export interface Value { x: number; y: number; w: number; h: number }

export const add = (a: Value, b: Value): Value =>
  ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
export const sub = (a: Value, b: Value): Value =>
  ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
export const scale = (a: Value, k: number): Value =>
  ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
export const lerp = (a: Value, b: Value, t: number): Value => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});
export const equals = (a: Value, b: Value) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export class Box extends Signal<Value> {
  constructor(v: Value = { x: 0, y: 0, w: 0, h: 0 }) { super(v); }

  expand(n: Val<number>) {
    return derived(Box, () => {
      const b = this.value, nv = value(n);
      return { x: b.x - nv, y: b.y - nv, w: b.w + 2 * nv, h: b.h + 2 * nv };
    });
  }

  get area() { return this._area ??= derived(Num, () => this.value.w * this.value.h); }
  private _area?: Num;

  derive(fn: (c: Chain) => Chain) {
    return derived(Box, () => fn(new Chain(this.value)).value);
  }
}
export interface Box extends LerpMethods<Value> {}

class Chain extends BaseChain<Value> {
  add(b: Val<Value>) { this.value = add(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<Value>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
  expand(n: Val<number>) {
    const b = this.value, nv = value(n);
    this.value = { x: b.x - nv, y: b.y - nv, w: b.w + 2 * nv, h: b.h + 2 * nv };
    return this;
  }
}

defineTrait(Box, LINEAR, { add, sub, scale });
defineTrait(Box, LERP,   lerp);
defineTrait(Box, EQUALS, equals);

export const box = (x: number, y: number, w: number, h: number): Box =>
  new Box({ x, y, w, h });
