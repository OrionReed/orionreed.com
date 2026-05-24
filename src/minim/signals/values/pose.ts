// pose.ts — reactive 2D rigid-body pose: { x, y, theta }.
//
// Single source of truth for a rigid body's state. The solver binds
// to a `Pose` cell as a 3-DOF block and writes back through the same
// signal, so renderers, drag handlers, IK targets, and physics all
// observe the same value. Position and angle "lenses" (Vec / Num
// views built with `Vec.lens` / `Num.lens`) compose naturally for
// downstream consumers that only care about translation or rotation.

import { bind } from "../lateral";
import { Signal, type SignalOptions, type Val } from "../signal";
import { type Linear, type Pack, traits } from "../traits";
import { type Wr, type Writable } from "../writable";

type V = { x: number; y: number; theta: number };

export const add = (a: V, b: V): V => ({
  x: a.x + b.x,
  y: a.y + b.y,
  theta: a.theta + b.theta,
});
export const sub = (a: V, b: V): V => ({
  x: a.x - b.x,
  y: a.y - b.y,
  theta: a.theta - b.theta,
});
export const scale = (a: V, k: number): V => ({
  x: a.x * k,
  y: a.y * k,
  theta: a.theta * k,
});
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  theta: a.theta + (b.theta - a.theta) * t,
});
export const metric = (a: V, b: V) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.theta - b.theta);
export const equals = (a: V, b: V) =>
  a === b || (a.x === b.x && a.y === b.y && a.theta === b.theta);

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 3,
  read: (v, a, o) => {
    a[o] = v.x;
    a[o + 1] = v.y;
    a[o + 2] = v.theta;
  },
  write: (a, o) => ({ x: a[o]!, y: a[o + 1]!, theta: a[o + 2]! }),
};

export class Pose extends Signal<V> {
  static traits = traits<V>()({ linear: linearImpl, lerp, metric, equals, pack: packImpl });

  declare readonly _writable: Wr<Pose>;

  constructor(v: V = { x: 0, y: 0, theta: 0 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }
}
export interface Pose {
  readonly constructor: typeof Pose;
  get value(): V;
}

export function pose(v: Val<V> = { x: 0, y: 0, theta: 0 }): Writable<Pose> {
  const p = new Pose() as Writable<Pose>;
  bind(p, v);
  return p;
}
