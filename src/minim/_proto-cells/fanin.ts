// fanin.ts — multi-input lens primitive.
//
// `fanin(Cls, parents, fwd, bwd?)` is the n-to-1 generalisation of
// `lensTo`. Read: aggregate over N parents via `fwd(vals)`. Write:
// split the new value into N parent-updates via `bwd(target)` or
// `bwd(target, vals)`, applied atomically inside `batch(...)` so
// subscribers fire once per fanin write, not N times.
//
// API: pass `vals` and `updates` as arrays. This is uniform across
// arities and lets the engine reliably classify bwd statefulness via
// `bwd.length` (1 → stateless, 2 → stateful) — variadic rest-params
// would all have length 1 and trip the dispatch.
//
// Stateful bwd (`(target, vals) => updates`):
//   - Engine peeks all parents into the scratch `vals` array on every
//     write. The bwd reads them to compute the parent updates.
// Stateless bwd (`target => updates`):
//   - Engine skips the peek loop. Useful for "ignore-current-state"
//     bwds like `axes` (write target.x and target.y directly).
//
// Allocation: one scratch `vals` array per fanin (mutated in place).
// No fresh allocations on the hot path. The bwd's returned `updates`
// array is allocated by the user fn — caller responsibility to keep
// it cheap. (Future optimisation: pass `out` array as a 3rd arg
// for in-place writeback. Not yet.)

import { batch, Signal } from "./signal";

/** Tuple type: `Vals<P>` = `[V1, V2, ...]` for parents `[Signal<V1>, Signal<V2>, ...]`. */
type Vals<P extends readonly Signal<unknown>[]> = {
  [K in keyof P]: P[K] extends Signal<infer V> ? V : never;
};

/** Update tuple: each entry is the new value of that parent, or
 *  `undefined` to skip writing that parent. */
type Updates<P extends readonly Signal<unknown>[]> = {
  [K in keyof P]?: P[K] extends Signal<infer V> ? V : never;
};

/** Multi-input lens: reads from N parents, writes back via `bwd`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors lensTo / mix
export function fanin<P extends readonly Signal<any>[], R, C extends new (...args: never[]) => Signal<any>>(
  Cls: C,
  parents: P,
  fwd: (vals: Vals<P>) => R,
  bwd?: ((target: R) => Updates<P>) | ((target: R, vals: Vals<P>) => Updates<P>),
): InstanceType<C> {
  const n = parents.length;
  const vals = new Array(n) as Vals<P>;

  const getter = (): R => {
    for (let i = 0; i < n; i++) {
      (vals as unknown[])[i] = (parents[i] as Signal<unknown>).value;
    }
    return fwd(vals);
  };

  if (bwd === undefined) {
    return Signal.install(Cls, getter as () => R) as InstanceType<C>;
  }

  // Arity-based: 1-arg bwd (stateless) skips the peek loop.
  // biome-ignore lint/suspicious/noExplicitAny: arity-only inspection
  const stateful = (bwd as (...args: any[]) => unknown).length >= 2;

  if (!stateful) {
    const sBwd = bwd as (target: R) => Updates<P>;
    const setter = (v: R): void => {
      const updates = sBwd(v);
      batch(() => {
        for (let i = 0; i < n; i++) {
          const u = (updates as unknown[])[i];
          if (u === undefined) continue;
          (parents[i] as Signal<unknown>).value = u;
        }
      });
    };
    return Signal.install(Cls, getter as () => R, setter as (v: R) => void) as InstanceType<C>;
  }

  const sBwd = bwd as (target: R, vals: Vals<P>) => Updates<P>;
  const setter = (v: R): void => {
    for (let i = 0; i < n; i++) {
      (vals as unknown[])[i] = (parents[i] as Signal<unknown>).peek();
    }
    const updates = sBwd(v, vals);
    batch(() => {
      for (let i = 0; i < n; i++) {
        const u = (updates as unknown[])[i];
        if (u === undefined) continue;
        (parents[i] as Signal<unknown>).value = u;
      }
    });
  };

  return Signal.install(Cls, getter as () => R, setter as (v: R) => void) as InstanceType<C>;
}
