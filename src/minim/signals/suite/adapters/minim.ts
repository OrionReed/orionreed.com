// minim adapter — implements the full `Reactive` surface.
//
// Each adapter value carries the underlying minim `Cell` so that lenses
// can be stacked: a `View` is a `Source`, and `lens`/`lensN` reach the
// backing cell off whatever source they're handed.

import {
  batch,
  type Cell,
  cell,
  derive,
  effect,
  lens as mlens,
  type Read,
  untracked,
} from "@minim/signals";
import type { Reactive, Readable, Source, Update, View } from "./types";

interface Backed<T> extends Source<T> {
  readonly cell: Read<T>;
}

const cellOf = (s: Readable<unknown>): Read<unknown> => (s as Backed<unknown>).cell;

function wrap<T>(c: Cell<T>): Backed<T> {
  return {
    cell: c as Read<T>,
    read: () => c.value,
    write: (v: T) => {
      (c as { value: T }).value = v;
    },
  };
}

export const minim: Reactive = {
  name: "minim",

  signal: <T>(initial: T): Source<T> => wrap(cell(initial) as unknown as Cell<T>),

  computed: <T>(fn: () => T): Readable<T> => wrap(derive(fn)),

  effect: fn => effect(fn),

  batch: fn => batch(fn),

  untracked: fn => untracked(fn),

  lens: <S, V>(source: Source<S>, fwd: (s: S) => V, bwd: (v: V, s: S) => S): View<V> => {
    const parent = cellOf(source) as Read<S>;
    const view = mlens(parent, fwd, (target: V, s: S) => bwd(target, s));
    return wrap(view as unknown as Cell<V>);
  },

  lensN: <V>(
    sources: readonly Source<unknown>[],
    fwd: (vals: readonly unknown[]) => V,
    bwd: (v: V, vals: readonly unknown[]) => readonly Update<unknown>[],
  ): View<V> => {
    const parents = sources.map(cellOf);
    const view = mlens(
      parents,
      ((vals: readonly unknown[]) => fwd(vals)) as never,
      ((target: V, vals: readonly unknown[]) => bwd(target, vals)) as never,
    );
    return wrap(view as unknown as Cell<V>);
  },
};
