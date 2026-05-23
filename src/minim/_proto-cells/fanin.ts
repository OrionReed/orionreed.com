// fanin.ts — multi-input lens primitive.
//
// `fanin(parents, fwd, bwd?)` is the n-to-1 generalisation of `lensTo`.
// Read: aggregate over N parents via `fwd(p1.value, p2.value, …)`.
// Write: split the new value into N parent-updates via `bwd(v, ps)`,
// applied atomically inside `batch(...)` so subscribers see one
// consistent state.
//
// Compared to a hand-rolled `Signal.install(Cls, fwd, setter)`:
//   - Cleaner API for the common case ("aggregate N writables").
//   - Automatic batching of parent writes — subscribers fire once
//     per `fanin` write, not N times.
//   - The bwd return shape (`undefined` to skip a parent, or a tuple
//     of new values) makes "read-only inputs" explicit.
//
// This is the propagator-network "up-rel" generalisation: a cell with
// multiple incoming edges, with a distribution policy on writes.
// Today's signal engine handles the read direction (multi-dep
// computed); `fanin` adds the write direction with explicit bwd.

import { batch, Signal, type WritableBrand } from "./signal";

/** Multi-input lens: reads from N parents, writes back via `bwd`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors lensTo
export function fanin<P extends readonly Signal<any>[], R, C extends new (...args: never[]) => Signal<R>>(
  Cls: C,
  parents: P,
  fwd: (...vals: { [K in keyof P]: P[K] extends Signal<infer V> ? V : never }) => R,
  bwd?: (
    v: R,
    ...vals: { [K in keyof P]: P[K] extends Signal<infer V> ? V : never }
  ) => { [K in keyof P]?: P[K] extends Signal<infer V> ? V : never },
): InstanceType<C> {
  const getter = (): R => {
    const vals = parents.map(p => (p as Signal<unknown>).value);
    return (fwd as (...args: unknown[]) => R)(...vals);
  };

  if (bwd === undefined) {
    return Signal.install(Cls, getter as () => R) as InstanceType<C>;
  }

  const setter = (v: R): void => {
    const vals = parents.map(p => (p as Signal<unknown>).peek());
    const updates = (bwd as (v: R, ...args: unknown[]) => Record<number, unknown>)(v, ...vals);
    batch(() => {
      for (let i = 0; i < parents.length; i++) {
        const u = updates[i];
        if (u === undefined) continue; // skip "no-update" parents
        const p = parents[i] as Signal<unknown> & WritableBrand;
        // Cast to set value on the writable parent.
        (p as Signal<unknown>).value = u;
      }
    });
  };

  return Signal.install(Cls, getter as () => R, setter as (v: R) => void) as InstanceType<C>;
}
