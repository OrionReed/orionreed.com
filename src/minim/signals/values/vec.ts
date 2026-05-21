// vec.ts — reactive 2D point.

import { Signal, computed, value, type Val, type SignalOptions } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { type Op, applyOp1, applyOp2, Chain } from "../ops";
import { tween, type Tween } from "../anim";
import { type Easing } from "../../core";
import { Num } from "./num";

// Module-local; consumers use `Of<Vec>`.
type V = { x: number; y: number };

export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});
export const metric = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y);
export const equals = (a: V, b: V) => a === b || (a.x === b.x && a.y === b.y);

/** Unit vector along `v`; `(0, 0)` stays `(0, 0)`. */
export const normalize = (v: V): V => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};

/** 90° CCW rotation (y-down: rotates left): `(x, y) → (y, -x)`. */
export const perp = (v: V): V => ({ x: v.y, y: -v.x });

// ─── Invertible ops ────────────────────────────────────────────────

const addOp: Op<V, [V]> = { fwd: add, bwd: sub };
const subOp: Op<V, [V]> = { fwd: sub, bwd: add };
const scaleOp: Op<V, [number]> = { fwd: scale, bwd: (v, k) => scale(v, 1 / k) };
const offsetOp: Op<V, [number, number]> = {
  fwd: (v, dx, dy) => ({ x: v.x + dx, y: v.y + dy }),
  bwd: (n, dx, dy) => ({ x: n.x - dx, y: n.y - dy }),
};

const linearImpl: Linear<V> = { add, sub, scale };

export class Vec extends Signal<V> {
  static traits: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };

  constructor(v: V = { x: 0, y: 0 }, opts?: SignalOptions<V>) { super(v, opts); }

  // ── Invertible (Lens-returning) ──
  add(b: Val<V>): Vec { return applyOp1(this, addOp, b, Vec); }
  sub(b: Val<V>): Vec { return applyOp1(this, subOp, b, Vec); }
  scale(k: Val<number>): Vec { return applyOp1(this, scaleOp, k, Vec); }
  offset(dx: Val<number>, dy: Val<number>): Vec {
    return applyOp2(this, offsetOp, dx, dy, Vec);
  }
  // axis-aligned offset sugar — all invertible via offsetOp with negation
  up(n: Val<number>): Vec    { return this.offset(0, computed(() => -value(n))); }
  down(n: Val<number>): Vec  { return this.offset(0, n); }
  left(n: Val<number>): Vec  { return this.offset(computed(() => -value(n)), 0); }
  right(n: Val<number>): Vec { return this.offset(n, 0); }

  // ── Non-invertible (return typed class; .value= throws at runtime) ──
  lerp(b: Val<V>, t: Val<number>): Vec {
    return computed(() => lerp(this.value, value(b), value(t)), Vec);
  }
  normalize(): Vec { return computed(() => normalize(this.value), Vec); }
  perp(): Vec { return computed(() => perp(this.value), Vec); }
  distance(other: Val<V>): Num {
    return computed(() => metric(this.value, value(other)), Num);
  }

  // ── Field lenses (writable) ──
  get x(): Num { return this.field("x", Num); }
  get y(): Num { return this.field("y", Num); }

  // ── Lazy derived (read-only at runtime) ──
  get magnitude(): Num {
    return this.memo("magnitude", () =>
      computed(() => Math.hypot(this.value.x, this.value.y), Num));
  }

  /** Tween-builder, implied by lerp trait. */
  to(target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }

  derive(fn: (c: VecChain) => VecChain): Vec {
    return fn(new VecChain()).toLens(this, Vec);
  }
}

export interface Vec { readonly constructor: typeof Vec }

export class VecChain extends Chain<V> {
  add(b: Val<V>): this { return this.push1(addOp, b); }
  sub(b: Val<V>): this { return this.push1(subOp, b); }
  scale(k: Val<number>): this { return this.push1(scaleOp, k); }
  offset(dx: Val<number>, dy: Val<number>): this {
    return this.push2(offsetOp, dx, dy);
  }
  up(n: Val<number>): this    { return this.push2(offsetOp, 0, computed(() => -value(n))); }
  down(n: Val<number>): this  { return this.push2(offsetOp, 0, n); }
  left(n: Val<number>): this  { return this.push2(offsetOp, computed(() => -value(n)), 0); }
  right(n: Val<number>): this { return this.push2(offsetOp, n, 0); }
}

/** Construct a Vec; per-axis Val<number> args bind the corresponding lens. */
export const vec = (x: Val<number> = 0, y: Val<number> = 0): Vec => {
  const v = new Vec();
  v.x.bind(x);
  v.y.bind(y);
  return v;
};

/** Vec at polar offset from `center`: `center + (r·cos a, r·sin a)`. */
export const polar = (
  center: Val<V>,
  r: Val<number>,
  a: Val<number>,
): Vec => {
  const out = new Vec();
  out.bind(() => {
    const c = value(center);
    const rv = value(r);
    const av = value(a);
    return { x: c.x + rv * Math.cos(av), y: c.y + rv * Math.sin(av) };
  });
  return out;
};
