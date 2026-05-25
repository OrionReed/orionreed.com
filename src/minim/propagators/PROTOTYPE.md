# Propagators — prototype findings

A working sketch of propagator networks built on `network()`. ~250 LoC of framework + 4 test files (~750 LoC across smoke, composition, layout, sudoku).

## What works

### 1. Non-coloring (the big one)

**Existing signals participate in propagators with zero ceremony.** No `Cell<T>` wrapper, no lattice attached at the signal layer, no type changes propagating to consumers. This is the design property that matters most.

A `Writable<Num>` is a propagator participant unchanged. So is a `Vec.lens(...)` lens, a `vec(...).x` field-lens, a custom-class signal — anything that satisfies `Writable<Signal<T>>`. The propagator doesn't know or care what kind of signal it's writing to; it just calls `.value` (read) and `.value =` (write).

```ts
const a = num(10);          // existing Num signal in your diagram
const aPlus5 = a.add(5);    // existing lens chain
const b = num(2);
const c = num(0);

const p = propagators();
p.add(adder(aPlus5, b, c)); // both `aPlus5` (lens) and the others
                            // participate without modification
```

Verified across 9 composition tests including:
- `Num` signals
- `Vec.lens(...)`-derived signals
- `Vec.x` field-lenses
- Two propagator networks observing overlapping signals
- Downstream `effect()` seeing propagator writes through normal subscription
- Custom propagators reading a `Vec` and writing a `Num` (heterogeneous value types)

### 2. Termination

Three layers of defense, all working:

- **Fuel cap on the fixpoint loop.** `propagators({ iterations: 1000 })` (default 1000). Hitting the cap throws `PropagatorDivergedError` with the set of still-changing signals. No infinite loops possible.
- **Freshness propagation.** Each iteration runs only propagators whose READS were freshly modified in the prior iteration. This prunes work and stops most cycles naturally.
- **Monotonic lattices** (e.g. set narrowing for sudoku) terminate well before the fuel cap, since every fire shrinks at least one cell in a finite-height lattice.

Verified: a maliciously-divergent propagator pair (`a = b + 1`, `b = a + 1`) throws cleanly with the offending signals named in `error.pending`.

### 3. Sudoku solver

A 4×4 sudoku with row/col/box `allDifferent` propagators solves cleanly:

```ts
for (const row of rows)  p.add(allDifferent(...row));
for (const col of cols)  p.add(allDifferent(...col));
for (const box of boxes) p.add(allDifferent(...box));
```

Set narrowing (cells start at `{1,2,3,4}`, propagators eliminate digits as singletons emerge) reaches a fully-determined Latin square in well under the fuel cap. The set-equality custom `equals` keeps no-op writes from triggering needless re-fires.

### 4. Layout combinators

`distributeH({ ..., mode: 'fit' | 'hug' })` works as expected:
- Resize container → gap auto-derives.
- Resize an item → gap auto-derives (in fit mode); container width auto-derives (in hug mode).
- Compose with `align(y1, y2, y3)` for top-aligned distributed boxes.

The bidirectional flow that lenses can't ergonomically express works here as a few-line propagator declaration.

## What's awkward (and what it means for the real design)

### 1. Order-dependence on the initial fire

`eq(a, b)` is symmetric semantically but the propagator declared first wins on the initial fire. This bit me twice during prototyping (once in composition tests, once in layout). The fix in each case was: write the "source-of-truth" cell *after* `p.add(...)` so the propagator network has nothing to propagate, then the explicit write triggers the network with `dirty = {source}`, freshness picks the right direction.

**Implication for the real design:** I think this is actually fine, *if documented*. The semantic is clear enough: on initial fire, propagators run in declaration order, last-write-wins. Users who want a specific direction-of-truth pick which cell to write first. The freshness algorithm correctly handles all subsequent writes.

What we should probably add: a way to declare "this cell is a source" that suppresses propagators that would WRITE to it on initial fire. A simple sketch:

```ts
p.markSource(containerWidth);  // fire-order priority: never overwrite this on init
```

Or more simply: combinators like `distributeH` get an explicit `mode` opt that determines which direction is emitted. (I did this for `distributeH`; the test passes.) For the generic case, the `markSource` thing might be useful, but isn't blocking.

### 2. `chainSum` n-way back-deduction

The naive "n-way back-deduction" propagator (given total + (n-1) parts, deduce the missing one) is a single propagator that reads ALL parts and writes one. If multiple parts are unknown at the same time, it can't deduce — its output ends up nonsensical (NaN, depending on initial values). Real propagator networks handle this with **partial information** (intervals shrink as more becomes known); we don't yet.

For layout and most numerical cases this is fine — typically you have one unknown at a time. For more advanced inference (interval arithmetic over partially-known systems), the prototype suggests adding **interval cells** as a separate combinator family with their own merge logic encoded in the step body. The non-coloring property is preserved: an interval cell is just `Signal<[number, number]>` with a custom `equals` that compares intervals, and the propagator's step does narrowing.

### 3. Fresh-set initial-empty handling

The freshness algorithm has a special case: on the *very first* fire (when `dirty` is empty because the network just got installed), I run all propagators in declaration order to seed initial state. This matches Constraints' settle pattern (the first `_runBody(new Set())` does the initial run). After that, every fire's `dirty` is populated by external writes, and freshness logic kicks in.

Implementation cost: 6 lines of special-case code in `_runFixpoint`. Mostly invisible to users.

### 4. Custom equality is essential for set/object cells

Sudoku cells use `equals: eqSet` because we always allocate fresh `Set` instances during narrowing — without custom equality, every "narrow that didn't actually shrink" would still notify and re-fire. With it, no-op narrows are silent and the network terminates cleanly.

This is leveraging an existing `signal()` feature, not new infrastructure. Just worth noting that real propagator usage will heavily rely on custom equality for non-primitive cell values.

## Where I'd take it next

Based on the prototype, here's the design I'd commit to.

### The framework (~250 LoC, ~3 files)

- `propagator.ts`: `Propagator` type (plain object: `{reads, writes, step}`), `propagator(reads, writes, step)` constructor.
- `network.ts`: `Propagators` class (one `network()` body, fixpoint loop with fuel cap, freshness algorithm), `propagators(opts)` factory, `PropagatorDivergedError`.
- `combinators.ts`: numerical (`adder`, `multiplier`, `eq`, `constant`, `chainSum`), layout (`align`, `distributeH`, `aspectRatio`), set (`allDifferent`).

That's the whole thing. No `Cell<T>` wrapper. No `Lattice<T>` infrastructure. Custom merge semantics live inside individual propagator step bodies (e.g., set intersection, interval narrowing) — they're per-combinator concerns, not per-cell.

### What's NOT in this design (and shouldn't be, IMO)

- **No `Cell<T>` type.** Confirmed unnecessary by the prototype. Existing signals work fine. Adding a `Cell` wrapper would be the colorization that the user explicitly wants to avoid.
- **No `Lattice<T>` registry.** Lattices are conceptual ideas baked into specific combinators, not a system-wide abstraction. `allDifferent` knows about set narrowing internally; users don't see "lattice" as a type.
- **No automatic contradiction detection across the framework.** Combinators that want it implement it locally (e.g., set narrowing to `{}` could throw or sentinel). Generic contradiction would require lattices, which we're not adding.

### Trade-offs vs. the textbook propagator network

We give up:
- True partial-info / interval narrowing across the whole network (could add as opt-in cells later).
- Universal contradiction detection.
- Lattice-based termination proofs (we use fuel cap instead).

We gain:
- Drop-in compatibility with every signal in the existing system.
- Same idiom as `Constraints` — propagator networks are siblings, not aliens.
- Tiny framework, easy to reason about.
- No new types in user code.

I think for the project's goals (layout combinators, occasional inference puzzles, "drop propagators into part of a diagram"), this trade-off is right. The textbook propagator features can come later as opt-in cells/lattices if a real use case demands them.

### Suggested integration

Promote `src/minim/propagators/` to a real subpackage. Re-export the public surface from `src/minim/index.ts` (sibling to `constraints`, `signals`, etc.).

Then a layout demo: a Figma-flavored auto-layout box. 3 boxes inside a container, drag any handle (corner of any box, container edge, gap), all others reflow correctly. ~50 LoC of demo code on top of `distributeH` + `align`. That's the headline-worthy concrete artifact.

A sudoku demo also works as a more involved example showing the same primitives extending to inference puzzles — different domain, same machinery.

## Test count

- `smoke.test.ts`: 10 tests (basic semantics, termination, lifecycle).
- `composition.test.ts`: 9 tests (non-coloring with lenses, vec fields, custom propagators, two networks).
- `layout.test.ts`: 6 tests (align, distributeH fit/hug modes, composition).
- `sudoku.test.ts`: 3 tests (4×4 puzzle, monotone narrowing, fuel-cap-respecting termination).

Total: 28 tests, all passing. Full suite: 848 tests passing.

## Recommendation

Ship this as-is, modulo:

1. Pick whether `chainSum` (multi-direction n-way) stays or gets removed (it's useful for some patterns but the back-direction-with-multiple-unknowns case is fragile).
2. Add a layout demo to validate the ergonomics in a real diagram.
3. Maybe add `interval()` / interval-narrowing combinators as a follow-up if a real use case demands partial info.
4. Document the "initial-fire order-dependence" as a known semantic.

The non-coloring property is preserved, termination is bulletproofed by the fuel cap, and the API surface is small. Good substrate for the next batch of work.
