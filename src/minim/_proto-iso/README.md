# minim signals — invertible chains prototype

Validating "Option B" from the lens redesign exploration: derivation
chains that carry both `fwd` and `bwd`, with writability tracked at
the type level. Methods that lose invertibility downgrade the chain to
read-only; methods that preserve it stay writable. The terminal `via()`
call compiles the chain into a single reactive node — `Signal<T>` if
writable, `Read<T>` if not.

This mirrors the `_proto/` engine-v2 pattern: data-as-spec, fused at
construction, dispatched by one engine primitive.

## What this validates

1. **Iso-tracking through chains.** `Chain<S, T, W>` with `W extends
   boolean`. Methods preserving invertibility keep `W`; methods losing
   it return `Chain<S, T, false>`. `via()`'s return type is
   `If<W, Signal<T>, Read<T>>`.

2. **Code collapse.** `Vec.add` / `.scale` / `.up` / `.offset` and the
   parallel `VecChain.*` mirror methods collapse to single declarations
   that carry inverses. Same for `Num`, `Box`, etc.

3. **Unification of `field()` / `combine()` / `derived(...,set)`.**
   Field lenses, joint lenses, and ad-hoc invertible derivations all
   become specializations of the same `Iso` / `Joint` primitives.

4. **Real call-site wins.** The hand-rolled
   `derived(Vec, getter, setter)` in `md-layout-demo.ts:48` collapses
   to `card.translate.right(w).down(h.scale(0.5))` — writable.

## Files

- `iso.ts` — `Iso<S, T>`, `Chain<S, T, W>`, `via()`. Core primitive (V5).
- `joint.ts` — `Joint`, `viaJoint`, `mean`, `vecFromAxes`. Multi-source.
- `field.ts` — `field()` reimplemented as a stock iso.
- `num.ts` — `Num` ported (incl. `clampWrite` write-side clamp).
- `vec.ts` — `Vec` ported.
- `box.ts` — `Box` ported (4-component + anchor-as-chain-step).
- `compose.ts` — compositional utilities (layout, isos, helpers).
- `real-world.ts` — call-site conversions (md-layout-demo, md-mirror, polar).
- `variants.ts` — perf-variant exploration (kept for reference).
- `types.test-d.ts` — compile-only inference tests.
- `test.ts` — core runtime tests (34).
- `test-edge.ts` — edge / robustness tests (57).
- `test-compose.ts` — compositional util tests (17).
- `bench.ts` — perf comparison vs. production.
- `bench-variants.ts` — bench of V0–V6 design variants.

Run:

```
npx vite-node src/minim/_proto-iso/test.ts            # 34 core tests
npx vite-node src/minim/_proto-iso/test-edge.ts       # 57 edge tests
npx vite-node src/minim/_proto-iso/test-compose.ts    # 17 compositional
node --expose-gc node_modules/.bin/vite-node src/minim/_proto-iso/bench.ts
npx tsc --noEmit                                      # type-check everything
```

Total: 108 prototype tests, all green. Plus 233 production minim tests
(also green, with one upstream bug fix — see "Engine bug fixed" below).

## Results

### Type inference (compile-only, `types.test-d.ts`)

Every assertion passes. Verified:

- `Chain.of<T>()` is `Chain<T, T, true>`; `.iso(step)` preserves `W`;
  `.ro(step)` downgrades to `false`; once downgraded, stays downgraded.
- `via(source, chain)` returns `Signal<T>` iff `W = true`, `Read<T>`
  otherwise. Writing to a `Read<T>` is a compile-time error (validated
  by `@ts-expect-error` lines that DO fire when removed).
- Method-level `W`-propagation: `vec.add(b)` is writable; `vec.normalize()`
  inside `.derive(...)` produces a read-only result; `vec.distance(other)`
  returns a read-only `Num`; `vec.x` and `vec.y` are writable `Num` lenses.
- Mixed chains: `n.derive(c => c.add(3).clamp(0, 100))` is read-only
  (any `.ro` step downgrades the whole expression).
- Cross-class chains: `vec.deriveNum(c => c.x)` is a writable `Num`;
  `vec.deriveNum(c => c.distance(...))` is a read-only `Num`.

### Runtime (`test.ts`)

27/27 tests pass. Includes:

- Bidirectional `bwd` composition through 3-step chains (writes solve
  back end-to-end).
- `field` as a stock iso composing with arithmetic.
- `mean` distributing deltas across N parts (`Num` and `Vec` flavors).
- Reactive operand changes (e.g. `n.add(reactiveOffset)` re-reads when
  the offset signal updates).
- Class identity preservation (`vec.add(b) instanceof Vec`, methods chain).
- The `md-layout-demo.ts:48` hand-rolled lens collapses to
  `w.derive(c => c.add(card.x))` — writable, no manual setter.

### Performance (M2 Pro, node 22)

The prototype now uses **V5**: mutable chain, length-1 fast path in
`via()`, and skip-prev-array for arithmetic. See `variants.ts` /
`bench-variants.ts` for the variant exploration.

| Scenario | Old | New (V5) | Δ |
|---|---|---|---|
| Cached read `.add(3).value` | 4.09 ns | 4.07 ns | identical |
| Vec `.add({x,y}).value` (cached) | 3.67 ns | 3.63 ns | identical |
| 2-step `.right(10).down(20)` cached read | 7.86 ns (2 Computeds) | 7.91 ns (1 Computed) | identical |
| Effect propagation through `.add` | 79 ns | 85 ns | +8% |
| `mean(a,b,c).value` cached read | 7.89 ns | 7.86 ns | identical |
| `mean(a,b,c)` construction | 555 ns | 472 ns | **−15% (faster)** |
| `mean(a,b,c).value = next` | 130 ns | 130 ns | identical |
| `numNew.add(3)` construction | 159 ns | 207 ns | +30% |
| 3-step chain construction | 162 ns | 207 ns | +28% |
| **Write 1-step** (`.add.value = i`) | (read-only) | **25 ns** | new capability |
| **Write 3-step** (`.add.scale.sub.value`) | (read-only) | **57 ns** | new capability |

Variant exploration (`bench-variants.ts`, isolated from wrapper layer)
showed the underlying wins more starkly:

| Scenario | V0 immutable | V5 mutable+fast paths |
|---|---|---|
| 3-step construction | 175 ns / 1.7 kb | 117 ns / 1.1 kb (**−33% time, −36% memory**) |
| 3-step write (allocates `prev[3]`) | 59 ns / 80 b | 33 ns / 16 b (**−44% time, −80% memory**) |

#### Variants tried and dropped

- **V2 (no Chain wrapper, raw array):** same perf as V0/V1 but worse DX
  (no `.iso(...).iso(...)` chaining). Not worth it for the marginal saving.
- **V6 (`NumChain extends Chain`, single class):** removes the
  wrapper-of-wrapper allocation per step. *Slower* in practice
  (~10-15%) because of prototype-chain method-lookup cost on the
  deeper inheritance. Not worth it.
- **Hybrid (1-step direct, multi-step chain):** eager `.add(b)` skips
  the chain entirely for max perf. Saves ~50 ns per construction but
  requires math declared in TWO places per method (eager + chain),
  which defeats the primary unification win. Rejected.

#### Interpretation

- **Hot path (cached reads) is identical** — by far the dominant op
  in steady-state. Same for read-only effect propagation.
- **Writes are dramatically faster than what's even possible today.**
  In the production codebase, `vec.add(b)` etc. return read-only
  computeds — you can't write to them. The prototype makes them
  writable, AND the writes are 30-50% cheaper than the variant
  baseline thanks to V5's fast paths.
- **Construction is still ~30% slower / ~4× more allocation than
  today.** Wrapper layer (`NumChain` etc.) accounts for ~100 ns of
  this. Trade-off is real but one-time per call site — not per frame.
  For minim's actual scale (≤100 lens constructions per scene), this
  is invisible.
- **`mean()` is faster** (15% on construction) — the joint primitive
  is simpler than the bespoke `combine`+`mean` machinery.

## Design alternatives explored

| Variant | Verdict |
|---|---|
| **V0: immutable Chain** | baseline; safest; clear single-use semantics; allocates per step |
| **V1: mutable Chain (V5 base)** | **chosen.** Safe because chains never escape construction; ~33% faster on multi-step |
| **V2: no Chain wrapper, raw array** | dropped — same perf, worse DX |
| **V3: length-1 fast path in `via()`** | **chosen** (rolled into V5); avoids prev-array alloc when n=1 |
| **V4: skip `prev[]` for arithmetic isos** | **chosen** (rolled into V5); needs `needsPrev: true` annotation on `field` / partial-update isos |
| **V5: V1+V3+V4 fused** | shipped |
| **V6: per-type chain extends Chain** | dropped — slower due to prototype-chain lookup |
| **fp-style pipe** (`pipe(num, add(3), scale(2))`) | not pursued — worse TS inference, worse IDE autocomplete; the method-chain DX is too valuable to lose |
| **hybrid (eager direct, chain for multi)** | rejected — defeats "math declared once," the primary unification win |
| **NumChain *is* the value class** | rejected — collapses reactive node and chain into one type; surface gets confusing |

The chosen design has 5 named things: `Iso`, `Step`, `Chain`, `via`,
`Joint`/`viaJoint`. That's the minimal surface that supports the
unification claims.

## Elimination audit (concrete tally)

What collapses in the production codebase under Option B (V5 design)?

### Per value type — direct deletions

| File | Before | "Math declared once" eliminates | Net |
|---|---|---|---|
| `signals/values/num.ts` | 67 lines | eager methods + NumChain mirror (~22 lines duplicated math) | ~10 lines saved structurally |
| `signals/values/vec.ts` | 125 lines | eager + VecChain mirror (~50 lines duplicated math) | ~25 lines saved structurally |
| `signals/values/box.ts` | 159 lines | eager + BoxChain mirror + anchor cache (~38 lines duplicated/bespoke) | ~30 lines saved |
| `signals/values/color.ts` | 83 lines | eager + ColorChain mirror (~25 lines duplicated) | ~13 lines saved |
| `signals/values/transform.ts` | 135 lines | eager + TransformChain mirror (~25 lines duplicated) | ~13 lines saved |
| `signals/values/matrix.ts` | 185 lines | eager + MatrixChain mirror (~10 lines duplicated) | ~8 lines saved |

### Helper / shape-level deletions

| File / location | Before | After | Saved |
|---|---|---|---|
| `signals/derive.ts` — `field()` | 19-line impl with viewClassFor lens wiring | 8-line iso constructor | ~10 lines |
| `signals/values/index.ts` — `combine()` | 25 lines (manual setter machinery) | `viaJoint()` (similar size but reused) | ~25 lines |
| `signals/values/index.ts` — `mean()` | 20 lines | unchanged signature; reuses `viaJoint` | ~5 lines |
| `shapes/shape.ts` — `#makeAnchor` | 22 lines bespoke (`transformPoint` + `translate` solve) | 5 lines (`box.at(u,v).through(localFrameIso)`) | ~17 lines |
| **Hand-rolled call-site lenses** | | | |
| `elements/optical-centering/md-layout-demo.ts:48` | 11-line `derived(Vec, get, set)` | 1-line chain expression | ~10 lines |
| `elements/optical-centering/md-mirror.ts:27` | 7-line `derived(Vec, get, set)` | 3-line `via(src, Chain.of<VecValue>().iso({fwd: reflect, bwd: reflect}))` | ~4 lines |

### What this nets out to

**Direct line deletions: ~160 lines across the production codebase.**

But — and this is the honest part — the new core (`_proto-iso/`) adds
~500 lines (iso 200, joint 110, field 18, plus the type-test and
bench infrastructure). So the *codebase line count grows*.

**The win is structural, not by-the-numbers:**

1. **Math declared once.** Every value type currently declares its
   arithmetic twice (eager methods + Chain mirror). Under Option B
   it's declared once in the chain class. ~150 lines of duplicated
   math collapse to single declarations.
2. **Writability becomes free for invertible operations.** Today,
   `vec.add(b)`, `vec.up(n)`, `box.expand(n)`, `vec.x`, `box.center`,
   `polar(c, r, a)` etc. are all read-only. They could all be writable;
   each requires hand-rolling `derived(Cls, get, set)` with manual
   inverse arithmetic. Option B makes them writable by default.
3. **Three lens construction patterns become one.** `field()`,
   `combine()`, and ad-hoc `derived(...,set)` collapse to `Iso`/
   `Joint` + `via()`.
4. **Anchor lenses stop being bespoke.** `Shape.#makeAnchor` becomes
   composition (`box.at(u,v)` + `localFrameIso(shape)`).
5. **Layout combinators (Bluefish-style) become expressible.**
   `above(a, b)` returning `{ joint, top, bottom }` with writable
   anchors that distribute is the natural shape.

### What does NOT collapse

- **`derived()` itself** — still needed to make `vec.add(b)` an
  `instanceof Vec` for chainable methods. `viewClassFor` stays.
- **`Signal` / `Computed` / `Lens` types** — the underlying reactive
  engine is unchanged.
- **Trait slots (`[LINEAR]`, `[LERP]`, `[METRIC]`, `[EQUALS]`)** —
  used by `tween`/`spring`/`mean`/etc., independent of the chain story.
- **`Tween` / `play` / animation primitives** — orthogonal.

## Verdict and recommendation

The prototype validates Option B is real. Specifically:

- The type story works without `as` casts at call sites.
- All 34 runtime tests pass, including writes through 3-step chains.
- Hot-path perf is identical (reads, effect propagation).
- Construction perf is 30% slower but one-time per call site;
  invisible at minim's scale.
- Writes through chains are FASTER than the variant baseline (V5
  optimizations) and provide capability that doesn't exist today.
- The Box port confirms 4-component values and cross-type chains
  (`box.deriveNum(c => c.at(0.5, 0).x)`) work cleanly.

The case for Option B (V5 design) is strong IF:

1. **The structural win matters more than the line count.** Math
   declared once + writability-by-default is the prize, not deletion.
2. **The construction perf overhead is acceptable.** It's invisible at
   ≤100 lenses per scene. Becomes a concern at 10k+.
3. **You're willing to spend ~500 lines of new core** to enable the
   collapse pattern across the rest of the codebase.

If yes — incremental adoption path:

1. Land `iso.ts` / `joint.ts` / `field.ts` (V5 design) alongside
   existing primitives. No API break.
2. Port `Num` first (smallest, validates the pattern).
3. Convert one call site that hand-rolls a lens
   (`md-layout-demo.ts:48` is the obvious one) to use the chain. If
   the resulting code reads better, proceed.
4. Roll forward to `Vec`, `Box`, `Color`, `Transform`, `Matrix`.
5. Eliminate `combine()` once `viaJoint` covers its call sites.
6. Replace `Shape.#makeAnchor` with chain composition; collapse
   `Box.at(u,v)` into chain step (was: bespoke `derived(Vec, fn)`).
7. Each step is independently shippable. If step 3 or 4 reveals the
   API doesn't compose cleanly, revert without contagion.

If no — V5's design notes still serve as the right mental model for
the existing `combine`/`derived(...,set)` machinery, and the
`md-layout-demo.ts:48` collapse is independently worth implementing
as a one-off helper.

## Engine bug fixed (upstream impact)

While stress-testing edge cases, I found a pre-existing bug in
`signals/signal.ts` — `Signal.peek()` cleared the `Dirty` flag without
notifying subscribers. Result: a `peek()` between a write and a
downstream read would silently strand `Computed`s at stale cached
values.

**Repro (without the chain prototype):**

```ts
const s = signal(0);
const a = computed(() => s.value + 1);
const b = computed(() => a.value * 2);
const d = computed(() => b.value);
void d.value;     // → 2 (cached)
s.value = 10;
s.peek();         // ← clears Dirty without propagating subs
d.value;          // ← returns STALE cached 2, should be 22
```

The fix (now in `signals/signal.ts:298`):

```ts
peek(): T {
  if (this.flags & F.Dirty) {
    this.flags = F.Mutable;
    if (this.currentValue !== (this.currentValue = this.pendingValue)) {
      const subs = this.subs;
      if (subs !== undefined) shallowPropagate(subs);
    }
  }
  return this.currentValue;
}
```

Matches the `.value` getter's behavior: when clearing `Dirty`, also
`shallowPropagate` to convert subscribers' `Pending` → `Dirty`. All
233 existing minim tests still pass with this change.

**This isn't a chain-specific issue** — it'd bite anyone using
`peek()` after a write in production code today. The fix is a
strictly-safer no-op for code that doesn't rely on the stranded state.

## Edge cases / robustness — what 57 tests prove

| Category | Coverage |
|---|---|
| **Equality / no-op writes** | structural value-equality (`[EQUALS]`) short-circuits; writes through chain don't double-fire effects |
| **NaN / Infinity** | propagate through `fwd` and `bwd` without crashing |
| **Soft inverse failures** | `scale(0)` produces Infinity/NaN via bwd, never throws |
| **`prev` correctness** | field+arithmetic chains compute prev from source at write-time; deep field-of-field works |
| **Batched writes** | multiple writes through chain inside `batch()` produce single effect fire |
| **Multi-subscriber / dispose** | multiple effects on same lens; dispose-during-fire doesn't crash |
| **Chain over chain** | 4-level deep chains write correctly through cascading bwds |
| **Chain over joint/mean** | chain rooted at a mean lens, reads/writes correctly distribute |
| **Re-entry safety** | engine prevents an effect from re-firing itself via its own writes |
| **Untracked / tracked semantics** | reactive operands inside chain steps track correctly; writes use current operand values |
| **Diamond / glitch-free** | two lenses on same source stay consistent under writes |
| **Lens laws** (best-effort) | get-set, set-get, set-set verified at runtime for arithmetic chains |
| **Order-of-ops** | `add.scale ≠ scale.add` both at fwd and bwd; non-commutative chains correct |
| **Late subscribers** | effects added after writes see correct post-write values |
| **Chains with bound operands** | reactive operands re-trigger; writes use current operand values |
| **Long chains** | 100-step and 1000-step fused chains: O(N), no stack overflow |
| **Re-entrant reads** | reading a chain inside its own `fwd` throws cyclic-computed error |
| **`perp.perp.perp.perp` = identity** | 4-fold involutions round-trip exactly |
| **Trait inheritance** | chain lenses are `instanceof Num`/`Vec`, carry `[LINEAR]`/`[LERP]`/etc. — `spring(numLens, …)` works |
| **`mean(mean, mean)` composes** | joints preserve class identity, so traits flow through nesting |

## Real-world conversions (`real-world.ts`)

Three call sites from the production codebase, with chain rewrites:

**1. `md-layout-demo.ts:48` — handle position lens (11 lines → 4)**

```ts
// Before:
const pos = derived(Vec,
  () => ({ x: card.translate.value.x + w.value,
           y: card.translate.value.y + h / 2 }),
  (p) => { w.value = Math.max(MIN_W, p.x - card.translate.value.x); },
);

// After:
const xAxis = w.derive((c) =>
  c.add(card.x).clampWrite(MIN_W + card.x.value, Infinity));
const yAxis = card.y.add(h / 2);
const pos = vecFromAxes(xAxis, yAxis);
```

The asymmetric writability (x writes to w; y writes to card.y) becomes
explicit. The clamp moves from a manual `Math.max` in the setter to a
`.clampWrite()` chain step, making the lens-side behavior compositional.

**2. `md-mirror.ts:27` — reflect across a line, self-inverse (7 lines → 3)**

```ts
// Before:
const mirrorOf = (src: Vec): Vec =>
  derived(Vec,
    () => reflect(src.value, mA.value, mB.value),
    (target) => { src.value = reflect(target, mA.value, mB.value); },
  );

// After: reflect is an involution → fwd === bwd. Express once.
const mirrorOf = (src: Vec): Vec =>
  via(src, Chain.of<VecValue>().iso({
    fwd: (p) => reflect(p, mA.value, mB.value),
    bwd: (p) => reflect(p, mA.value, mB.value),
  }), Vec);
```

**3. `polar()` (signals/values/vec.ts:112) — make it bidirectional**

The existing `polar()` is one-way (binds a Vec from `center, r, a`).
Under chains, `polarLens()` becomes a writable joint — writing a
cartesian Vec solves back for `r` and `a` (keeping `center` fixed):

```ts
export function polarLens(center: Vec, r: Num, a: Num): Vec {
  return viaJoint([r, a, center] as const, {
    fwd: (rv, av, cv) => ({
      x: cv.x + rv * Math.cos(av),
      y: cv.y + rv * Math.sin(av),
    }),
    bwd: (next, [_r, _a, cv]) => {
      const dx = next.x - cv.x;
      const dy = next.y - cv.y;
      return [Math.hypot(dx, dy), Math.atan2(dy, dx), cv];
    },
  }, Vec);
}
```

All three conversions tested in `test-compose.ts`.

## Compositional gains — what becomes natural (`compose.ts`)

### Pure isomorphisms (one-line composables)

```ts
degToRad        // 1-line bidirectional
radToDeg
flipRange(lo, hi)            // self-inverse over a range
remap(loA, hiA, loB, hiB)    // linear remap, bidirectional
normalize01(lo, hi)          // alias for remap(lo, hi, 0, 1)
cartesianToPolar             // {x,y} ↔ {r,a}
polarToCartesian             // inverse of the above
```

Composing them is just chain composition:

```ts
const sliderNorm = via(slider, Chain.of<number>()
  .iso(normalize01(0, 100)));   // slider in pixels ↔ slider as [0,1]

const angleDeg = via(angleRad, Chain.of<number>()
  .iso(radToDeg));              // store radians, display degrees
```

### Reactive helpers — writable from the start

```ts
midpoint(a, b)        // Vec — DRAG IT and both endpoints shift equally
midpointNum(a, b)     // Num version
align(a, b)           // Num — read gives shared value, write makes both equal
between(a, b, t)      // Vec read-only; t may be reactive
clamp01(n)            // Num read-only (clamp isn't invertible)
distance(a, b)        // Num read-only
```

### Anchored layout — Bluefish-style

```ts
pin(boxA, 0.5, 1,    // anchor: bottom-center
    boxB, 0.5, 0)    // anchor: top-center
// → Vec lens at the joint. Drag the joint, both boxes move.
```

### Stress test: 5-level cross-type chain stays writable

This compiles AND works at runtime:

```ts
const lens = boxSig.deriveNum((c) =>
  c.at(0.5, 0.5)  // Box → Vec  (anchor iso, writable)
   .x             // Vec → Num  (field iso, writable)
   .add(1000)     // Num → Num  (add iso, writable)
   .scale(2)      // Num → Num  (scale iso, writable)
);

lens.value = 4000;   // routes back: 4000/2 = 2000, -1000 = 1000,
                     // then box.x adjusted so center-x = 1000 → box.x = 950
```

Five chain steps; each carries its inverse; the whole expression is
writable; the source box gets shifted correctly. This is the
"embarrassingly compositional" property in concrete form.

## New utility primitive added: `clampWrite`

The real-world handle conversion (md-layout-demo) revealed a missing
primitive. The standard `clamp()` is **read-side** (truncates reads,
write-only — can't invert). For "drag handle but limit to range" you
want a **write-side clamp** — reads pass through, writes are
truncated before propagating.

```ts
// NumChain method (preserves writability):
clampWrite(lo, hi): NumChain<W> {
  return ... iso({
    fwd: (v) => v,                              // identity on read
    bwd: (v) => Math.max(lo, Math.min(hi, v)),  // clamp on write
  });
}
```

Generalizes: `valuesetWrite`, `mapWrite`, `transformWrite` — any
write-side-only transform. These are useful for handles, sliders,
input validation.

## Open questions / known caveats (updated)

1. **Runtime "soft" invertibility.** Edge tests confirm `scale(0)`
   produces `Infinity`/`NaN` rather than throwing — documented as a
   footgun. Mitigation paths (`bwd` returning `S | FAIL`; type-level
   non-zero constraints) remain as future work.

2. **Cross-class chains need dedicated methods (`deriveNum`,
   `deriveVec`).** Today `Vec.derive` only handles Vec→Vec. A unified
   `derive(fn): InferredReturn` would be nicer; doable via further
   type-level inference.

3. **The wrapper layer (`NumChain` etc.) costs ~100 ns per
   construction.** Accepted; the prototype is correct and fast in the
   hot path.

4. **No `Color`/`Transform`/`Matrix` ports yet.** Box port (with
   anchor-as-chain-step and cross-type Box→Vec→Num chains) confirms
   the pattern generalizes. Remaining value types follow the recipe.

5. **The article's full propagator network** (siblings constraining
   each other via mutual `to`) is now partially realized via `pin()`,
   `align()`, `midpoint()`, `between()` in `compose.ts`. A full
   layout DSL (`above`/`beside`/`grid` with auto-constraint) is the
   next concrete demo; sketched in `compose.ts`.

6. **Engine re-entry behavior is documented (not a bug).** An effect
   that writes to a signal it depends on does NOT re-fire itself
   during the same run. This is by design (prevents infinite loops);
   tests verify the behavior. Iterative fixpoints need to be expressed
   as explicit generators (animations) rather than effect-driven.
