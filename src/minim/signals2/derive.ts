// derive.ts — fluent reactive composition primitives.
//
//   Chain<T>            mutating wrapper, used inside `vec.derive(c => …)`
//   field(p, k)         plain Lens<P[K]> onto a parent field
//   typedField(p, k, C) Lens<P[K]> with a value-type's methods
//   typedLensClass(C)   build a Lens subclass carrying C's instance methods
//   derived(C, fn)      build a Computed-backed instance of C (chainable)
//
// Each value-type class overrides `derive` with its own typed signature,
// so `c => c.add(b).scale(2)` types correctly. There is NO derive() on
// Signal.prototype — it's a per-class concern.

import { Signal, Computed, Lens, computed } from "./engine";

// ── Chain<T> — base mutating wrapper ───────────────────────────────
//
// Each value-type extends this with its own methods (NumChain,
// VecChain, etc.). Methods mutate `chain.value` and return `this`.

export class Chain<T> {
  value: T;
  constructor(v: T) { this.value = v; }
}

// ── derived(Cls, fn) — Computed-backed instance with Cls's surface ──
//
// The trick: build a per-Cls "ComputedCls" once that extends Computed
// and copies Cls.prototype's methods + Cls's static side. Returned
// instances have Computed semantics (lazy eval, caching) AND Cls's
// method surface (so vec.add(b).scale(2) keeps chaining).

const COMPUTED_CLS_CACHE = new WeakMap<object, new (fn: () => unknown) => Computed<unknown>>();

function computedClassFor(Cls: { prototype: object }): new (fn: () => unknown) => Computed<unknown> {
  let cached = COMPUTED_CLS_CACHE.get(Cls);
  if (cached) return cached;
  class ComputedCls extends Computed<unknown> {}
  // Copy instance methods (skip `value` — keep Computed's getter — and `constructor`).
  for (const k of Object.getOwnPropertyNames(Cls.prototype)) {
    if (k === "constructor" || k === "value") continue;
    const desc = Object.getOwnPropertyDescriptor(Cls.prototype, k);
    if (desc) Object.defineProperty(ComputedCls.prototype, k, desc);
  }
  // Copy statics (for classOf(derived).traits to work).
  for (const k of Object.getOwnPropertyNames(Cls)) {
    if (k === "length" || k === "name" || k === "prototype") continue;
    const desc = Object.getOwnPropertyDescriptor(Cls, k);
    if (desc) Object.defineProperty(ComputedCls, k, desc);
  }
  cached = ComputedCls;
  COMPUTED_CLS_CACHE.set(Cls, cached);
  return cached;
}

export function derived<T, C extends Signal<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
): C {
  const ComputedCls = computedClassFor(Cls as unknown as { prototype: object });
  return new ComputedCls(fn) as unknown as C;
}

// ── field — typed sub-cell accessor ────────────────────────────────

const FIELD_CACHE = Symbol("minim.field-cache");

/** Plain typed lens onto `parent.value[key]`. Cached on parent. */
export function field<P, K extends keyof P>(parent: Signal<P>, key: K): Lens<P[K]> {
  const cache = ((parent as any)[FIELD_CACHE] ??= {}) as Record<string, Lens<unknown>>;
  const cached = cache[key as string];
  if (cached) return cached as Lens<P[K]>;
  const fl = new Lens<P[K]>(
    () => (parent.value as P)[key],
    (v) => { parent.value = { ...(parent.peek() as object), [key]: v } as P; },
  );
  cache[key as string] = fl as unknown as Lens<unknown>;
  return fl;
}

/** Build a Lens subclass that carries `Type.prototype`'s methods.
 *  Returned class is typed as `new (g, s) => InstanceType<Type>` so
 *  field accessors don't need `as unknown as` casts at the call site. */
export function typedLensClass<T, C>(
  Type: { prototype: object; new (...args: never[]): C },
): new (g: () => T, s: (v: T) => void) => C {
  class TypedLens extends Lens<T> {}
  for (const k of Object.getOwnPropertyNames(Type.prototype)) {
    if (k === "constructor" || k === "value") continue;
    const desc = Object.getOwnPropertyDescriptor(Type.prototype, k);
    if (desc) Object.defineProperty(TypedLens.prototype, k, desc);
  }
  return TypedLens as unknown as new (g: () => T, s: (v: T) => void) => C;
}

/** Typed sub-field: a Lens<P[K]> wearing a value-type's method surface.
 *  `LensCls` should come from `typedLensClass(SomeValueType)`. */
export function typedField<P, K extends keyof P, C>(
  parent: Signal<P>,
  key: K,
  LensCls: new (g: () => P[K], s: (v: P[K]) => void) => C,
): C {
  const cache = ((parent as any)[FIELD_CACHE] ??= {}) as Record<string, unknown>;
  const cached = cache[key as string];
  if (cached) return cached as C;
  const fl = new LensCls(
    () => (parent.value as P)[key],
    (v) => { parent.value = { ...(parent.peek() as object), [key]: v } as P; },
  );
  cache[key as string] = fl;
  return fl;
}
