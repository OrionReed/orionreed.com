# Spike: simpler `Writable<R>`

Self-contained prototype of the alternative type story for value classes.
**Same external API** (`Vec.derive`, `Vec.lens`, `Writable<Vec>`, factory
returns), with a **simpler internal type machine** that fixes a real
correctness bug in today's recursive-lift approach.

The spike runs on the existing `Signal` engine — only the public type
story changes. Runtime is reused verbatim (alien-signals, lens fusion,
equality dispatch).

## What changes

| | Today | Spike |
|---|---|---|
| `Writable<R>` resolution | recursive transform: `Omit<R,…> & Writers<…> & WritableBrand & {lifted invertibles} & {recursively-lifted fields}` | single-hop registry: `R extends { _writable: infer W } ? W : never` |
| Invertible methods | `(...) => Vec`, listed in `static invertibles = invertibles<Vec>()(…)` | `(...) => this`, no list |
| Field-lens declaration | `get x(): Num { return lazy(this, "x", () => this.lensTo(Num, s=>s.x, (v,s)=>({...s, x: v}))) }` | same |
| Writable counterpart | recursive `LiftField<X>` — auto, but **type-lies** on derived RO fields like `vec.magnitude` and `box.center` | per-class `Vec_W extends Wr<Vec> { get x(): Writable<Num>; get y(): Writable<Num> }` — explicit, honest |
| `Tween.to` brand bypass | `tween(this as never, …)` | `to(this: Writable<R>, …)` — no cast |
| Factory cast | `as unknown as Writable<X>` | `as Writable<X>` (one cast) |
| Field-lens write closure | `(v, s) => ({ ...s, x: v })` (literal `x`, V8 fast path) | same |

## The three primitives in `writable.ts`

```ts
// Single-hop registry lookup
type Writable<R> = R extends { readonly _writable: infer W } ? W : never;

// Default writable shape — used directly for scalar classes whose
// fields don't need overrides; used as the base for richer per-class
// writable interfaces
type Wr<R> = R & WritableBrand & { value: Of<R> };

// Animator constraint
interface WritableOf<T> extends WritableBrand { value: T; peek(): T }
```

That's it. No helper functions, no `Inherits<R, T>`, no overridden
`lazy`. The `Wr<R>` shape covers scalar classes (Num) and serves as
the base type for richer writable interfaces.

## Authoring template

```ts
import { lazy, Signal, type Val, valFn } from "../signal";
import { traits, type Linear } from "../traits";
import type { Wr, Writable } from "./writable";

class Vec extends Signal<V> {
  static traits = traits<V>()({ linear: linearImpl, lerp, metric, equals });
  declare readonly _writable: Vec_W;

  add(b: Val<V>): this { /* invertible — `this` propagates writability */ }
  normalize(): Vec { /* non-invertible — explicit RO return */ }

  // Field-lens getter — typed `: Num` (RO at type level via interface
  // merge). Vec_W (below) overrides .x / .y to their writable
  // counterparts. The lens itself is constructed via `lazy + lensTo`
  // with literal property access in the closures (V8-friendly).
  get x(): Num {
    return lazy(this, "x", () =>
      this.lensTo(Num, s => s.x, (v, s) => ({ ...s, x: v })),
    );
  }
  get y(): Num { /* same shape */ }

  // Derived RO view — typed `: Num`. Vec_W does NOT override this,
  // so `vec.magnitude.value = …` is correctly rejected at compile
  // time (today's `LiftField` would type-lie this as writable).
  get magnitude(): Num {
    return lazy(this, "magnitude", () => this.deriveTo(Num, v => Math.hypot(v.x, v.y)));
  }

  // Tween — writable-only via `this:` constraint (no `as never`)
  to(this: Writable<Vec>, target: V, dur: Val<number>): Tween<V> {
    return tween(this, target, dur);
  }
}
interface Vec {
  readonly constructor: typeof Vec;
  get value(): V;
}

/** Writable Vec — overrides field-lenses that ARE writable. Derived
 *  RO views (`magnitude`) are intentionally not listed. */
interface Vec_W extends Wr<Vec> {
  get x(): Writable<Num>;
  get y(): Writable<Num>;
}

function vec(...): Writable<Vec> {
  const v = new Vec(...) as Writable<Vec>;
  return v;
}
```

## What's eliminated vs today

- `LiftField<X>`, `InvOf<R>`, `LensFields<R>`, `Writers<T>` utility types
- `static invertibles = invertibles<Foo>()(…)` per-class list
- `invertibles<R>()` helper
- `as never` cast on `Tween.to`
- `as unknown as Writable<X>` factory casts (now single-cast)
- **Type-lie on derived RO fields** (`box.center`, `vec.magnitude`,
  `color.luminance`, `matrix.determinant` are no longer over-eagerly
  typed as writable on writable receivers — fixes a real bug)

## What's added vs today

- `declare readonly _writable: Foo_W` per class — phantom registry
  brand (1 line)
- Per-class writable interface (`interface Foo_W extends Wr<Foo> {
  …field-lens overrides… }`) — explicit list of which fields propagate
  writability. Number of override lines = number of writable field
  lenses on the class.
- `to(this: Writable<Foo>, …)` constraint — one line per class with
  a `to` method

## Net authoring cost vs today (per class)

| | Today | Spike |
|---|---|---|
| `static invertibles = invertibles<Foo>()(…)` | 1-3 lines | gone |
| Per field-lens getter body | 3 lines | 3 lines (same) |
| Per derived RO getter body | 2-3 lines | 2-3 lines (same) |
| `_writable: Foo_W` declaration | n/a | 1 line |
| `interface Foo_W extends Wr<Foo> {…}` | n/a | 1 + N lines (N = writable fields) |
| `to()` body | `tween(this as never, …)` | `(this: Writable<Foo>, …) … tween(this, …)` (same length) |
| Factory cast | `as unknown as Writable<Foo>` | `as Writable<Foo>` (1 cast vs 2) |

For Vec (5 invertibles, 2 writable fields, 1 derived RO):
- Today: ~6 lines `static invertibles`, no writable interface
- Spike: 1 line `_writable`, ~3 lines `interface Vec_W { value, x, y }`

About the same LOC. The spike is correct (no type lie), explicit
(writable fields are listed), and locally-reasoned (each method's
return type tells you if it's invertible — no static list).

## Tests

`types.test.ts` — 17 type-level probes covering direct writes, derived
RO views, invertible chains preserving writability via `this`,
non-invertibles always RO, mixed chains losing writability at the
non-invertible step, animator constraints rejecting bare RO, `Tween.to`
requiring writable receiver, nested writability through
`Transform.translate.x`, RO consumer compatibility, generic `Traits`
constraint compatibility, full Hsl lifecycle, `Writable<Vec>` registry
resolution, field-lens types (RO bare → writable on `Writable<R>`),
derived RO fields stay RO, and `WritableOf<T>` brand-gating.

`runtime.test.ts` — 20 runtime tests for factories, derived-RO write
throws, invertible chain writebacks, auto-fusion, field-lens caching +
propagation, nested writability, brand-gated user-defined class,
end-to-end reactivity through nested fields.

All 37 probes/tests pass. `tsc --noEmit` clean (the only TS errors in
the workspace are in `_proto-relate/`, an unrelated WIP directory).

## Migration estimate

- `writable.ts` — replace with spike version (~99 → ~50 lines)
- 6 live value classes — drop `static invertibles = invertibles<R>()(…)`
  list, change return types to `: this` for invertibles, change
  `to()` to `(this: Writable<…>, …)`, drop double casts, add
  `_writable: Foo_W` line, declare `interface Foo_W extends Wr<Foo> {…}`
  with field-lens overrides. Net ~5-line drop per class.
- `extensibility.test.ts` — update Hsl authoring to new pattern (~5 line drop)
- `signal.ts` — drop `invertibles<R>()` helper (~20 lines)
- consumer code (`shape.ts`, `handle.ts`, etc.) — no changes (public
  types preserved)

Estimated net diff: ~−80 lines, plus the correctness fix on
derived-RO field types and the elimination of multiple type-system
caveats.
