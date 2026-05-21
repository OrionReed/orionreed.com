# Type-system exploration: writability encoding

Thirteen self-contained TS files exploring how to encode "this
signal is read-only" at the type level. Each `.ts` file compiles in
isolation; each `@ts-expect-error` marker proves TS rejects what we
want rejected.

**Winner: E13** — two-class hierarchy per value type (`Vec` + `WritableVec extends Vec`)
with overridden methods. Verified against the full surface (traits,
animators, combinators, shape-like patterns, chains, field lenses,
nested access). The only known approach that gives **perfect type
inference matching runtime truth at every step.**

Previous "winners" with caveats:
- **E11** (intersection-mixin `Writable<R>`): simpler but had a
  field-lens capability hole — `vec.normalize().x.value = 5` slipped
  through TS.
- **E7** (variance `Signal<T, W>` + `out C`): elegant but broke at
  the trait-intersection level (E10 isolated this).

## File-by-file results

| file | approach | status |
|---|---|---|
| `e1-builtin-readonly.ts` | `Readonly<Vec>` (TS built-in) | **fails** — doesn't block `.set()` calls |
| `e2-writable-default.ts` | Writable default + `Readonly<R>` Omit narrowing | works for eager methods alone |
| `e3-readonly-default.ts` | RO default + `Writable<R>` intersection adds setters | works for eager methods alone |
| `e4-variance.ts` | `Signal<T, W extends boolean>` phantom param | boolean literals are disjoint, no subtype |
| `e5-combined.ts` | E4 internally + E3 surface | same variance issue as E4 |
| `e6-branded-cap.ts` | branded `RW extends RO` types + W phantom | setter contravariance flips subtype direction |
| `e7-explicit-variance.ts` | E6 + `out C` annotation | works in isolation; **breaks under trait intersection** |
| `e8-simpler-brands.ts` | E7 with plain string brand keys | works; brands don't need `unique symbol` |
| `e9-full-system.ts` | E7/E8 applied to full system | **traits intersection breaks variance check** |
| `e10-variance-debug.ts` | isolated repro of E9 break | confirmed unfixable at TS level |
| `e11-pragmatic.ts` | E3-style intersection + chain W phantom | **all animator/combinator patterns pass — but** field lens capability hole |
| `e12-this-types.ts` | E11 + `this`-typed methods to recover field lens flow | **fails** — TS's `this` collapses to class type, doesn't carry intersection wrappers |
| `e13-two-class.ts` | Two-class hierarchy per value type (`Vec` + `WritableVec extends Vec`) | **all patterns pass, no holes** ✓ |

## E13 — the design

```ts
// ─── Core ─────────────────────────────────────────────────────────
declare class Signal<T> {
  get value(): T;
  peek(): T;
  // NO setter, NO .set, NO .bind at the type level
}

type Of<R> = R extends Signal<infer T> ? T : never;

// Writable surface (shared by all writable Signals)
interface Writers<T> {
  value: T;
  set(v: T): unknown;
  bind(s: T | (() => T)): () => void;
}

// ─── Per value type: TWO classes ──────────────────────────────────
// Base class (RO):
declare class Vec extends Signal<V> {
  static traits: Required<TraitDict<V>>;
  add(b: V): Vec;                    // RO base — returns RO
  scale(k: number): Vec;
  normalize(): Vec;                  // non-invertible — stays Vec
  get x(): Num;                      // RO field lens
  get y(): Num;
  derive<W extends boolean>(fn: (c: VecChain<true>) => VecChain<W>): Vec;
}
interface Vec { readonly constructor: typeof Vec }

// Writable subclass — overrides invertible methods + field lenses:
declare class WritableVec extends Vec {
  override get value(): V;
  set value(v: V);                   // adds setter
  set(v: V): unknown;
  bind(s: V | (() => V)): () => void;
  override add(b: V): WritableVec;   // narrow return to WritableVec
  override scale(k: number): WritableVec;
  override get x(): WritableNum;     // field lens lifts to writable
  override get y(): WritableNum;
  // normalize() inherited from base — stays Vec (non-invertible)
  override derive<W extends boolean>(fn: (c: VecChain<true>) => VecChain<W>): W extends true ? WritableVec : Vec;
}

// ─── Public alias (sugar) ─────────────────────────────────────────
type Writable<R extends Signal<unknown>> =
  R extends WritableVec ? WritableVec
  : R extends Vec ? WritableVec
  : R extends WritableNum ? WritableNum
  : R extends Num ? WritableNum
  : R extends Signal<infer T> ? Signal<T> & Writers<T>
  : never;

// ─── Factories return the writable subclass ───────────────────────
declare const vec: () => WritableVec;

// ─── Animators (Writers-generic for non-class signals) ────────────
declare function spring<T>(
  sig: (Signal<T> & Writers<T>) & Traits<T, "linear" | "metric">,
  target: T,
): void;
```

## Verified properties (E13)

| property | works? |
|---|---|
| RO default at the type level | ✓ |
| Lazy code is safe code (buggy fn caught locally) | ✓ |
| `WritableVec` is structurally a `Vec` (subtype, via `extends`) | ✓ |
| `.value =` rejected on plain `Vec` | ✓ |
| Animators reject RO source | ✓ |
| Animators reject types without required trait | ✓ |
| `"has writable .translate"` shape patterns | ✓ |
| Animators on chain results respect chain writability | ✓ |
| Chain writability propagates correctly through `derive()` | ✓ |
| **Field-lens capability tracking** (`ro.x.value` rejected) | ✓ |
| **Deep field access** (`writable.translate.x.value` accepted, RO rejected) | ✓ |
| Eager method capability propagates (`vec.add(b).scale(2)` is WritableVec) | ✓ |

## How E13 closes the holes that broke E7/E11

**E11 hole** — field-lens capability: `vec.normalize().x` returned
`Writable<Num>` regardless of source. E13 closes this because `Vec.x`
is `Num` (RO base getter) and `WritableVec.x` is `WritableNum`
(overridden getter on the writable subclass). The receiver's actual
class determines which getter is in scope.

**E7 hole** — trait-intersected variance check: TS bypassed `out C`
variance enforcement when intersected with a constraint type. E13
doesn't use phantom-param variance at all — capability is encoded as
a real subclass relationship, which TS handles correctly under
intersection.

**E12 attempt** — `this`-typed methods: would propagate receiver
type through invertible methods. Failed because TS's `this` resolves
to the class type, not arbitrary intersection wrappers around it.
E13 doesn't need `this`-types because each subclass explicitly
overrides return types.

## Cost vs benefit

**E13 vs E11 author cost:** roughly +10 lines per value class for
the `WritableXxx` subclass declaration (override methods, override
field lens getters, accessor pair for `value`). For 6 value classes
in the codebase, ~60 extra lines total.

**Benefit:** the field-lens hole closes. `vec.normalize().x.value =
5` is now a compile error instead of a runtime throw.

## Why E10 was the actual blocking issue

E7 worked in isolation but broke at trait-intersected animators. The
root cause (from `e10-variance-debug.ts`): when TS computes
assignability for `Vec<RO>` against `Signal<T, RW> & SomeTraitMarker<T>`,
the intersection-side constraint check appears to bypass the variance
enforcement from `out C`. We tried:

- Splitting generics (`<T, R extends ...>`): same failure
- R-anchored inference (`<R extends Signal<unknown, RW>>`): same failure
- Separating constraint to its own parameter: same failure
- Switching from `constructor: { ... }` brand to `unique symbol` keys: same failure

The behavior was reproducible across all variations. We concluded TS
doesn't enforce parameter variance across intersection branches in
the way we need.

## Cost summary

**Author cost per value class** (`Num`, `Vec`, `Box`, `Color`, `Matrix`, `Transform`):
- Base class declaration (~10 lines): `static traits`, methods, field-lens getters, `interface X { readonly constructor: typeof X }` merge.
- Writable subclass declaration (~10 lines): `override get value`/`set value` pair, `.set`, `.bind`, overridden invertible method return types, overridden field-lens getter types.
- Chain class (`VecChain<W>` etc.) — already needed phantom W; unchanged from E11.

**Author cost per animator/combinator:**
- Type sig as `(Signal<T> & Writers<T>) & Traits<T, K>`. Generic over the value type, no specific class binding.

**Consumer cost per signature:**
- Read-only: `function foo(v: Vec)` — unchanged.
- Write-needed: `function foo(v: WritableVec)` — one extra word.
- Generic accepting either: `function foo(v: Vec)` — same as RO (`WritableVec extends Vec`).

**Runtime cost:** zero. Subclass relationship is purely type-level; one runtime class per value type.

## Migration estimate

4–6 hours for a real migration:

1. **Engine** (~30 min): split `Signal<T>` getter-only from `WritableSignal<T>` (`= Signal<T> & Writers<T>`). Add `Writers<T>` interface.
2. **Value classes** (~45 min × 6): split each into base + Writable subclass. Mostly mechanical:
   - Move setter, `.set`, `.bind` from base to subclass.
   - Override invertible methods to narrow return type.
   - Override field-lens getters to return writable field types.
3. **Factories** (~10 min total): factory return types switch to `WritableXxx`.
4. **Animators / combinators in `anim.ts` / `multi.ts`** (~30 min): retype constraints.
5. **Consumer sweep** (~1 hour): the ~20 write-needing sites in `shapes/`, `elements/`, etc. switch their sigs to `WritableVec`/`WritableNum`/etc. Most read-only sigs stay unchanged.

## What this gets us in practice

- `spring(sig, target)` and friends statically reject RO sources.
- `Tween` builder, animators, `mean`/`combine` all type-check their inputs.
- Authors of shapes/handles declaring "drag handle for a writable Vec" express that in types.
- "Buggy function that mutates without declaring writable" — caught immediately.
- `ro.x.value = ...` rejected at compile time (closed in E13).
- `writableShape.translate.x.value = ...` accepted — capability flows through field-of-field access.

**No known type holes.** Perfect inference matching runtime truth.

## Quick verification

```bash
npx tsc --noEmit
# e1 is intentionally annotated to show its failure mode (RO via Readonly<> doesn't block .set).
# e7 works in isolation but breaks at trait-intersection level (e9).
# e11 has a field-lens hole (documented in its trade-offs).
# e12 fails — this-types don't propagate intersection wrappers.
# e13 is the production-ready answer.
```
