// color.ts — reactive RGBA colour.

import { Signal, computed, type Computed, value, type Val } from "../signal";
import { LINEAR, LERP, EQUALS, type Linear } from "../traits";
import { derived } from "../derive";
import { tween, type Tween } from "../lerp";
import { type Easing } from "../../core";
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

const linearImpl: Linear<Value> = { add, sub, scale };

export class Color extends Signal<Value> {
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

  // Trait slots — on prototype.
  get [LINEAR](): Linear<Value> { return linearImpl; }
  [LERP](a: Value, b: Value, t: number) { return lerp(a, b, t); }
  [EQUALS](a: Value, b: Value) { return equals(a, b); }

  to(target: Value, dur: Val<number>, ease?: Easing): Tween<Value> {
    return tween(this, target, dur, ease);
  }

  derive(fn: (c: ColorChain) => ColorChain) {
    return derived(Color, () => fn(new ColorChain(this.value)).value);
  }
}

export class ColorChain {
  value: Value;
  constructor(v: Value) { this.value = v; }
  add(b: Val<Value>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<Value>) { this.value = sub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<Value>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
}

export const rgb = (r: number, g: number, b: number) => new Color({ r, g, b, a: 1 });
export const rgba = (r: number, g: number, b: number, a: number) => new Color({ r, g, b, a });
