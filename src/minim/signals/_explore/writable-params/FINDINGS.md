# Writable Parameters — Findings

> *Prototype completed: 7 test files, 89 tests, all green. Full project
> suite (1343 tests) green. Project typecheck clean.*

## Bottom line

**The hypothesis holds.** Writable parameters can be added to the
existing engine without new types, without new footgun classes beyond
what's currently possible, and without breaking the "writability ⇒
acyclic-by-construction" guarantee. The exception is one well-known
class of unsoundness (the *asymmetric diamond*), which is detectable at
construction.

## What the prototype demonstrates

The engine already supports the mechanism, just with no surface API for
it. `Cls.lens([parents], fwd, bwd)` accepts a `Partial`-style bwd that
emits `undefined` for any cell it doesn't want to update; `_fanin`
already does `if (u === undefined) continue` and otherwise calls
`parent._setWithExclusion(...)` inside a `batch()`. The contribution of
the prototype is a thin factory layer (`wp.ts`, `wp-auto.ts`) that
exposes this through ergonomic shapes:

- `vecRightW(a, n)` — the canonical vec-with-slack.
- `numAddW(a, b, weight=0.5)` — weighted sum, fully bidirectional.
- `numWithSlack(a, slack)` — a anchored, slack absorbs all writes.
- `clampStretch(t, lo, hi)` — clamp where out-of-range writes expand
  the bound (lo or hi absorbs).
- `clampSlide(t, lo, hi)` — clamp where out-of-range writes translate
  the window (lo and hi shift together).
- `rightAuto(a, n)` — polymorphic dispatch: literal/RO → today's
  read-only behavior; writable → wp behavior. Same return type.

## Invariant verification

### Invariant A: "identical footguns to normal signals"

**Confirmed.** The ONLY way to spell a cycle through pure lens +
value-method composition is via `effect()` (or `network()`), exactly
as today. Verified by adversarial construction in `footguns.test.ts`
HUNT 7 and `scenarios.test.ts` ACYCLICITY: every parent in a writable
lens must already exist at the moment of construction; expression order
forces strictly-upstream parent relations; the parent relation forms a
DAG by structural induction on construction. Writable-param promotion
does not change *when* a cell exists, only what the bwd is *allowed* to
do with it.

### Invariant B: "types infer writability automatically"

**Confirmed.** `vecRightW(a: Writable<Vec>, n: Writable<Num>)` returns
`Writable<Vec>` by signature. The chain stays writable through any
subsequent `.right(5)` / `.scale(k)` / etc. that itself returns
`Writable<...>`. `Vec.derive(...)` continues to collapse to read-only.
The polymorphic `rightAuto` returns `Writable<Vec>` regardless of the
param flavor, exactly as the user envisioned. The TypeScript type
signature `Cls.lens([parents], fwd, bwd)` already uses the right shape:
`{ [K in keyof P]?: V }` for the bwd return, which honors the partial-
intention semantics natively.

The `@ts-expect-error` markers in `types.test.ts` verify that the
type system still rejects:
- Assigning to a `Cls.derive(...)` cell.
- Passing a literal `number` to `vecRightW`'s `Writable<Num>` slot.
- Passing a `Read<Num>` (from `Num.derive`) to `vecRightW`'s
  `Writable<Num>` slot.

## What did NOT break the world

Across 89 prototype tests, the following ran cleanly and consistent
with the rest of the engine:

| Scenario | Result |
| --- | --- |
| Simple `vecRightW(a, n)` | PutGet, GetPut, PutPut all hold |
| 5-level cascading wp chain | One-pass propagation, correct values |
| 100-level cascading wp chain | No stack overflow, correct |
| 1000 sibling lenses sharing one writable param | All re-derive correctly |
| Shared writable param across two `vecRightW` instances | Drag one, other follows — exactly like sharing a signal |
| Writable param that's itself a lens (`raw.scale(2)`) | Bwd cascades cleanly through both layers |
| Lens output read by effect; bwd writes to a shared param | Effect re-fires; values consistent |
| Symmetric diamond (two views of same root, even weights) | Accidentally PutGet-correct (intentions converge) |
| Glitch-free observation across batched multi-cell writes | One observation per batch; never mid-update |
| Bwd that calls `signal.peek()` for non-parent context | No dep leak; behaves as today |
| Bwd that calls `signal.value` for tracked-read | No dep leak (bwd runs outside reactive context) |
| Stale source-value reads inside bwd | None — bwd receives fresh snapshot via the engine's `vals` param |
| Re-entrant write inside `fwd` | Same as today's footgun |
| Side effect inside `bwd` (e.g., counter increment) | Same as today's footgun |
| Effect on writable param that watchdogs the value | Composes cleanly |
| Lossy bwd (clamp absorbs out-of-range writes) | PutGet violated, as documented for any lossy lens; nothing new |
| Pretend-writable RO signal (cast hack) | Engine throws clearly at write time |

## The ONE confirmed footgun

### The asymmetric diamond

When a writable lens has two parents that are **distinct lens views of
the same primitive**, and the bwd splits the write asymmetrically
between them, the two intentions for the underlying primitive disagree.
Last-write-wins decides. PutGet is violated.

```ts
const raw = num(10);
const view1 = raw.add(0);   // identity lens on raw
const view2 = raw.add(0);   // ANOTHER identity lens on raw
const sum = numAddW(view1, view2, 0.8);  // 80/20 split
sum.value = 30;             // intentions: view1 := 18, view2 := 12
// view1 → raw := 18; view2 → raw := 12; last wins → raw = 12
expect(sum.value).toBe(24); // NOT 30. PUTGET VIOLATED.
```

This is the classical *lensProduct* unsoundness from Haskell `lens`
(see `Control.Lens.Unsound`):

> "A lens product. There is no law-abiding way to do this in general.
> Result is only a valid Lens if the input lenses project disjoint
> parts of the structure."

When the parents are projections of the same source and the bwd writes
both, you have the lensProduct shape. The diamond is **detectable at
construction**: walk each parent's transitive root set and check for
intersection. The engine doesn't do this today but could.

The symmetric version (`weight = 0.5` on two identity views of the
same root) happens to satisfy PutGet by construction-coincidence —
both intentions are equal. Don't lean on this; it's not a property of
the framework, it's a property of that specific weight choice.

### Severity

- **Local reasoning preserved?** YES. The shape is visible in the lens
  construction: same primitive appearing transitively in two parents.
- **Surprising on first encounter?** YES. Most users don't think about
  diamond patterns when constructing lenses.
- **Detectable?** YES. Static check over the parent set.
- **Mitigatable?** YES. Either warn/throw at construction, or
  commit to merge semantics (sum gradients, last-write-wins,
  whatever) and document.

### Comparison to today

Without writable params, the diamond pattern is harder to spell
accidentally — you'd have to explicitly use the multi-input
`Cls.lens([...], ...)` factory with overlapping parents. The
single-source path that produces today's source-method lenses
(`a.right(n)`, `t.clamp(lo, hi)`) doesn't admit this case at all
because params are read-only.

Promoting params to writable opens this hole. It's the same hole every
multi-input bidirectional system has (backprop with weight sharing
solves it via gradient accumulation; partial-state lenses solve it via
merge intentions; we'd resolve it via batched last-write-wins or
explicit merge).

## Recommendation

Ship it, with three concrete moves:

1. **Add the polymorphic factory layer** — make every existing
   source-method lens optionally writable-param at the call site, by
   detecting whether the passed param is writable at runtime. The
   `rightAuto` prototype shows this is a 20-line pattern. Returns
   the same `Writable<…>` type regardless. Zero new types.

2. **Static diamond detection** — at construction, walk the transitive
   root set of each parent of a writable lens; if any two intersect
   AND the bwd writes to both, warn (or throw under
   `strict-diamonds` mode). Bun-cheap; one-time cost at construction.
   Probably worth landing as a lint that's opt-in rather than a hard
   error, because some diamonds are intentional (symmetric case
   converges; users may want the "last write wins" semantics
   explicitly).

3. **Document the law tier** — every wp lens factory should declare
   which laws hold. From the prototype:
   - `vecRightW`, `numAddW`, `numWithSlack`: PG + GP + PP. Very-well-
     behaved.
   - `clampStretch`, `clampSlide`: PG + GP. PP fails (writing 100,
     then 50, leaves hi at 100 then 50 — different from writing 50
     directly which leaves hi at 10). Same as today's `clamp`.
   - Any `lensW` with overlapping parents: PG depends on bwd
     symmetry. Document explicitly.

## What stays the same

- The complete API surface of read-only-param lenses (`.right(n)`,
  `.scale(k)`, `.clamp(lo, hi)`, etc.) is untouched.
- The 1343 existing tests pass without modification.
- The TypeScript surface for `Cls.lens([parents], fwd, bwd)` already
  encodes the correct shape — no signature changes.
- The engine's batched-propagation, self-exclusion, equality-checking,
  and read-tracking machinery handles all of this without modification.

## What changes

- New factory functions (`vecRightW`, `numAddW`, ...) that take
  `Writable<…>` parents and emit intentions for them in the bwd.
- Optionally: a polymorphic dispatch layer (`rightAuto`-style) that
  unifies the read-only and writable-param call sites under one name.
- Optionally: a static diamond detector at construction time.

## Open questions

1. **Naming**: `vecRightW`, `numAddW` is one convention; `rightAuto`,
   `addAuto` is another. The latter is more inviting but obscures the
   semantic difference; the former is explicit but doubles the API
   surface. The polymorphic dispatch path makes either viable.

2. **Default bwd policy for "obvious" wp variants**: For `vecRightW`,
   does the param absorb 100% of the x-delta (current), 50/50 split,
   or proportional to some weight? The prototype uses 100% absorption
   as the "intuitive" choice (n IS the offset; dragging the lens
   should slide n). An optional `weight: number` parameter covers the
   spectrum.

3. **Should the lens designer be able to declare per-param weights at
   construction time, with weights as `Val<number>` (reactively
   parametrised)?** This is the natural extension. From the previous
   chat: yes, and it gives us "policy as a cell". The factory shape
   for that is straightforward but adds one new method per shape.

4. **`Cls.lens` symmetric variant**: the engine has
   `SymmetricLensSpecN` for complement-tracking. Writable-param lenses
   in their stateless form don't need it; but for lenses where the
   write IS lossy (the clamp-stretch family), the complement could
   record which bound was last stretched. Out of scope for the
   prototype; named here as future work.

## Final assessment

The user's intuition was correct on every count:

- Invariant A (identical footguns) is preserved. The only NEW
  footgun-shape (asymmetric diamond) is structurally identical to
  `lensProduct` from Haskell `lens`, requires no non-local reasoning
  to detect, and is straightforwardly addressable.
- Invariant B (writability inferred) is preserved verbatim. No new
  types are needed. The engine's `Partial`-style bwd return type
  already encodes the right shape.
- Composition works. Lenses with writable params compose with each
  other and with classical RO-param lenses without surprise.
- Glitch-freedom is preserved. The existing `batch` + self-exclusion
  + equality-checking machinery handles every scenario tested.

This is the "unoccupied corner" we identified earlier. It's reachable
with a few hundred lines of factory code, zero engine changes, and
one well-known caveat. Ship it.
