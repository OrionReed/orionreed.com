# Value-type storage: attempts & failure modes

A running log of designs we've tried for the value-type layer (`Vec`,
`Box`, `Color`, `Matrix`, `Transform`), why each failed, and what we
think the right next step is. Useful before another attempt.

## What we're trying to achieve

A "value type" is a reactive composite with:

1. **Composite read/write**: `vec.value === {x, y}`, `vec.value = {…}`.
2. **Per-field reactivity**: `vec.x` is its own `Signal<number>`; effects
   bound only to `vec.x` don't re-fire on `vec.y` changes.
3. **Per-field write propagation**: `vec.x.value = 5` updates the
   composite and fires subscribers correctly.
4. **Trait dispatch**: generic primitives (`tween`, `spring`, `toward`,
   `mean`) look up `[LINEAR]`/`[LERP]`/`[METRIC]`/`[EQUALS]` on the
   value to dispatch polymorphically.
5. **Method chaining**: `vec.add(b).scale(k)` reads naturally.
6. **Chain mode**: `vec.derive(c => c.add(b).scale(k))` for fused
   single-Computed expressions.
7. **`instanceof`**: `derived(Vec, fn) instanceof Vec` so consumers can
   narrow on `instanceof Vec`.
8. **Author ergonomics**: defining a new value type should be obvious
   and low-boilerplate — ideally just math + traits.
9. **High performance at scale**: axis writes shouldn't allocate;
   composite reads should be O(1).

## Where we are today (current code)

`Vec extends Signal<{x,y}>`. Composite is the source of truth. Field
lenses (`vec.x`, `vec.y`) are `Computed`-backed views that spread-
replace on write: `vec.x.value = 5` → `vec.value = {...vec.peek(), x: 5}`.

- **Cost**: every axis write allocates a fresh composite object (~120 b
  for Vec, more for Box/Transform). At 100 shapes × 60 fps × 1 axis
  write per frame: ~14 k allocs/sec. Invisible at this scale; would
  matter at 10k+ shapes.
- **`derived(Vec, fn) instanceof Vec`** works via `viewClassFor` —
  synthesizes a class extending `Computed` with `Vec.prototype` methods
  copied and the prototype chain re-targeted through `Vec.prototype`.
  This metaprogramming is contained in `derive.ts`.
- **Traits** are now declared inline on the class (`get [LINEAR]() {...}`,
  `[LERP](a,b,t) {...}`) rather than via the deleted `defineTrait`
  helper. `viewClassFor` copies them along with the methods.

This is the result after rolling back the failed "Strategy C" attempt
described below. The cleanups orthogonal to storage (inline traits,
`defineTrait` deletion, `BaseChain` deletion, plain `Symbol(…)` instead
of `Symbol.for(…)`) were kept.

## Attempt 1: Move B — axis-cells-as-truth

**Idea**: `Vec` is two Num cells + a `Lens` (writable Computed) for the
composite. `vec.x` IS a real `Num` signal; the composite is a derived
view that batches writes back to the cells.

**Pros**:
- Axes are real signals (clean conceptually).
- Per-field reactivity comes for free.
- Axis writes don't allocate (one Num write).
- Finer-grained subscription propagation.

**Cons that killed it**:
- Composite writes 3–5× slower than today (lens setter + 2 axis writes
  + batched propagation: ~92 ns vs ~20 ns).
- Composite reads through the lens add ~3–8 ns (Computed dirty check vs
  direct Signal property access).
- For minim's actual workload (tween-typical: composite write + effect
  read per frame), this was ~3× slower than today (171 ns vs 56 ns).

Bench numbers were small in absolute terms (<1% CPU at 100 shapes), but
the user's perf concern was real for large animations (1000+ shapes).

**Why we backed off**: the perf give-back wasn't worth it for the
target workload. The class hierarchy got awkward too — `instanceof Vec`
required a Symbol.hasInstance trick because cell-Vec and derived-Vec
extended different base classes (Signal vs Computed).

## Attempt 2: Strategy C — in-place mutation + lazy snapshot

**Idea**: Keep composite-as-truth. Avoid spread allocation by mutating
an internal object in place; serve external reads from a detached
snapshot allocated lazily on first read after each write. Add
`_markDirty()` / `_markClean()` / `_track()` methods to `Signal` so the
override can bypass equality and propagate manually.

**Author of `Vec`** had to write:
- Two Symbol-keyed fields: `[INTERNAL]` (mutable storage) and
  `[CACHED]` (lazy snapshot).
- Four cached `Computed` accessor descriptors at module top (to
  fall through to Computed semantics on derived instances, because
  `super.value` resolves through `Vec.prototype.__proto__ ===
  Signal.prototype`, not `Computed.prototype`).
- Five method overrides (`value` get + set, `peek`, `_update`,
  `writeAxis`), each with the same branch on `[INTERNAL]` presence.
- Knowledge of `_markDirty` / `_markClean` / `_track` and when to call
  each (and which one not to call from where).

`field()`'s setter dispatched through `parent.writeAxis(key, v)` when
available; fell back to spread-replace otherwise.

**Bench wins**:
- `vec.x.value = i`: 2.7× faster (90 ns → 33 ns), no alloc.
- `vec.value = {x,y}`: 2.7× faster (20 ns → 7 ns), no alloc.
- Tween-typical (composite write + effect): 1.4× faster (56 ns → 39 ns).
- `vec.value` cached read: ~6× slower in absolute (0.6 ns → 4 ns),
  but tiny absolute.

**Why it failed**:

1. **The metaprogramming we said we'd kill survived.** `viewClassFor`
   stayed (still needed for `instanceof Vec` on derived). `defineTrait`
   was gone but we added five overrides + Symbol storage + cached
   descriptors *per value type*. Net magic increased, distributed
   across five files instead of one helper.

2. **Authoring became dramatically harder.** Adding a new value type
   now required understanding: the `[INTERNAL]` / `[CACHED]` Symbol
   pattern, the branch-on-presence convention, the Computed-descriptor
   caching workaround, the `_markDirty`/`_markClean`/`_track` triad,
   the dirty-flag state machine of alien-signals (the underlying
   reactive engine), and how `super.value` resolves through prototype
   chains. None of this is hidden — it has to live in every value
   file.

3. **Footguns**: forget to invalidate `[CACHED]`, get stale reads;
   forget `_markDirty`, no propagation; forget `_markClean` in
   `_update`, infinite dirty loop; forget `_track` in the getter, no
   subscription; use `super.value` instead of `_track`, subscribers
   get cleared without `shallowPropagate`. We hit four of these five
   during implementation.

4. **The perf wins were chasing the wrong workload.** At 100 shapes ×
   60 fps, the C-strategy savings are ~700 µs/sec — well below 0.1%
   CPU. For the target scale, the wins are invisible. They'd only
   matter at 10k+ shapes, which is not realistic for minim.

5. **`_markDirty`/`_markClean`/`_track` leaked Signal internals**
   into the public API. Anyone authoring a value type now had to
   understand the underlying reactive engine's flag state machine.

**Verdict**: a benchmark-optimal strategy that traded enormous
authoring complexity for invisible runtime gains. Reverted.

## What we kept from the failed attempt

The "orthogonal cleanups" — improvements that didn't depend on the
storage refactor — survived the revert:

- **Inline trait declarations**: `class Vec { [LERP](a,b,t) {...}; ... }`
  instead of `defineTrait(Vec, LERP, ...)` at module load. Same
  runtime effect; no global Object.assign side-effects; no
  registration order issues; types statically check the method shape.
- **`defineTrait` / `lerpImpl` / `LerpMethods` deleted**. The
  per-class `.to(target, dur, ease)` method is declared inline on
  each value class.
- **`BaseChain` deleted**. Each value type has its own standalone
  `Chain` class (e.g., `VecChain`) with no shared base.
- **`bindFields` deleted**. Factory functions call `.bind(x)` directly
  per axis instead of going through a generic key-iterating helper.
- **`Symbol.for("minim.X")` → `Symbol("X")`**. Module-local symbols
  for trait slots; no global registry collision risk.
- **`VecOps<R>` interface mirror deleted**. The "implements VecOps<Vec>
  AND VecOps<Chain> so they stay in sync" pattern was deleted in favor
  of trusting TypeScript's normal method-by-method check on Chain
  classes. Minor regression risk (drift between Vec and VecChain) for
  significant readability gain.

## What we did not solve

The original wart that triggered this entire push:

```ts
// vec.x.value = 5 → spread-replaces the whole composite:
parent.value = { ...parent.peek(), x: 5 };
```

This allocates a fresh `{x, y}` object per axis write. For minim's
actual workloads it doesn't matter, but it's structurally ugly and
would matter at scale.

`viewClassFor` is also still there. It works, but it's the densest
metaprogramming in the codebase: synthesize a class extending
`Computed`, copy own-props from both prototypes, re-target the
prototype chain via `setPrototypeOf`. ~30 lines in `derive.ts`, all
to satisfy `derived(Vec, fn) instanceof Vec`.

## What we think the next attempt should look like

Based on research into how other libraries handle this:

- **Solid**: Proxy + per-property `createSignal()` stored in a hidden
  `$NODE` map. ~76 lines centralized. Authors don't define value types
  — they just use `createStore({x, y})`. Cost: Proxy reads are 3–4×
  slower than direct Signal access.
- **Vue 3 / Svelte 5**: Same as Solid — Proxy-based deep reactivity.
- **Leptos (Rust)**: Trait composition. Implement 4 base traits
  (`Track`, `Notify`, `ReadUntracked`, `Write`); the derived traits
  (`With`, `Get`, `Set`, `Update`) come from blanket implementations.
  No per-type override boilerplate.
- **Conal Elliott / Grapefruit (Haskell FRP)**: "Record of signals"
  is the foundational pattern. Each field is its own reactive value;
  composite reads use Applicative composition. The type system handles
  dispatch via type classes.

**Two paths worth considering for the next attempt**:

### Path A: New foundational primitive (`compositeSignal`)

Add a peer primitive to `Signal` / `Computed`: `compositeSignal<T>` —
a Signal that natively supports per-field tracking, lazy snapshots,
and batched composite writes. Authors of value types `extends
CompositeSignal<T>` and provide ~3 abstract methods (`cloneOf`,
`equalsOf`, `assignInto`). The C-strategy machinery lives in
`CompositeSignal` (one place), not in every value file (five places).

This is "what Strategy C should have been if we'd centralized it from
the start". The complexity is real but lives at the foundational level
alongside `Signal` and `Computed` — not as a per-value-type tax.

### Path B: Proxy-based reactive struct

Adopt Solid's pattern: a `reactive(obj)` primitive that returns a
proxy with per-property internal signals. Value types become almost
no-code:

```ts
export const vec = (x = 0, y = 0) =>
  reactiveStruct({x, y}, vecMethodBag);
```

Pay the Proxy perf cost (~3–4× slower than direct signal access).
Authors don't see the reactive plumbing; they just declare a struct +
method bag.

### What you said no to (already)

A `defineComposite()` or `struct()` factory helper that hides the
C-strategy machinery. The objection: hiding magic behind a function
isn't removing it. Path A is structurally different because the
abstraction is at the **primitive layer** (peer of Signal/Computed),
not the **value-type-definition layer** (wrapper around primitives).

---

When we come back to this, the bench scenarios to keep an eye on:

| Scenario | HEAD perf | Notes |
|---|---|---|
| `vec.x.value = 5` | ~90 ns, 120 b | Spread allocates. |
| `vec.value = {x,y}` | ~20 ns, 72 b | Signal write. |
| `vec.value` (cached) | ~0.6 ns | Direct read. |
| Tween + effect cycle | ~56 ns | The hot path. |
| Axis write + axis-only effect | ~186 ns | Field lens dirty + effect rerun. |

For 100-shape minim diagrams: all of these are invisible. The
storage refactor is interesting territory but not urgent.
