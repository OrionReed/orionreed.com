// vec.ts — reactive 2D point.

import {
  Signal, computedCls, lensCls, value,
  type Val, type SignalOptions,
} from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { applyOp1, applyOp2, type Op } from "../ops";
import { type Writable, invertibles } from "../writable";
import { Num } from "./num";

type V = { x: number; y: number };

export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});
export const metric = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y);
export const equals = (a: V, b: V) => a === b || (a.x === b.x && a.y === b.y);
export const normalize = (v: V): V => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};
export const perp = (v: V): V => ({ x: v.y, y: -v.x });

const linearImpl: Linear<V> = { add, sub, scale };

const addOp:    Op<V, [V]>              = { fwd: add, bwd: sub };
const subOp:    Op<V, [V]>              = { fwd: sub, bwd: add };
const scaleOp:  Op<V, [number]>         = { fwd: scale, bwd: (v, k) => scale(v, 1 / k) };
const offsetOp: Op<V, [number, number]> = {
  fwd: (v, dx, dy) => ({ x: v.x + dx, y: v.y + dy }),
  bwd: (n, dx, dy) => ({ x: n.x - dx, y: n.y - dy }),
};

export class Vec extends Signal<V> {
  // ── class-level config ─────────────────────────────────────────
  static traits: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };
  static invertibles = invertibles<Vec>()("add", "sub", "scale", "offset");

  // ── class-level constructors ───────────────────────────────────
  static derive(fn: () => V): Vec { return computedCls(Vec, fn) }
  static lens(g: () => V, s: (v: V) => void): Writable<Vec> {
    return lensCls(Vec, g, s) as unknown as Writable<Vec>;
  }
  static is(v: unknown): v is Vec { return v instanceof Vec }

  // ── instance ───────────────────────────────────────────────────
  constructor(v: V = { x: 0, y: 0 }, opts?: SignalOptions<V>) { super(v, opts) }

  add(b: Val<V>): Vec     { return applyOp1(this, addOp,    b, Vec) }
  sub(b: Val<V>): Vec     { return applyOp1(this, subOp,    b, Vec) }
  scale(k: Val<number>): Vec { return applyOp1(this, scaleOp, k, Vec) }
  offset(dx: Val<number>, dy: Val<number>): Vec {
    return applyOp2(this, offsetOp, dx, dy, Vec);
  }

  normalize(): Vec { return Vec.derive(() => normalize(this.value)) }
  perp(): Vec      { return Vec.derive(() => perp(this.value)) }
  lerp(b: Val<V>, t: Val<number>): Vec {
    return Vec.derive(() => lerp(this.value, value(b), value(t)));
  }
  distance(other: Val<V>): Num {
    return Num.derive(() => metric(this.value, value(other)));
  }

  get x(): Num { return this.field("x", Num) }
  get y(): Num { return this.field("y", Num) }
  get magnitude(): Num {
    return this.memo("magnitude", () =>
      Num.derive(() => Math.hypot(this.value.x, this.value.y)));
  }
}
export interface Vec {
  readonly constructor: typeof Vec;
  get value(): V;
}

export function vec(x: Val<number> = 0, y: Val<number> = 0): Writable<Vec> {
  const v = new Vec() as unknown as Writable<Vec>;
  v.x.bind(x);
  v.y.bind(y);
  return v;
}
