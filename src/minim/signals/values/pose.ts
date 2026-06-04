// pose.ts — reactive 2D rigid-body pose: { x, y, theta }.
//
// Single source of truth for a rigid body. The solver binds the cell as
// a 3-DOF block and writes back through it, so renderers, drag handlers,
// IK, and physics all observe the same value. Vec / Num lenses compose
// for consumers that care only about translation or rotation.

import { Cell, type Init, type Writable } from "../signal";
import type { Linear, Pack, Pivotal, TraitDict } from "../traits";

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
export const metric = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.theta - b.theta);
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
/** Rotate-about-pivot moves the position and adds dθ to orientation;
 *  scale-about-pivot scales position, orientation untouched. */
const pivotalImpl: Pivotal<V> = {
  rotateAbout: (v, p, dθ) => {
    const cos = Math.cos(dθ);
    const sin = Math.sin(dθ);
    const dx = v.x - p.x;
    const dy = v.y - p.y;
    return {
      x: p.x + cos * dx - sin * dy,
      y: p.y + sin * dx + cos * dy,
      theta: v.theta + dθ,
    };
  },
  scaleAbout: (v, p, k) => ({
    x: p.x + k * (v.x - p.x),
    y: p.y + k * (v.y - p.y),
    theta: v.theta,
  }),
};

export class Pose extends Cell<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
    pivotal: pivotalImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Pose.traits;

  constructor(v: V = { x: 0, y: 0, theta: 0 }) {
    super(v, { equals });
  }
}

/** Writable `Pose`. Literal seeds a fresh cell; existing `Pose` passes
 *  through by identity. RO sources are rejected at the type level — use
 *  `Pose.derive(...)` for reactive RO tracking, or `cell.value` to
 *  snapshot. */
export function pose(v: Init<Pose> = { x: 0, y: 0, theta: 0 }): Writable<Pose> {
  if (v instanceof Pose) return v as Writable<Pose>;
  const p = new Pose() as Writable<Pose>;
  p.value = v;
  return p;
}
