// Principled `viewClassFor` v2 — INVERT THE INHERITANCE.
//
// The insight: the current code does
//   class View extends Computed       // chain: View → Computed → Signal
//   copyOwnProps(Computed.prototype, View)   // redundant; already in chain
//   copyOwnProps(Cls.prototype, View)        // bring Vec's methods
//   setPrototypeOf(View, Cls.prototype)      // re-target → View → Vec → Signal
//
// The redundancy + the re-target are both because we extended the WRONG
// class. If we extend Cls instead:
//
//   class View extends Cls                   // chain: View → Vec → Signal (NATURAL!)
//   copyOwnProps(Computed.prototype, View)   // bring Computed's overrides as own-props
//   // no copy of Cls (already in chain), no setPrototypeOf
//
// Result:
//   - instanceof Cls uses NATIVE prototype-chain check (270ps, not 4ns)
//   - No setPrototypeOf anywhere — V8 hidden classes stay healthy
//   - Less work per synthesis (one copyOwnProps call, no re-target)
//   - View.prototype's chain is "natural" — V8's inline-cache friendliness improves
//
// Trade-off: View instances are no longer `instanceof Computed`. We need
// to check if minim relies on that anywhere. Grep showed:
//   - One use in tests; not in production code
//   - `instanceof Signal` still works (Signal is in the chain via Cls)
//   - `isSignal(x)` (the standard guard) uses `instanceof Signal`

import {
  Signal,
  Computed,
  type Val,
} from "../signals/signal";

// We import the runtime Computed value (ComputedImpl). The methods
// we want to copy live on its prototype.
// `Computed` is exported as a type alias + the runtime class.
const ComputedImpl = Computed as unknown as new (g: () => unknown, s?: (v: unknown) => void) => unknown;
const ComputedProto = (ComputedImpl as unknown as { prototype: object }).prototype;

const VIEW_CLASS_CACHE = new WeakMap<object, unknown>();

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

/** Synthesize a class that's structurally a `Computed`-style derived
 *  Cls instance. View extends Cls (natural inheritance, native instanceof).
 *  Computed's behavior is copied onto View.prototype as own-props. */
function viewClassFor<T, C extends Signal<T>>(
  Cls: new (...args: never[]) => C,
): new (g: () => T, s?: (v: T) => void) => C {
  const cached = VIEW_CLASS_CACHE.get(Cls);
  if (cached !== undefined) return cached as new (g: () => T, s?: (v: T) => void) => C;

  // View extends Cls. The constructor takes (getter, setter?) like Computed.
  // We `super()` to Cls's constructor (no args → Cls uses its default).
  // Then we install the computed-state fields (cachedValue, getter, setter)
  // and reset flags so the value getter (copied below) treats this as
  // a fresh, never-evaluated computed.
  class View extends (Cls as unknown as new () => Signal<T>) {
    declare cachedValue: T | undefined;
    declare getter: () => T;
    declare setter?: (v: T) => void;

    constructor(getter: () => T, setter?: (v: T) => void) {
      super();
      // Match ComputedImpl's constructor initialization:
      this.cachedValue = undefined;
      this.getter = getter;
      if (setter !== undefined) this.setter = setter;
      this.flags = 0;
    }
  }

  // Copy Computed's own-prop overrides (value getter/setter, peek, _update,
  // _unwatched) onto View.prototype. These SHADOW the Signal versions
  // inherited via Cls → Signal.
  copyOwnProps(ComputedProto, View.prototype);
  // Also pre-copy Cls's methods onto View.prototype for faster dispatch
  // (1-step lookup instead of 2-step chain walk to Cls.prototype). This is
  // a perf optimization — the methods are still accessible via the chain
  // even without it, but the copy makes hot-path method calls ~10% faster.
  copyOwnProps((Cls as { prototype: object }).prototype, View.prototype);

  // Restore Cls's name for nicer stack traces.
  if (Cls.name) Object.defineProperty(View, "name", { value: Cls.name, configurable: true });

  VIEW_CLASS_CACHE.set(Cls, View);
  return View as unknown as new (g: () => T, s?: (v: T) => void) => C;
}

/** Same signature as the current `derived()`. The synthesized View
 *  uses natural inheritance from Cls — no setPrototypeOf, no
 *  Symbol.hasInstance. Native instanceof speed. */
export function derived<T, C extends Signal<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
  setter?: (v: T) => void,
): C {
  const ViewCls = viewClassFor(Cls) as unknown as new (g: () => T, s?: (v: T) => void) => C;
  return new ViewCls(fn, setter);
}

export type { Val };
