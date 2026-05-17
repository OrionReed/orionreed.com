// derive.ts — composition primitives.
//
//   Chain<T>           mutating wrapper used inside `vec.derive(c => …)`
//   field(p, k, Type)  typed Lens<P[K]> wearing Type's instance interface
//   derived(C, fn)     Computed-backed instance of C (chainable result)

import { Signal, Computed } from "./signal";

// ════════════════════════════════════════════════════════════════════
// Chain<T>
// ════════════════════════════════════════════════════════════════════

export class Chain<T> {
  value: T;
  constructor(v: T) { this.value = v; }
}

// ════════════════════════════════════════════════════════════════════
// View-class synthesis: build a subclass of `Base` that inherits Cls's
// instance methods + symbol-keyed prototype slots (traits) + name.
//
// `setPrototypeOf(View, Cls)` would re-target `super()`, breaking
// Computed's `(getter, setter?)` constructor signature — so we copy.
// ════════════════════════════════════════════════════════════════════

const VIEW_CLASS_CACHE = new WeakMap<object, WeakMap<object, unknown>>();

function viewClassFor<B>(Base: B, Cls: { prototype: object; name?: string }): B {
  let perBase = VIEW_CLASS_CACHE.get(Base as object);
  if (perBase === undefined) VIEW_CLASS_CACHE.set(Base as object, perBase = new WeakMap());
  const cached = perBase.get(Cls);
  if (cached !== undefined) return cached as B;
  class View extends (Base as new (...args: never[]) => object) {}
  const keys: (string | symbol)[] = [
    ...Object.getOwnPropertyNames(Cls.prototype),
    ...Object.getOwnPropertySymbols(Cls.prototype),
  ];
  for (const k of keys) {
    if (k === "constructor" || k === "value") continue;
    const desc = Object.getOwnPropertyDescriptor(Cls.prototype, k);
    if (desc) Object.defineProperty(View.prototype, k, desc);
  }
  if (Cls.name) Object.defineProperty(View, "name", { value: Cls.name, configurable: true });
  perBase.set(Cls, View);
  return View as unknown as B;
}

// ════════════════════════════════════════════════════════════════════
// derived(Cls, fn) — Computed-backed instance presenting Cls's surface
// ════════════════════════════════════════════════════════════════════

export function derived<T, C extends Signal<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
): C {
  const ComputedCls = viewClassFor(Computed, Cls) as unknown as new (fn: () => T) => Computed<T>;
  return new ComputedCls(fn) as unknown as C;
}

// ════════════════════════════════════════════════════════════════════
// field(parent, key, Type) — typed sub-cell accessor
// ════════════════════════════════════════════════════════════════════

const FIELD_CACHE = Symbol("minim.field-cache");

/** Typed lens onto `parent.value[key]` wearing `Type`'s instance methods.
 *  Cached per (parent, key) for stable identity.
 *
 *      class Vec extends Signal<Vec.Value> {
 *        get x() { return field(this, "x", Num); }
 *      }
 */
export function field<P, K extends keyof P, Type extends new (...args: never[]) => Signal<P[K]>>(
  parent: Signal<P>,
  key: K,
  Type: Type,
): InstanceType<Type> {
  const cache = ((parent as unknown as Record<symbol, Record<string, unknown>>)[FIELD_CACHE] ??= {});
  const cached = cache[key as string];
  if (cached) return cached as InstanceType<Type>;
  const LensCls = viewClassFor(Computed, Type) as unknown as new (g: () => P[K], s: (v: P[K]) => void) => Computed<P[K]>;
  const fl = new LensCls(
    () => (parent.value as P)[key],
    (v) => { parent.value = { ...(parent.peek() as object), [key]: v } as P; },
  );
  cache[key as string] = fl;
  return fl as unknown as InstanceType<Type>;
}
