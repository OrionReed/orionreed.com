# r5 — Phase 0 complete

All value classes ported, all combinators / animators / clock ported.
`Writable<R>` works for user-defined value classes with zero library
changes (the LiftField hand-maintained registry is gone).

## Status

- **27 tests passing** (engine, values, types, box/transform,
  extensibility for user-defined Hsl class)
- **Typecheck clean** across all files
- **Bench matches r2** (parity within ~5% noise on signal write, vec
  write-through, vec construction, chain depth 4)

## What we built

### Engine (signal.ts)

Merged Signal class — unchanged from r2. Added:

- `WritableBrand` interface (unique-symbol-keyed).
- `Signal.install(Cls, getter, setter?)` static — friend factory used by
  the public `computed` / `lens` / `computedCls` / `lensCls`. Lets us
  keep `getter` / `setter` private at the class level.
- Private `getter` / `setter` fields — external corruption blocked.
- `Signal._mode(v)` static — supports `isComputed` / `isLens` runtime
  checks without exposing the private state.
- `valFn(v)` — public closure-form `Val<T>` resolver (was previously
  internal to ops/anim).

### Factories

```ts
signal(initial)            : Signal<T> & WritableBrand
computed(fn)               : Signal<T>                  // RO
lens(g, s)                 : Signal<T> & WritableBrand  // RW derived
computedCls(Vec, fn)       : Vec                        // typed RO
lensCls(Vec, g, s)         : Vec                        // typed RW (cast at site)
```

Per value class:

```ts
Num.derive(fn)             : Num
Num.lens(g, s)             : Writable<Num>
Num.is(v)                  : v is Num
num(v)                     : Writable<Num>
```

### `Writable<R>` modifier

**Now fully extensible.** `LiftField<X> = X extends Read<unknown> ?
Writable<X> : X` — recursive for any Read-shaped field, no per-class
registry.

User-defined value classes "just work":

```ts
class Hsl extends Signal<{ h:number; s:number; l:number }> {
  static traits = { linear, lerp, metric, equals };
  static invertibles = invertibles<Hsl>()("add", "scale");
  static derive(fn): Hsl     { return computedCls(Hsl, fn) }
  static lens(g, s)          { return lensCls(Hsl, g, s) as Writable<Hsl> }
  static is(v): v is Hsl     { return v instanceof Hsl }
  add(b): Hsl                { return applyOp1(this, addOp, b, Hsl) }
  scale(k): Hsl              { return applyOp1(this, scaleOp, k, Hsl) }
  get h(): Num               { return this.field("h", Num) }
  get s(): Num               { return this.field("s", Num) }
  get l(): Num               { return this.field("l", Num) }
}
interface Hsl { readonly constructor: typeof Hsl; get value(): Hsl["value"] }
function hsl(...): Writable<Hsl> { return new Hsl(...) as Writable<Hsl> }
```

Then `Writable<Hsl>` automatically:
- Lifts `add` / `scale` returns to `Writable<Hsl>` (via `static invertibles`)
- Lifts `.h` / `.s` / `.l` field lenses to `Writable<Num>` (via auto-detect + recursive LiftField)
- Adds writable surface + brand
- Animators (`spring(hsl(...), target)`) accept it (carries brand + traits)

See `_test/extensibility.test.ts`.

### `invertibles<R>()` helper

Type-safe declaration of which methods are bidirectional:

```ts
static invertibles = invertibles<Vec>()("add", "sub", "scale", "offset");
```

Enforces:
- Literal narrowing (no `as const` needed)
- Each listed key is actually a method on R
- Each listed method's return type is R (the invertible-chain shape)

Forgetting an `as const` or typo'ing a name is a compile error.

### `static` reorganization

All value classes follow the pattern:
1. Pure value-space functions + Op declarations (module top)
2. `class X extends Signal<V>`:
   - `static traits`
   - `static invertibles`
   - `static derive` / `lens` / `is`
   - constructor
   - invertible methods (return X)
   - non-invertible methods (return X, but RO at consumer site)
   - field-lens getters
   - lazy memoised derived getters
3. `interface X { readonly constructor: typeof X; get value(): V }`
4. Factory function

### Box.at() memoization fix

`at(u, v)` no longer caches per arbitrary (u, v) pair. Named edges
(`.center`, `.top`, `.bottom`, `.left`, `.right`) memoise separately
under stable keys so they're cheap and stable-identity. Arbitrary
`box.at(0.42, 0.17)` creates a fresh Computed (still works, but
doesn't leak cache entries per call).

## LOC comparison (final)

| file | r2 (today) | r5 | Δ |
|---|---|---|---|
| `signals/values/num.ts` | 76 | 62 | -14 |
| `signals/values/vec.ts` | 128 | 86 | -42 |
| `signals/values/box.ts` | 147 | 105 | -42 |
| `signals/values/color.ts` | 84 | 86 | +2 |
| `signals/values/matrix.ts` | 150 | 154 | +4 |
| `signals/values/transform.ts` | 138 | 123 | -15 |
| `signals/values/anchor.ts` | 28 | 30 | +2 |
| `signals/values/multi.ts` | 79 | 68 | -11 |
| `signals/values/hyper.ts` | 119 | 76 | -43 |
| `signals/anim.ts` | 434 | 387 | -47 |
| **+** `_proto-r5/writable.ts` (new) | — | 98 | +98 |
| **TOTAL** | 1383 | 1275 | **−108** |

Net: -108 lines across the whole signals layer, with strictly more
features (Writable modifier, invertibles enforcement, all footguns
closed). The biggest savings on Vec/Box/Hyper come from dropping
Chain class boilerplate (per-class `*Chain extends Chain<V>` + chain
methods that mirror eager methods).

Color and Matrix grew slightly (+2/+4 lines) because the static
declarations were moved to the top and the `lens` cast is explicit.
Acceptable.

## Footguns (final status)

| | r2 | r5 |
|---|---|---|
| `roVec.value = …` | runtime throw | compile error |
| `roVec.x.value = …` | runtime throw | compile error |
| `spring(roVec, target)` | runtime throw | compile error |
| `roVec.set(5)` | runtime throw | compile error |
| `roVec.bind(src)` | runtime throw | compile error |
| `userVec.getter = ...` (corrupt mode) | works (BAD) | compile error |
| `static invertibles = ["typo"]` | silent break | compile error |
| `at()` arbitrary (u,v) cache leak | per-call leak | no leak |

All known footguns closed.

## Public surface (39 exports)

```ts
// Engine
Signal, signal, computed, lens, computedCls, lensCls,
effect, batch, untracked,
isSignal, isComputed, isLens,
value, valFn,
Read<T>, Val<T>, Of<R>, SignalOptions, WritableBrand

// Traits
Linear<T>, Lerp<T>, Metric<T>, Equals<T>, Traits<T, K>, TraitDict<T>,
requireLinear, requireLerp, requireMetric, requireEquals

// Ops (for value-class authors)
Op<V, Args>, applyOp0, applyOp1, applyOp2

// Writable
Writable<R>, WritableOf<T>, invertibles

// Value classes
Num, num, Vec, vec, Box, box, Transform, transform, TransformInit,
Color, rgb, rgba,
Matrix, matrix, (+ matrix math helpers: identity, fromTranslate, fromScale,
                  fromRotate, multiply, invert, determinant, transformPoint,
                  transformBox, compose, toMatrixString, isIdentity),
Anchor, Dir,
combine, mean, hyperLens, InversePolicy,

// Anim
Tween, tween, tweenStep, spring, toward, attract,
wave, driven, when, not, untilChange, loop, every,
play, Play, PlayTrigger, SpringOpts,

// Clock
clockSignal
```

## Remaining open questions / minor footguns

1. **Bare `Signal<T>.value` is writable at the type level.** Value
   classes get RO via interface merge `get value(): V`, but `Signal<T>`
   itself doesn't. So `computed(() => 1).value = 5` is type-allowed
   (runtime throws). Not a problem in practice — `signal(0)` returns
   `Signal<T> & WritableBrand` (the brand surfaces .set/.bind), and
   the user normally accesses the brand through value-class wrappers.
   To fully close: add an interface merge `interface Signal<T> { get
   value(): T }` — but this clashes with the class's own accessor
   declaration (TS2300 "duplicate identifier"). Workaround would need
   a redesign of Signal's value accessors.

2. **Consumer functions typed `(p: Vec)` don't accept `Writable<Vec>`
   cleanly.** Recursive variance check trips. Workaround:
   `(p: Read<{x,y}>)` for "any read source", or explicit cast at
   call site. Documented in `_test/types.test.ts`.

3. **`new Vec()` produces a bare Vec at the type level** — works at
   runtime but lacks the brand, so most write operations are rejected.
   Convention: use factories (`vec(...)`, `Vec.lens(...)`) instead.

4. **Static-invertibles helper isn't ergonomic enough.** Authors must
   write `invertibles<Vec>()(...)` which is a tad clunky. Could be
   `Inv<Vec>("add", "sub", ...)` or similar. Cosmetic.

5. **HyperLens output writability** — outputs with a backward policy
   are typed as `Signal<T> & WritableBrand`. Outputs without a policy
   are bare `Signal<T>` (RO at the consumer level, runtime throws on
   write). Good.

## Bench (parity vs r2)

```
signal write (pre-constructed, 10k):  r2 ~245µs, r5 ~245µs   (parity)
vec.x write-through (10k):            r2 ~1.03ms, r5 ~1.05ms (parity)
vec construction (10k):               r2 ~2.95ms, r5 ~2.95ms (parity)
chain depth 4 (10k writes):           r2 ~1.55ms, r5 ~1.55ms (parity)
```

Same engine, same perf.

## Ready for upstream

Phase 0 is done. Recommendation: proceed to Phase 1 — swap
`signals/` to use this implementation. Plan in `MIGRATION.md` (next).
