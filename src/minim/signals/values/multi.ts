// multi.ts — N-to-1 writable derived views (combine, mean).
//
// Canonical "more-than-a-DAG" structures: one derived cell observes
// N parents and distributes writes back to all of them.

import { type Of, type Read, Signal } from "../signal";
import { requireLinear, type Traits } from "../traits";
import { type Writable, type WritableOf } from "../writable";

/** N-to-1 lens flavoured as `parts[0]`'s class. `merge` reads all
 *  parts to produce the composite; `distribute` is the inverse —
 *  given a new composite value, returns the per-part values to write
 *  back. Each part's class must support construction with no args. */
export function combine<T, S extends Read<T>>(
  parts: readonly S[],
  merge: (vs: readonly T[]) => T,
  distribute: (next: T, prev: readonly T[]) => readonly T[],
): Writable<S> {
  if (parts.length === 0) throw new Error("combine: need ≥1 signal");
  const Cls = (parts[0] as object).constructor as new (...args: never[]) => Signal<T>;
  const lensView = Signal.install<T, Signal<T>>(
    Cls,
    () => {
      const vs = new Array<T>(parts.length);
      for (let i = 0; i < parts.length; i++) vs[i] = parts[i].value;
      return merge(vs);
    },
    next => {
      const prev = new Array<T>(parts.length);
      for (let i = 0; i < parts.length; i++) prev[i] = parts[i].peek();
      const updated = distribute(next, prev);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p instanceof Signal) (p as Signal<T>).value = updated[i];
      }
    },
  );
  return lensView as unknown as Writable<S>;
}

/** Writable arithmetic mean. Writing distributes the delta evenly to
 *  all parts. All parts must be of the same value class and that class
 *  must declare a `linear` trait. Each part must be writable (factory-
 *  returned, lens-form, etc.) — RO parts can't accept the distributed
 *  write-back. */
export function mean<R extends Read<unknown>>(
  ...signals: (R & WritableOf<Of<R>> & Traits<Of<R>, "linear">)[]
): Writable<R> {
  type V = Of<R>;
  if (signals.length === 0) throw new Error("mean: need ≥1 signal");
  const lin = requireLinear(signals[0] as unknown as Traits<V, "linear">);
  const invN = 1 / signals.length;
  return combine<V, Read<V>>(
    signals as ReadonlyArray<Read<V>>,
    vs => {
      let acc = vs[0];
      for (let i = 1; i < vs.length; i++) acc = lin.add(acc, vs[i]);
      return lin.scale(acc, invN);
    },
    (next, prev) => {
      let acc = prev[0];
      for (let i = 1; i < prev.length; i++) acc = lin.add(acc, prev[i]);
      const cur = lin.scale(acc, invN);
      const delta = lin.sub(next, cur);
      return prev.map(v => lin.add(v, delta));
    },
  ) as unknown as Writable<R>;
}
