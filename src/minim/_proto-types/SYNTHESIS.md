# Type system + lib synthesis

Four upstream lib changes compose to a design that is **type-correct,
ergonomic, and net smaller** than today. Validated end-to-end in
`e16-three-class.ts`, `e17-auto-fields.ts`, `e18-realistic.ts`.

## The four changes

### 1. Promote helper (replaces all WritableXxx subclass duplication)

One ~14-line generic in `signals/` that lifts any value class to its
writable form. Per value class: `type WritableVec = Promote<Vec, "add" | ...>`.

- Inv method names lifted to widen return type (writability flows through chains).
- Field lens props auto-detected (`R[K] extends ReactiveBase<unknown>`) and lifted via a dispatch table.
- No `WritableVec extends Vec` subclass needed.

### 2. Auto-derived field lenses

A `FieldLenses<V>` mapped type + interface merge. Value class declares
methods only; field-lens getters (`x: Num`, `y: Num`, `w: Num`, …)
appear via interface merge with `FieldLenses<VecV>`. Dispatch table
(`FieldLensType<X>`) is declared once for the whole lib.

At runtime: a one-time `defineFields(this, V_KEYS)` call in the
constructor sets up the getter chain via existing `this.field()`.

### 3. Class-static `Vec.derive` / `Vec.lens` (kills the Cls overload mess)

Today's `signal.ts` has two double-overloads to support `computed(fn, Cls?)` and `lens(get, set, Cls?)` — ~50 lines of overload glue.

Move it to the value class:

```ts
class Vec extends ReactiveBase<VecV> {
  static derive(fn: () => VecV): Vec        { /* new instance, set getter */ }
  static lens(get, set): WritableVec        { /* new instance, set getter+setter */ }
}
```

- 2-3 lines per value class.
- Drops ~50 lines from `signal.ts`.
- Eliminates a runtime cast: no more `inst.getter = getter` after `new Cls()`.

### 4. Three-class primitive split (Signal / Computed / Lens)

Engine-level clarity, not a per-class LOC win:

- Merged Signal currently carries 5 unused slots per pure instance and branches on `if (this.getter !== undefined)` in every hot accessor.
- Splitting yields smaller instances, monomorphic dispatch, primitive-level type writability (`Lens<T>` and `Signal<T>` are inherently writable; `Computed<T>` isn't — no phantom params or capability brands needed).
- Animator constraint becomes `ReactiveBase<T> & Writers<T> & Traits<T, K>` — works for both raw primitives and value classes.

Cost: ~10-15 line increase in the engine file. Recommend doing it but it's separable from the type-system work.

## Per-file LOC impact

Measured against current `signals/` directory (949 lines across 9 value/combinator files).

| file | today | with all 4 changes | Δ |
|---|---|---|---|
| `signal.ts` | 832 | ~770 (-overload glue +ReactiveBase abstract) | -62 |
| `values/num.ts` | 76 | ~28 | -48 |
| `values/vec.ts` | 128 | ~36 | -92 |
| `values/box.ts` | 147 | ~32 | -115 |
| `values/color.ts` | 84 | ~30 | -54 |
| `values/matrix.ts` | 150 | ~40 | -110 |
| `values/transform.ts` | 138 | ~32 | -106 |
| `values/anchor.ts` | 28 | ~12 | -16 |
| `values/multi.ts` | 79 | ~50 | -29 |
| `values/hyper.ts` | 119 | ~110 | -9 |
| **+** `signals/promote.ts` (new) | — | ~25 | +25 |
| **total** | **1781** | **~1165** | **−616 (-35%)** |

(Note: signal.ts line count above includes the entire engine, not just the public class.)

Vec drops from 128 → 36 (-72%). Box drops from 147 → 32 (-78%). The biggest wins are on value classes that had heavy field-lens enumerations + many invertible methods.

## What stays

- The Promote helper itself (~14 lines, but pays for itself 6× over).
- The `FieldLensType<X>` dispatch table (~6 lines, declared once for the whole lib).
- VecChain/NumChain/BoxChain classes — separate ergonomics concern from writability. Chain methods mirror eager methods today; could be auto-derived from a single `Ops` table per value class to save ~5 lines per class.

## Type correctness (verified across e14/e17/e18)

| property | works |
|---|---|
| RO default at type level | ✓ |
| `vec().value = …` accepted | ✓ |
| `vec().normalize().value = …` rejected | ✓ |
| `vec().x.value = 5` accepted (field on writable) | ✓ |
| `vec().normalize().x.value = 5` rejected (★ field on RO) | ✓ |
| Eager chain promotes through invertible methods | ✓ |
| `derive(c => c.add(b))` returns writable from writable source | ✓ |
| `Vec.derive(fn)` static returns RO | ✓ |
| `Vec.lens(get, set)` static returns writable | ✓ |
| Animators reject RO sources | ✓ |
| Animators reject types missing required trait (e.g. Box ↛ spring) | ✓ |
| `WritableVec ⊆ Vec` (subtype, RO sigs accept writable) | ✓ |
| Local-reasoning: buggy fn caught in its own body | ✓ |

No known holes. Field-lens capability flows correctly (the gap that E11 had and that broke E12).

## What's not in the synthesis (independent concerns)

1. **Method audit.** Some value-class methods (`Vec.up/down/left/right` axis-sugar; `Vec.distance` is a one-liner over `metric`; `Color` has many one-off methods) could move to free functions or be removed. Pure design call, ~10-30 lines saved per class. Not coupled to the type system.

2. **Chain auto-generation from Ops table.** Today each value class declares `add/sub/scale` etc. twice (once on `Vec`, once on `VecChain`). A single declaration like `const VEC_OPS = { add: addOp, sub: subOp, … }` could synthesize both at runtime via prototype assignment. ~5-10 lines per class.

3. **Smaller value-class roster.** `Anchor`, `Dir`, possibly `Color`/`Transform` could be structural Signals over plain object types with helper functions instead of full value classes. Saves an entire file per dropped class.

## Recommendation

Adopt #1 (Promote) and #2 (auto field lenses) first — they're the type-system payoff and require no engine changes. ~150 lines saved without touching `signal.ts`.

Then #3 (class-static derive/lens) — small per-class additions but lets us delete the overload mess in `signal.ts`.

Then #4 (3-class engine split) — separable, motivated by engine clarity rather than LOC. Probably worth it but no rush.

Method audit + chain auto-gen + roster trimming are orthogonal cleanups that can happen any time.
