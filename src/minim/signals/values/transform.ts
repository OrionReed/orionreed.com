// transform.ts — reactive 2D transform (translate/scale/origin/rotate/opacity).
//
// Nested field lenses (`.translate` → `Vec`), name-collision pattern
// (`Transform.scale` is the Vec axis lens, scalar multiplication only
// on TransformChain).

import { Signal, computed, value, type Val, type SignalOptions, type Of, type SignalInit } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { type Op, applyOp1, Chain } from "../ops";
import { tween, type Tween } from "../anim";
import { type Easing } from "../../core";
import { Num } from "./num";
import {
  Vec,
  add as vAdd, sub as vSub, scale as vScale, lerp as vLerp,
  metric as vMetric, equals as vEquals,
} from "./vec";

type V = {
  translate: Of<Vec>;
  scale: Of<Vec>;
  origin: Of<Vec>;
  rotate: number;
  opacity: number;
};

export type TransformInit = SignalInit<V>;

export const DEFAULT: V = {
  translate: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  rotate: 0,
  opacity: 1,
};

export const add = (a: V, b: V): V => ({
  translate: vAdd(a.translate, b.translate),
  scale:     vAdd(a.scale,     b.scale),
  origin:    vAdd(a.origin,    b.origin),
  rotate:    a.rotate + b.rotate,
  opacity:   a.opacity + b.opacity,
});
export const sub = (a: V, b: V): V => ({
  translate: vSub(a.translate, b.translate),
  scale:     vSub(a.scale,     b.scale),
  origin:    vSub(a.origin,    b.origin),
  rotate:    a.rotate - b.rotate,
  opacity:   a.opacity - b.opacity,
});
export const scale = (a: V, k: number): V => ({
  translate: vScale(a.translate, k),
  scale:     vScale(a.scale,     k),
  origin:    vScale(a.origin,    k),
  rotate:    a.rotate * k,
  opacity:   a.opacity * k,
});
export const lerp = (a: V, b: V, t: number): V => ({
  translate: vLerp(a.translate, b.translate, t),
  scale:     vLerp(a.scale,     b.scale,     t),
  origin:    vLerp(a.origin,    b.origin,    t),
  rotate:    a.rotate + (b.rotate - a.rotate) * t,
  opacity:   a.opacity + (b.opacity - a.opacity) * t,
});
export const equals = (a: V, b: V) =>
  a === b || (
    vEquals(a.translate, b.translate) && vEquals(a.scale, b.scale) &&
    vEquals(a.origin, b.origin) && a.rotate === b.rotate && a.opacity === b.opacity
  );

export const metric = (a: V, b: V) =>
  vMetric(a.translate, b.translate) +
  vMetric(a.scale,     b.scale) +
  vMetric(a.origin,    b.origin) +
  Math.abs(a.rotate  - b.rotate) +
  Math.abs(a.opacity - b.opacity);

// ─── Invertible ops ────────────────────────────────────────────────

const addOp: Op<V, [V]> = { fwd: add, bwd: sub };
const subOp: Op<V, [V]> = { fwd: sub, bwd: add };
const scaleOp: Op<V, [number]> = { fwd: scale, bwd: (v, k) => scale(v, 1 / k) };

const linearImpl: Linear<V> = { add, sub, scale };

export class Transform extends Signal<V> {
  static traits: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };

  constructor(v: V = DEFAULT, opts?: SignalOptions<V>) { super(v, opts); }

  // ── Invertible ──
  add(b: Val<V>): Transform { return applyOp1(this, addOp, b, Transform); }
  sub(b: Val<V>): Transform { return applyOp1(this, subOp, b, Transform); }

  // ── Non-invertible ──
  lerp(b: Val<V>, t: Val<number>): Transform {
    return computed(() => lerp(this.value, value(b), value(t)), Transform);
  }

  // Nested-class field lenses: translate/scale/origin are Vecs.
  // `scale` here is the Vec axis lens — scalar multiplication lives
  // ONLY on TransformChain to avoid the collision.
  get translate(): Vec { return this.field("translate", Vec); }
  get scale(): Vec     { return this.field("scale",     Vec); }
  get origin(): Vec    { return this.field("origin",    Vec); }
  get rotate(): Num    { return this.field("rotate",    Num); }
  get opacity(): Num   { return this.field("opacity",   Num); }

  /** Tween-builder, implied by lerp trait. */
  to(target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }

  derive(fn: (c: TransformChain) => TransformChain): Transform {
    return fn(new TransformChain()).toLens(this, Transform);
  }
}

export interface Transform { readonly constructor: typeof Transform }

export class TransformChain extends Chain<V> {
  add(b: Val<V>): this { return this.push1(addOp, b); }
  sub(b: Val<V>): this { return this.push1(subOp, b); }
  /** Scalar multiply (chain-only — `Transform.scale` is the Vec axis lens). */
  scale(k: Val<number>): this { return this.push1(scaleOp, k); }
}

export const transform = (init?: TransformInit): Transform => {
  const tr = new Transform();
  if (init) {
    if (init.translate !== undefined) tr.translate.bind(init.translate);
    if (init.scale     !== undefined) tr.scale.bind(init.scale);
    if (init.origin    !== undefined) tr.origin.bind(init.origin);
    if (init.rotate    !== undefined) tr.rotate.bind(init.rotate);
    if (init.opacity   !== undefined) tr.opacity.bind(init.opacity);
  }
  return tr;
};
