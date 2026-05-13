// Vec ported to the cell primitive. Same surface as `signals/vec.ts`'s
// Vec — same axes, same lifted ops, same lazy `length` getter, same
// `set`/`bind` methods, same `[LERP]`/`[ALGEBRA]` slots. Different
// authoring style: one proto-bag literal composed from helpers,
// instead of a fluent Builder chain.
//
// Used by `cell-full.bench.ts` to validate the simplification across
// the full surface.

import { computed, effect, type ReadonlySignal } from "../../core/signal";
import {
  axes,
  construct,
  defineCell,
  lazies,
  lift,
  liftScalar,
  withAlgebra,
} from "./cell";

export type V = { x: number; y: number };

// Forward ref so lifted ops can return cells of this type (and chain).
// `mkDerived` carries an explicit return type so the type cycle through
// `VecProto`/`VecRef` doesn't trip the inference engine.
let VecRef: { derived: (fn: () => V) => unknown };
const mkDerived = (fn: () => V): unknown => VecRef.derived(fn);

// ── Methods bag (functions, [LERP]/[ALGEBRA] symbols, etc. —
//    installed verbatim on the prototype). Spread of regular values
//    is safe; this bag must NOT contain property descriptors.
const VecMethods = {
  // Algebra: stamps [LERP] + [ALGEBRA] symbols on the proto.
  ...withAlgebra<V>({
    add: (a, b: V): V => ({ x: a.x + b.x, y: a.y + b.y }),
    sub: (a, b: V): V => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k: number): V => ({ x: a.x * k, y: a.y * k }),
    lerp: (a, b: V, t: number): V => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    }),
  }),

  // Lifted struct-returning ops.
  add: lift<V>((a, b: V): V => ({ x: a.x + b.x, y: a.y + b.y }), mkDerived),
  sub: lift<V>((a, b: V): V => ({ x: a.x - b.x, y: a.y - b.y }), mkDerived),
  scale: lift<V>(
    (a, k: number): V => ({ x: a.x * k, y: a.y * k }),
    mkDerived,
  ),
  perp: lift<V>((a): V => ({ x: -a.y, y: a.x }), mkDerived),
  normalize: lift<V>((a): V => {
    const len = Math.hypot(a.x, a.y) || 1;
    return { x: a.x / len, y: a.y / len };
  }, mkDerived),
  lerp: lift<V>(
    (a, b: V, t: number): V => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    }),
    mkDerived,
  ),
  offset: lift<V>(
    (a, dx: number, dy: number): V => ({ x: a.x + dx, y: a.y + dy }),
    mkDerived,
  ),
  up: lift<V>((a, n: number): V => ({ x: a.x, y: a.y - n }), mkDerived),
  down: lift<V>((a, n: number): V => ({ x: a.x, y: a.y + n }), mkDerived),
  left: lift<V>((a, n: number): V => ({ x: a.x - n, y: a.y }), mkDerived),
  right: lift<V>((a, n: number): V => ({ x: a.x + n, y: a.y }), mkDerived),

  // Lifted scalar.
  distance: liftScalar<V, number>((a, b: V): number =>
    Math.hypot(a.x - b.x, a.y - b.y),
  ),

  // Free-form methods.
  set<S extends { value: V }>(this: S, target: { value: V }): S {
    this.value = target.value;
    return this;
  },
  bind(this: { value: V }, target: { value: V }): () => void {
    const self = this;
    return effect(() => {
      self.value = target.value;
    });
  },
};

// ── Descriptors bag (real getters / setters — installed via
//    Object.defineProperties, NOT via spread).
const VecDescriptors = {
  ...axes<V, "x" | "y">(
    ["x", "y"],
    construct((x: number, y: number): V => ({ x, y })),
  ),
  ...lazies({
    length(this: { value: V }): ReadonlySignal<number> {
      const self = this;
      return computed(() => Math.hypot(self.value.x, self.value.y));
    },
  }),
};

export const Vec = defineCell<V, typeof VecMethods>(
  "Vec",
  VecMethods,
  VecDescriptors,
  { equals: (a, b) => a.x === b.x && a.y === b.y },
);
VecRef = Vec as unknown as { derived: (fn: () => V) => unknown };

/** Match the existing `pt(x, y)` factory signature for benches that
 *  exercise the user-facing entry. */
export const pt = (x: number, y: number) => Vec.signal({ x, y });
