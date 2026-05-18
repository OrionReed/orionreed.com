import { Signal, Computed, batch, type Val } from "./signal";

/** Per-field reactive init: each axis accepts plain T, signal, or thunk. */
export type ReactiveInit<T> = { [K in keyof T]?: Val<T[K]> };

/** Mutating builder used inside `sig.derive(c => …)`. */
export class BaseChain<T> {
  value: T;
  constructor(v: T) { this.value = v; }
}

// View-class synthesis. We want `derived(Vec, …) instanceof Vec` while
// reusing Computed's eval semantics. Approach: subclass Computed, copy
// Computed's own prototype props onto View.prototype, then re-target
// View.prototype's proto chain through Cls.prototype. Re-targeting the
// instance lookup chain is safe; `super()` resolution is fixed at
// class-def via [[HomeObject]].

const VIEW_CLASS_CACHE = new WeakMap<object, WeakMap<object, unknown>>();

function copyOwnProps(from: object, to: object): void {
  // Skip `constructor`; DO copy `value` (Computed's override).
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
  copyOwnProps((Base as { prototype: object }).prototype, View.prototype);
  copyOwnProps(Cls.prototype, View.prototype);
  Object.setPrototypeOf(View.prototype, Cls.prototype);
  if (Cls.name) Object.defineProperty(View, "name", { value: Cls.name, configurable: true });
  perBase.set(Cls, View);
  return View as unknown as B;
}

/** Computed-backed instance of `Cls`; pass `setter` for a writable lens. */
export function derived<T, C extends Signal<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
  setter?: (v: T) => void,
): C {
  const ComputedCls = viewClassFor(Computed, Cls) as unknown as new (g: () => T, s?: (v: T) => void) => Computed<T>;
  return new ComputedCls(fn, setter) as unknown as C;
}

const FIELD_CACHE = Symbol("minim.field-cache");

/** Typed lens onto `parent.value[key]`, cached per (parent, key). */
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

/** Bind a record of axes on a composite signal; batched. */
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
