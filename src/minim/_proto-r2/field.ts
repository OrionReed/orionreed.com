// field() — typed reactive field lens, cached per (parent, key).
//
// In production minim this routes through viewClassFor + Computed. Here
// it routes through `lens(Cls, get, set)`. The Symbol cache matches
// production: a `Symbol("field-cache")` keyed Record on the parent
// instance, which is the fastest shape we measured (faster than WeakMap
// for the hot "create-or-read once per render" pattern in animations).

import { Reactive, lens, type Val, value } from "./reactive";
import type { ValueClass } from "./traits";

/** Per-field reactive init: each axis accepts plain T, signal, or thunk. */
export type ReactiveInit<T> = { [K in keyof T]?: Val<T[K]> };

const FIELD_CACHE = Symbol("r2.field-cache");

/** Typed lens onto `parent.value[key]`, cached per (parent, key). */
export function field<
  P,
  K extends keyof P,
  Cls extends new (...args: never[]) => Reactive<P[K]>,
>(parent: Reactive<P>, key: K, Type: Cls): InstanceType<Cls> {
  const cache = ((parent as unknown as Record<symbol, Record<string, unknown>>)[FIELD_CACHE] ??= {});
  const k = key as string;
  const cached = cache[k];
  if (cached) return cached as InstanceType<Cls>;
  const fl = lens(
    Type,
    () => (parent.value as P)[key],
    (v) => { parent.value = { ...(parent.peek() as object), [key]: v } as P; },
  );
  cache[k] = fl;
  return fl as InstanceType<Cls>;
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
