// Num ported to invertible chains.
//
// What changed vs `signals/values/num.ts`:
//   - The eager methods (`add`, `sub`, `scale`) now route through the
//     chain instead of constructing a `derived(Num, fn)` directly.
//   - The chain methods carry inverses (`bwd`), so the chain is
//     writable end-to-end whenever every step is invertible.
//   - `clamp` is one-way; it returns `NumChain<false>`, downgrading the
//     chain's writability bit.
//
// The math (`add`, `sub`, `scale`, `clamp`) is declared ONCE in the
// chain class. The eager methods are one-line forwarders.

import { Signal, value, type Val } from "../signals/signal";
import { LINEAR, LERP, METRIC, EQUALS, type Linear } from "../signals/traits";
import { Chain, via, type ViaTyped } from "./iso";

export type Value = number;

const add = (a: Value, b: Value) => a + b;
const sub = (a: Value, b: Value) => a - b;
const scl = (a: Value, k: number) => a * k;
const lerpFn = (a: Value, b: Value, t: number) => a + (b - a) * t;
const linearImpl: Linear<Value> = { add, sub, scale: scl };

/** Chain over `number`. `W` tracks writability through composition. */
export class NumChain<W extends boolean> {
  constructor(readonly _chain: Chain<unknown, Value, W>) {}

  /** Empty chain rooted at `S = number`. */
  static start(): NumChain<true> {
    return new NumChain(Chain.of<Value>() as unknown as Chain<unknown, Value, true>);
  }

  // Invertible (preserve W) ───
  add(b: Val<Value>): NumChain<W> {
    return new NumChain(this._chain.iso({
      fwd: (v) => v + value(b),
      bwd: (v) => v - value(b),
    }));
  }
  sub(b: Val<Value>): NumChain<W> {
    return new NumChain(this._chain.iso({
      fwd: (v) => v - value(b),
      bwd: (v) => v + value(b),
    }));
  }
  /** Scalar multiply. NOTE: not invertible at runtime when `k === 0`;
   *  reads still work, writes will divide by zero. (We could lift this
   *  to type-level by typing `k` as `Exclude<number, 0>`, but at the
   *  call site this is rarely worth the friction.) */
  scale(k: Val<number>): NumChain<W> {
    return new NumChain(this._chain.iso({
      fwd: (v) => v * value(k),
      bwd: (v) => v / value(k),
    }));
  }
  /** Linear interpolate from current toward `b` at fraction `t`.
   *  Invertible: `v = (1-t)·cur + t·b`, so `cur = (v - t·b)/(1-t)`. */
  lerp(b: Val<Value>, t: Val<number>): NumChain<W> {
    return new NumChain(this._chain.iso({
      fwd: (v) => lerpFn(v, value(b), value(t)),
      bwd: (v) => {
        const tv = value(t);
        return tv === 1 ? value(b) : (v - tv * value(b)) / (1 - tv);
      },
    }));
  }

  // One-way (downgrade to false) ───
  clamp(lo: Val<Value>, hi: Val<Value>): NumChain<false> {
    return new NumChain<false>(this._chain.ro({
      fwd: (v) => {
        const l = value(lo), h = value(hi);
        return v < l ? l : v > h ? h : v;
      },
    }));
  }

  /** Write-side clamp: reads pass through unchanged; WRITES are clamped
   *  to `[lo, hi]` before propagating upstream. Preserves writability.
   *  Useful for "drag handle but don't let it go past a limit." */
  clampWrite(lo: Val<Value>, hi: Val<Value>): NumChain<W> {
    return new NumChain<W>(this._chain.iso({
      fwd: (v) => v,
      bwd: (v) => {
        const l = value(lo), h = value(hi);
        return v < l ? l : v > h ? h : v;
      },
    }));
  }
}

export class Num extends Signal<Value> {
  constructor(v: Value = 0) { super(v); }

  // Trait slots.
  get [LINEAR](): Linear<Value> { return linearImpl; }
  [LERP](a: Value, b: Value, t: number) { return lerpFn(a, b, t); }
  [METRIC](a: Value, b: Value) { return Math.abs(a - b); }
  [EQUALS](a: Value, b: Value) { return a === b; }

  /** One-line forwarder. Returns a writable view since `add` is invertible. */
  add(b: Val<Value>): Num { return this.derive((c) => c.add(b)); }
  sub(b: Val<Value>): Num { return this.derive((c) => c.sub(b)); }
  scale(k: Val<number>): Num { return this.derive((c) => c.scale(k)); }
  /** Read-only view (clamp is not invertible). */
  clamp(lo: Val<Value>, hi: Val<Value>): ViaTyped<Value, false, Num> {
    return this.derive((c) => c.clamp(lo, hi));
  }

  /** Fused chain builder. The return type tracks writability of the
   *  expression: any `ro` step downgrades the chain to a read-only `Num`. */
  derive<W extends boolean>(
    fn: (c: NumChain<true>) => NumChain<W>,
  ): ViaTyped<Value, W, Num> {
    const chain = fn(NumChain.start());
    return via(this as Signal<Value>, chain._chain as Chain<Value, Value, W>, Num);
  }
}

export const num = (v: Val<Value> = 0): Num => {
  const n = new Num();
  n.bind(v);
  return n;
};
