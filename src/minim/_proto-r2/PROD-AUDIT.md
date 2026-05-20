# Production audit: what would change to adopt r2

A walk through everything in the codebase that imports the signals
API, categorized by impact. The headline: **most consumer code is
trivially mechanical to migrate.** The only "interesting" work is
authors of bespoke value types (a handful of files).

**The delete-list is aggressive.** See `## DELETE` sections below
for the full inventory of what disappears, no compat shim, no
hide-from-public. The merged design is a clean replacement.

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

## Migration sequence (no compat shim, take ALL improvements at once)

User decision: **no intermediate compat-shim state**. Land r2 in one
sitting; delete everything on the delete-list at the same time.

A reasonable order:

1. **Rename `src/minim/_proto-r2/` → `src/minim/signals/`** (move /
   replace). Update all imports across the codebase from `../signals/X`
   to use the new module paths.
2. **Codemod the ~12 `derived(Cls, fn[, set])` call sites** in
   `shapes/` to `computed(fn, Cls)` (no setter) or `lens(get, set, Cls)`
   (with setter). AST-aware codemod or manual.
3. **Manually convert the 2 custom value-type files** in
   `elements/optical-centering/`: `md-lerps.ts` and `md-morph.ts`.
   Change `[LERP]`/`[EQUALS]` symbols to `static traits = {…}` shape
   with the `interface ClassName { constructor: typeof ClassName }` merge.
4. **Retype `setSignalWriteHook` callback** in `assert/record.ts` — type
   change only, no logic change.
5. **Drop all `*Value` → `Of<Vec>` aliasing** in consumer code. Find
   every `import { type Value as VecValue }` pattern and replace with
   `import { type Of, type Vec }` + `Of<Vec>` use sites.
6. **Delete the 8 `_proto-*` folders** (after extracting any notes
   you want to preserve to a permanent location).
7. **Delete `src/minim/_notes/values-storage-attempts.md`** (historical
   context now superseded; git log preserves it).
8. **Run the test suite + bench.** Should be net-faster across
   realistic workloads; the only consistent regression is `signal(0)`
   construction (~3 ns absolute).

Estimated effort: 4–6 hours for the whole migration if done in one
sitting. Most of it is codemod-able.

## DELETE inventory (no rename, no hide, no compat — gone)

### Whole files deleted

- `src/minim/signals/derive.ts` (replaced by `Signal.field()` method)
- `src/minim/signals/signal.ts` (replaced by r2's `signal.ts`)
- `src/minim/signals/traits.ts` (replaced by r2's `traits.ts`)
- `src/minim/signals/index.ts` (replaced by r2's `index.ts`)
- `src/minim/signals/clock.ts` (only 16 lines; verify no consumers first)
- `src/minim/signals/values/*.ts` (replaced by r2's `values/*.ts`)
- `src/minim/_notes/values-storage-attempts.md` (historical)
- `src/minim/_bench/signals.bench.ts` (replaced by r2's `bench.ts`)

### Whole folders deleted (after merge)

- `src/minim/_proto/`
- `src/minim/_proto-callable/`
- `src/minim/_proto-combo-b/`
- `src/minim/_proto-iso/`
- `src/minim/_proto-r2/` (becomes `src/minim/signals/`)
- `src/minim/_proto-reactive/`
- `src/minim/_proto-vc/`
- `src/minim/_proto-wrap/`

### Exported symbols deleted

| symbol | from | replacement / why |
|---|---|---|
| `ComputedImpl` | `signals/signal.ts` | merged into `Signal<T>` |
| `Computed` (runtime export) | `signals/signal.ts` | kept only as type alias |
| `derived` | `signals/derive.ts` | split into `computed(fn, Cls)` + `lens(get, set, Cls)` |
| `viewClassFor` | `signals/derive.ts` | not needed (natural prototype chain) |
| `VIEW_CLASS_CACHE` | `signals/derive.ts` | not needed |
| `copyOwnProps` | `signals/derive.ts` | not needed |
| `FIELD_CACHE` (Symbol) | `signals/derive.ts` | replaced by `Signal._fields` private slot |
| `LINEAR` (Symbol) | `signals/traits.ts` | replaced by string key `"linear"` |
| `LERP` (Symbol) | `signals/traits.ts` | string `"lerp"` |
| `METRIC` (Symbol) | `signals/traits.ts` | string `"metric"` |
| `EQUALS` (Symbol) | `signals/traits.ts` | string `"equals"` |
| `classOf<T>(s)` | `signals/traits.ts` | inline `(s as object).constructor.name` |
| `ValueClass<T>` | `signals/traits.ts` | not needed |
| `clockSignal(anim)` | `signals/clock.ts` | verify consumers first; likely delete |
| `* as VecMath`, `BoxMath`, `ColorMath`, `MatrixMath`, `NumMath`, `TransformMath` | `signals/index.ts` | verify consumers first; consumers import math fns directly from value modules |
| `type Value` (in each value module) | `signals/values/*.ts` | each module exposes `type V` locally; consumers use `Of<Vec>` |
| `type VecValue` / `BoxValue` / `NumValue` / `ColorValue` / `MatrixValue` / `TransformValue` | `signals/values/index.ts` | replaced by `Of<Vec>` etc. |

### Patterns deleted across all value-type files

- `get [LINEAR]()` getter on prototype — replaced by `static traits = {…}`
- `[LERP](…)` / `[METRIC](…)` / `[EQUALS](…)` method declarations
- `const linearImpl: Linear<Value> = { add, sub, scale }` module-level
  consts (now inlined into `static traits.linear`)
- `private _mag?: Num`, `_area?`, `_center?`, `_top?`, `_bottom?`,
  `_left?`, `_right?`, `_lum?`, `_css?`, `_det?` private slots — all
  collapse into `this.memo(key, factory)` calls

### Consumer-side patterns deleted

- `import { type Value as XValue }` rename style (every file using it)
- Every `derived(Cls, fn[, setter])` call site (~12 in `shapes/*.ts`)
- Every direct `sig[LINEAR]` / `sig[LERP]` / `sig[METRIC]` / `sig[EQUALS]`
  access (the 2 custom-value-type files in `elements/`)

### Documentation deleted

- Every `_proto-*/README.md` and `_proto-*/MIGRATION-PLAN.md`
- `_notes/values-storage-attempts.md`
- Possibly `posts/minim.md` and `posts/optical-centering.md` code
  samples if they reference deleted patterns

### Summary count

| category | count |
|---|---|
| whole files deleted | ~12 (incl. all `signals/values/*.ts`) |
| whole folders deleted | **8** `_proto-*` folders |
| exported symbols deleted | ~20+ |
| symbol-keyed traits | **4** (LINEAR, LERP, METRIC, EQUALS — gone entirely) |
| private memoization slots across value classes | ~12 (all replaced by `memo()`) |
| `*Value` interface exports | **6** (per value type) |

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
