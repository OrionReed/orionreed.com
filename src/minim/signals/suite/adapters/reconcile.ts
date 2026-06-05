// Adapter for the recursive reconciliation prototype (_proto/reconcile-multi).
// Implements the full `Reactive` surface so the bireactive laws/benches run on
// it head-to-head with minim. The prototype's forward core is naive (pull +
// eager invalidate, no equality short-circuit), so it is NOT expected to match
// minim on forward minimality — what's under test here is the BACKWARD
// architecture (soundness, lens laws, confluence, lossy absorption).

import {
  type Bilens,
  Computed,
  Effect,
  Root,
  type Root as RRoot,
  batch as rbatch,
  lens as rlens,
  lensN as rlensN,
  untracked as runtracked,
  write as rwrite,
} from "../../_proto/reconcile-multi";
import type { Reactive, Readable, Source, Update, View } from "./types";

type Node = RRoot | Bilens;
interface Backed<T> extends Source<T> {
  readonly node: Node;
}
const nodeOf = (s: Readable<unknown>): Node => (s as Backed<unknown>).node;

function wrap<T>(node: Node): Backed<T> {
  return {
    node,
    read: () => node.get() as T,
    write: (v: T) => rwrite(node, v),
  };
}

export const reconcile: Reactive = {
  name: "reconcile",

  signal: <T>(initial: T): Source<T> => wrap<T>(new Root(initial)),

  computed: <T>(fn: () => T): Readable<T> => {
    const c = new Computed(fn);
    return { read: () => c.get() };
  },

  effect: fn => {
    const e = new Effect(fn as () => void);
    return () => e.dispose();
  },

  batch: fn => rbatch(fn),

  untracked: fn => runtracked(fn),

  lens: <S, V>(source: Source<S>, fwd: (s: S) => V, bwd: (v: V, s: S) => S): View<V> =>
    wrap<V>(rlens<S, V>(nodeOf(source), fwd, (target, cur) => bwd(target, cur))),

  lensN: <V>(
    sources: readonly Source<unknown>[],
    fwd: (vals: readonly unknown[]) => V,
    bwd: (v: V, vals: readonly unknown[]) => readonly Update<unknown>[],
  ): View<V> =>
    wrap<V>(
      rlensN<V>(
        sources.map(nodeOf),
        vals => fwd(vals),
        (target, vals) => bwd(target, vals) as (unknown | undefined)[],
      ),
    ),
};
