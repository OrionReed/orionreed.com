// color.ts — reactive RGBA colour.

import { Signal, computed, type Computed, value, type Val } from "../signal";
import { LINEAR, LERP, EQUALS } from "../traits";
import { BaseChain, derived } from "../derive";
import { defineTrait, type LerpMethods } from "../lerp";
import { Num } from "./num";

export interface Value { r: number; g: number; b: number; a: number }

export const add = (a: Value, b: Value): Value =>
  ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a });
export const sub = (a: Value, b: Value): Value =>
  ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a });
export const scale = (a: Value, k: number): Value =>
  ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k });
export const lerp = (a: Value, b: Value, t: number): Value => ({
  r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t,
});
export const equals = (a: Value, b: Value) =>
  a === b || (a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a);

/** Op surface — closed-on-Color operations. Implemented by reactive
 *  `Color` and the mutating `Chain`. */
interface ColorOps<R> {
  add(b: Val<Value>): R;
  sub(b: Val<Value>): R;
  scale(k: Val<number>): R;
  lerp(b: Val<Value>, t: Val<number>): R;
}

export class Color extends Signal<Value> implements ColorOps<Color> {
  constructor(v: Value = { r: 0, g: 0, b: 0, a: 1 }) { super(v); }

  add(b: Val<Value>) { return derived(Color, () => add(this.value, value(b))); }
  sub(b: Val<Value>) { return derived(Color, () => sub(this.value, value(b))); }
  scale(k: Val<number>) { return derived(Color, () => scale(this.value, value(k))); }
  lerp(b: Val<Value>, t: Val<number>) {
    return derived(Color, () => lerp(this.value, value(b), value(t)));
  }

  get luminance() {
    return this._lum ??= derived(Num, () => {
      const c = this.value;
      return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    });
  }
  private _lum?: Num;

  /** Reactive CSS string — `rgba(r*255, g*255, b*255, a)`. Lazy + cached. */
  get css(): Computed<string> {
    return this._css ??= computed(() => {
      const c = this.value;
      const r = Math.round(c.r * 255);
      const g = Math.round(c.g * 255);
      const b = Math.round(c.b * 255);
      return `rgba(${r}, ${g}, ${b}, ${c.a})`;
    });
  }
  private _css?: Computed<string>;

  derive(fn: (c: Chain) => Chain) {
    return derived(Color, () => fn(new Chain(this.value)).value);
  }
}
export interface Color extends LerpMethods<Value> {}

class Chain extends BaseChain<Value> implements ColorOps<Chain> {
  add(b: Val<Value>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<Value>) { this.value = sub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<Value>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
}

defineTrait(Color, LINEAR, { add, sub, scale });
defineTrait(Color, LERP,   lerp);
defineTrait(Color, EQUALS, equals);

export const rgb = (r: number, g: number, b: number) => new Color({ r, g, b, a: 1 });
export const rgba = (r: number, g: number, b: number, a: number) => new Color({ r, g, b, a });
