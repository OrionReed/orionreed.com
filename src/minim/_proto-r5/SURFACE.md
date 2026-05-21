# Public surface audit

Holistic pass on r5. Each export evaluated for: (a) is it necessary,
(b) does it overlap with anything else, (c) could it collapse.

## Inventory

### Core (12)

| | what | role |
|---|---|---|
| `Signal<T>` (class) | the reactive primitive | engine |
| `signal(v)` | factory for writable source | engine |
| `computed(fn)` | factory for RO derived | engine |
| `lens(g, s)` | factory for writable derived | engine |
| `effect(fn)` | side-effect runner | engine |
| `batch(fn)` | coalesce writes | engine |
| `untracked(fn)` | run without tracking | engine |
| `isSignal/isComputed/isLens` | runtime predicates | narrowing |
| `value(v)` | resolve `Val<T>` | helper |
| `Read<T>` | RO surface interface | param typing |
| `Val<T>` | factory arg shape | param typing |
| `Of<R>` | extract `T` from `R` | utility |
| `SignalOptions` | constructor opts | constructor |

### Traits (9)

| | what | role |
|---|---|---|
| `Linear<T>` `Lerp<T>` `Metric<T>` `Equals<T>` (4 interfaces) | trait shapes | class authors |
| `Traits<T, K>` | trait constraint | animator sigs |
| `requireLinear/Lerp/Metric/Equals` (4 helpers) | runtime trait getters | animators |

### Ops (3)

| | what | role |
|---|---|---|
| `Op<V, Args>` | bidirectional op shape | value-class authors |
| `applyOp1` `applyOp2` | apply Op as Lens | value-class authors |

### Writable (2)

| | what | role |
|---|---|---|
| `Writable<R>` | lift a value class to writable form | factory returns, param types |
| `WritableOf<T>` | T-anchored writable shape | animator constraint |

### Value classes (9)

| | what | role |
|---|---|---|
| `Num` `num` | scalar | value type |
| `Vec` `vec` | 2D point | value type |
| `Box` `box` | rectangle | value type |
| `Transform` `transform` `TransformInit` | 2D transform | value type |

**Total: 35 exports.**

## Concerns + overlaps

### Read<T> vs Signal<T>

Both expose `.value`/`.peek`. Read<T> is the covariant minimum; Signal<T> is the full class.

- Used in `Val<T> = T | (() => T) | Read<T>` — third arm.
- Used as parameter type when you want "any read-source of T".

**Verdict: keep.** Removing means inlining `{ readonly value: T; peek(): T }` everywhere, less ergonomic. Read<T> is the cleanest expression of "minimum readable shape".

### Writable<R> vs WritableOf<T>

Both express writability. Different anchoring:
- `Writable<R>` takes a value class type, lifts methods/fields. Use as factory return and param type.
- `WritableOf<T>` is T-anchored structural. Use as generic animator constraint.

Equivalent: `WritableOf<T> ≈ Writable<Read<T>>` (Writable with no invertibles/fields lifts).

**Verdict: keep both.** `Writable<Vec>` reads as "writable Vec", `WritableOf<T>` reads as "any writable of T". The animator sig `WritableOf<T> & Traits<T, "linear">` is much more natural than `Writable<Read<T>> & Traits<T, "linear">`.

### 4 `requireXxx` helpers vs single `require<K>`

Could collapse to `require(s, "linear")` taking a key. Trade-off: -3 exports for slightly less ergonomic typing.

**Verdict: keep separate.** Each `requireXxx` has the trait type inferred at the call site; a generic `require` would need an explicit type argument or a generic constraint that's harder to read.

### Op + applyOp* exposed

Necessary for users authoring new value classes. Internal-only otherwise.

**Verdict: keep.** External value-class authoring is a documented capability.

### `SignalOptions` rarely used

Used by `signal(v, opts)` for custom `equals` / `watched` / `unwatched` callbacks. Niche but useful.

**Verdict: keep.**

### Per-value-class `TransformInit` etc

Currently only Transform exports an init type because it has multiple optional fields. Could be generic helper `Init<V>`.

**Verdict: keep as-is.** Per-class init types let authors customize. We could add a generic `Init<V>` if multiple value classes adopt the pattern.

## Things collapsed in r5 vs r2 / r4

- ~~`RO<R>`~~ — replaced by bare class type (RO is the default).
- ~~`Computed<T>` type alias~~ — was Omit-narrowing of Signal, confusing. Use `Signal<T>` (RO at type level via interface merge) or runtime check `isComputed(x)`.
- ~~`Lens<T>` type alias~~ — was identity of Signal<T>. Use `Signal<T> & WritableBrand` or `Writable<Signal<T>>`.
- ~~`Writers<T>`~~ — internal to `Writable<R>`.
- ~~`Promote<R, Inv>`~~ — replaced by `Writable<R>` (no Inv arg, auto-detect via `static invertibles`).
- ~~`WritableNum`~~ ~~`WritableVec`~~ ~~`WritableBox`~~ — replaced by `Writable<Num>` / `Writable<Vec>` / `Writable<Box>`.
- ~~`isNode`~~ — predicate for the abstract base; not commonly needed.
- ~~`TraitDict`~~ ~~`TraitKey`~~ — internal types backing `Traits<T, K>`.
- ~~`Chain<V>`~~ ~~`derive`~~ — removed entirely (future perf upgrade).

Net: r2 had ~42 exports; r5 has 35. The cuts are real abstractions removed, not just hiding.

## Naming consistency

- Lowercase = factory: `signal`, `vec`, `num`, `box`, `transform`
- Capital = class: `Signal`, `Vec`, `Num`, `Box`, `Transform`
- Capital generic = type: `Read<T>`, `Val<T>`, `Of<R>`, `Writable<R>`, `WritableOf<T>`
- `Traits<T, K>` — capital, parameterised constraint
- `require<Trait>` helpers — verb prefix

Reads well. No surprises.

## Compose-test

```ts
// "Read-only reader of any T value" (covariant)
function readVec(v: Vec): { x: number; y: number } { return v.value }
readVec(vec());                  // ✓ Writable<Vec> ⊆ Vec
readVec(vec().normalize());      // ✓ bare Vec
readVec(Vec.derive(() => ({...}))); // ✓

// "Writable Vec, please"
function setVec(v: Writable<Vec>, t: { x: number; y: number }) { v.value = t }
setVec(vec(), {x:0,y:0});        // ✓
// setVec(vec().normalize(), ...); // ✗ — bare Vec lacks brand

// "Animator-style: writable carrying T with linear+metric"
function spring<T>(s: WritableOf<T> & Traits<T, "linear" | "metric">, target: T): void {
  s.value = target;
}
spring(vec(), { x: 0, y: 0 });   // ✓
spring(num(5), 10);              // ✓
// spring(vec().normalize(), {x:0,y:0}); // ✗

// "Generic Read source of T" (covariant)
function describe<T>(s: Read<T>): T { return s.value }
describe(num(5));                // ✓
describe(vec());                 // ✓ Vec satisfies Read<{x,y}>

// "Factory arg pattern"
function bindTo<T>(target: Writable<Signal<T>>, source: Val<T>): () => void {
  return target.bind(source);
}
```

All compositions feel natural. No "wait what's the difference" moments.

## Footguns: status

| footgun | r4 | r5 |
|---|---|---|
| `roVec.value = …` | caught | caught (interface merge) |
| `roVec.x.value = …` (field on RO) | caught | caught (LiftField doesn't apply to bare Vec) |
| `spring(roVec, target)` | structural pass (BAD) | **caught** (WritableBrand required) |
| `roVec.set(5)` | not caught (method inherited) | **caught** (set's `this: WritableBrand`) |
| `roVec.bind(src)` | not caught | **caught** (same) |

All known footguns closed. The brand is the linchpin.

## Per-value-class LOC

|              | r2 (today) | r5  |
|--------------|------------|-----|
| `num.ts`     | 76         | 61  |
| `vec.ts`     | 128        | 84  |
| `box.ts`     | 147        | 95  |
| `transform.ts` | 138      | 125 |

Per-class shrinkage 14-44 lines. Total saved: ~124 lines across 4 value classes. Plus `writable.ts` (76 lines, paid once).
