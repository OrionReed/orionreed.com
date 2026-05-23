// transform.ts (spike) — nested writable Vec fields. Two levels of
// writable propagation: `Transform_W` overrides each field-lens to
// writable, and `Vec_W` (in vec.ts) overrides Vec's own field lenses
// to writable. So `tr.translate.x.value = 5` types-check on writable
// Transform; the bare RO equivalent is blocked.

import { lazy, type Of, Signal, type SignalOptions, type Val, valFn, value } from "../signal";
import { type Linear, traits } from "../traits";
import { bind } from "./bind";
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
import type { Wr, Writable } from "./writable";

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
  static traits = traits<V>()({ linear: linearImpl, lerp, metric, equals });

  declare readonly _writable: Transform_W;

  constructor(v: V = DEFAULT, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(v => add(v, bf()), n => sub(n, bf()));
  }
  sub(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(v => sub(v, bf()), n => add(n, bf()));
  }
  lerp(b: Val<V>, t: Val<number>): Transform {
    return Transform.derive(() => lerp(this.value, value(b), value(t)));
  }

  get translate(): Vec {
    return lazy(this, "translate", () =>
      this.lensTo(Vec, s => s.translate, (v, s) => ({ ...s, translate: v })),
    );
  }
  get scale(): Vec {
    return lazy(this, "scale", () =>
      this.lensTo(Vec, s => s.scale, (v, s) => ({ ...s, scale: v })),
    );
  }
  get origin(): Vec {
    return lazy(this, "origin", () =>
      this.lensTo(Vec, s => s.origin, (v, s) => ({ ...s, origin: v })),
    );
  }
  get rotate(): Num {
    return lazy(this, "rotate", () =>
      this.lensTo(Num, s => s.rotate, (v, s) => ({ ...s, rotate: v })),
    );
  }
  get opacity(): Num {
    return lazy(this, "opacity", () =>
      this.lensTo(Num, s => s.opacity, (v, s) => ({ ...s, opacity: v })),
    );
  }
}
export interface Transform {
  readonly constructor: typeof Transform;
  get value(): V;
}

/** Writable Transform — overrides every field-lens to writable. */
export interface Transform_W extends Wr<Transform> {
  get translate(): Writable<Vec>;
  get scale(): Writable<Vec>;
  get origin(): Writable<Vec>;
  get rotate(): Writable<Num>;
  get opacity(): Writable<Num>;
}

export type TransformInit = { [K in keyof V]?: Val<V[K]> };

export function transform(init?: TransformInit): Writable<Transform> {
  const tr = new Transform() as Writable<Transform>;
  if (init) {
    if (init.translate !== undefined) bind(tr.translate, init.translate);
    if (init.scale !== undefined) bind(tr.scale, init.scale);
    if (init.origin !== undefined) bind(tr.origin, init.origin);
    if (init.rotate !== undefined) bind(tr.rotate, init.rotate);
    if (init.opacity !== undefined) bind(tr.opacity, init.opacity);
  }
  return tr;
}
