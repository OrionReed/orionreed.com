// color.ts — reactive RGBA color.

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { applyOp1, type Op } from "../ops";
import {
  computed,
  computedCls,
  lensCls,
  Signal,
  type SignalOptions,
  type Val,
  value,
} from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { invertibles, type Writable } from "../writable";
import { Num } from "./num";

type V = { r: number; g: number; b: number; a: number };

export const add = (a: V, b: V): V => ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, a: a.a + b.a });
export const sub = (a: V, b: V): V => ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b, a: a.a - b.a });
export const scale = (a: V, k: number): V => ({ r: a.r * k, g: a.g * k, b: a.b * k, a: a.a * k });
export const lerp = (a: V, b: V, t: number): V => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
  a: a.a + (b.a - a.a) * t,
});
export const equals = (a: V, b: V) =>
  a === b || (a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a);

const linearImpl: Linear<V> = { add, sub, scale };

const addOp: Op<V, [V]> = { fwd: add, bwd: sub };
const subOp: Op<V, [V]> = { fwd: sub, bwd: add };
const scaleOp: Op<V, [number]> = { fwd: scale, bwd: (v, k) => scale(v, 1 / k) };

export class Color extends Signal<V> {
  // ── class-level config ─────────────────────────────────────────
  static traits: TraitDict<V> & { linear: Linear<V>; lerp: typeof lerp; equals: typeof equals } = {
    linear: linearImpl,
    lerp,
    equals,
  };
  static invertibles = invertibles<Color>()("add", "sub", "scale", "through");

  // ── class-level constructors ───────────────────────────────────
  static derive(fn: () => V): Color {
    return computedCls(Color, fn);
  }
  static lens(g: () => V, s: (v: V) => void): Writable<Color> {
    return lensCls(Color, g, s) as unknown as Writable<Color>;
  }
  static is(v: unknown): v is Color {
    return v instanceof Color;
  }

  // ── instance ───────────────────────────────────────────────────
  constructor(v: V = { r: 0, g: 0, b: 0, a: 1 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): Color {
    return applyOp1(this, addOp, b, Color);
  }
  sub(b: Val<V>): Color {
    return applyOp1(this, subOp, b, Color);
  }
  scale(k: Val<number>): Color {
    return applyOp1(this, scaleOp, k, Color);
  }
  lerp(b: Val<V>, t: Val<number>): Color {
    return Color.derive(() => lerp(this.value, value(b), value(t)));
  }

  get r(): Num {
    return this.field("r", Num);
  }
  get g(): Num {
    return this.field("g", Num);
  }
  get b(): Num {
    return this.field("b", Num);
  }
  get a(): Num {
    return this.field("a", Num);
  }
  get luminance(): Num {
    return this.memo("luminance", () =>
      Num.derive(() => {
        const c = this.value;
        return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      }),
    );
  }
  get css(): Signal<string> {
    return this.memo("css", () =>
      computed(() => {
        const c = this.value;
        const r = Math.round(c.r * 255);
        const g = Math.round(c.g * 255);
        const b = Math.round(c.b * 255);
        return `rgba(${r}, ${g}, ${b}, ${c.a})`;
      }),
    );
  }

  /** Tween-builder, implied by the lerp trait. */
  to(target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this as never, target, dur, ease);
  }
}
export interface Color {
  readonly constructor: typeof Color;
  get value(): V;
}

export const rgb = (r: number, g: number, b: number) =>
  new Color({ r, g, b, a: 1 }) as unknown as Writable<Color>;
export const rgba = (r: number, g: number, b: number, a: number) =>
  new Color({ r, g, b, a }) as unknown as Writable<Color>;
