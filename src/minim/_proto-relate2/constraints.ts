// constraints.ts — factory functions over `Cluster`.
//
// We reuse the `Force` subclasses from `_proto-avbd/constraints`
// (they're pure Solver+cellId-shaped numerical primitives, no
// reactive coupling). Factories here just bind signals through
// the cluster, then construct the Force on the inner solver.

import {
  BoundsForce,
  DistanceForce,
  EqForce,
  GenericForce,
  LensNumForce,
  type ResidualFn,
  SoftTargetForce,
} from "../_proto-avbd/constraints";
import type { Signal } from "../signals";
import { Cluster } from "./cluster";

// biome-ignore lint/suspicious/noExplicitAny: variance escape; runtime contract is "Signal carrying pack trait"
export type Bindable = Signal<any>;

export function eq(c: Cluster, a: Bindable, b: Bindable): EqForce {
  const f = new EqForce(c.solver, c.bind(a), c.bind(b));
  c.solver.addForce(f);
  return f;
}

export function distance(c: Cluster, a: Bindable, b: Bindable, rest: number): DistanceForce {
  const f = new DistanceForce(c.solver, c.bind(a), c.bind(b), rest);
  c.solver.addForce(f);
  return f;
}

export function spring(
  c: Cluster,
  a: Bindable,
  b: Bindable,
  rest: number,
  stiffness: number,
): DistanceForce {
  const f = new DistanceForce(c.solver, c.bind(a), c.bind(b), rest, false, stiffness);
  c.solver.addForce(f);
  return f;
}

export function lensNum(
  c: Cluster,
  a: Bindable,
  b: Bindable,
  fwd: (x: number) => number,
): LensNumForce {
  const f = new LensNumForce(c.solver, c.bind(a), c.bind(b), fwd);
  c.solver.addForce(f);
  return f;
}

export function clamp(c: Cluster, x: Bindable, lo: number, hi: number): BoundsForce {
  const f = new BoundsForce(c.solver, c.bind(x), lo, hi);
  c.solver.addForce(f);
  return f;
}

export function leq(c: Cluster, a: Bindable, b: Bindable): GenericForce {
  const f = generic(c, [a, b], 1, (pos, out) => {
    out[0]! = pos[1]![0]! - pos[0]![0]!;
  });
  f.fmax[0]! = 0;
  return f;
}

export function geq(c: Cluster, a: Bindable, b: Bindable): GenericForce {
  return leq(c, b, a);
}

export function softTarget(
  c: Cluster,
  cell: Bindable,
  target: ArrayLike<number>,
  stiffness: number,
): SoftTargetForce {
  const f = new SoftTargetForce(c.solver, c.bind(cell), target, stiffness);
  c.solver.addForce(f);
  return f;
}

export function generic(
  c: Cluster,
  cells: readonly Bindable[],
  rows: number,
  fn: ResidualFn,
  opts?: { fdStep?: number; hard?: boolean; stiffness?: number },
): GenericForce {
  const f = new GenericForce(c.solver, cells.map(s => c.bind(s)), rows, fn, opts);
  c.solver.addForce(f);
  return f;
}
