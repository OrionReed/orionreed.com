// ops.ts — bidirectional operation primitives.
//
// `Op<V, Args>` is a (fwd, bwd) pair. Used by eager invertible
// methods on value classes via `applyOp1`/`applyOp2`. No `Chain`
// class — `derive()` is dropped in r4. The two-call equivalent
// `vec.add(b).scale(k)` produces two nested lenses; perfectly fine
// for non-hot paths, and a `Vec.lens(get, set)` escape hatch exists
// for hot cases.

import { Signal, lens, type Val, type Lens } from "./signal";

export interface Op<V, Args extends readonly unknown[]> {
  fwd: (v: V, ...args: Args) => V;
  bwd: (n: V, ...args: Args) => V;
}

function valFn<T>(v: Val<T>): () => T {
  if (v instanceof Signal) return () => v.value;
  if (typeof v === "function") return v as () => T;
  return () => v as T;
}

export function applyOp1<V, A, C extends new (...args: never[]) => Signal<V>>(
  parent: Signal<V>, op: Op<V, [A]>, arg: Val<A>, Cls: C,
): InstanceType<C> {
  const get = valFn(arg);
  return lens(
    () => op.fwd(parent.value, get()),
    (n) => { parent.value = op.bwd(n, get()) },
    Cls,
  ) as InstanceType<C>;
}

export function applyOp2<V, A1, A2, C extends new (...args: never[]) => Signal<V>>(
  parent: Signal<V>, op: Op<V, [A1, A2]>, arg1: Val<A1>, arg2: Val<A2>, Cls: C,
): InstanceType<C> {
  const get1 = valFn(arg1);
  const get2 = valFn(arg2);
  return lens(
    () => op.fwd(parent.value, get1(), get2()),
    (n) => { parent.value = op.bwd(n, get1(), get2()) },
    Cls,
  ) as InstanceType<C>;
}

export type { Lens };
