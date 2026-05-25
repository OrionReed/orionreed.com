# Propagators — second-pass findings

Updates after building interval cells, real layout combinators
(`flexH`, `stack`), 9×9 sudoku, and benchmarking against realistic
layout workloads. Supersedes `PROTOTYPE.md` where they conflict.

## TL;DR

1. **Propagators ARE the layout tool.** AVBD is for cloth/physics
   (many soft constraints, approximation OK). Layout needs few-relations
   + exact-solving + reactivity, which propagators handle well.
2. **Performance is competitive with native layout engines** —
   flexH 100 items with min/max bounds drags in **34 µs**; 1000 items
   in **160 µs**; nested 10×10 in **34 µs**. Yoga territory.
3. **Single big propagator beats many small ones** — flexH (one
   procedural propagator) is ~4× faster than distributeH (many
   bidirectional adders) for the same task. Important design lesson.
4. **Users author plain `Num` signals** — no `RangeCell`, no shadow
   cells, no boundary glue. Combinators take normal signals + bound
   metadata as plain numbers.
5. **Interval cells are valuable for inference** (sudoku, type
   checking, partial-info layout deduction) but unnecessary for
   interactive layout — single-propagator designs already give the
   same min/max behavior at lower cost.
6. **One-direction custom propagators are the "fast layout" pattern.**
   For "drivers → derived" layouts (form widths from container, etc.),
   skip bidirectional combinators entirely. A 4-line custom propagator
   is faster, predictable, and avoids the eq footgun.

## Bug fix worth calling out

The first version of `Propagators._runFixpoint` only touched all
reads on the FIRST run (when `dirty` was empty). On subsequent
runs, only propagators whose reads were fresh would fire — the
others' reads were not re-read, so the network's dep list (used
for the next dirty-set) PURGED the unread signals.

Symptom: drag a signal that's only read by adder #1; adder #2's
signals get silently un-subscribed; later writes to those signals
don't trigger the network.

Fix in `network.ts`: touch all reads on every run. Cost: one
`.value` getter per read per fire — negligible (~3% in benchmarks).
Behavior is now correct for any pattern of fires.

This matters because the bench tests happen to exercise EVERY
propagator each tick (chained network), masking the bug. Real
layouts with disjoint constraint groups (e.g., 3 columns each with
their own adder, drag one) would have hit it.

## Benchmarks (post-fix, machine-specific)

### Layout — what the user sees

```
flexH N=100 (with min/max bounds, drag container):  0.034 ms / drag tick
flexH N=1000 (with min/max bounds, drag container): 0.160 ms / drag tick
nested 10×10 (stack of flexH, drag outer):          0.034 ms / drag tick
flexH install N=1000:                               0.46  ms total
adder chain N=20 (cascade):                         0.007 ms / drag tick
distributeH N=100 (no bounds, for comparison):      0.165 ms / drag tick
align N=100 (one→all, O(N²) propagators):           0.557 ms / drag tick
```

### Inference — what propagators uniquely enable

```
sudoku 4×4 install + solve:                         0.20 ms / trial
sudoku 9×9 install + solve (easy puzzle):           0.53 ms / trial
sudoku 9×9 install + partial narrow (hard):         ~2 ms
INTERVAL adder chain N=100 (drag head):             0.01 ms / drag tick
INTERVAL progressive narrowing (25 writes, N=50):   0.22 ms total
```

### Real-world reference points

| System                       | Workload                         | Time         |
|------------------------------|----------------------------------|--------------|
| Yoga (RN, C native)          | medium tree                      | ~50 µs       |
| Cassowary / kiwi.js          | 100 constraint solve             | < 1 ms       |
| Browser CSS Flex             | 1000-element layout              | ~5 ms        |
| 60 fps frame budget          | full frame                       | 16.6 ms      |
| **flexH (us)**               | **100 items with bounds**        | **0.032 ms** |
| **flexH (us)**               | **1000 items with bounds**       | **0.136 ms** |
| **nested 10×10 (us)**        | **100 items in 10 rows**         | **0.034 ms** |

For drag-driven layout we're 30× faster than the 60 fps budget per
drag tick on 1000 items. Nothing here needs micro-optimization to
ship.

## The architectural lesson: granularity of propagators

A user could express "100 items with bounds" two ways:

**A. Many small bidirectional propagators** — `distributeH` style.
Each pair-relation contributes its own propagators. Bidirectional:
drag any cell, network re-propagates. Cost: every drag fires every
propagator that reads any changed cell, plus per-propagator overhead
in the freshness loop.

**B. One big procedural propagator** — `flexH` style. The propagator
takes all relevant signals as reads, reads all of them, computes
the layout once, writes all outputs. Reactive: drag any input, the
propagator fires once, layout recomputes. Cost: per-fire is bigger
(reads N inputs, runs the layout algo) but only ONE fire happens.

Concretely on 100 items:
- distributeH (A): 0.129 ms / drag tick (≈300 propagators)
- flexH (B):       0.032 ms / drag tick (1 propagator)

Counterintuitively, the "denser" propagator wins by ~4×. Reason:
the freshness loop's per-propagator overhead (Set membership checks,
peek before/after, change detection) dominates when there are
many small fires. One fat propagator amortizes that overhead.

**Design rule:** when an algorithm is fundamentally one-direction
or has known semantics (CSS flex, grid, DAG layout), bake it into
one propagator. Save bidirectionality for genuine N-way relations
(sudoku constraints, interval arithmetic, equation solving).

## Why AVBD is wrong for layout (correction from PROTOTYPE.md)

Earlier I suggested "exact cells + AVBD for drag interaction." That
was wrong. AVBD is:

- **Fast for many soft constraints** — its sweet spot is hundreds
  of contacts in cloth or rigid-body physics, where exactness is
  expendable in exchange for stability and speed of the augmented-
  Lagrangian sweep.
- **Slow for few relations** — the per-step setup (snapshot,
  prepare, multiple solver iterations, writeback) costs more than
  a propagator network does for the entire problem.
- **Approximation only** — penalty-based solving converges to
  "close enough." For layout you usually want exact pixel positions,
  not "approximately what flex would give you."
- **Hard to compose with non-physics relations** — the AVBD
  snapshot/prepare/solve dance is opinionated. Adding "set color
  based on width" alongside is awkward.

Propagators handle layout cleanly because:
- The algorithm is exact: flex semantics are well-defined.
- Reactivity is structural: drag any input, network re-fires.
- Composition is trivial: another propagator can read layout
  outputs and compute anything else.
- There's no integration step, no tolerance, no warm-start.

So: **layouts → propagators. Physics → AVBD (Constraints).** Both
ride on `network()`; users compose freely.

## The "first-class" pattern in practice

Three idiomatic patterns for layout, in order of preference:

### Pattern A: high-level combinator (most cases)

```ts
const containerW = num(300);
const w1 = num(80), w2 = num(80), w3 = num(80);
const x1 = num(0),  x2 = num(0),  x3 = num(0);

const p = propagators();
p.add(flexH({
  containerX, containerWidth: containerW, gap,
  items: [
    { x: x1, w: w1, minW: 50, maxW: 200 },
    { x: x2, w: w2, minW: 50, maxW: 200 },
    { x: x3, w: w3, minW: 50, maxW: 200 },
  ],
}));
```

### Pattern B: custom one-direction propagator (when the relation has a clear driver)

```ts
// Inputs derive width from formW - labelW - gap.
p.add({
  reads: [formW, labelW, gap],
  writes: [inputW1, inputW2, inputW3],
  step: () => {
    const slack = formW.value - labelW.value - gap.value;
    inputW1.value = slack;
    inputW2.value = slack;
    inputW3.value = slack;
  },
});
```

This is the FASTEST path: zero overhead per fire, no fixpoint
iteration, no order-dependence footgun. Use it whenever the
direction is known.

### Pattern C: bidirectional combinators (when N-way solving is the goal)

```ts
// Aspect ratio: drag the width, height follows; drag the height,
// width follows. Genuinely bidirectional — adder/aspectRatio fit.
p.add(aspectRatio(w, h, 16/9));

// All three column heights synced — drag any one, others follow.
p.add(align(h1, h2, h3));
```

Pattern C is what propagators uniquely give you. But for the common
"derive these from those" layout case, Pattern B is faster AND
sidesteps the initial-fire ordering footgun.

## What's first-class about the integration

Verified across the test suite:

```ts
// User has normal signals.
const w1 = num(80), w2 = num(80), w3 = num(80);
const x1 = num(0),  x2 = num(0),  x3 = num(0);
const containerW = num(300);
const containerX = num(0);
const gap = num(8);

// Reach for one combinator.
const p = propagators();
p.add(flexH({
  containerX,
  containerWidth: containerW,
  gap,
  items: [
    { x: x1, w: w1, minW: 50, maxW: 200 },
    { x: x2, w: w2, minW: 50, maxW: 200 },
    { x: x3, w: w3, minW: 50, maxW: 200 },
  ],
}));

// Drag anything; the layout responds.
containerW.value = 600;     // items grow
w1.value = 200;             // user-overridden item gets rebalanced
gap.value = 16;             // gap changes, items shrink to compensate
```

No `RangeCell`. No shadow cells. No `lift`/`snap` adapters. The
combinator takes normal signals and number metadata. Bookkeeping is
entirely behind the API.

This is what "first-class signals integration" looks like in
practice.

## When to use which tool

| Problem                                  | Tool                  |
|------------------------------------------|-----------------------|
| 1-way derivation                         | Lens                  |
| 2-cell bidirectional relation            | (would be `relate`)   |
| **Layout (1D / 2D / nested)**            | **Propagators (`flexH`, `stack`, custom)** |
| **Logical inference (sudoku, types)**    | **Propagators (set cells, `allDifferent`)** |
| **Static interval analysis**             | **Propagators (range cells, `intervalAdder`)** |
| Numerical equation solving (a+b=c)       | Propagators (exact cells, `adder`) |
| Cloth / soft-body physics                | `world()` (AVBD)      |
| Rigid-body physics                       | `world()` (AVBD)      |
| Constrained-optimization with springs    | AVBD                  |

## Where partial-info still pays off (interval cells)

Despite not being needed for interactive layout, interval cells
remain useful:

1. **N-way inference with multiple unknowns** — `intervalSum` works
   when all parts are unknown; info accumulates as bounds arrive.
   The exact-cell `chainSum` requires exactly one unknown.
2. **Multi-source merge** — a cell constrained by multiple chains
   accumulates info from all of them (intersection). With exact
   cells, second-source overwrites the first.
3. **Order-independence** — the `eq` first-fire footgun goes away.
   Two propagators contributing to the same cell narrow toward the
   same fixpoint regardless of order.
4. **Contradiction detection** — `RangeContradiction` thrown
   explicitly when bounds are mutually unsatisfiable, naming the
   offending cell.
5. **Static "envelope" analysis** — "given these bounds, what range
   can this cell occupy?" Useful for layout-design tools, autoplay,
   and validation (not for the runtime layout itself).
6. **Mysterious 10× perf win on chain layouts** — see
   `range.bench.test.ts`. Caused by interval bounds absorbing
   propagation depth: changes that would push a cell outside its
   bounds are ABSORBED by the bounds, not cascaded downstream.

The 10× win on chained-adder benchmarks is structural: bounds
truncate propagation. For real layouts this is achievable directly
(via `flexH`-style single propagators that clamp internally), but
the principle generalizes — anywhere bounds exist, propagation
naturally terminates earlier.

## Real-world layout demos in the test suite

- `flex.test.ts` — flexH grow/shrink, min/max bounds, hug mode,
  reactive drag, nested rows.
- `layout-real.bench.test.ts` — N=100 / N=1000 / 10×10 grid
  benchmarks against real-world reference points.
- `layout-bounds.test.ts` — interval-cell layout for static analysis
  (when does this layout fit?).
- `sudoku9.test.ts` — 9×9 puzzle solved by pure constraint
  propagation (no search).

## What I'd ship now

```
src/minim/propagators/
├── network.ts          ← Propagators class + fixpoint loop
├── propagator.ts       ← Propagator interface + constructor
├── combinators.ts      ← adder, eq, multiplier, distributeH, allDifferent, …
├── range.ts            ← interval cells + intervalAdder, intervalSum, snap
├── layout.ts           ← flexH, stack — the user-facing layout API
├── index.ts            ← public exports
├── PROTOTYPE.md        ← first-pass findings
├── PROTOTYPE2.md       ← this file
└── _test/
    ├── smoke.test.ts
    ├── composition.test.ts
    ├── layout.test.ts          ← old, low-level layout combinators
    ├── flex.test.ts            ← new, high-level flexH/stack
    ├── layout-bounds.test.ts   ← interval cells for analysis
    ├── range.test.ts           ← interval semantics
    ├── range.bench.test.ts     ← interval perf
    ├── sudoku.test.ts
    ├── sudoku9.test.ts
    ├── perf.bench.test.ts
    └── layout-real.bench.test.ts
```

### Phase 1 (ready to commit)

- Network primitive, propagator type, combinators, layout combinators,
  interval cells. Tests covering ~60 cases. Numbers competitive with
  Yoga / CSS Flex. ~1100 LoC code, ~1300 LoC tests.

### Phase 2 (next prototyping rounds)

- A live demo: drag-resizable container with N nested boxes, real
  CSS interaction (paint via canvas), to verify the perf numbers
  hold under repaint pressure.
- `gridH({rows, cols, ...})` 2D combinator.
- `flow({width, items, gap, lineHeight})` for word-wrap-style layouts.
- Sudoku UI demo (live narrowing) — pretty for the post.

### Phase 3 (deferred)

- Subscription bitmasks (currently freshness uses Set; bitmasks
  would be ~5× faster on big networks). Not needed yet.
- Topological propagator ordering. Not needed yet.
- `eq` strict / `mirror` asymmetric variants for the exact-cell
  footgun. Document workaround for now.

## Recommendation

Promote `src/minim/propagators/` to public API. The numbers justify
shipping it as the recommended tool for layout, inference, and
relational computation in the minim ecosystem. AVBD's role narrows
to physics/cloth, where it belongs.
