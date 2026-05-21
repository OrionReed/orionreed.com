// ops.ts — bidirectional operation primitives.
//
// `Op<V, Args>` is a pair of `fwd`/`bwd` functions. Shared between
// the eager method implementation (e.g. `Vec.add`) and any future
// chain helper. Currently no Chain class — the prototype keeps the
// per-method `applyOp*` calls and treats fused chains as a future
// perf upgrade.

import { type Node, type Val, valueOf } from "./node";
import { type Lens } from "./signal";

export interface Op<V, A extends readonly unknown[]> {
  fwd: (v: V, ...a: A) => V;
  bwd: (n: V, ...a: A) => V;
}

/** Build a writable lens from a 1-arg op against a writable source. */
export function applyOp1<V, A, R extends Lens<V>>(
  src: Node<V> & { value: V },
  op: Op<V, [A]>,
  a: Val<A>,
  Cls: new (get: () => V, set: (v: V) => void) => R,
): R {
  return new Cls(
    () => op.fwd(src.value, valueOf(a)),
    (n) => { src.value = op.bwd(n, valueOf(a)) },
  );
}

/** 2-arg version. */
export function applyOp2<V, A, B, R extends Lens<V>>(
  src: Node<V> & { value: V },
  op: Op<V, [A, B]>,
  a: Val<A>,
  b: Val<B>,
  Cls: new (get: () => V, set: (v: V) => void) => R,
): R {
  return new Cls(
    () => op.fwd(src.value, valueOf(a), valueOf(b)),
    (n) => { src.value = op.bwd(n, valueOf(a), valueOf(b)) },
  );
}
