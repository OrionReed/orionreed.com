# Multi-port lens unification — design sketch

The codebase has accumulated five primitives that share the
"N inputs → M outputs with optional per-output backward policy" shape:

```
combine(parts, merge, distribute)       N→1 same-type, closed-form bwd
mean(...sigs)                           N→1 same-type, linear-derived bwd
hyperLens(inputs, fwd, backward)        N→M with per-output policy
policyLensVec(inputs, fwd, weights, opts)  N→1 Vec, closed-form OR jacobian
argminNum/argminVec                     N→1, numerical jacobian + weights
polar(c, r, a, policy)                  3-input → Vec, 4 policy variants
```

The `_proto-policy` prototype already shows that `polar` and `argminVec`
collapse to one primitive with the same semantics. The question is
what the GENERAL shape should be.

## Three candidate API shapes

### Candidate A: One mega-primitive (super-options)

```ts
function multiLens<Ins, Outs>(
  inputs: Ins,                           // array or object of writable cells
  forward: (vs: ValuesOf<Ins>) => Outs,  // forward fn
  opts?: {
    inverse?: PartialPolicy<Outs, Ins>;     // per-output closed-form bwd
    jacobian?: "fd";                        // numerical fallback
    weights?: number[];                     // per-input absorption
    clampTarget?: (target, current) => target;  // pre-write hook
    wrap?: { [K in keyof Outs]?: ValueClass };  // output value-class wraps
  },
): { [K in keyof Outs]: WrappedCell };
```

Pros: one entry point, fully expressive, learn-once.
Cons: option soup; output type-system gets gnarly (PartialPolicy +
conditional WrappedCell); easy to misuse (passing jacobian + inverse
for the same output is undefined).

### Candidate B: Three primitives by use-case

```ts
combine(parts, merge, distribute)
multiLens(inputs, forward, inverse, wraps?)   // closed-form N→M
jacobianLens(inputs, forward, weights, opts?) // numerical N→M
```

Pros: each is clearer about its semantics; no option-soup; type
signatures are sane.
Cons: slightly more API surface; users need to know which one to pick
(but the choice is "do I have a closed-form inverse?" — easy).

### Candidate C: Compose smaller primitives

```ts
// Lens as data:
type MultiLens<Ins, Outs> = {
  get: (vs: ValuesOf<Ins>) => Outs;
  put?: (next: Outs, prev: ValuesOf<Ins>) => ValuesOf<Ins>;  // optional inverse
};

function apply<Ins, Outs>(inputs: Ins, lens: MultiLens<Ins, Outs>): WrappedCellOutputs;

// Numerical fallback as a wrapper:
function numerical<Ins, Out>(
  forward: (vs) => Out,
  weights: number[],
): MultiLens<Ins, Out>;  // synthesizes a `put` via Jacobian

// Compose: chain multiple multi-lenses sequentially
function compose(...lenses): MultiLens;
```

Pros: orthogonal building blocks; the closed-form vs numerical
distinction is "which lens you construct" rather than an opt; lenses
become first-class values that can be passed around, composed, named.
Cons: more pieces; no single "do the whole thing" call — but that's
the point.

## Open questions for each

### Output shape

All three handle N→M, but the output shape differs:
- A: nested object/record
- B: explicit `wraps` argument per output
- C: lens-as-data records its own output shape

The natural call site for `polar` wants ONE Vec output, not a record.
Calls that want N→M (e.g., decomposing a Vec into r+θ) want named
outputs. So either:
- Distinguish N→1 and N→M in the API (B does this via separate fns).
- Always return records, and add sugar for N→1 (A: `outputs.value` if
  Outs is a single-output type).
- Lens declares its own arity (C: `MultiLens<Ins, Outs>` where Outs
  can be Single<T> or Multi<{...}>).

### Output type-awareness

Each lens output needs a value class for the user-facing wrapper.
Today, `polar` hardcodes Vec; `combine` infers from `parts[0].constructor`.

Candidates A/B explicitly pass `wraps`. C bakes it into the lens type
(`MultiLens<Ins, Outs, OutWraps>` would be a 3-param type — getting
complex).

### Per-input weights vs per-output policy

These are conceptually different and possibly orthogonal:
- weights: "input i absorbs k× of any residual" (per-input scalar)
- policy: "when output O is written, here's how to redistribute" (per-output fn)

Today's `polar` uses BOTH (policies are weight patterns: rotate =
[0,0,1,1] etc.). Maybe weights ARE per-output policies, just degenerate.

C's compose-orthogonal design suggests: weights and policies are
distinct lens kinds. `weightedLens(weights)` and `policyLens(fns)`
are siblings, both implementing `MultiLens`.

### Forward-only outputs (RO)

Today's `hyperLens` lets some outputs be RO (no policy). A/B encode
this via partial inverse. C: lens with `put: undefined` is RO.

### Composition

Can a `multiLens` output feed into another `multiLens`? Yes, but the
wrapping semantics get fiddly. C's compose addresses this naturally;
A/B don't.

## Recommendation

**Candidate B** (three primitives) for the migration. Reasons:

1. Each primitive's type signature is clean and TypeScript can infer it.
2. Closed-form vs numerical IS a real distinction the user makes at
   the call site — putting them in different fns surfaces that.
3. Migration from current code is mechanical (existing primitives map
   1:1 to `combine` / `multiLens` / `jacobianLens`).
4. The lens-as-data abstraction (C) is interesting but is a deeper
   library design choice that's better made AFTER the consolidation,
   not as part of it. We can always refactor B's three primitives to
   share a lens-as-data backend later without breaking the surface.

Concrete migration after picking B:
- `combine`, `mean` (already correct) — kept as-is.
- `polar` → wrapped in `multiLens` with closed-form inverse, 4 policy
  variants become 4 weight choices.
- `argminNum` / `argminVec` → `jacobianLens` calls.
- `hyperLens` → `multiLens` (since hyperLens already takes closed-form
  per-output policies).
- `policyLensVec` → delete (was a prototype that merged the closed +
  numerical paths into one fn; under B that's two fns).

Estimated LoC delta: ~300 lines deleted (multi.ts + hyper.ts + argmin.ts
+ proto-policy + ~half of vec.ts's polar).

## Perf concern (from the existing prototype bench)

The existing `policyLensVec` prototype shows polar-via-policy is
**~3× slower** on writes than hand-rolled `polar` (0.33µs vs 0.08µs).
That's the gap to close before consolidating. Suspects:
- per-write `inputs.map(i => i.peek())` allocation
- per-write `forward(xs)` re-computation under untracked subs

Profile before migration. The shape should NOT regress production
polar (which is used in animation hot paths).

## What this design pass DOES NOT settle

- Cross-type lensTo integration: should `multiLens` outputs be
  wrappable in arbitrary value classes? Yes, via the `wraps` arg.
  But that means the lens primitives need to know about the wrapper
  class system. Slight coupling — probably fine.
- Lens-laws verification on multiLens: each output should be
  individually law-checkable (PutGet/GetPut/PutPut). The laws
  framework should extend to per-output testing.
- Fusion across multi-lenses: today `.through` fuses; should
  `.through.through.multiLens.through` fuse across the multi-lens
  boundary? Probably not — multi-lenses are structurally different
  from endo-lenses. Document the boundary.
