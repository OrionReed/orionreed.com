// multi.ts — N-to-1 writable derived views (combine, mean).
//
// These are the canonical "more-than-a-DAG" structures in the library:
// one derived cell observes N parents and distributes writes back to
// all of them. Each operation is bidirectional and the dependency
// shape is a hypergraph edge, not a DAG edge.
//
// Ported from `signals/values/index.ts` to the r2 API:
//   - `lens(get, set, Cls)` (was `derived(Cls, get, set)`)
//   - nominal `HasLinear<T>` constraint on `mean` (was `requireLinear`
//     with a runtime throw)

import { Signal, lens, type Read, type ValueOf } from "../signal";
import { requireLinear, type Traits } from "../traits";

/** N-to-1 lens flavored as `parts[0]`'s class. The merge function reads
 *  all parts to produce the composite; `distribute` is the inverse —
 *  given a new composite value, returns the per-part values to write
 *  back. Each part's class must support construction with no args. */
export function combine<T, S extends Read<T>>(
  parts: readonly S[],
  merge: (vs: readonly T[]) => T,
  distribute: (next: T, prev: readonly T[]) => readonly T[],
): S {
  if (parts.length === 0) throw new Error("combine: need ≥1 signal");
  const Cls = (parts[0] as object).constructor as new (...args: never[]) => Signal<T>;
  return lens<T, Signal<T>>(
    () => {
      const vs = new Array<T>(parts.length);
      for (let i = 0; i < parts.length; i++) vs[i] = parts[i].value;
      return merge(vs);
    },
    (next) => {
      const prev = new Array<T>(parts.length);
      for (let i = 0; i < parts.length; i++) prev[i] = parts[i].peek();
      const updated = distribute(next, prev);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p instanceof Signal) (p as Signal<T>).value = updated[i];
      }
    },
    Cls,
  ) as unknown as S;
}

/** Writable arithmetic mean. Writing distributes the delta evenly to
 *  all parts. All parts must be of the same value class and that class
 *  must declare a `linear` trait.
 *
 *  Inference shape:
 *    - `R extends Read<unknown>` anchors the class identity (Num/Vec/…)
 *      so the return type preserves the input class.
 *    - The trait constraint `& HasLinear<ValueOf<R>>` is applied at the
 *      parameter site instead of in `R`'s bound; this avoids the
 *      variance trap (`Linear<T>` is invariant, so `HasLinear<number>`
 *      isn't assignable to `HasLinear<unknown>`). */
export function mean<R extends Read<unknown>>(
  first: R & Traits<ValueOf<R>, "linear">,
  ...rest: (R & Traits<ValueOf<R>, "linear">)[]
): R {
  type V = ValueOf<R>;
  const signals = [first, ...rest] as ReadonlyArray<Read<V>>;
  const lin = requireLinear(first as Traits<V, "linear">);
  const invN = 1 / signals.length;
  return combine<V, Read<V>>(
    signals,
    (vs) => {
      let acc = vs[0];
      for (let i = 1; i < vs.length; i++) acc = lin.add(acc, vs[i]);
      return lin.scale(acc, invN);
    },
    (next, prev) => {
      let acc = prev[0];
      for (let i = 1; i < prev.length; i++) acc = lin.add(acc, prev[i]);
      const cur = lin.scale(acc, invN);
      const delta = lin.sub(next, cur);
      return prev.map((v) => lin.add(v, delta));
    },
  ) as unknown as R;
}
