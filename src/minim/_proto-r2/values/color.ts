// color.ts — reactive RGBA color.

import { Signal, computed, type Computed, value, type Val, type SignalOptions, type RO } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { type Op, applyOp1, Chain } from "../ops";
import { Num } from "./num";

type V = { r: number; g: number; b: number; a: number };

export const add = (a: V, b: V): V =>
  ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a });
export const sub = (a: V, b: V): V =>
  ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a });
export const scale = (a: V, k: number): V =>
  ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k });
export const lerp = (a: V, b: V, t: number): V => ({
  r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t,
});
export const equals = (a: V, b: V) =>
  a === b || (a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a);

const addOp: Op<V, [V]> = { fwd: add, bwd: sub };
const subOp: Op<V, [V]> = { fwd: sub, bwd: add };
const scaleOp: Op<V, [number]> = { fwd: scale, bwd: (v, k) => scale(v, 1 / k) };

const linearImpl: Linear<V> = { add, sub, scale };

export class Color extends Signal<V> {
  static traits: TraitDict<V> & { linear: Linear<V>; lerp: typeof lerp; equals: typeof equals } = {
    linear: linearImpl, lerp, equals,
  };

  constructor(v: V = { r: 0, g: 0, b: 0, a: 1 }, opts?: SignalOptions<V>) { super(v, opts); }

  // ── Invertible ──
  add(b: Val<V>): Color { return applyOp1(this, addOp, b, Color); }
  sub(b: Val<V>): Color { return applyOp1(this, subOp, b, Color); }
  scale(k: Val<number>): Color { return applyOp1(this, scaleOp, k, Color); }

  // ── Non-invertible ──
  lerp(b: Val<V>, t: Val<number>): RO<Color> {
    return computed(() => lerp(this.value, value(b), value(t)), Color) as RO<Color>;
  }

  get luminance(): RO<Num> {
    return this.memo("luminance", () => computed(() => {
      const c = this.value;
      return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    }, Num)) as RO<Num>;
  }

  get css(): Computed<string> {
    return this.memo("css", () => computed(() => {
      const c = this.value;
      const r = Math.round(c.r * 255);
      const g = Math.round(c.g * 255);
      const b = Math.round(c.b * 255);
      return `rgba(${r}, ${g}, ${b}, ${c.a})`;
    })) as Computed<string>;
  }

  derive(fn: (c: ColorChain) => ColorChain): Color {
    return fn(new ColorChain()).toLens(this, Color);
  }
}

export interface Color { readonly constructor: typeof Color }

export class ColorChain extends Chain<V> {
  add(b: Val<V>): this { return this.push1(addOp, b); }
  sub(b: Val<V>): this { return this.push1(subOp, b); }
  scale(k: Val<number>): this { return this.push1(scaleOp, k); }
}

export const rgb = (r: number, g: number, b: number) => new Color({ r, g, b, a: 1 });
export const rgba = (r: number, g: number, b: number, a: number) => new Color({ r, g, b, a });
