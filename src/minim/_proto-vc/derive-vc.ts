// Principled `viewClassFor` — no `setPrototypeOf` mutation.
//
// Strategy:
//   1. `View extends Computed` — natural prototype chain. No re-targeting.
//   2. Copy Computed.prototype's own props onto View.prototype (so View
//      has Computed's value getter/setter/peek/etc. as own-on-prototype).
//   3. Copy Cls.prototype's own props onto View.prototype (Vec methods,
//      trait slots, etc.).
//   4. `instanceof Cls` is provided via Symbol.hasInstance on Cls,
//      checking either the native prototype chain (for plain `new Cls()`
//      instances) OR a marker symbol on the synthesized prototype.
//
// What changes vs `signals/derive.ts`:
//   - DROP `Object.setPrototypeOf(View.prototype, Cls.prototype)`.
//   - ADD `Symbol.hasInstance` install on Cls.
//   - ADD marker symbol on View.prototype.

import { Signal, Computed, type Val } from "../signals/signal";

const VIEW_OF = Symbol("minim.view-of");

// Per (Base, Cls) cache — same as current.
const VIEW_CLASS_CACHE = new WeakMap<object, WeakMap<object, unknown>>();

function copyOwnProps(from: object, to: object): void {
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

/** Install Symbol.hasInstance on Cls so `instance instanceof Cls` works
 *  for both regular `new Cls(...)` instances AND synthesized-View instances.
 *  Idempotent (safe to call repeatedly for the same Cls). */
function installHasInstance<C extends object>(Cls: C): void {
  // Skip if already installed (own descriptor with our marker).
  const existing = Object.getOwnPropertyDescriptor(Cls, Symbol.hasInstance);
  if (existing && (existing.value as { _minimHasInstance?: true })?._minimHasInstance) return;

  const proto = (Cls as { prototype: object }).prototype;
  const check = function (this: unknown, instance: unknown): boolean {
    if (instance === null || instance === undefined) return false;
    if (typeof instance !== "object" && typeof instance !== "function") return false;
    // Native: Cls.prototype is in the instance's prototype chain.
    if (proto && Object.prototype.isPrototypeOf.call(proto, instance)) return true;
    // Synthesized View: prototype carries VIEW_OF marker pointing at Cls.
    const v = (instance as { [VIEW_OF]?: unknown })[VIEW_OF];
    return v === Cls;
  };
  (check as { _minimHasInstance?: true })._minimHasInstance = true;

  Object.defineProperty(Cls, Symbol.hasInstance, {
    value: check,
    configurable: true,
    writable: false,
  });
}

function viewClassFor<B>(Base: B, Cls: { prototype: object; name?: string }): B {
  let perBase = VIEW_CLASS_CACHE.get(Base as object);
  if (perBase === undefined) VIEW_CLASS_CACHE.set(Base as object, perBase = new WeakMap());
  const cached = perBase.get(Cls);
  if (cached !== undefined) return cached as B;

  class View extends (Base as new (...args: never[]) => object) {}
  // Bring Computed's behavior in (value getter, peek, _update, etc.)
  copyOwnProps((Base as { prototype: object }).prototype, View.prototype);
  // Bring Cls's methods + trait slots in. Overwrites Computed's where
  // there's overlap (rare; only `constructor` which we skip).
  copyOwnProps(Cls.prototype, View.prototype);

  // Mark the prototype with VIEW_OF so Symbol.hasInstance can recognize it.
  Object.defineProperty(View.prototype, VIEW_OF, {
    value: Cls,
    configurable: true,
    writable: false,
    enumerable: false,
  });

  // Install Symbol.hasInstance on Cls (idempotent).
  installHasInstance(Cls);

  if (Cls.name) Object.defineProperty(View, "name", { value: Cls.name, configurable: true });

  perBase.set(Cls, View);
  return View as unknown as B;
}

/** Same signature as the current `derived()`. The change is internal:
 *  no `setPrototypeOf` on the synthesized prototype. */
export function derived<T, C extends Signal<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
  setter?: (v: T) => void,
): C {
  const ComputedCls = viewClassFor(Computed, Cls) as unknown as new (g: () => T, s?: (v: T) => void) => Computed<T>;
  return new ComputedCls(fn, setter) as unknown as C;
}

// Re-export for parity with `signals/derive.ts`.
export type { Val };
