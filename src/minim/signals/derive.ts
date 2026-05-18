// derive.ts — composition primitives.
//
//   Chain<T>           mutating wrapper used inside `vec.derive(c => …)`
//   field(p, k, Type)  typed Lens<P[K]> wearing Type's instance interface
//   derived(C, fn)     Computed-backed instance of C (chainable result)

import { Signal, Computed, batch, type Val } from "./signal";

/** Per-field reactive-init record — `{ [K in keyof T]?: Val<T[K]> }`.
 *  Used by composite factories (`vec`, `transform`) so each axis can
 *  accept any of plain T, signal, or thunk. */
export type ReactiveInit<T> = { [K in keyof T]?: Val<T[K]> };

// ════════════════════════════════════════════════════════════════════
// BaseChain<T> — the mutating builder used inside `cell.derive(c => …)`.
// Each value-type extends with its own `Vec.Chain`, `Num.Chain`, etc.
// ════════════════════════════════════════════════════════════════════

export class BaseChain<T> {
  value: T;
  constructor(v: T) { this.value = v; }
}

// ════════════════════════════════════════════════════════════════════
// View-class synthesis: build a subclass of `Base` (`Computed`) whose
// instances satisfy `instanceof Cls`.
//
// Approach: declare `class View extends Base`, then copy `Base`'s own
// prototype props onto `View.prototype` and re-target the prototype
// chain so it goes `View.prototype → Cls.prototype → Signal.prototype`.
// `instance instanceof Cls` becomes true (the bug fix); Base's methods
// still resolve because we copied them as own properties.
//
// Re-targeting `View.prototype.__proto__` (instance lookup chain) is
// different from `setPrototypeOf(View, ...)` (function-prototype lookup
// for `super()` resolution) — the latter would break `super(getter,
// setter)`; the former is safe. `super()` is resolved at class-def time
// via [[HomeObject]] and not affected by later proto-chain edits.
// ════════════════════════════════════════════════════════════════════

const VIEW_CLASS_CACHE = new WeakMap<object, WeakMap<object, unknown>>();

function copyOwnProps(from: object, to: object): void {
  // Skip `constructor` so `to.constructor` keeps pointing at the right
  // class. `value` IS copied — Computed's own override of the `value`
  // getter (dirty-check + recompute) must reach View instances, even
  // after we re-target the proto chain through Cls.
  for (const k of Object.getOwnPropertyNames(from)) {
    if (k === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(from, k);
    if (desc) Object.defineProperty(to, k, desc);
  }
  for (const k of Object.getOwnPropertySymbols(from)) {
    const desc = Object.getOwnPropertyDescriptor(from, k);
    if (desc) Object.defineProperty(to, k, desc);
  }
}

function viewClassFor<B>(Base: B, Cls: { prototype: object; name?: string }): B {
  let perBase = VIEW_CLASS_CACHE.get(Base as object);
  if (perBase === undefined) VIEW_CLASS_CACHE.set(Base as object, perBase = new WeakMap());
  const cached = perBase.get(Cls);
  if (cached !== undefined) return cached as B;
  class View extends (Base as new (...args: never[]) => object) {}
  // Copy Base's own prototype props (e.g. Computed's `_update`, value
  // getter override) BEFORE re-targeting the proto chain, otherwise
  // they'd become unreachable.
  copyOwnProps((Base as { prototype: object }).prototype, View.prototype);
  // Copy Cls's own prototype props (instance methods + symbol-keyed
  // trait slots like `[LINEAR]`).
  copyOwnProps(Cls.prototype, View.prototype);
  // Make `instance instanceof Cls` work: View.prototype → Cls.prototype
  // → … → Signal.prototype. Cls extends Signal in practice, so Signal's
  // own methods (peek, value getter/setter, bind, etc.) remain reachable
  // through Cls's chain.
  Object.setPrototypeOf(View.prototype, Cls.prototype);
  if (Cls.name) Object.defineProperty(View, "name", { value: Cls.name, configurable: true });
  perBase.set(Cls, View);
  return View as unknown as B;
}

// ════════════════════════════════════════════════════════════════════
// derived(Cls, fn) — Computed-backed instance presenting Cls's surface
// ════════════════════════════════════════════════════════════════════

/** Computed-backed instance of `Cls` (Vec, Num, Box, …) presenting
 *  `Cls`'s full instance surface. Pass a `setter` to get a writable
 *  lens with the same typed surface. */
export function derived<T, C extends Signal<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
  setter?: (v: T) => void,
): C {
  const ComputedCls = viewClassFor(Computed, Cls) as unknown as new (g: () => T, s?: (v: T) => void) => Computed<T>;
  return new ComputedCls(fn, setter) as unknown as C;
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

/** Bind a record of axes on a composite cell — used by factories like
 *  `vec(x, y)` and `transform({...})`. Wraps in `batch()` so observers
 *  don't see intermediate states.
 *
 *  Each value in `init` may be plain T, a signal, or a thunk. Reads
 *  the typed lens via `field(sig, key, ...)` — assumes the cell exposes
 *  a getter for each key (which value-type classes do via `get k()`). */
export function bindFields<P, I extends ReactiveInit<P>>(sig: Signal<P>, init: I): void {
  batch(() => {
    for (const k in init) {
      const v = init[k];
      if (v !== undefined) {
        const lens = (sig as unknown as Record<string, Signal<unknown>>)[k];
        if (lens) lens.bind(v as Val<unknown>);
      }
    }
  });
}
