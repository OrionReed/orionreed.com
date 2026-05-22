// ops.ts — bidirectional operation primitives.
//
// `Op<V, Args>` is a (fwd, bwd) pair. Used by eager invertible
// methods on value classes via `applyOp1`/`applyOp2`. No `Chain`
// class — `derive()` is dropped in r4. The two-call equivalent
// `vec.add(b).scale(k)` produces two nested lenses; perfectly fine
// for non-hot paths, and a `Vec.lens(get, set)` escape hatch exists
// for hot cases.

import { lensCls, Signal, type Val, valFn } from "./signal";

export interface Op<V, Args extends readonly unknown[]> {
  fwd: (v: V, ...args: Args) => V;
  bwd: (n: V, ...args: Args) => V;
}

/** Nullary op (e.g. matrix invert — its own inverse). */
export function applyOp0<V, C extends Signal<V>>(
  parent: Signal<V>,
  op: Op<V, []>,
  Cls: new (...args: never[]) => C,
): C {
  return lensCls(
    Cls,
    () => op.fwd(parent.value),
    n => {
      parent.value = op.bwd(n);
    },
  );
}

export function applyOp1<V, A, C extends Signal<V>>(
  parent: Signal<V>,
  op: Op<V, [A]>,
  arg: Val<A>,
  Cls: new (...args: never[]) => C,
): C {
  const get = valFn(arg);
  return lensCls(
    Cls,
    () => op.fwd(parent.value, get()),
    n => {
      parent.value = op.bwd(n, get());
    },
  );
}

export function applyOp2<V, A1, A2, C extends Signal<V>>(
  parent: Signal<V>,
  op: Op<V, [A1, A2]>,
  arg1: Val<A1>,
  arg2: Val<A2>,
  Cls: new (...args: never[]) => C,
): C {
  const get1 = valFn(arg1);
  const get2 = valFn(arg2);
  return lensCls(
    Cls,
    () => op.fwd(parent.value, get1(), get2()),
    n => {
      parent.value = op.bwd(n, get1(), get2());
    },
  );
}
