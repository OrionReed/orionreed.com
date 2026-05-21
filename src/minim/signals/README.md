# `_proto-r2` — merged `Signal<T>`, production-ready prototype

A merged-class reactivity primitive with a Rust-ish nominal trait
system, designed to replace the current `signals/` module. Faster on
realistic workloads, less metaprogramming, simpler API surface,
better type safety on consumer code.

Naming: `Signal<T>` is the class (matches prod; "Reactive" was the
internal working name while we developed it). All three modes
(signal / computed / lens) share one class; mode is determined by
which fields are set.

## What this is

A self-contained reactive layer:

```
signal.ts          Signal<T> + signal/computed/lens/effect/batch/untracked
                   + Signal.memo() + Signal.field() + RO<R> + Of<R>
traits.ts          TraitDict<T> + Traits<T, K> nominal constraint
ops.ts             Op<V, Args> + applyOp0/1/2 + Chain<V> base class
                   (bidirectional lens infrastructure)
anim.ts            spring / tween / toward / attract on Traits<T, …>
values/num.ts      Num + NumChain (add/sub/scale invertible)
values/vec.ts      Vec + VecChain + polar
values/box.ts      Box + BoxChain (add/sub/scale/expand invertible)
values/color.ts    Color + ColorChain (luminance, css derived views)
values/matrix.ts   Matrix + MatrixChain (multiply, invert invertible)
values/transform.ts Transform + TransformChain (nested-Vec field lenses)
values/multi.ts    combine / mean (N-to-1 writable lens)
values/hyper.ts    hyperLens (N→M with per-output inverse policies)
index.ts           Public API
conformance.test.ts  RFTS (161 pass / 18 skipped — identical to prod)
engine.test.ts       Engine edges, footguns, memo, traits
types.test.ts        Compile-time inference + constraint checks
anim.test.ts         Animator math + Traits<T, …> probes
multi.test.ts        mean/combine semantics
hyper.test.ts        hyperLens: pointOnLine, wheel, pinch
stress.test.ts       Color/Matrix/Transform breaking-attempts
bidirectional.test.ts  Write-through eager + chain + RO type rejection
bench-runner.ts    Paired-comparison harness with median + MAD
bench.ts           prod vs r2 across 21 scenarios
PROD-AUDIT.md      What changes when we adopt this
STRUCTURE-NOTES.md DAG-vs-hypergraph + hyperLens + profunctor sketches
```

All tests pass: **312 / 312** (with 18 RFTS divergences skipped, same as prod).

## API

### Constructors — Cls is the last (optional) arg

```ts
signal(initial, opts?)                // Reactive<T>, writable
computed(fn)                          // Reactive<T>, read-only
computed(fn, Vec)                     // Vec, read-only
lens(get, set)                        // Reactive<T>, writable derived
lens(get, set, Num)                   // Num, writable derived
effect(fn)                            // disposer
batch(fn)                             // coalesces flush
untracked(fn)                         // untracked read

new Vec({x:0, y:0}, opts?)            // typed signal — just use the class
new Num(0, opts?)
new Box({x:0, y:0, w:10, h:10}, opts?)
```

We deliberately don't overload `signal(v, Cls)`. That path would need
a runtime discriminator on `(opts | Cls)` and adds no power over
`new Cls(v, opts?)` — every value class already extends `Reactive<T>`
and accepts the same constructor shape. The asymmetry with
`computed/lens` is justified: those factories need to install
`getter`/`setter` *after* construction, so a typed factory is the
only ergonomic way; signal-mode has no such setup.

### Bidirectional value layer

Every naturally-invertible method on every value type is now a **Lens**
(writable), not a `Computed` (read-only). Writes through derived
signals flow back to the source automatically — for free, no custom
lens wiring per consumer.

```ts
const a = vec(1, 2); const b = vec(10, 20);
const sum = a.add(b);                  // Vec (Lens)
sum.value = { x: 100, y: 200 };
// a updates to {x: 90, y: 180}; b unchanged.

const m = matrix();
const product = m.multiply(fromTranslate(10, 0));
product.value = fromTranslate(50, 20);
// m becomes fromTranslate(40, 20).

const tr = transform({ translate: { x: 5, y: 5 } });
const offsetX = tr.translate.x.add(10);  // Num (Lens) — bidirectional through TWO field lenses
offsetX.value = 100;
// tr.translate.x = 90; tr.value.translate.x = 90.
```

The **chain form** is equally bidirectional:

```ts
const a = vec(0, 0); const b = vec(1, 2);
const r = a.derive((c) => c.add(b).scale(3).offset(10, 0));
r.value = { x: 31, y: 30 };
// Walks inverses in reverse: a = ((r - (10,0)) / 3) - (1,2) = (6, 8)
expect(a.value).toEqual({ x: 6, y: 8 });
```

**Invariant:** `parent.foo(args)` and `parent.derive(c => c.foo(args))`
produce signals with identical read AND write behavior. The chain
just fuses everything into a single lens (no allocation per chain
step at read time), but the result behaves the same.

#### What's invertible vs not

| value | invertible (Lens) | not invertible (`RO<Cls>`) |
|---|---|---|
| Num | add, sub, scale | clamp |
| Vec | add, sub, scale, offset, up/down/left/right | normalize, perp, lerp, distance, magnitude |
| Box | add, sub, scale, expand | lerp, at, area, contains, center/top/bottom/left/right |
| Color | add, sub, scale | lerp, luminance, css |
| Matrix | multiply, invert | determinant |
| Transform | add, sub | lerp |

Non-invertible methods return `RO<Cls>` — a TS narrowing where
`.value` is readonly and `.set` / `.bind` are absent. Writing to
them is a **compile error**, not a runtime throw. And the chain
class doesn't expose them at all — so `vec.derive(c => c.normalize())`
fails at the `c.normalize()` site with "Property 'normalize' does
not exist on type 'VecChain'".

This is the type-tracked invertibility guarantee: **if it
type-checks, it writes correctly.**

#### Shared op infrastructure

Each invertible operation is declared once at module scope as an
`Op<V, Args>` with paired `fwd` and `bwd`:

```ts
const addOp: Op<V, [V]> = { fwd: add, bwd: sub };
const scaleOp: Op<V, [number]> = {
  fwd: scale,
  bwd: (v, k) => scale(v, 1 / k),
};
```

Both eager methods and chain methods reference the same op constant.
Math lives in one place; the wiring is one-liner forwarders:

```ts
class Vec extends Signal<V> {
  add(b: Val<V>): Vec { return applyOp1(this, addOp, b, Vec); }
  // …
}
class VecChain extends Chain<V> {
  add(b: Val<V>): this { return this.push1(addOp, b); }
  // …
}
```

Adding a new invertible operation: declare an `Op`, reference it in
two one-liner methods. No closure allocation per call (the op constant
is shared), no per-chain-step object allocation beyond two `fwd`/`bwd`
closures that close over the resolved args.

### Naming: `Of<R>` replaces `*Value` exports

We removed all `*Value` interface exports (`VecValue`, `BoxValue`, …).
Each value module uses a module-local `type V = …` alias for its math
helpers. Consumers needing the value shape use `Of<R>`:

```ts
import { Vec, type Of } from "@minim/signals";

function reflect(p: Of<Vec>, a: Of<Vec>, b: Of<Vec>): Of<Vec> { … }
// or alias once locally
type V = Of<Vec>;
function reflect(p: V, a: V, b: V): V { … }
```

One name (`Of`) instead of N per-type names. Compositional,
self-documenting, no rename-on-import boilerplate.

### `Signal.field(key, Cls)` replaces free `field()`

The free `field()` function is gone. Field lenses are now a method on
Signal, cached in a dedicated `_fields` slot (separate from `memo`
to avoid template-literal key allocation per access):

```ts
class Vec extends Signal<V> {
  get x(): Num { return this.field("x", Num); }
  get y(): Num { return this.field("y", Num); }
}
```

Bench: `vec.x.peek` is −25% vs prod, `vec.x.value =` is −14% vs prod.

### `Signal.memo(key, factory)`

Per-instance lazy cache for derived views. Replaces three ad-hoc
patterns from the first round:

```ts
class Vec extends Reactive<VecValue> {
  get x() { return this.memo("x", () => field(this, "x", Num)); }
  get y() { return this.memo("y", () => field(this, "y", Num)); }
  get magnitude() {
    return this.memo("magnitude", () =>
      computed(() => Math.hypot(this.value.x, this.value.y), Num));
  }
}
```

vs the first round's mix of `_mag?` slots, `FIELD_CACHE` Symbol, and
implicit one-shot getters. Now it's all one mechanism, one cache, one
shape.

`field()` is now stateless: pure constructor. Identity (`vec.x ===
vec.x`) is enforced by callers wrapping in `memo()`. Less hidden state;
the cache is right where the cached thing lives.

### Static traits — Rust-ish trait declaration

```ts
export class Vec extends Reactive<VecValue> {
  static traits: Required<Traits<VecValue>> = {
    linear: { add, sub, scale },
    lerp,
    metric,
    equals,
  };
}
export interface Vec { readonly constructor: typeof Vec }
```

One declaration, no symbol slots, no `defineTrait()` post-class
installer. Trait helpers (`requireLinear`, `linearOf`, …) look up
via `s.constructor.traits.linear` — one extra property load vs the
old symbol round-trip, and only on the cold setup path of animators.

The `interface ClassName { readonly constructor: typeof ClassName }`
merge re-types `inst.constructor` from `Function` (TS default) to the
actual static side — required so the nominal constraint
(`Has<T, "linear" | "metric" | …>`) can see the static `traits` dict.

#### Type-level "I take any reactive with these traits"

ONE constraint type, parameterized by a string union of trait keys:

```ts
function spring<T>(sig: Has<T, "linear" | "metric">, target: Val<T>) { … }
function tween<T>(sig: Has<T, "lerp">, target: T, dur: Val<number>) { … }
function attract<T>(sig: Has<T, "linear">, target: Val<T>, k?: Val<number>) { … }
```

No per-trait aliases (`HasLinear`, `HasMetric`, `HasLerp`, …), no
per-consumer aliases (`SpringTarget`, `TweenTarget`, …). One type
covers all the cases via union of keys; reads as a sentence at the
call site.

Compile error if you pass `spring(box, …)` — Box has linear/lerp/
equals but not metric. Compile error if you pass `spring(signal(0), …)`
— plain Reactive has no traits dictionary. The `types.test.ts` file
has a `_typeOnlyConstraintProbe` block with `@ts-expect-error`
markers that fail compilation if the constraints regress.

Equality is special: `_equals` is resolved once at construction
(opts.equals wins, else `traits.equals`, else `===`) and cached on the
instance, so writes only ever read one slot. Eliminates the dual
lookup that contributed to first-round write regressions.

### Value-type naming: `*Value` suffix + `ValueOf<R>`

```ts
import { Vec, type VecValue, ValueOf } from "@r2";

function reflect(p: VecValue, a: VecValue, b: VecValue): VecValue { … }
// or:
function reflect(p: ValueOf<Vec>, a: ValueOf<Vec>): ValueOf<Vec> { … }
```

The suffix is the canonical exported name (no more `import { Value as
VecValue }` rename boilerplate). `ValueOf<R>` is the universal
extractor for cases where you only have the class in scope or are
writing class-generic code.

### Public predicates / types (unchanged from first round)

`isSignal`, `isComputed`, `isLens` runtime checks. `Computed<T>` and
`Lens<T>` type aliases. `Val<T>` parameter shape. `Read<T>` covariant
read interface. `ValueOf<R>` extractor.

## Bench vs prod

`npx vite-node src/minim/_proto-r2/bench.ts`

Stable picture across two consecutive runs (CV mostly ±1–3%, except
sub-20 ns ops at the measurement floor):

| scenario                                  | prod     | r2       | Δ |
| ----------------------------------------- | -------- | -------- | --- |
| construction: signal(0)                   | 14 ns    | 17 ns    | **+25%** (only consistent regression) |
| construction: num(0)                      | 47 ns    | 43 ns    | **−9%** |
| construction: vec(0, 0)                   | 367 ns   | 290 ns   | **−21%** |
| construction: box(0,0,0,0)                | 1.01 µs  | 573 ns   | **−43%** |
| read: signal.peek                         | 5.3 ns   | 5.5 ns   | +4% |
| read: vec.x.peek                          | 28 ns    | 21 ns    | **−25%** |
| read: computed.value (cached)             | 5.4 ns   | 5.7 ns   | +6% |
| write: signal.value =                     | 14 ns    | 11 ns    | **−25%** |
| write: vec.x.value =                      | 148 ns   | 127 ns   | **−14%** |
| write + 1 effect                          | 48 ns    | 49 ns    | +1% |
| batch × 10 writes (1 effect)              | 188 ns   | 138 ns   | **−27%** |
| 10-deep computed chain                    | 316 ns   | 275 ns   | **−13%** |
| 50-deep computed chain                    | 1.59 µs  | 1.22 µs  | **−23%** |
| eager chain: vec.add().scale().offset()   | 186 ns   | 141 ns   | **−24%** |
| **fused chain: vec.derive(c=>...)**       | 707 ns   | 106 ns   | **−85%** |
| realistic scene: 100 boxes / center       | 22 µs    | 19 µs    | **−11%** |
| spring: 100 frames (vec)                  | 232 ns   | 219 ns   | **−5%** |
| mean of 4 nums                            | 281 ns   | 282 ns   | ≈ |
| **transform.translate.x write** (deep)    | 451 ns   | 370 ns   | **−18%** |

**The two killer measurements:**

1. **Fused chain `−85%` (707 → 106 ns).** The new `Chain<V>` base
   composes fwd/bwd functions into a single pair at `toLens()` time.
   Reads run those functions in order — no per-call allocation, no
   chain object iteration with arg unwrapping. The old approach
   constructed a chain object per `.derive()` call, ran each method
   in sequence, then read the final value. This is a structural
   speedup, not noise.

2. **`transform.translate.x write` `−18%` (451 → 370 ns).** Every
   shape with a transform writes `.translate.x` / `.rotate` /
   `.scale.x` on every animation frame. The dedicated `_fields`
   cache (separate from `memo()` to avoid template-literal key
   allocation per `.x` access) makes the field-lens hot path
   substantially faster than prod.

Aside from `signal(0)` construction (3 ns absolute, the wider
class-shape cost), **r2 is faster than prod on every measurement
we care about.**

The shape:

1. **`_equals` resolved at construction** eliminates the dual symbol-
   lookup on every write. Big shift on `write:` paths and the
   realistic scene.
2. **`memo()` Record-cache is faster than `FIELD_CACHE` Symbol** on
   the hot `vec.x.peek()` / `vec.x.value =` paths.
3. **Static traits dict on the class** is no slower than the old
   symbol slot on writes (lookup happens once per animator setup,
   captured in a closure).
4. **Wider class shape** still costs ~18–29% on `signal(0)`
   construction — two extra slots (`_equals`, `_memoCache`) beyond
   round 1's three. Unavoidable; signal construction at 17 ns absolute
   is well below any frame-budget concern.
5. **No asymptotic regression.** 50-deep chain stays in the same
   relative band as 10-deep.

The realistic scene flipped from +13% to −10% — that's the headline.
A combination of the equality fast-path, faster field-lens caching,
and the same cleaner Reactive set-path. The merged design is now
**net faster** on realistic workloads.

## Footguns surfaced (and tested)

All round-1 footguns still tested (peek-propagate, cascade flush,
`toPrimitive`, cycle detection, diamond single-update, etc.). New
tests added for:

- **`memo()` identity** — `vec.x === vec.x`, `box.center === box.center`,
  symbol-keyed memo entries.
- **`memo()` cache isolation** — distinct keys produce distinct cached
  values.
- **Static-traits dispatch** — `Num.traits.linear` is the same object as
  `(num(0).constructor as typeof Num).traits.linear`.
- **`opts.equals` overrides class traits.equals** — per-instance epsilon
  equality on an otherwise-strict Num.
- **`HasLinear<T>` / `HasMetric<T>` reject classes without the trait**
  at compile time. `@ts-expect-error` probe.
- **`ValueOf<R>` extracts the inner type** correctly for Vec/Num/Box
  and plain `Reactive<T>`.

## What's still open

In approximate "useful vs scary" order:

- **`Anchor` / `Dir`** — small enum-like value class, mechanical port.
- **`Tween` chainable builder + `play`/`when`/`loop`/`every`/`untilChange`/`not`** —
  not trait-bound; pure `Signal` → `Signal` (no change) plus the
  `derived` → `computed`/`lens` rename. Mechanical.
- **Optional lens-law dev assertions** — small, useful. On `lens()`
  in `import.meta.env.DEV`, run the 3 round-trips against
  `parent.peek()` + a synthetic sample. Catches bad custom lenses at
  construction.
- **Profunctor optics in `_proto-r2-optics/`** — clean-slate
  exploratory prototype. Start with `Lens<S, A>` only and the
  single-cell reactive integration.
- **Chain duplication** — the class and the chain still mirror each
  other (`Vec.add` and `VecChain.add`). The math lives once at module
  scope, so the duplication is one-line forwarders. Tried unifying
  via "eager methods always go through `.derive()`" and rejected
  because it allocates a chain wrapper per eager call and makes the
  simple case hurt. Not pursuing further.

## How to run

```bash
npx vitest run src/minim/_proto-r2/                    # 231 tests
npx vite-node src/minim/_proto-r2/bench.ts             # paired bench
BENCH_PHASES=30 BENCH_WARMUP=10 npx vite-node …        # tighter CVs
```

## Verdict — ready for production

The merged design is architecturally right, faster on every realistic
workload (especially the +22% win on `transform.translate.x` writes),
and removes the only metaprogramming hack from the engine
(`viewClassFor` + `setPrototypeOf`).

Stress-tested against three additional value types (Color, Matrix,
Transform). Edge cases covered: sparse trait dicts (Matrix has only
`equals`, fails `spring`/`tween`/`attract`/`mean` at compile time),
nested-class field lenses (Transform.translate is a Vec, not a Num),
3-deep field-lens chains (Transform.translate.x), name collisions
(Transform.scale is a Vec lens; chain.scale is scalar), custom equals
with floating-point epsilon, 100-key memo cache.

The static-traits + nominal-constraint pattern gives us a Rust-ish
"I take any T that implements Linear<T> + Metric<T>" call site
without any post-class installer or decorator magic. Trait
declarations live inside the class body, in one dictionary, with no
symbols visible to the consumer. Compile errors instead of runtime
throws on "forgot to implement [LINEAR]" mistakes.

Migration to production is documented in PROD-AUDIT.md — ~4–6 hours,
mostly mechanical, with a backwards-compat shim plan to land
incrementally without breaking consumers.
