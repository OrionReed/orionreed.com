// The local algebra of a single write-through node — the genuinely new
// concept relative to forward reactivity (forward computeds are pure
// functions; there is no "law" to satisfy). Classical lens laws,
// adapted to the reactive setting and expressed as fast-check
// properties so a failure shrinks to a minimal repro:
//
//   GetPut : write(view, read(view))      leaves the source unchanged.
//   PutGet : read(view) after write(view, v)  == v.
//   PutPut : write(v1); write(v2)  ==  write(v2)   (last write wins).
//
// A lens satisfying all three is very-well-behaved; PutGet-only (writes
// snap into a restricted range) is lossy.

import fc from "fast-check";
import type { Reactive, Source, View } from "../adapters/types";
import { approx } from "../harness/eq";

export interface LensSpec<S, V> {
  rx: Reactive;
  /** Fresh (source, view) pair seeded from an initial source value. */
  build: (rx: Reactive, init: S) => { source: Source<S>; view: View<V> };
  initSource: fc.Arbitrary<S>;
  /** Values written through the view. For lossy lenses, restrict to the
   *  view's preserved range so PutGet is meaningful. */
  viewWrite: fc.Arbitrary<V>;
  sourceEq?: (a: S, b: S) => boolean;
  viewEq?: (a: V, b: V) => boolean;
}

const numEq = approx() as (a: unknown, b: unknown) => boolean;

function eqs<S, V>(spec: LensSpec<S, V>) {
  return {
    sourceEq: spec.sourceEq ?? (numEq as (a: S, b: S) => boolean),
    viewEq: spec.viewEq ?? (numEq as (a: V, b: V) => boolean),
  };
}

export function getPut<S, V>(spec: LensSpec<S, V>): fc.IPropertyWithHooks<[S]> {
  const { sourceEq } = eqs(spec);
  return fc.property(spec.initSource, init => {
    const { source, view } = spec.build(spec.rx, init);
    const before = source.read();
    view.write(view.read());
    return sourceEq(source.read(), before);
  });
}

export function putGet<S, V>(spec: LensSpec<S, V>): fc.IPropertyWithHooks<[S, V]> {
  const { viewEq } = eqs(spec);
  return fc.property(spec.initSource, spec.viewWrite, (init, v) => {
    const { view } = spec.build(spec.rx, init);
    view.write(v);
    return viewEq(view.read(), v);
  });
}

export function putPut<S, V>(spec: LensSpec<S, V>): fc.IPropertyWithHooks<[S, V, V]> {
  const { sourceEq } = eqs(spec);
  return fc.property(spec.initSource, spec.viewWrite, spec.viewWrite, (init, v1, v2) => {
    const a = spec.build(spec.rx, init);
    a.view.write(v1);
    a.view.write(v2);
    const afterBoth = a.source.read();
    const b = spec.build(spec.rx, init);
    b.view.write(v2);
    return sourceEq(afterBoth, b.source.read());
  });
}

/** Run all three (very-well-behaved). */
export function veryWellBehaved<S, V>(spec: LensSpec<S, V>): fc.IPropertyWithHooks<unknown[]>[] {
  return [
    getPut(spec) as fc.IPropertyWithHooks<unknown[]>,
    putGet(spec) as fc.IPropertyWithHooks<unknown[]>,
    putPut(spec) as fc.IPropertyWithHooks<unknown[]>,
  ];
}
