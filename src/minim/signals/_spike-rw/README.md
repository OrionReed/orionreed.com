# Spike: simpler `Writable<R>`

Self-contained prototype of the alternative type story for value classes.
**Same external API** (`Vec.derive`, `Vec.lens`, `Writable<Vec>`, factory
returns), with a **simpler internal type machine** AND a more concise
authoring story for value-class definitions.

The spike runs on the existing `Signal` engine — only the public type
story changes. Runtime is reused verbatim (alien-signals, lens fusion,
equality dispatch).

## What changes

| | Today | Spike |
|---|---|---|
| `Writable<R>` resolution | recursive transform | single-hop registry: `R extends { _writable: infer W } ? W : never` |
| Invertible methods | `(...) => Vec`, listed in `static invertibles = invertibles<Vec>()(…)` | `(...) => this`, no list |
| Field-lens declaration | `get x(): Num { return lazy(this, "x", () => this.lensTo(Num, s=>s.x, (v,s)=>({...s, x: v}))) }` | `get x() { return field(this, "x", Num); }` |
| Derived RO views | `get magnitude(): Num { return lazy(this, "magnitude", () => this.deriveTo(Num, fn)) }` (annotation required to avoid LiftField type-lie) | `get magnitude() { return derived(this, "magnitude", Num, fn); }` (correct by construction) |
| Writable counterpart | recursive `LiftField` derives it (with type-lie on derived RO fields) | `Wr<R>` shape: `R & WritableBrand & { value: Of<R> }` (no separate `Foo_W` interface needed) |
| `Tween.to` brand bypass | `tween(this as never, …)` | `to(this: Writable<R>, …)` — no cast |
| Factory cast | `as unknown as Writable<X>` | `as Writable<X>` (one cast) |

## The four primitives in `writable.ts`

```ts
// Single-hop registry lookup
type Writable<R> = R extends { readonly _writable: infer W } ? W : never;

// Default writable shape — applied via `_writable: Wr<Foo>` per class
type Wr<R> = R & WritableBrand & { value: Of<R> };

// Animator constraint
interface WritableOf<T> extends WritableBrand { value: T; peek(): T }

// Authoring helpers
function field<S, K, C>(parent, key, Cls): Inherits<S, InstanceType<C>>
function derived<S, C>(parent, key, Cls, fn): InstanceType<C>
```

`Inherits<R, T>` is the internal conditional `R extends WritableBrand ? Writable<T> : T`. Authors don't import it directly — the `field()` helper encapsulates the conditional.

## Authoring template (full Hsl example)

```ts
class Hsl extends Signal<V> {
  static traits = traits<V>()({ linear: linearImpl, lerp, metric, equals });
  declare readonly _writable: Wr<Hsl>;

  constructor(v = { h: 0, s: 0, l: 0 }) { super(v); }

  add(b: Val<V>): this { /* invertible — `this` propagates writability */ }
  scale(k: Val<number>): this { /* same */ }

  // Field lenses — one line each, conditional return type
  get h() { return field(this, "h", Num); }
  get s() { return field(this, "s", Num); }
  get l() { return field(this, "l", Num); }

  // Tween — writable-only via `this:` constraint
  to(this: Writable<Hsl>, target: V, dur: Val<number>): Tween<V> {
    return tween(this, target, dur);
  }
}
interface Hsl {
  readonly constructor: typeof Hsl;
  get value(): V;     // RO via interface merge
}
function hsl(...): Writable<Hsl> {
  return new Hsl(...) as Writable<Hsl>;   // single cast, no `unknown` hop
}
```

That's the entire mechanical pattern. The Hsl spike file is **62 lines total** for a complete value class with full trait support, invertibles, three field lenses, and factory — vs ~95 lines for the equivalent today.

## What's eliminated vs today

- `LiftField<X>`, `InvOf<R>`, `LensFields<R>`, `Writers<T>` utility types
- `static invertibles = invertibles<Foo>()(…)` per-class list
- `invertibles<R>()` helper
- Per-class writable interface declaration (`interface Foo_W extends Foo, WritableBrand { … }`)
- `as never` cast on `Tween.to`
- `as unknown as Writable<X>` factory casts (now single-cast)
- Type-lie on derived RO fields (`box.center`, `vec.magnitude`, `color.luminance`, `matrix.determinant` were over-eagerly typed as writable)
- `lazy(this, "x", () => this.lensTo(Num, s=>s.x, (v,s)=>({…s, x: v})))` boilerplate at every field-lens getter

## What's added vs today

- `declare readonly _writable: Wr<Foo>` per class — phantom registry brand (1 line)
- `field(parent, key, Cls)` helper — used at every field-lens getter
- `derived(parent, key, Cls, fn)` helper — used at every derived-RO getter

## Tests

`types.test.ts` — 17 type-level probes covering direct writes, derived RO views, invertible chains preserving writability via `this`, non-invertibles always RO, mixed chains losing writability at the non-invertible step, animator constraints rejecting bare RO, `Tween.to` requiring writable receiver, nested writability through `Transform.translate.x`, RO consumer compatibility, generic `Traits` constraint compatibility, full Hsl lifecycle, `Writable<Vec>` registry resolution, `Wr<Num>` recognition, and `WritableOf<T>` brand-gating.

`runtime.test.ts` — 20 runtime tests for factories, derived-RO write throws, invertible chain writebacks, auto-fusion, field-lens caching + propagation, nested writability, brand-gated user-defined class, end-to-end reactivity through nested fields.

All 37 probes/tests pass. `tsc --noEmit` clean.

## LOC comparison (matched subset)

| | Today | Spike |
|---|---|---|
| `num.ts` | 147 | 119 |
| `vec.ts` | 312 | 182 |
| `transform.ts` | 163 | 136 |
| `writable.ts` | 99 | 116 (housing the new helpers) |
| **subset total** | **721** | **553** (−23%) |

Adding the spike's `field` / `derived` helpers + `Wr<R>` to the live `writable.ts` would also benefit the un-migrated value classes (Box, Color, Matrix) when they're updated.

## Migration estimate

- `writable.ts` — replace with the spike version (~25 → ~80 lines, net +55 because helpers move here from various places)
- 6 live value classes — drop `static invertibles`, change return types to `: this` for invertibles, replace 3-line lazy+lensTo bodies with 1-line `field()` calls, replace `lazy + deriveTo` with `derived()`, drop double casts, add `_writable: Wr<Foo>` line. Net ~30-line drop per class, ~180 lines total.
- `extensibility.test.ts` — update Hsl authoring to new pattern (~30 line drop)
- `signal.ts` — drop `invertibles<R>()` helper (~20 lines)
- consumer code (`shape.ts`, `handle.ts`, etc.) — no changes (public types preserved)

Estimated net diff: ~−175 lines, plus correctness fix on derived-RO field types.
