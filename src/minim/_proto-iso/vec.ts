// Vec ported to invertible chains.
//
// Demonstrates two things the simpler Num case didn't:
//   1. Field access as composition: `vec.x` is `field("x")` composed
//      onto the Vec's chain. Same primitive as everything else.
//   2. Type-changing chain steps: `vec.distance(other)` exits the
//      Vec chain and starts a Num chain — read-only because distance
//      isn't invertible.

import { Signal, value, type Val } from "../signals/signal";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../signals/traits";
import { Chain, via, type ViaTyped } from "./iso";
import { field } from "./field";
import { Num, NumChain } from "./num";

export interface Value { x: number; y: number }

const vAdd = (a: Value, b: Value): Value => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: Value, b: Value): Value => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: Value, k: number): Value => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: Value, b: Value, t: number): Value => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
});
const vMetric = (a: Value, b: Value) => Math.hypot(a.x - b.x, a.y - b.y);
const vEquals = (a: Value, b: Value) =>
  a === b || (a.x === b.x && a.y === b.y);
const vNormalize = (v: Value): Value => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};
const vPerp = (v: Value): Value => ({ x: v.y, y: -v.x });

const linearImpl: Linear<Value> = { add: vAdd, sub: vSub, scale: vScale };

/** Chain over `Value`. Invertible methods preserve `W`; one-way methods
 *  (`normalize`) downgrade to `false`. Type-changing methods construct
 *  a fresh chain of the target type. */
export class VecChain<W extends boolean> {
  constructor(readonly _chain: Chain<unknown, Value, W>) {}

  static start(): VecChain<true> {
    return new VecChain(Chain.of<Value>() as unknown as Chain<unknown, Value, true>);
  }

  // Invertible (preserve W) ───
  add(b: Val<Value>): VecChain<W> {
    return new VecChain(this._chain.iso({
      fwd: (v) => vAdd(v, value(b)),
      bwd: (v) => vSub(v, value(b)),
    }));
  }
  sub(b: Val<Value>): VecChain<W> {
    return new VecChain(this._chain.iso({
      fwd: (v) => vSub(v, value(b)),
      bwd: (v) => vAdd(v, value(b)),
    }));
  }
  /** Scalar multiply. Not invertible at `k === 0`. */
  scale(k: Val<number>): VecChain<W> {
    return new VecChain(this._chain.iso({
      fwd: (v) => vScale(v, value(k)),
      bwd: (v) => vScale(v, 1 / value(k)),
    }));
  }
  up(n: Val<number>): VecChain<W> {
    return new VecChain(this._chain.iso({
      fwd: (v) => ({ x: v.x, y: v.y - value(n) }),
      bwd: (v) => ({ x: v.x, y: v.y + value(n) }),
    }));
  }
  down(n: Val<number>): VecChain<W> {
    return new VecChain(this._chain.iso({
      fwd: (v) => ({ x: v.x, y: v.y + value(n) }),
      bwd: (v) => ({ x: v.x, y: v.y - value(n) }),
    }));
  }
  left(n: Val<number>): VecChain<W> {
    return new VecChain(this._chain.iso({
      fwd: (v) => ({ x: v.x - value(n), y: v.y }),
      bwd: (v) => ({ x: v.x + value(n), y: v.y }),
    }));
  }
  right(n: Val<number>): VecChain<W> {
    return new VecChain(this._chain.iso({
      fwd: (v) => ({ x: v.x + value(n), y: v.y }),
      bwd: (v) => ({ x: v.x - value(n), y: v.y }),
    }));
  }
  offset(dx: Val<number>, dy: Val<number>): VecChain<W> {
    return new VecChain(this._chain.iso({
      fwd: (v) => ({ x: v.x + value(dx), y: v.y + value(dy) }),
      bwd: (v) => ({ x: v.x - value(dx), y: v.y - value(dy) }),
    }));
  }
  /** `perp` is its own inverse cubed: `perp(perp(perp(perp(v)))) = v`.
   *  We use `perp⁻¹(v) = (-y, x)` (the explicit inverse) for clarity. */
  perp(): VecChain<W> {
    return new VecChain(this._chain.iso({
      fwd: vPerp,
      bwd: (v) => ({ x: -v.y, y: v.x }),
    }));
  }

  // One-way (downgrade to false) ───
  /** Normalize: information-losing (magnitude is discarded). Read-only. */
  normalize(): VecChain<false> {
    return new VecChain<false>(this._chain.ro({ fwd: vNormalize }));
  }

  // Type-changing → NumChain ───
  /** Project to scalar. Always read-only. */
  distance(other: Val<Value>): NumChain<false> {
    return new NumChain<false>(
      (this._chain as Chain<unknown, Value, boolean>).ro({
        fwd: (v: Value) => vMetric(v, value(other)),
      }) as Chain<unknown, number, false>,
    );
  }
  /** Pick the x-axis as a NumChain. Field lens — fully invertible
   *  (set-x writes through to the source). */
  get x(): NumChain<W> {
    return new NumChain<W>(
      (this._chain as Chain<unknown, Value, W>).iso(field<Value, "x">("x")) as unknown as Chain<unknown, number, W>,
    );
  }
  get y(): NumChain<W> {
    return new NumChain<W>(
      (this._chain as Chain<unknown, Value, W>).iso(field<Value, "y">("y")) as unknown as Chain<unknown, number, W>,
    );
  }
  /** Magnitude — read-only (loses direction). */
  get magnitude(): NumChain<false> {
    return new NumChain<false>(
      (this._chain as Chain<unknown, Value, boolean>).ro({
        fwd: (v: Value) => Math.hypot(v.x, v.y),
      }) as Chain<unknown, number, false>,
    );
  }
}

export class Vec extends Signal<Value> {
  constructor(v: Value = { x: 0, y: 0 }) { super(v); }

  get [LINEAR](): Linear<Value> { return linearImpl; }
  [LERP](a: Value, b: Value, t: number) { return vLerp(a, b, t); }
  [METRIC](a: Value, b: Value) { return vMetric(a, b); }
  [EQUALS](a: Value, b: Value) { return vEquals(a, b); }

  // Eager methods — one-line forwarders through the chain. Each one
  // returns a writable Vec because the underlying chain step is invertible.
  add(b: Val<Value>): Vec { return this.derive((c) => c.add(b)); }
  sub(b: Val<Value>): Vec { return this.derive((c) => c.sub(b)); }
  scale(k: Val<number>): Vec { return this.derive((c) => c.scale(k)); }
  up(n: Val<number>): Vec { return this.derive((c) => c.up(n)); }
  down(n: Val<number>): Vec { return this.derive((c) => c.down(n)); }
  left(n: Val<number>): Vec { return this.derive((c) => c.left(n)); }
  right(n: Val<number>): Vec { return this.derive((c) => c.right(n)); }
  offset(dx: Val<number>, dy: Val<number>): Vec { return this.derive((c) => c.offset(dx, dy)); }
  perp(): Vec { return this.derive((c) => c.perp()); }

  // Type-changing & read-only eager methods.
  distance(other: Val<Value>): ViaTyped<number, false, Num> {
    return this.deriveNum((c) => c.distance(other));
  }
  get magnitude(): ViaTyped<number, false, Num> {
    return this.deriveNum((c) => c.magnitude);
  }
  /** Writable axis lens. */
  get x(): Num { return this.deriveNum((c) => c.x) as Num; }
  get y(): Num { return this.deriveNum((c) => c.y) as Num; }

  /** Fused chain builder for Vec→Vec expressions. Writability tracked. */
  derive<W extends boolean>(
    fn: (c: VecChain<true>) => VecChain<W>,
  ): ViaTyped<Value, W, Vec> {
    const chain = fn(VecChain.start());
    return via(this as Signal<Value>, chain._chain as Chain<Value, Value, W>, Vec);
  }

  /** Fused chain builder for Vec→Num expressions (type-changing).
   *  Writability comes from the resulting NumChain. */
  deriveNum<W extends boolean>(
    fn: (c: VecChain<true>) => NumChain<W>,
  ): ViaTyped<number, W, Num> {
    const chain = fn(VecChain.start());
    return via(this as Signal<Value>, chain._chain as Chain<Value, number, W>, Num);
  }
}

export const vec = (x: Val<number> = 0, y: Val<number> = 0): Vec => {
  const v = new Vec();
  v.x.bind(x);
  v.y.bind(y);
  return v;
};
