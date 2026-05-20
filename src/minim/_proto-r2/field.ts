// field() — typed reactive field lens for a key on a composite signal.
//
// Identity (`vec.x === vec.x`) is the caller's responsibility now: the
// caller uses `parent.memo("x", () => field(parent, "x", Num))` for
// stable identity. `field()` itself just constructs the lens, no cache.
//
// This collapses the two ad-hoc per-instance caches we had (FIELD_CACHE
// for axis lenses, `_mag?` etc. for lazy domain getters) into one
// mechanism: Reactive.memo().

import { Reactive, lens, type Val, value } from "./reactive";
import type { ValueClass } from "./traits";

/** Per-field reactive init: each axis accepts plain T, signal, or thunk. */
export type ReactiveInit<T> = { [K in keyof T]?: Val<T[K]> };

/** Typed lens onto `parent.value[key]`. Stateless: wrap with
 *  `parent.memo(key, () => field(parent, key, Cls))` for stable identity. */
export function field<
  P,
  K extends keyof P,
  Cls extends new (...args: never[]) => Reactive<P[K]>,
>(parent: Reactive<P>, key: K, Type: Cls): InstanceType<Cls> {
  return lens(
    () => (parent.value as P)[key],
    (v) => { parent.value = { ...(parent.peek() as object), [key]: v } as P; },
    Type,
  ) as InstanceType<Cls>;
}

/** Resolve a `ReactiveInit<T>` against a defaults snapshot, returning T. */
export function resolveInit<T extends object>(
  defaults: T,
  init: ReactiveInit<T> | undefined,
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
  init: ReactiveInit<T> | undefined,
  fieldFactories: { [K in keyof T]?: () => Reactive<T[K]> },
): void {
  if (init === undefined) return;
  for (const k of Object.keys(init) as (keyof T)[]) {
    const v = init[k];
    if (v instanceof Reactive || typeof v === "function") {
      const make = fieldFactories[k];
      if (make) make().bind(v as Val<T[keyof T]>);
    }
  }
}

export type { ValueClass };
