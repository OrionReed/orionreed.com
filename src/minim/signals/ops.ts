// ops.ts — bidirectional operation primitives.
//
// An `Op<V, Args>` is a pair (fwd, bwd) of pure functions on V plus
// extra args. fwd reads child from parent; bwd writes parent from
// child. Used to build:
//
//   - Eager lens-returning methods on value classes (`applyOp1`,
//     `applyOp2`).
//   - The chain class for `vec.derive(c => c.add(b).scale(k))`,
//     which composes fwd in order and bwd in reverse.
//
// Design notes:
//
//   - **Each op is declared ONCE at module scope.** Both the eager
//     method body and the chain method body reference the same
//     `addOp` / `scaleOp` constant. Math is not duplicated.
//
//   - **Only "clearly invertible" ops belong here.** Operations with
//     multiple valid inverses (lerp's "preserve t vs preserve a/b",
//     normalize's information loss, etc.) are NOT bidirectional and
//     stay as `computed(...)` methods returning `RO<Cls>`.
//
//   - **Type-tracked invertibility.** Because the chain class only
//     exposes invertible methods, `derive(fn)` always returns a Lens
//     (writable). TS rejects `c.normalize()` inside a derive callback
//     at compile time — there's no such chain method.
//
//   - **Args are `Val<A>` (plain | thunk | Signal).** Resolved once at
//     apply / push time via `valFn`. Re-reading is a function call;
//     reactive args track correctly.

import {
  Signal, lens, type Val, value, valFn, type Lens,
} from "./signal";

/** A bidirectional operation on V with extra args. */
export interface Op<V, Args extends readonly unknown[]> {
  fwd: (v: V, ...args: Args) => V;
  bwd: (n: V, ...args: Args) => V;
}

/** Apply a unary Op as a typed Lens on `parent`. */
export function applyOp1<V, A, C extends new (...args: never[]) => Signal<V>>(
  parent: Signal<V>,
  op: Op<V, [A]>,
  arg: Val<A>,
  Cls: C,
): InstanceType<C> {
  const get = valFn(arg);
  return lens(
    () => op.fwd(parent.value, get()),
    (n) => { parent.value = op.bwd(n, get()); },
    Cls,
  ) as InstanceType<C>;
}

/** Apply a binary Op as a typed Lens on `parent`. */
export function applyOp2<V, A1, A2, C extends new (...args: never[]) => Signal<V>>(
  parent: Signal<V>,
  op: Op<V, [A1, A2]>,
  arg1: Val<A1>, arg2: Val<A2>,
  Cls: C,
): InstanceType<C> {
  const get1 = valFn(arg1);
  const get2 = valFn(arg2);
  return lens(
    () => op.fwd(parent.value, get1(), get2()),
    (n) => { parent.value = op.bwd(n, get1(), get2()); },
    Cls,
  ) as InstanceType<C>;
}

/** Nullary op application — for `invert()` / `perp()` / etc. with
 *  no runtime args. Useful when an op has no parameters at all. */
export function applyOp0<V, C extends new (...args: never[]) => Signal<V>>(
  parent: Signal<V>,
  op: Op<V, []>,
  Cls: C,
): InstanceType<C> {
  return lens(
    () => op.fwd(parent.value),
    (n) => { parent.value = op.bwd(n); },
    Cls,
  ) as InstanceType<C>;
}

/** Base class for invertible chain builders. Subclasses add typed
 *  convenience methods that push ops; `toLens()` composes the
 *  accumulated fwd/bwd into a single Lens.
 *
 *  Per-step cost: two closures (fwd, bwd) push to parallel arrays.
 *  At read time, the lens iterates fwds in order; at write time,
 *  bwds in reverse. No array allocation per evaluation. */
export class Chain<V> {
  protected fwds: Array<(v: V) => V> = [];
  protected bwds: Array<(v: V) => V> = [];

  protected push0(op: Op<V, []>): this {
    this.fwds.push((v) => op.fwd(v));
    this.bwds.push((n) => op.bwd(n));
    return this;
  }

  protected push1<A>(op: Op<V, [A]>, arg: Val<A>): this {
    const get = valFn(arg);
    this.fwds.push((v) => op.fwd(v, get()));
    this.bwds.push((n) => op.bwd(n, get()));
    return this;
  }

  protected push2<A1, A2>(op: Op<V, [A1, A2]>, arg1: Val<A1>, arg2: Val<A2>): this {
    const get1 = valFn(arg1);
    const get2 = valFn(arg2);
    this.fwds.push((v) => op.fwd(v, get1(), get2()));
    this.bwds.push((n) => op.bwd(n, get1(), get2()));
    return this;
  }

  /** Compose the accumulated chain into a single Lens reading from
   *  `parent`. Empty chain returns a lens that's the identity. */
  toLens<C extends new (...args: never[]) => Signal<V>>(
    parent: Signal<V>,
    Cls: C,
  ): InstanceType<C> {
    const fwds = this.fwds;
    const bwds = this.bwds;
    return lens(
      () => {
        let v = parent.value;
        for (let i = 0; i < fwds.length; i++) v = fwds[i](v);
        return v;
      },
      (n) => {
        let v = n;
        for (let i = bwds.length - 1; i >= 0; i--) v = bwds[i](v);
        parent.value = v;
      },
      Cls,
    ) as InstanceType<C>;
  }
}

// Re-export Lens so consumers don't need to reach into signal.ts.
export type { Lens };
