// color.ts — reactive RGBA color.
//
// Invertibles (`add`, `sub`, `scale`) return `: this` and ride on
// `Signal#through(fwd, bwd)`. Chained calls auto-fuse.

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { computed, lazy, Signal, type SignalOptions, type Val, valFn, value } from "../signal";
import { type Linear, type Pack, traits } from "../traits";
import { derived, field, type Wr, type Writable } from "../writable";
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
const packImpl: Pack<V> = {
  dim: 4,
  read: (v, a, o) => {
    a[o] = v.r;
    a[o + 1] = v.g;
    a[o + 2] = v.b;
    a[o + 3] = v.a;
  },
  write: (a, o) => ({ r: a[o]!, g: a[o + 1]!, b: a[o + 2]!, a: a[o + 3]! }),
};

export class Color extends Signal<V> {
  static traits = traits<V>()({ linear: linearImpl, lerp, equals, pack: packImpl });

  /** Phantom registry brand — `Writable<Color>` resolves to `Wr<Color>`. */
  declare readonly _writable: Wr<Color>;

  constructor(v: V = { r: 0, g: 0, b: 0, a: 1 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(
      v => add(v, bf()),
      n => sub(n, bf()),
    );
  }
  sub(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(
      v => sub(v, bf()),
      n => add(n, bf()),
    );
  }
  scale(k: Val<number>): this {
    const kf = valFn(k);
    return this.through(
      v => scale(v, kf()),
      n => scale(n, 1 / kf()),
    );
  }
  lerp(b: Val<V>, t: Val<number>): Color {
    return Color.derive(() => lerp(this.value, value(b), value(t)));
  }

  // ── field lenses & derived views ──────────────────────────────────
  get r() {
    return field(this, "r", Num);
  }
  get g() {
    return field(this, "g", Num);
  }
  get b() {
    return field(this, "b", Num);
  }
  get a() {
    return field(this, "a", Num);
  }
  get luminance() {
    return derived(this, "luminance", Num, c => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b);
  }
  get css(): Signal<string> {
    return lazy(this, "css", () =>
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
  to(this: Writable<Color>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}
export interface Color {
  readonly constructor: typeof Color;
  get value(): V;
}

export const rgb = (r: number, g: number, b: number) =>
  new Color({ r, g, b, a: 1 }) as Writable<Color>;
export const rgba = (r: number, g: number, b: number, a: number) =>
  new Color({ r, g, b, a }) as Writable<Color>;
