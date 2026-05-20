// color.ts — reactive RGBA color (r2).
//
// 4 channels, all in [0, 1]. Lerp is linear in RGB — fine for most UI
// uses; if you want oklch interpolation that's a different value type.
//
// Two memoized derived views: `luminance` (Num) and `css` (Computed<string>
// — a string-typed reactive view that's NOT a value class because string
// has no [LINEAR]/[METRIC]/etc.).

import { Signal, computed, type Computed, value, type Val, type SignalOptions } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { Num } from "./num";

export interface ColorValue { r: number; g: number; b: number; a: number }

export const add = (a: ColorValue, b: ColorValue): ColorValue =>
  ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a });
export const sub = (a: ColorValue, b: ColorValue): ColorValue =>
  ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a });
export const scale = (a: ColorValue, k: number): ColorValue =>
  ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k });
export const lerp = (a: ColorValue, b: ColorValue, t: number): ColorValue => ({
  r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t,
});
export const equals = (a: ColorValue, b: ColorValue) =>
  a === b || (a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a);

export class Color extends Signal<ColorValue> {
  static traits: TraitDict<ColorValue> & { linear: Linear<ColorValue>; lerp: typeof lerp; equals: typeof equals } = {
    linear: { add, sub, scale },
    lerp,
    equals,
  };

  constructor(v: ColorValue = { r: 0, g: 0, b: 0, a: 1 }, opts?: SignalOptions<ColorValue>) {
    super(v, opts);
  }

  add(b: Val<ColorValue>) { return computed(() => add(this.value, value(b)), Color); }
  sub(b: Val<ColorValue>) { return computed(() => sub(this.value, value(b)), Color); }
  scale(k: Val<number>) { return computed(() => scale(this.value, value(k)), Color); }
  lerp(b: Val<ColorValue>, t: Val<number>) {
    return computed(() => lerp(this.value, value(b), value(t)), Color);
  }

  get luminance(): Num {
    return this.memo("luminance", () => computed(() => {
      const c = this.value;
      return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    }, Num));
  }

  /** Reactive CSS string — `rgba(r*255, g*255, b*255, a)`. Lazy + cached.
   *  Returns a `Computed<string>` (no value class for strings). */
  get css(): Computed<string> {
    return this.memo("css", () => computed(() => {
      const c = this.value;
      const r = Math.round(c.r * 255);
      const g = Math.round(c.g * 255);
      const b = Math.round(c.b * 255);
      return `rgba(${r}, ${g}, ${b}, ${c.a})`;
    })) as Computed<string>;
  }

  derive(fn: (c: ColorChain) => ColorChain) {
    return computed(() => fn(new ColorChain(this.value)).value, Color);
  }
}

export interface Color { readonly constructor: typeof Color }

export class ColorChain {
  value: ColorValue;
  constructor(v: ColorValue) { this.value = v; }
  add(b: Val<ColorValue>) { this.value = add(this.value, value(b)); return this; }
  sub(b: Val<ColorValue>) { this.value = sub(this.value, value(b)); return this; }
  scale(k: Val<number>) { this.value = scale(this.value, value(k)); return this; }
  lerp(b: Val<ColorValue>, t: Val<number>) {
    this.value = lerp(this.value, value(b), value(t)); return this;
  }
}

export const rgb = (r: number, g: number, b: number) => new Color({ r, g, b, a: 1 });
export const rgba = (r: number, g: number, b: number, a: number) => new Color({ r, g, b, a });
