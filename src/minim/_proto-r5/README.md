# r5 — `Writable<R>` as a modifier + spring footgun closed

Changes vs r4:

- **`Writable<R>` is a generic modifier**, not per-class named types.
  Use `Writable<Vec>` / `Writable<Num>`; no `WritableNum`/`WritableVec`
  aliases needed.
- **Animator-style constraints work generically** via `WritableOf<T>
  & Traits<T, K>`. Bare RO Vec is rejected at compile time.
- **`static invertibles` static field** on each value class drives the
  type-level method-return lifting. Author writes one line:
  `static invertibles = ["add", "sub", "scale"] as const`.
- **Surface trim**: dropped `WritableNum`/`WritableVec`/`Promote`/
  `Writers`/`RO`/`Computed`/`Lens` type aliases (replaced by
  `Writable<R>` modifier or just bare class types). ~8 fewer exports.

## Public surface (the whole thing)

```ts
// Engine
Signal, signal, computed, lens, effect, batch, untracked,
isSignal, isComputed, isLens, value,
Read<T>, Val<T>, Of<R>, SignalOptions

// Traits
Linear<T>, Lerp<T>, Metric<T>, Equals<T>, Traits<T, K>,
requireLinear, requireLerp, requireMetric, requireEquals

// Ops (for value-class authors)
Op<V, Args>, applyOp1, applyOp2

// Writable
Writable<R>, WritableOf<T>

// Value classes
Num, num, Vec, vec
```

~34 exports total. r4 had ~42.

## The animator pattern

```ts
function spring<T>(
  s: WritableOf<T> & Traits<T, "linear" | "metric">,
  target: T,
): void {
  s.value = target;
}

spring(vec(1, 2), { x: 0, y: 0 });    // ✓
spring(num(0), 5);                    // ✓
spring(vec().normalize(), { x: 0, y: 0 }); // ✗ — no brand on RO Vec
spring(new Vec(), { x: 0, y: 0 });    // ✗ — `new Vec()` doesn't add the brand
```

`Vec.lens(...)`, `vec(...)`, `Num.lens(...)`, `num(...)`, `vec().add(...)`, etc — all return branded `Writable<R>` values. Bare `new Vec()`, `Vec.derive(...)`, `vec().normalize()` etc don't.

## Authoring shape per value class

```ts
export class Num extends Signal<V> {
  static traits: Required<TraitDict<V>> = { linear, lerp, metric, equals };
  static invertibles = ["add", "sub", "scale"] as const;  // ★ one-liner
  constructor(v: V = 0, opts?: SignalOptions<V>) { super(v, opts) }

  add(b: Val<V>): Num     { return applyOp1(this, addOp, b, Num) }
  sub(b: Val<V>): Num     { return applyOp1(this, subOp, b, Num) }
  scale(k: Val<number>): Num { return applyOp1(this, scaleOp, k, Num) }
  clamp(lo: Val<V>, hi: Val<V>): Num { /* ... */ }

  static derive(fn: () => V): Num { return computed(fn, Num) }
  static lens(g, s): Writable<Num> { return lensFactory(g, s, Num) as ... }
  static is(v: unknown): v is Num { return v instanceof Num }
}
export interface Num {
  readonly constructor: typeof Num;
  get value(): V;
}
export function num(v: Val<V> = 0): Writable<Num> {
  const n = new Num(); n.bind(v); return n as unknown as Writable<Num>;
}
```

## LOC comparison

|              | r2 (today) | r4         | **r5**  |
|--------------|------------|------------|---------|
| `num.ts`     | 76         | 62         | **61**  |
| `vec.ts`     | 128        | 87         | **84**  |
| helper       | —          | 71 (Promote) | 111 (writable) |

writable.ts is a touch bigger than promote.ts because of WritableOf
+ the brand + more docstrings. Net: per-class is essentially tied
with r4 but the public API is meaningfully cleaner.

## Verified properties

| property | works |
|---|---|
| `vec().value =` accepted | ✓ |
| `vec().normalize().value =` rejected | ✓ |
| `vec().normalize().x.value =` rejected (field-of-RO) | ✓ |
| `vec().add(b).scale(2).value =` accepted (invertible chain) | ✓ |
| `spring(vec(), ...)` accepted | ✓ |
| `spring(vec().normalize(), ...)` rejected | ✓ |
| `spring(new Vec(), ...)` rejected | ✓ |
| Buggy fn `(v: Vec) => { v.value = ... }` caught locally | ✓ |
| Generic accept-any-reader `(v: Vec) => v.value` works | ✓ |

## What's left to decide

- **The brand**: a `unique symbol` declared at module scope. Means
  `Writable<R>` is nominally branded across module boundaries — if
  someone re-implements `WritableOf<T>` themselves they need to
  import our brand. Acceptable for an internal lib; could be exported
  if external consumers need it.
- **`static invertibles = [...] as const`**: easy to forget. If
  someone omits `as const`, the type stays as `string[]` and
  `Writable<R>` quietly stops lifting methods. Could enforce via
  a static-assertion helper if it bites in practice.
- **`set` / `bind` inherited from Signal class are still callable on
  bare RO `Vec` at the type level** (they're class methods, not
  accessors — interface merge can't subtract). Minor footgun; could
  be fixed by moving them off the class to the `Writable<R>` mixin,
  but that's a bigger refactor.

Want me to port Box + Transform to confirm the pattern scales, or
look at moving `set`/`bind` off the Signal class?
