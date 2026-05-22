# Multi-port lens: broader exploration

## Current landscape (post-cleanup)

| Primitive | Inputs | Outputs | RW | Membership | Closed/Numerical | Notes |
|---|---|---|---|---|---|---|
| `combine(parts, merge, dist)` | static N homogeneous | 1 | yes | static | closed | the OG RW N→1 |
| `mean(...sigs)` | static N | 1 | yes | static | closed (linear-derived) | thin wrapper |
| `mix(Cls, merge)` | static N homogeneous | 1 | **NO** | **mutable** | closed | RO, trait-driven |
| `polar(c, r, a, policy)` | 3 heterogeneous | 1 Vec | yes | static | closed (4 policies) | specialized |
| `hyperLens(ins, fwd, bwd)` | static N heterogeneous | M | yes | static | closed | general N→M |
| `argminNum/Vec(parts, fwd, w, opts)` | static N homogeneous | 1 | yes | static | numerical | LM step |
| `_proto-policy/policyLensVec` | static N | 1 Vec | yes | static | **both (branched)** | **3× slower than hand polar** |

Coverage gaps:
- `mix` doesn't do writeback (the RO/RW split is the main asymmetry).
- No combinator does mutable membership + writeback (probably nobody needs).
- The "both closed & numerical in one fn" approach (policyLensVec) is fundamentally slower.

## Root cause of the perf gap

`policyLensVec`'s bwd allocates per-write:
1. `inputs.map(i => i.peek())` — fresh array of length N
2. `userInverse(target, xs, weights)` returns a NEW array of length N
3. (Numerical path) `Jx[]`, `Jy[]` — two more arrays

Hand-rolled `polar` allocates zero per write — it inlines 2-3 reads and 1-2 writes for each policy.

**Lesson**: a one-fn-fits-all primitive will always pay 2-3× allocation cost because the user's `inverse` callback can't write directly into the source signals; it has to return data structures the wrapper then iterates over. Hand-rolling avoids this by knowing which signals to write at code-generation time.

## What this means for the design space

The "unify closed-form + numerical into one fn" goal is at odds with the "match hand-rolled perf" goal. Pick one:
- **Unified**: simpler API, pays 2-3× alloc overhead, fine for non-hot paths
- **Specialized**: faster paths exist as distinct functions, more API to learn

Most real workloads have:
- A handful of hot lens-shapes (polar in solar-system / orbits, IK in handle-chains) → these should be specialized
- A long tail of ad-hoc multi-input combinators → these can ride on a general primitive even with some overhead

So the practical answer is probably: **keep the hot specialized fns; add a clean general combinator for the long tail.**

## Candidate designs

### Candidate A: Extend `mix` with writeback

Smallest delta from current code. `mix` is already the user's preferred N→1 primitive.

```ts
const blend = mix(Vec, "weighted")           // RO
  .writeback("delta-even")                    // trait-derived: split delta evenly via Linear
blend.add(orbit, { weight: w1 })
blend.value = newVec  // writes delta back to contributors

// Custom:
const blend2 = mix(Vec, customMerge).writeback(
  (next, prev) => /* return new prev values per contributor */
)
```

Trait-driven writeback options (string names):
- `"delta-even"` — `delta = next - cur; new[i] = old[i] + delta` (needs Linear)
- `"replace-first"` — write to first contributor, ignore the rest
- `"proportional"` — distribute by current weight (needs Linear)

**Pros**: builds on existing user-preferred shape. The "mix + writeback" mental model is clean.

**Cons**: mutable membership + writeback has tricky edge cases (what if you write while a contributor was just removed?). The closed-form writeback can't be polar-style (needs heterogeneous inputs).

### Candidate B: Three orthogonal primitives, no super-fn

```ts
mix(Cls, merge)                              // existing RO mutable
combine(parts, merge, distribute)            // existing RW static homogeneous (rename to `meld`?)
hyperLens(inputs, fwd, bwd)                  // existing RW static heterogeneous N→M
argmin(parts, fwd, weights, opts)            // existing numerical
// Specialized fast paths: polar(), etc.
```

Just delete `policyLensVec` (the prototype that proved unification was a perf-loss). Keep the rest.

Optionally extend `mix` with closed-form writeback as a small win on top.

**Pros**: zero perf regression. Each primitive is purpose-built and fast.

**Cons**: doesn't actually "consolidate" anything. The original motivation for unification was reduced API surface — but the bench tells us that surface is earning its keep.

### Candidate C: Lens-as-data with explicit apply

Lenses become first-class values; `apply()` produces reactive cells.

```ts
const polarLens: Lens<[Vec, Num, Num], Vec> = {
  get: ([c, r, a]) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }),
  put: (next, [c, r, a]) => /* per-policy distribute */,
}
const cell = apply([cSig, rSig, aSig], polarLens)
```

**Pros**: lenses are values you can name, test in isolation, compose explicitly. Pure functions easy to reason about.

**Cons**: big API change; same per-write allocation cost (lens.put returns a tuple). Adds a layer without obvious payoff over candidate B.

### Candidate D: Specialized + perf-aware general

A "Tier 1" hand-rolled specialization for hot paths (polar, IK, mean, weighted blend) + a "Tier 2" general combinator for the long tail. The Tier-2 combinator uses allocation-aware tricks (pre-allocated scratch buffers, mutable-callback API for the user) to halve the overhead.

```ts
// Tier 1 (hot): hand-tuned, no allocations.
polar(c, r, a, policy)
ikChain(joints, target, opts)
weightedBlend(parts, weights)   // specialized perf-aware mix-as-lens

// Tier 2 (general, slower): one combinator, allocation-aware.
multiLens(inputs, forward, {
  // bwd can MUTATE its argument; no new array allocation
  inverse(target, mutableXs, weights) { mutableXs[0] = …; mutableXs[1] = …; },
  // numerical fallback uses pre-allocated scratch
  jacobian: "fd",
})
```

**Pros**: 80/20 split — hot stuff stays fast, general stuff exists but cheap to deprioritize.

**Cons**: still two systems. The user has to know which tier their use case fits in. (Real codebases tolerate this — Vue / Solid / etc. all have hot specializations behind ergonomic APIs.)

## My read

After thinking through these:

1. **Candidate B is the honest near-term answer.** The bench tells us unification has a real cost. Keeping specialized fast paths AND a small set of general combinators is the right factoring.

2. **Candidate A (mix.writeback) is a worthwhile small extension.** It builds on the user's existing mix work and fills a real gap (mix → RW). Doesn't try to replace polar/argmin.

3. **Candidates C and D are over-engineering for what we have.** Lens-as-data is interesting library design but no use case demands it. The Tier-1/Tier-2 split codifies what already exists informally.

So my recommendation: **A + B**. Extend `mix` with a writeback chain (`.writeback(fn | "delta-even" | ...)`). Delete `_proto-policy`. Keep `combine`, `hyperLens`, `argmin*`, `polar` as they are. Maybe rename `combine` → `meld` (since `mix` and `meld` are nicely paired — RO vs RW versions of the same idea).

## What's worth prototyping concretely

- `mix.writeback(...)` extension on `mix.ts`. With both trait-driven options and a custom-fn escape hatch. Tests covering: re-fires effects on writeback; correct delta distribution; handles add/remove correctly.
- A targeted perf bench comparing `mix(Vec, "weighted")` write vs hand-rolled equivalent and vs current `mean(...)` write. Shows the perf is at parity (not worse than mean) and the API is nicer.
- A `meld` alias for `combine` (or just rename) so the RO/RW pair has matching names.

## What NOT to do (resolved)

- Don't ship `policyLensVec` — it conflates closed + numerical and pays 3× alloc cost.
- Don't pursue the lens-as-data refactor — costs too much for what it buys.
- Don't try to absorb `polar` into a general primitive — it's a hot path that warrants hand-tuning.
