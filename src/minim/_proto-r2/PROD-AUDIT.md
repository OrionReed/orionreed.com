# Production audit: what would change to adopt r2

A walk through everything in the codebase that imports the signals
API, categorized by impact. The headline: **most consumer code is
trivially mechanical to migrate.** The only "interesting" work is
authors of bespoke value types (a handful of files).

## Counts

| symbol | call sites outside signals/_proto/_test |
|---|---|
| `Signal<T>` (type) | ~40 files |
| `signal()` (factory) | ~20 files |
| `derived(Cls, get, set?)` | ~12 files (mostly `shapes/`) |
| `computed(fn)` (factory) | ~15 files |
| `effect`, `batch`, `untracked` | ~30 files combined |
| `Vec` / `Num` / `Box` / `Color` / `Matrix` / `Transform` (value classes) | ~50 files |
| `LERP` / `LINEAR` / `METRIC` / `EQUALS` (trait symbols) | **2 files** outside signals/: `md-lerps.ts`, `md-morph.ts` |
| `requireLinear` / `linearOf` / etc | **0 files** outside signals/ |
| `classOf` | **0 files** outside signals/ |
| `viewClassFor` | **0 files** outside `derive.ts` |
| `setSignalWriteHook` | **1 file** (`assert/record.ts`) |

## Categorized changes

### Category A — pure renames (codemod-friendly)

These are mechanical sed-style replacements with no behavioral change.

| from | to | scope |
|---|---|---|
| `Signal<T>` (type) | `Reactive<T>` | ~40 files |
| `Signal` (class import) | `Reactive` | most don't import the class; types only |
| `Computed<T>` | `Computed<T>` (unchanged — kept as type alias) | a few |
| `derived(Cls, get)` | `computed(get, Cls)` | ~10 sites |
| `derived(Cls, get, set)` | `lens(get, set, Cls)` | ~10 sites |
| `import { Value as XValue }` | `import { XValue }` | wherever the `Value` rename was applied |
| `(s as object)[LERP]` style trait access | `(s.constructor as typeof X).traits.lerp` | the 2 custom-value-type files |

A single codemod could handle all of these. Real example from
`shapes/handle.ts`:

```ts
// before
const pos = derived(Vec,
  () => { … },
  (target) => { … },
);

// after
const pos = lens(
  () => { … },
  (target) => { … },
  Vec,
);
```

The arg order swap is mechanical (and there's a clear distinction
between read-only `derived(Cls, fn)` → `computed(fn, Cls)` vs writable
`derived(Cls, fn, setter)` → `lens(fn, setter, Cls)`).

### Category B — custom value-type declarations (touch & think)

Files that declare their own value classes via `[LERP]` / `[EQUALS]`
symbols:

1. **`elements/optical-centering/md-lerps.ts`** — declares a `Signal<string>`
   subclass with a `[LERP]` slot for string interpolation.
2. **`elements/optical-centering/md-morph.ts`** — declares a `Signal<PolygonValue>`
   subclass with `[LERP]` and `[EQUALS]` slots.

Both convert to the `static traits = {…}` shape:

```ts
// before
class LerpableString extends Signal<string> {
  [LERP](a: string, b: string, t: number) { return stringLerp(a, b, t); }
}

// after
class LerpableString extends Reactive<string> {
  static traits: TraitDict<string> = { lerp: stringLerp };
}
export interface LerpableString { readonly constructor: typeof LerpableString }
```

This is the only place outside `signals/values/` that needs care.
Two files, ~10 lines each.

### Category C — the assert/record write hook (one file)

`src/minim/assert/record.ts` uses `setSignalWriteHook((sig) => …)` to
attribute writes to the active span. The hook signature is identical
in r2 — just retype `Signal` → `Reactive` in the callback parameter.
Zero behavioral change.

```ts
// before
removeWriteHook = setSignalWriteHook((sig: Signal<unknown>) => { … });

// after
removeWriteHook = setSignalWriteHook((sig: Reactive<unknown>) => { … });
```

### Category D — animator consumer code (zero changes if we add backwards-compat layer)

Files calling `spring(sig, …)`, `tween(sig, …)`, `toward(sig, …)`,
`attract(sig, …)` work unchanged because the new signatures
(`Traits<T, "linear" | "metric">`) are *more specific* than the old
(`Signal<T>` + runtime-throw). Existing call sites pass Vec/Num/etc.
which already satisfy the new constraints.

The only place this would break: a user explicitly typing the
parameter as `Signal<T>` when they only have `Vec`. That's unusual;
the codebase doesn't do this anywhere I can see.

### Category E — clock / waapi / ext (mechanical)

`clock.ts`, `ext/waapi.ts`, `ext/timeline.ts`, `ext/snapshot.ts` —
all use the engine surface (signal/computed/effect/batch). Pure
mechanical: same factory calls work, types resolve.

### Category F — shape system internals (shapes/*.ts)

The shapes folder is the heaviest user of `derived(Cls, …)`. Every
call site becomes one of:

- `derived(Cls, get)` → `computed(get, Cls)` (read-only)
- `derived(Cls, get, set)` → `lens(get, set, Cls)` (writable)

Plus the `Signal<T>` type imports become `Reactive<T>`.

Shape constructors don't touch trait symbols or `viewClassFor`; the
internals are pure consumer.

### Category G — tests (`_test/`)

The existing prod test suite already passes against r2 conformance.
Migration is the same Cat A renames; nothing semantic changes.

## What would NOT change

- **Reactive engine semantics.** alien-signals algorithm is identical;
  `peek`/`flush` fixes are present in both prod and r2.
- **Effect lifecycle.** Same cleanup ordering, same disposal, same
  batch semantics.
- **Trait dispatch behavior at the call site.** `spring(vec, target)`
  works the same; the change is in the lookup path
  (`s.constructor.traits.linear` instead of `s[LINEAR]`), not in the
  observable behavior.
- **`field()` lens caching at the *call site*.** Today `vec.x === vec.x`
  via FIELD_CACHE symbol; in r2 same identity via `this.memo()`.
  Consumer-visible behavior identical.
- **Animator math.** spring/tween/toward/attract math is verbatim.

## What WOULD change for value-type authors (subtle)

These only matter for someone writing a *new* value type:

1. **`memo()` for `.x`/`.magnitude`/etc.** Instead of `field(this, "x", Num)`
   in the getter, use `this.memo("x", () => field(this, "x", Num))`.
   `field()` itself is now stateless.

2. **`static traits = {…}` for trait declaration.** Instead of
   `[LINEAR]` / `[LERP]` / `[METRIC]` / `[EQUALS]` slots on the class
   prototype, one `static traits` dict.

3. **`interface ClassName { constructor: typeof ClassName }` merge.**
   Add this one-liner after each value class declaration so the
   `Traits<T, K>` constraint can see the static `traits` dict
   through TypeScript's `inst.constructor` narrowing.

4. **Subclass constructors that want `opts`** (rare) — declare
   `(v: T = default, opts?: ReactiveOptions<T>)` and forward to
   `super(v, opts)`.

All four are documented in the r2 README + the value-type files
(`values/num.ts`, `values/vec.ts`, `values/box.ts`) serve as ready
reference templates.

## Migration sequence (if/when we decide to ship)

A reasonable order:

1. **Land r2 alongside prod** as a parallel module
   (`src/minim/r2/`). Both work. Tests reference both.
2. **Port `Color`, `Matrix`, `Transform`, `Anchor`** value types from
   `signals/values/` to r2 (mechanical, ~1 hour each).
3. **Port `Tween` chainable class** and `play`/`when`/`loop`/`every`/`untilChange`/`not`
   to use Reactive instead of Signal (no trait constraints needed).
4. **Add a backwards-compat shim**: `signal/index.ts` re-exports r2
   primitives under their old names (`Signal = Reactive`, etc). This
   lets consumer code keep importing from `@minim/signals` with no
   change required.
5. **One consumer at a time, replace `derived` with `computed` /
   `lens`** — codemod or manual; ~12 files in shapes/.
6. **Rename the custom value types** in `md-lerps.ts` and
   `md-morph.ts` to the `static traits` shape (manual; 2 files).
7. **Drop the shim and the old `signals/` folder.** All consumers now
   import directly from r2.

Estimated effort: 4–6 hours for the whole migration if it's done in
one sitting. Most of it is codemod-able.

## Risk areas

1. **`setSignalWriteHook` recursion**. Both prod and r2 have the
   `flush()` re-entrancy guard now. No change in risk; documented in
   r2 to make sure it doesn't regress.

2. **`derived(Cls, fn)` with no setter became `computed(fn, Cls)`.**
   If anyone was passing `derived(Cls, fn, undefined)` expecting a
   "no-setter computed", the new `computed(fn, Cls)` shape is the
   replacement — but `lens(fn, undefined!, Cls)` would crash. Codemod
   needs to special-case the 2-arg form correctly.

3. **Custom-value-type authors using `viewClassFor` indirectly** —
   `derived(MyCustomClass, …)` works because `viewClassFor` synthesizes
   a class. In r2, `computed(fn, MyCustomClass)` does the simpler
   `new MyCustomClass(); inst.getter = fn`. Works only if
   `MyCustomClass`'s constructor handles zero-arg construction
   (default value). All current value classes do this. Custom classes
   that don't would break — none in the current codebase that I can
   find.

4. **Order of declaration vs interface merge.** The `interface Vec {
   readonly constructor: typeof Vec }` merge must come *after* the
   class. Standard pattern but easy to forget when porting.

## Recommendation

Migration is low-risk and mostly mechanical. The biggest behavioral
upgrade for end-users is the nominal trait constraints — animator
consumers get compile-time errors instead of runtime throws on
"forgot to add `[LINEAR]`" mistakes.

If we ship r2, the codemod path (steps 4-7 above) is straightforward.
The only files needing careful manual attention are the two custom
value types in `elements/optical-centering/`.
