// color.ts — reactive RGBA color.
//
// Invertibles (`add`, `sub`, `scale`) return `: this` and ride on
// `Signal#lens(fwd, bwd)`. Chained calls auto-fuse.

import type { Easing } from "../../core";
import { type Tween, tween } from "../anim";
import {
  derive,
  type Init,
  lazy,
  reader,
  readNow,
  Signal,
  type Val,
  type Writable,
} from "../signal";
import type { Linear, Pack, TraitDict } from "../traits";
import { derived, field } from "../writable";
import { Num, num } from "./num";

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
/** L2 distance in RGBA-space. */
export const metric = (a: V, b: V) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b, a.a - b.a);

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
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Color.traits;

  constructor(v: V = { r: 0, g: 0, b: 0, a: 1 }) {
    super(v, { equals });
  }

  add(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => add(v, bf()),
      n => sub(n, bf()),
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => sub(v, bf()),
      n => add(n, bf()),
    );
  }
  scale(k: Val<number>): this {
    const kf = reader(k);
    return this.lens(
      v => scale(v, kf()),
      n => scale(n, 1 / kf()),
    );
  }
  lerp(b: Val<V>, t: Val<number>): Color {
    return Color.derive(() => lerp(this.value, readNow(b), readNow(t)));
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
      derive(() => {
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

/** Writable `Color` from RGB channels (alpha = 1). Each channel is a
 *  literal `number` (lifted to a fresh seed) or an existing `Writable<Num>`
 *  (identity passthrough). All-literal inputs take a fast path; mixed
 *  inputs build a lens so channel-writes round-trip to source. */
export function rgb(r: Init<Num>, g: Init<Num>, b: Init<Num>): Writable<Color> {
  if (typeof r === "number" && typeof g === "number" && typeof b === "number") {
    return new Color({ r, g, b, a: 1 }) as Writable<Color>;
  }
  return Color.lens(
    [num(r), num(g), num(b)] as const,
    ([r, g, b]) => ({ r, g, b, a: 1 }),
    target => [target.r, target.g, target.b] as never,
  );
}

/** Writable `Color` from RGBA channels. Same lift rule as `rgb`. */
export function rgba(r: Init<Num>, g: Init<Num>, b: Init<Num>, a: Init<Num>): Writable<Color> {
  if (
    typeof r === "number" &&
    typeof g === "number" &&
    typeof b === "number" &&
    typeof a === "number"
  ) {
    return new Color({ r, g, b, a }) as Writable<Color>;
  }
  return Color.lens(
    [num(r), num(g), num(b), num(a)] as const,
    ([r, g, b, a]) => ({ r, g, b, a }),
    target => [target.r, target.g, target.b, target.a] as never,
  );
}
