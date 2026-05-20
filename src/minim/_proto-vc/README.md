# viewClassFor — principled redesign

## What's actually hacky

Re-reading `signals/derive.ts:28-40`, the metaprogramming has THREE parts:

```ts
function viewClassFor<B>(Base: B, Cls: { prototype: object }): B {
  ...
  class View extends (Base as new (...args: never[]) => object) {}
  copyOwnProps((Base as { prototype: object }).prototype, View.prototype);  // [1]
  copyOwnProps(Cls.prototype, View.prototype);                              // [2]
  Object.setPrototypeOf(View.prototype, Cls.prototype);                     // [3] ← hack
  ...
}
```

| Step | What it does | Status |
|---|---|---|
| **[1] Copy Base.prototype's own props onto View** | Brings Computed's `value` getter/setter, `peek`, `_update`, etc. onto View's own prototype | Fine — explicit, contained |
| **[2] Copy Cls.prototype's own props onto View** | Brings Vec's methods (`add`, `perp`, `[LINEAR]`, `[LERP]`, etc.) onto View's own prototype | Fine — explicit, contained |
| **[3] `setPrototypeOf(View.prototype, Cls.prototype)`** | Re-targets the prototype chain so `instance instanceof Cls` returns true | **HACK** — confirmed V8 deopt risk |

Web search confirms `setPrototypeOf` invalidates V8's hidden-class assumptions and can deopt inline caches — even when done once. The performance hit isn't just at the setPrototypeOf call; it propagates to any subsequent code accessing affected objects.

## What [3] is for, and what we can use instead

Step [3] exists for ONE reason: making `derived(Vec, fn) instanceof Vec` return true.

After [1]+[2], `View.prototype` already has all the methods needed (Computed's behavior + Cls's methods). Method dispatch works perfectly. The only thing missing is the prototype-chain `instanceof` check.

The principled replacement: **`Symbol.hasInstance` on `Cls`**. This is exactly the JavaScript mechanism for "custom instanceof behavior" — designed for this case.

```ts
const VIEW_OF = Symbol("minim.view-of");

// At View synthesis:
(View.prototype as any)[VIEW_OF] = Cls;

// On Cls (one-time install):
Object.defineProperty(Cls, Symbol.hasInstance, {
  value(instance: unknown) {
    if (instance == null || typeof instance !== "object") return false;
    // Native: regular `new Cls()` instances have Cls.prototype in chain
    if (Cls.prototype.isPrototypeOf(instance)) return true;
    // Synthesized: View instances carry the VIEW_OF marker
    return (instance as { [VIEW_OF]?: unknown })[VIEW_OF] === Cls;
  },
});
```

## What this fixes

- **No `setPrototypeOf` anywhere.** The prototype chain stays "natural": `View.prototype → Computed.prototype → Signal.prototype`. No re-targeting.
- **No V8 hidden-class invalidation risk.** The proto chain is set once at class definition (via `extends Base`) and never mutated.
- **Inline caches stay healthy.** Property accesses on derived Vec/Box/etc. instances follow a stable, well-known chain shape.
- **`instanceof Cls` still works** via the explicit Symbol.hasInstance check. Slightly slower than native (a property read + comparison) but only called at `instanceof` sites, not in hot paths.
- **Method dispatch is FASTER** (or at least no slower) because the proto chain doesn't have the unusual shape that setPrototypeOf produces.

## What this doesn't fix

- Computed still extends Signal (the inheritance structure of the engine is unchanged).
- Trait slots still installed via inline class methods (`get [LINEAR]() { ... }`).
- Chain class boilerplate still exists per value type.
- `field()` Symbol cache still exists.

This is THE smallest principled fix that addresses the most fragile hack. Other improvements (chain primitives, declarative authoring) are orthogonal and can layer on top.

## Files

- `derive-vc.ts` — refactored `derived()` and `viewClassFor` using Symbol.hasInstance.
- `signal-vec.ts` — Vec ported (mostly copy of `_proto-iso/vec.ts`, just imports the new `derived`).
- `signal-num.ts` — Num ported.
- `test.ts` — verify behavior matches current.
- `bench.ts` — perf comparison vs. current (with setPrototypeOf).
