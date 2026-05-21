# r4 — merged Signal + Promote types (the simple path)

What this is: today's `signals/` engine (merged `Signal<T>` class)
plus a type-system Promote helper to track writability. No 3-class
engine split. No `derive()` / `Chain` (dropped per the user's plan).
Adds `Vec.derive` / `Vec.lens` / `Vec.is` statics.

Result: per-value-class authoring is **simpler than today**, and
writability is tracked at the type level (mostly — see "open
footgun" below).

## LOC per file

|                | r2 (today)       | r3 (split + mixin) | **r4 (merged + Promote)** |
|----------------|------------------|--------------------|---------------------------|
| `num.ts`       | 76               | 131                | **62**                    |
| `vec.ts`       | 128              | 207                | **87**                    |
| `promote.ts`   | —                | —                  | 71 (one-time)             |
| total / class  | —                | 169                | **75**                    |

Each value class is one class declaration with its methods, plus a
short interface merge to override `.value` to readonly at the public
type level. No subclasses, no mixin tables, no `Object.assign` /
`defineProperty` dance.

## Benchmark (vs r2)

Median across 3 runs, M2 Pro.

| benchmark                         | r2       | r4       | Δ      |
|-----------------------------------|----------|----------|--------|
| signal write (pre-constructed)    | 229 µs   | 232 µs   | ±1%   |
| `vec.x.value =` write-through     | 1.01 ms  | 1.02 ms  | ±1%   |
| `vec(x, y)` construction          | 3.01 ms  | 2.98 ms  | ±1%   |
| chain depth 4 (10k writes)        | 1.48 ms  | 1.44 ms  | ±2%   |

Same engine = same perf, as expected.

## What this design gets us

**Authoring** (per value class, mechanical):

```ts
export class Num extends Signal<V> {
  static traits: Required<TraitDict<V>> = { linear, lerp, metric, equals };
  constructor(v: V = 0, opts?: NodeOptions<V>) { super(v, opts) }

  add(b: Val<V>): Num    { return applyOp1(this, addOp,   b, Num) }
  sub(b: Val<V>): Num    { return applyOp1(this, subOp,   b, Num) }
  scale(k: Val<number>): Num { return applyOp1(this, scaleOp, k, Num) }
  clamp(lo: Val<V>, hi: Val<V>): Num { /* ... */ }

  static derive(fn: () => V): Num { return computed(fn, Num) }
  static lens(g: () => V, s: (v: V) => void): WritableNum { /* ... */ }
  static is(v: unknown): v is Num { return v instanceof Num }
}
// Interface merge: bare Num is RO at the type level. Writable form
// is `WritableNum` (one-line Promote alias in promote.ts).
export interface Num {
  readonly constructor: typeof Num;
  get value(): V;
}

export function num(v: Val<V> = 0): WritableNum {
  const n = new Num();
  n.bind(v);
  return n as unknown as WritableNum;
}
```

Plus, in `promote.ts`:

```ts
export type WritableNum = Promote<Num, "add" | "sub" | "scale">;
export type WritableVec = Promote<Vec, "add" | "sub" | "scale" | "offset">;
```

That's it. One line per writable form.

**Type-level writability**:

- `vec()` returns `WritableVec`. `.value = …`, `.set(…)`, `.bind(…)` all work.
- `vec().normalize()` returns `Vec` (RO). `.value = …` → TS error.
- `vec().normalize().x.value = 5` → TS error (field-lens capability flows via Promote's `LensFields` auto-detection).
- `vec().add(b).scale(2).value = …` → OK. Promote lifts the chain return through invertible methods.

**Runtime instanceof**:

- `numInstance instanceof Num` — works (Num is the actual class).
- `Num.is(x)` — sugar over `instanceof Num`.

## Open footgun

Animator-style sigs `spring(s: Writable<T> & Traits<T, K>, target: T)`
don't statically reject a bare RO `Vec` because TS's interface merge
of `get value(): V` over a class with both `get/set value` accessors
doesn't fully strip the inherited setter at structural checks.

**Caught**: `roVec.value = 5` — direct write.
**Not caught**: `spring(roVec, target)` — structural check passes.

Workaround: animators should narrow their input type to `WritableVec` /
`Writable<T>` rather than rely on structural rejection. Or wrap a
nominal brand on `Writers<T>` (tried; ran into intersection-with-Signal
quirks; deferred).

Most practical code flows through factories (`vec()`, `Vec.lens(...)`)
which return the writable types directly, so the footgun rarely
surfaces in real authoring.

## What's NOT in r4 (worth flagging)

- **No `derive()` / `Chain`**. Replaced by nested invertible methods
  (`vec.add(b).scale(2)`) which produce nested lenses. For deeply-fused
  chains as a perf upgrade, see future-work notes.
- **No 3-class engine split**. The merged `Signal<T>` engine is kept.
  Engine clarity wins from r3 don't justify the authoring cost.
- **Not all value classes ported yet** — only Num and Vec. Box, Color,
  Matrix, Transform, Anchor follow the same pattern; mechanical to
  port. Anim / multi / hyper need their existing form.

## My take

r4 is the right balance. It keeps the proven engine, drops the
unnecessary `Chain`/`derive` machinery, and adds type-level
writability tracking via a small Promote helper. Per-class authoring
shrinks vs r2 because we lose `derive` + `VecChain` boilerplate. The
animator footgun is annoying but small and addressable.

vs r3: less perf wins (mid-range chains and lens-write are marginal),
but **dramatically simpler authoring** and **no engine churn**.
