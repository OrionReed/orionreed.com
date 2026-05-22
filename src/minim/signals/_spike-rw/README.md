# Spike: simpler `Writable<R>`

Self-contained prototype of the alternative type story for value classes.
**Same external API** (`Vec.derive`, `Vec.lens`, `Writable<Vec>`, factory
returns), with a **simpler internal type machine**.

The spike runs on the existing `Signal` engine — only the public type
story changes. Runtime is reused verbatim (alien-signals, lens fusion,
equality dispatch).

## What changes

| | Today | Spike |
|---|---|---|
| `Writable<R>` resolution | recursive transform: `Omit<R,…> & Writers<…> & WritableBrand & {lifted invertibles} & {recursively lifted fields}` | single-hop registry: `R extends { _writable: infer W } ? W : never` |
| Invertible methods | typed `(...) => Vec`, lifted via `static invertibles = invertibles<Vec>()(…)` | typed `(...) => this`, no list |
| Field-lens overrides on writable form | recursive `LiftField<X>` walks any `Read<unknown>`-typed property — **type lie** for derived RO fields like `box.center` | per-field getter uses `Inherits<this, Foo>` conditional; writable interface declares no field overrides |
| Derived-view fields (`magnitude`, `box.center`) | over-eagerly typed as writable on writable receivers | typed as plain `Foo` (RO) — explicit, honest |
| `Tween.to` brand bypass | `tween(this as never, …)` | `to(this: Writable<R>, …)` — no cast |
| Factory cast | `as unknown as Writable<X>` | `as Writable<X>` (one cast) |
| Getter body cast | n/a | none — locally re-typed `lazy` carries `Inherits<this, T>` through |

## Three primitives in `writable.ts`

```ts
type Writable<R> = R extends { readonly _writable: infer W } ? W : never;
type Inherits<R, T> = R extends WritableBrand ? Writable<T> : T;
interface WritableOf<T> extends WritableBrand { value: T; peek(): T; }
```

Plus a locally-typed `lazy` re-export that resolves the conditional at
the call site, dropping the `as never` cast at every getter body:

```ts
export const lazy = rawLazy as <S, T>(
  self: S,
  key: string | symbol,
  make: () => T,
) => S extends WritableBrand ? Writable<T> : T;
```

## Authoring template

```ts
class Foo extends Signal<V> {
  static traits = traits<V>()({ … });
  declare readonly _writable: Foo_W;          // registry brand

  add(b: Val<V>): this { … }                  // invertible — `this` propagates writability
  scale(k: Val<number>): this { … }
  normalize(): Foo { … }                      // non-invertible — explicit RO return

  to(this: Writable<Foo>, …): Tween<V> { … }  // writable-only via `this:` constraint

  // Field lens — `Inherits<this, Bar>` polymorphic on receiver
  get x(): Inherits<this, Bar> {
    return lazy(this, "x", () => this.lensTo(Bar, …));
    // No cast — `lazy`'s conditional return matches `Inherits<this, Bar>`
  }
  get derived(): Bar { … }                    // derived RO — plain `Bar`
}
interface Foo {
  readonly constructor: typeof Foo;
  get value(): V;                             // RO via interface merge
}
interface Foo_W extends Foo, WritableBrand {
  value: V;                                   // RW override
  // No field overrides — `Inherits<this, T>` handles them uniformly
}
function foo(…): Writable<Foo> {
  return new Foo(…) as Writable<Foo>;         // single cast, no `unknown` hop
}
```

## What's eliminated vs today

- `LiftField<X>`, `InvOf<R>`, `LensFields<R>`, `Writers<T>` — all gone
- `static invertibles = invertibles<Foo>()(…)` per-class list — gone
- `invertibles<R>()` helper — gone
- `as never` casts on `Tween.to` — gone
- `as unknown as Writable<X>` factory casts — collapsed to single cast
- "Type lie" on derived RO fields like `box.center`/`vec.magnitude`
  being typed as writable — fixed (writable iff actually writable)

## What's added vs today

- `declare readonly _writable: Foo_W` per class — phantom registry brand
- `interface Foo_W extends Foo, WritableBrand { value: V }` per class —
  3 lines, constant regardless of field count
- `Inherits<R, T>` type alias — one new helper

## What's covered (in `_test/`)

`types.test.ts` — 17 type-level probes (positive accept + `@ts-expect-error`):

1. Direct writes on writable factory return
2. Derived RO views block writes
3. `Vec.derive(fn)` returns bare `Vec` (RO)
4. `Vec.lens(g, s)` returns `Writable<Vec>`
5. Invertible chains preserve writability via `this`
6. Non-invertibles always return RO regardless of receiver
7. Mixed chains lose writability at the non-invertible step
8. Animator constraints reject bare RO at the call site
9. `Tween.to` requires writable receiver
10. Nested writability (`Transform.translate.x.value = 5`)
11. RO consumer accepts both forms
12. Generic `Traits` constraint accepts both forms
13. User-defined `Hsl` — full lifecycle
14. `Writable<Vec>` registry resolution
14b. `Inherits<this, Num>`-conditional getters resolve correctly
14c. Derived RO fields stay RO on writable receivers (no type lie)
15. `WritableOf<T>` rejects bare RO via brand

`runtime.test.ts` — 20 tests covering factories, derived-RO write
throws, invertible chain writebacks, auto-fusion, field-lens caching
+ propagation, nested writability, brand-gated user-defined class,
end-to-end reactivity through nested fields.

All 37 probes/tests pass. `tsc --noEmit` clean.

## Migration estimate

- `writable.ts` — gut and replace (~80 → ~25 lines): registry lookup,
  `Inherits<R, T>`, conditionally-typed `lazy` override
- 6 value classes — add `_writable` phantom + writable interface, drop
  `static invertibles`, change return types to `: this` for invertibles,
  use `Inherits<this, …>` for field lenses, change `to()` to
  `(this: Writable<…>, …)`, drop the `as unknown as Writable<X>` casts
  (~20 line diff per class)
- `extensibility.test.ts` — update Hsl authoring to new pattern
- `signal.ts` — drop `invertibles<R>()` helper
- consumer code (`shape.ts`, `handle.ts`, etc) — no changes

Estimated total: ~300 line diff across ~10 files. Existing test suite
serves as regression net (runtime is identical).
