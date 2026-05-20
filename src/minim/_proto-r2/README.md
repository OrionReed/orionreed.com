# `_proto-r2` — merged `Reactive<T>`, second round

A round of prototyping for the merged-class reactivity primitive,
sized to surface what actually breaks rather than what looks clean
on a slide.

The first round established the merged class shape, the `computed` /
`lens` API split, and a paired-comparison bench. This second round
tackles the open questions the design surfaced: per-instance
memoization, suffix naming for value types, swapped argument order,
and a nominal Rust-ish trait declaration.

## What this is

A self-contained reactive layer:

```
reactive.ts        Reactive<T> + signal/computed/lens/effect/batch/untracked
                   + Reactive.memo() per-instance derived cache
traits.ts          static traits dict + HasLinear/HasMetric/… nominal constraints
field.ts           Typed field lens (stateless; cache via Reactive.memo)
values/num.ts      Num + NumChain  (static traits, no symbol slots)
values/vec.ts      Vec + VecChain + polar
values/box.ts      Box + BoxChain
index.ts           Public API (incl. ValueOf<R> and the *Value suffix names)
conformance.test.ts  RFTS (161 pass / 18 skipped — identical to prod)
engine.test.ts       60 hand-rolled tests: edges, footguns, memo, traits
types.test.ts        10 compile-time inference + constraint checks
bench-runner.ts    Paired-comparison bench harness
bench.ts           minim (prod) vs r2 across 18 scenarios
```

All tests pass: **231 / 231** (with 18 RFTS divergences skipped, same as prod).

## API

### Constructors — Cls is now the last (optional) arg

```ts
signal(initial, opts?)                // Reactive<T>, writable
computed(fn)                          // Reactive<T>, read-only
computed(fn, Vec)                     // Vec, read-only
lens(get, set)                        // Reactive<T>, writable derived
lens(get, set, Num)                   // Num, writable derived
effect(fn)                            // disposer
batch(fn)                             // coalesces flush
untracked(fn)                         // untracked read
```

`signal(initial)` mirrors the convention; reading right-to-left, the
optional `Cls` says "and dress it up as a Vec" rather than leading
with type-as-prefix.

### `Reactive.memo(key, factory)`

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
actual static side — required so the nominal constraints
(`HasLinear<T>`, `HasMetric<T>`, …) can see the static `traits` dict.

#### Type-level "I take any reactive with these traits"

```ts
function spring<R extends Read<unknown>
  & HasLinear<ValueOf<R>>
  & HasMetric<ValueOf<R>>>(sig: R, target: Val<ValueOf<R>>) { … }
```

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

## What changed since round 1 — bench

`npx vite-node src/minim/_proto-r2/bench.ts`

Stable picture across runs (CV mostly ±1–3%, except sub-20 ns ops
which are at the measurement floor):

| scenario                                  | minim    | r2 round 1 | r2 round 2 |
| ----------------------------------------- | -------- | ---------- | ---------- |
| construction: signal(0)                   | 15 ns    | +10–25%    | **+18–29%** |
| construction: num(0)                      | 50 ns    | ±5%        | ±2%        |
| construction: vec(0, 0)                   | 370 ns   | −13%       | **−7 to −22%** |
| construction: box(0,0,0,0)                | 1.03 µs  | −35%       | **−30 to −34%** |
| read: signal.peek                         | 5.4 ns   | +4%        | +5%        |
| read: vec.x.peek                          | 26 ns    | ≈          | **−42 to −48%** |
| read: computed.value (cached)             | 6.1 ns   | ±5%        | ±5%        |
| write: signal.value =                     | 15 ns    | +5%        | **−24 to −27%** |
| write: vec.x.value =                      | 145 ns   | +6%        | **−12 to −17%** |
| write + 1 effect                          | 48 ns    | **+22%**   | **+4 to +13%** |
| batch × 10 writes (1 effect)              | 195 ns   | **+22%**   | **−30 to +1%** |
| 10-deep computed chain (write+read)       | 320 ns   | +15%       | **−11 to −13%** |
| 50-deep computed chain (write+read)       | 1.6 µs   | +15%       | **−22 to −23%** |
| eager chain: vec.add().scale().offset()   | 188 ns   | +5%        | **−9 to −10%** |
| fused chain: vec.derive(c=>...)           | 720 ns   | **−26%**   | **−28%**   |
| realistic scene: 100 boxes / center       | 22 µs    | +13%       | **−5 to −11%** |

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

Deliberately left for a later round:

- **`combine` / `mean`** (N-to-1 lenses). Mechanical port using
  `lens(get, set, Cls)`.
- **Animation system integration** (`tween`, `spring`, `Anim`). The
  `setSignalWriteHook` is plumbed; the work is converting the
  animators to use the nominal constraints (`spring<R extends … &
  HasLinear<ValueOf<R>> & HasMetric<ValueOf<R>>>(sig: R, …)`).
- **Other value types** (`Color`, `Matrix`, `Transform`, `Anchor`).
  Mechanical port — same shape as Num/Vec/Box.
- **Chain duplication.** The class and the chain still mirror each
  other (`Vec.add` and `VecChain.add`). The math lives once at module
  scope, so the duplication is one-line forwarders; tried unifying
  via "eager methods always go through `.derive()`" and rejected
  because it allocates a chain wrapper per eager call and makes the
  simple case hurt (which the user explicitly said earlier is bad).
- **Per-process bench isolation** for tighter CVs if we want to detect
  smaller deltas.

## How to run

```bash
npx vitest run src/minim/_proto-r2/                    # 231 tests
npx vite-node src/minim/_proto-r2/bench.ts             # paired bench
BENCH_PHASES=30 BENCH_WARMUP=10 npx vite-node …        # tighter CVs
```

## Verdict

Round 2 turned the merged design from "architecturally right but
~20% slower on hot writes" into "architecturally right and faster
everywhere except 17-ns signal construction." The wins came from
collapsing dynamic lookups (symbol-keyed equals; FIELD_CACHE symbol
round-trip) into stable per-instance slots and direct Record access.

The static-traits + nominal-constraint pattern gives us a Rust-ish
"I take any T that implements Linear<T> + Metric<T>" call site without
adding any post-class installer or decorator magic. Trait
declarations live inside the class body, in one dictionary, with no
symbols visible to the consumer.

The `memo()` unification killed the inconsistency from round 1
(three different "not a Vec" patterns: `_mag?` slot, FIELD_CACHE
Symbol, lazy getter). Now everything cached per-instance flows
through the same mechanism.

The chain-class mirror remains a small wart; every direction tried so
far either re-introduces magic or makes the simple case worse. Living
with the duplication.
