// field() — typed reactive field lens for a key on a composite signal.
//
// Identity (`vec.x === vec.x`) is the caller's responsibility now: the
// caller uses `parent.memo("x", () => field(parent, "x", Num))` for
// stable identity. `field()` itself just constructs the lens, no cache.
//
// This collapses the two ad-hoc per-instance caches we had (FIELD_CACHE
// for axis lenses, `_mag?` etc. for lazy domain getters) into one
// mechanism: Signal.memo().

import { Signal, lens, type Val, value } from "./signal";

/** Per-field reactive init: each axis accepts plain T, signal, or thunk. */
export type SignalInit<T> = { [K in keyof T]?: Val<T[K]> };

/** Typed lens onto `parent.value[key]`. Stateless: wrap with
 *  `parent.memo(key, () => field(parent, key, Cls))` for stable identity. */
export function field<
  P,
  K extends keyof P,
  Cls extends new (...args: never[]) => Signal<P[K]>,
>(parent: Signal<P>, key: K, Type: Cls): InstanceType<Cls> {
  return lens(
    () => (parent.value as P)[key],
    (v) => { parent.value = { ...(parent.peek() as object), [key]: v } as P; },
    Type,
  ) as InstanceType<Cls>;
}

/** Resolve a `SignalInit<T>` against a defaults snapshot, returning T. */
export function resolveInit<T extends object>(
  defaults: T,
  init: SignalInit<T> | undefined,
): T {
  if (init === undefined) return { ...defaults };
  const out = { ...defaults } as T;
  for (const k of Object.keys(init) as (keyof T)[]) {
    const v = init[k];
    if (v !== undefined) (out as Record<keyof T, unknown>)[k] = value(v as Val<T[keyof T]>);
  }
  return out;
}

/** Bind a reactive init's reactive members into a target post-construction. */
export function bindInit<T extends object>(
  init: SignalInit<T> | undefined,
  fieldFactories: { [K in keyof T]?: () => Signal<T[K]> },
): void {
  if (init === undefined) return;
  for (const k of Object.keys(init) as (keyof T)[]) {
    const v = init[k];
    if (v instanceof Signal || typeof v === "function") {
      const make = fieldFactories[k];
      if (make) make().bind(v as Val<T[keyof T]>);
    }
  }
}

