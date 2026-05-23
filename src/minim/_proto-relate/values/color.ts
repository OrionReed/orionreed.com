// color.ts — reactive RGBA color.
//
// Invertibles (`add`, `sub`, `scale`) ride on
// `Signal#through(fwd, bwd)`. Chained calls auto-fuse.

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { computed, lazy, Signal, type SignalOptions, type Val, valFn, value } from "../signal";
import { type Linear, traits } from "../traits";
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

export class Color extends Signal<V> {
  // ── class-level config ─────────────────────────────────────────
  static traits = traits<V>()({
    linear: linearImpl,
    lerp,
    equals,
    packer: {
      dim: 4,
      pack: (v: V, into: number[], off: number) => {
        into[off] = v.r;
        into[off + 1] = v.g;
        into[off + 2] = v.b;
        into[off + 3] = v.a;
      },
      unpack: (from: readonly number[], off: number): V => ({
        r: from[off]!,
        g: from[off + 1]!,
        b: from[off + 2]!,
        a: from[off + 3]!,
      }),
    },
  });
  static invertibles = invertibles<Color>()("add", "sub", "scale", "through");

  // ── instance ───────────────────────────────────────────────────
  // (derive / lens / is inherited from Signal)
  constructor(v: V = { r: 0, g: 0, b: 0, a: 1 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): Color {
    const bf = valFn(b);
    return this.through(
      v => add(v, bf()),
      n => sub(n, bf()),
    );
  }
  sub(b: Val<V>): Color {
    const bf = valFn(b);
    return this.through(
      v => sub(v, bf()),
      n => add(n, bf()),
    );
  }
  scale(k: Val<number>): Color {
    const kf = valFn(k);
    return this.through(
      v => scale(v, kf()),
      n => scale(n, 1 / kf()),
    );
  }
  lerp(b: Val<V>, t: Val<number>): Color {
    return Color.derive(() => lerp(this.value, value(b), value(t)));
  }

  get r(): Num {
    return lazy(this, "r", () =>
      this.lensTo(
        Num,
        s => s.r,
        (v, s) => ({ ...s, r: v }),
      ),
    );
  }
  get g(): Num {
    return lazy(this, "g", () =>
      this.lensTo(
        Num,
        s => s.g,
        (v, s) => ({ ...s, g: v }),
      ),
    );
  }
  get b(): Num {
    return lazy(this, "b", () =>
      this.lensTo(
        Num,
        s => s.b,
        (v, s) => ({ ...s, b: v }),
      ),
    );
  }
  get a(): Num {
    return lazy(this, "a", () =>
      this.lensTo(
        Num,
        s => s.a,
        (v, s) => ({ ...s, a: v }),
      ),
    );
  }
  get luminance(): Num {
    return lazy(this, "luminance", () =>
      this.deriveTo(Num, c => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b),
    );
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
