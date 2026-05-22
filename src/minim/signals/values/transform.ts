// transform.ts — reactive 2D transform.
//
// Invertibles (`add`, `sub`) ride on `Signal#through(fwd, bwd)`.
// Chained calls auto-fuse.

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { bind } from "../lateral";
import { type Of, Signal, type SignalOptions, type Val, valFn, value } from "../signal";
import { type Linear, traits } from "../traits";
import { invertibles, type Writable } from "../writable";
import { Num } from "./num";
import {
  Vec,
  add as vAdd,
  equals as vEquals,
  lerp as vLerp,
  metric as vMetric,
  scale as vScale,
  sub as vSub,
} from "./vec";

type V = {
  translate: Of<Vec>;
  scale: Of<Vec>;
  origin: Of<Vec>;
  rotate: number;
  opacity: number;
};

export const DEFAULT: V = {
  translate: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  rotate: 0,
  opacity: 1,
};

export const add = (a: V, b: V): V => ({
  translate: vAdd(a.translate, b.translate),
  scale: vAdd(a.scale, b.scale),
  origin: vAdd(a.origin, b.origin),
  rotate: a.rotate + b.rotate,
  opacity: a.opacity + b.opacity,
});
export const sub = (a: V, b: V): V => ({
  translate: vSub(a.translate, b.translate),
  scale: vSub(a.scale, b.scale),
  origin: vSub(a.origin, b.origin),
  rotate: a.rotate - b.rotate,
  opacity: a.opacity - b.opacity,
});
export const scale = (a: V, k: number): V => ({
  translate: vScale(a.translate, k),
  scale: vScale(a.scale, k),
  origin: vScale(a.origin, k),
  rotate: a.rotate * k,
  opacity: a.opacity * k,
});
export const lerp = (a: V, b: V, t: number): V => ({
  translate: vLerp(a.translate, b.translate, t),
  scale: vLerp(a.scale, b.scale, t),
  origin: vLerp(a.origin, b.origin, t),
  rotate: a.rotate + (b.rotate - a.rotate) * t,
  opacity: a.opacity + (b.opacity - a.opacity) * t,
});
export const equals = (a: V, b: V) =>
  a === b ||
  (vEquals(a.translate, b.translate) &&
    vEquals(a.scale, b.scale) &&
    vEquals(a.origin, b.origin) &&
    a.rotate === b.rotate &&
    a.opacity === b.opacity);
export const metric = (a: V, b: V) =>
  vMetric(a.translate, b.translate) +
  vMetric(a.scale, b.scale) +
  vMetric(a.origin, b.origin) +
  Math.abs(a.rotate - b.rotate) +
  Math.abs(a.opacity - b.opacity);

const linearImpl: Linear<V> = { add, sub, scale };

export class Transform extends Signal<V> {
  // ── class-level config ─────────────────────────────────────────
  static traits = traits<V>()({ linear: linearImpl, lerp, metric, equals });
  /** Scalar `scale` lives as a Vec field lens (`.scale`), not as an
   *  invertible eager method — to scalar-multiply a Transform, use
   *  `Transform.lens(...)` or compose via field writes. */
  static invertibles = invertibles<Transform>()("add", "sub", "through");

  // ── instance ───────────────────────────────────────────────────
  // (derive / lens / is inherited from Signal)
  constructor(v: V = DEFAULT, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): Transform {
    const bf = valFn(b);
    return this.through(
      v => add(v, bf()),
      n => sub(n, bf()),
    );
  }
  sub(b: Val<V>): Transform {
    const bf = valFn(b);
    return this.through(
      v => sub(v, bf()),
      n => add(n, bf()),
    );
  }
  lerp(b: Val<V>, t: Val<number>): Transform {
    return Transform.derive(() => lerp(this.value, value(b), value(t)));
  }

  get translate(): Vec {
    return this.field("translate", Vec);
  }
  get scale(): Vec {
    return this.field("scale", Vec);
  }
  get origin(): Vec {
    return this.field("origin", Vec);
  }
  get rotate(): Num {
    return this.field("rotate", Num);
  }
  get opacity(): Num {
    return this.field("opacity", Num);
  }

  /** Tween-builder, implied by the lerp trait. */
  to(target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this as never, target, dur, ease);
  }
}
export interface Transform {
  readonly constructor: typeof Transform;
  get value(): V;
}

export type TransformInit = { [K in keyof V]?: Val<V[K]> };

export function transform(init?: TransformInit): Writable<Transform> {
  const tr = new Transform() as unknown as Writable<Transform>;
  if (init) {
    if (init.translate !== undefined)
      bind(tr.translate as unknown as Writable<Vec>, init.translate);
    if (init.scale !== undefined) bind(tr.scale as unknown as Writable<Vec>, init.scale);
    if (init.origin !== undefined) bind(tr.origin as unknown as Writable<Vec>, init.origin);
    if (init.rotate !== undefined) bind(tr.rotate as unknown as Writable<Num>, init.rotate);
    if (init.opacity !== undefined) bind(tr.opacity as unknown as Writable<Num>, init.opacity);
  }
  return tr;
}
