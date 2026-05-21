# r5 — `Writable<R>` modifier, no footguns, ported value classes

A clean iteration on the merged-Signal engine. Type-system carries
writability via a generic `Writable<R>` modifier. All known footguns
closed. Engine perf matches r2 (same engine, no changes).

## What changed vs r4

1. **`Writable<R>` is a generic modifier** — no per-class `WritableNum`
   / `WritableVec` named types. Author writes `static invertibles =
   [...] as const` on the class; `Writable<R>` auto-detects and lifts.

2. **Animator constraint works generically** — `WritableOf<T> &
   Traits<T, K>` rejects bare RO Vecs at compile time. The brand on
   `WritableOf<T>` is the linchpin.

3. **`set`/`bind` footgun closed** — `Signal.set(this: WritableBrand &
   Signal<T>, …)` `this`-type constraint means `roVec.set(5)` is a
   compile error. Only branded receivers (factory-returned, lens-form)
   can call.

4. **Surface trimmed** — dropped `RO`, `Computed` / `Lens` type
   aliases, `Writers`, `Promote`, `WritableNum/Vec/Box`, `isNode`,
   `TraitDict`, `TraitKey`. Net: 35 exports (r2 had ~42).

5. **Box and Transform ported** to confirm the pattern scales.

## Ported value classes (all tests pass)

|              | r2 (today) | **r5** | saved  |
|--------------|------------|--------|--------|
| `num.ts`     | 76         | 61     | -15    |
| `vec.ts`     | 128        | 84     | -44    |
| `box.ts`     | 147        | 95     | -52    |
| `transform.ts` | 138      | 125    | -13    |
| **+** `writable.ts` (new) | — | 76 (one-time) | +76 |

Net: 4 value classes saved 124 lines; pay 76 once for `writable.ts`. **−48 lines net so far**, growing as more value classes port (color, matrix, anchor, etc.).

## Public surface (35 exports)

```ts
// Engine (12)
Signal, signal, computed, lens, effect, batch, untracked,
isSignal, isComputed, isLens, value,
Read<T>, Val<T>, Of<R>, SignalOptions

// Traits (9)
Linear<T>, Lerp<T>, Metric<T>, Equals<T>, Traits<T, K>,
requireLinear, requireLerp, requireMetric, requireEquals

// Ops (3)
Op<V, Args>, applyOp1, applyOp2

// Writable (2)
Writable<R>, WritableOf<T>

// Value classes (9)
Num, num, Vec, vec, Box, box, Transform, transform, TransformInit
```

See `SURFACE.md` for the full audit (each export evaluated for necessity / overlap / consolidation).

## All known footguns closed

| | r4 | **r5** |
|---|---|---|
| `roVec.value = …` | caught | caught |
| `roVec.x.value = …` | caught | caught |
| `spring(roVec, target)` | structural pass (BAD) | **caught** |
| `roVec.set(5)` | not caught | **caught** |
| `roVec.bind(src)` | not caught | **caught** |

## Authoring shape per value class

```ts
export class Vec extends Signal<V> {
  static traits: Required<TraitDict<V>> = { linear, lerp, metric, equals };
  static invertibles = ["add", "sub", "scale", "offset"] as const;   // ★
  constructor(v: V = { x: 0, y: 0 }, opts?: SignalOptions<V>) { super(v, opts) }

  add(b: Val<V>): Vec     { return applyOp1(this, addOp,    b, Vec) }
  sub(b: Val<V>): Vec     { return applyOp1(this, subOp,    b, Vec) }
  scale(k: Val<number>): Vec { return applyOp1(this, scaleOp, k, Vec) }
  offset(dx: Val<number>, dy: Val<number>): Vec {
    return applyOp2(this, offsetOp, dx, dy, Vec);
  }

  normalize(): Vec { return computed(() => normalize(this.value), Vec) }
  perp(): Vec      { return computed(() => perp(this.value), Vec) }
  // ... etc

  get x(): Num { return this.field("x", Num) }
  get y(): Num { return this.field("y", Num) }
  get magnitude(): Num { /* memoised */ }

  static derive(fn: () => V): Vec { return computed(fn, Vec) }
  static lens(g: () => V, s: (v: V) => void): Writable<Vec> { /* ... */ }
  static is(v: unknown): v is Vec { return v instanceof Vec }
}
export interface Vec {
  readonly constructor: typeof Vec;
  get value(): V;  // interface merge: RO at public type level
}

export function vec(x: Val<number> = 0, y: Val<number> = 0): Writable<Vec> {
  const v = new Vec() as Writable<Vec>;
  v.x.bind(x); v.y.bind(y);
  return v;
}
```

Tracking elements per value class:
- 1 class declaration
- 1 `static traits` line
- 1 `static invertibles` line
- N methods, declared once
- field-lens getters (one line each via `this.field(...)`)
- 3 statics: `derive`, `lens`, `is`
- 1 interface merge for constructor + value RO
- 1 factory function

No mixin tables, no `Object.assign`, no `defineProperty`. Just plain class declaration with a one-liner static field.

## How `Writable<R>` works

```ts
type Writable<R> =
  Omit<R, "value" | InvOf<R> | LensFields<R>>
  & Writers<R extends Read<infer T> ? T : never>
  & WritableBrand
  & { [K in InvOf<R>]: R[K] extends (...a: infer A) => R ? (...a: A) => Writable<R> : R[K] }
  & { [K in LensFields<R>]: LiftField<R[K]> };
```

- `InvOf<R>` reads `R['constructor']['invertibles'][number]`. Auto-detect from the class's static field.
- `LensFields<R>` auto-detects properties typed as `Read<unknown>`.
- `LiftField<X>` dispatches each field type to its `Writable<…>` form.
- `WritableBrand` is a `unique symbol` interface; only factory casts add it.

## How the `.set` / `.bind` footgun is closed

```ts
class Signal<T> {
  set(this: WritableBrand & Signal<T>, v: Val<T>): typeof this { … }
  bind(this: WritableBrand & Signal<T>, source: Val<T>): () => void { … }
}
```

The `this` parameter requires the receiver to carry `WritableBrand`. Bare `Vec` / `Num` / `Signal` (without factory-cast brand) can't satisfy. Calling `.set` is a compile error. `Writable<R>` / `WritableOf<T>` carry the brand → callable.

## Perf

Same engine as r2. Bench-confirmed within ±5% on all paths (signal write, vec.x write-through, vec construction, chain depth 4). r5 ≈ r2 at the engine level.

## Status

- Tests: **23 passing** (engine basics, value classes, types, box, transform)
- Typecheck: clean
- Bench: parity with r2
- Authoring: tighter per class, no mixin complexity
- Footguns: all known holes closed

Ready for further porting (Color, Matrix, Anchor) and then anim.ts.
