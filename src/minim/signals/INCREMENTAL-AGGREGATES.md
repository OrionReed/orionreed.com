# Incremental Aggregates — Design Notes

**Status**: design notes. Nothing in this file is implemented. A working
prototype was built and reverted (see "What the prototype showed" below).
Read this when picking the work up; the algebraic story, the numerical
analysis, and the engine-side blockers are all here.

Companion to [`BIDIRECTIONAL-LENSES.md`](./BIDIRECTIONAL-LENSES.md) (the
shipped lens algorithm) and [`DATAFLOW-EXPLORATIONS.md`](./DATAFLOW-EXPLORATIONS.md)
(the broader speculative landscape this fits into).

---

## 1. The problem

Aggregate lenses (`centroidLens`, `meanLens`, `bboxLens`, the `procrustesLens`
family, etc. in [`aggregates.ts`](./aggregates.ts) and
[`lenses/`](./lenses/)) currently recompute everything from scratch on
every input change. Cheap in practice for small N; the scale limit is
real for N >> 100, especially in interactive workloads where one input
moves per frame.

The question: can we make these incremental (update one contribution
when one input changes) without giving up correctness?

---

## 2. Algebraic taxonomy

Whether an aggregate is incrementalizable depends on its algebra:

| Class | Structure | Cost per change | Examples |
| --- | --- | --- | --- |
| **Integer group** | `(N, +, 0, neg)` | O(1), bit-exact | count, integer sum, integer centroid (after dividing) |
| **Float group** | same shape, lossy arithmetic | O(1), O(ε)-bounded with Kahan/Neumaier | mean, centroid, sum of distances |
| **Monoid (no inverse)** | `(S, ⊕, e)` | O(N) (re-combine cached contributions) | string concatenation, AND/OR over arbitrary types |
| **Semilattice (idempotent)** | `(L, ⊔, ⊥)` | O(1) on monotone insert; O(N) on extremum shrinkage | min, max, AABB, hull-on-insert |
| **Non-algebraic** | — | O(N) (unavoidable) | median, mode, k-th order statistic |

The first three rows are the "easy" cases. The lattice case needs more
care (extremum-removal is the bad case). The non-algebraic row can't be
helped within this framework.

---

## 3. Numerical analysis — the "drift" question, answered honestly

Earlier framings handwaved with "incremental drifts; add a periodic
recompute knob." That was wrong. The honest story is:

| Algorithm | Error bound | Reference |
| --- | --- | --- |
| Integer arithmetic | **0** (exact) | trivial |
| Naive single-pass float sum | O(K·ε) | Higham 2002 §4.3 |
| Naive incremental float sum (subtract old, add new) | O(K·ε) | same |
| **Kahan-compensated** sum | O(ε) regardless of K | Kahan 1965 |
| **Neumaier-compensated** sum | O(ε), handles |delta| > |sum| | Neumaier 1974 |
| Pairwise summation (tree fold) | O(ε log N) | Higham 2002 §4.4 |

So:

- Integer aggregates are bit-exact. No drift possible.
- Float aggregates without compensation have O(K·ε) drift — **the same
  bound as a naive single-pass recompute**. The "incremental version
  drifts" framing implied incremental was *worse* than recompute. It
  isn't; they have the same numerical class.
- With Kahan/Neumaier compensation, the incremental version is **strictly
  better** than naive recompute, regardless of K.

No "periodic recompute knob" needed. Pick the algorithm by the precision
you need.

### Neumaier add (reference implementation)

```ts
function neumaierAdd(state: { sum: number; c: number }, x: number): void {
  const sum = state.sum;
  const t = sum + x;
  if (Math.abs(sum) >= Math.abs(x)) {
    state.c += sum - t + x;
  } else {
    state.c += x - t + sum;
  }
  state.sum = t;
}
// Truth = state.sum + state.c, to machine precision.
```

For incremental sum-with-inverse: when input i changes from `old` to
`new`, compute `delta = new - old` and `neumaierAdd(state, delta)`.

---

## 4. Proposed library API

A small module sitting alongside [`aggregates.ts`](./aggregates.ts).

### Group interface

```ts
interface Group<U> {
  readonly empty: U;
  add(a: U, b: U): U;
  sub(a: U, b: U): U;
}

const NumGroup: Group<number> = {
  empty: 0,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
};

const VecGroup: Group<{ x: number; y: number }> = {
  empty: { x: 0, y: 0 },
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
};
```

### Core primitive

```ts
function groupAggregate<T, U>(
  inputs: readonly Read<T>[],
  group: Group<U>,
  project: (t: T) => U,
): Signal<U>;
```

O(1) per change. Body maintains `contribs[i] = project(inputs[i].value)`
across fires; when input `i` changes, updates `acc ← add(sub(acc, old), new)`.

### Compensated variants

```ts
function kahanSum(inputs: readonly Read<number>[]): Signal<number>;
function kahanSumOf<T>(inputs: readonly Read<T>[], project: (t: T) => number): Signal<number>;
function kahanCentroid(inputs: readonly Read<{ x: number; y: number }>[]): Signal<{ x: number; y: number }>;
```

Use when the workload accumulates many updates AND float precision matters.

### Bidirectional variants

`centroidLens` and friends are writable today. The incremental version
should preserve that — the read path is incremental, the write path
stays the same as today (target → distribute delta to all parents).
The write triggers `dirty = {0..n-1}` on the next read, which degrades
gracefully to a full recompute via the incremental body's accumulator
reset.

---

## 5. The engine extension — what worked and what didn't

### What was tried

Modify `_fanin` to detect `fwd.length >= 2` and pass a
`dirty: ReadonlySet<number>` as a second arg:

```ts
function _fanin(Cls, parents, fwd, bwd?) {
  const n = parents.length;
  const vals = new Array(n);
  const wantsDirty = fwd.length >= 2;
  const lastVals = wantsDirty ? new Array(n) : null;
  const dirty = wantsDirty ? new Set<number>() : null;
  let firstFire = true;

  const getter = wantsDirty
    ? (): unknown => {
        for (let i = 0; i < n; i++) vals[i] = parents[i].value;
        dirty.clear();
        if (firstFire) {
          for (let i = 0; i < n; i++) {
            dirty.add(i);
            lastVals[i] = vals[i];
          }
          firstFire = false;
        } else {
          for (let i = 0; i < n; i++) {
            if (lastVals[i] !== vals[i]) {
              dirty.add(i);
              lastVals[i] = vals[i];
            }
          }
        }
        return fwd(vals, dirty);
      }
    : ...
}
```

This works correctly. Composition tests all pass. The body can do O(1)
work using `dirty` for delta updates.

### Why it's not enough

The engine **still reads all N parent values on every fire**:

```ts
for (let i = 0; i < n; i++) vals[i] = parents[i].value;
```

This is O(N). The body's O(1) win is dwarfed at the sizes that matter.

### Bench numbers from the prototype

Apple M-series, single thread, vitest, ITERS=10,000.

| N | naive (µs/op) | incremental (µs/op) | kahan (µs/op) |
| --- | --- | --- | --- |
| 10 | 0.13 | 0.21 | 0.16 |
| 100 | 1.3 | 0.99 | 1.0 |
| 1000 | 14.6 | 14.9 | 15.0 |
| 10000 | 125 | 138 | 120 |

Overhead floor (N=1000, empty arity-2 body): arity-1 fwd = 9.1 µs,
arity-2 fwd = 11.8 µs. The opt-in path costs ~30% more bookkeeping than
the plain path — that's the engine's per-fire O(N) compare loop.

End-to-end win: modest (~25% on N=10000 compensated). Nothing dramatic.

---

## 6. The blocker — and the deeper engine change that lifts it

### Why simple read-skipping breaks

The natural next step: add `_writeVersion` to Signal, bumped on actual
value change. Then `_fanin`'s getter could skip `.value` reads for
parents whose version hasn't advanced:

```ts
for (let i = 0; i < n; i++) {
  const pv = parents[i]._writeVersion;
  if (pv !== lastVersions[i]) {
    vals[i] = parents[i].value;
    if (lastVals[i] !== vals[i]) dirty.add(i);
    lastVersions[i] = pv;
  }
}
```

This was implemented and immediately broke 5 tests. The reason is
fundamental to the engine's design.

The engine's dep-tracking model (alien-signals algorithm) requires
**every `.value` from inside a getter to call `link()`**, which sets the
parent-child link's version to the current cycle. After the getter
returns, `purgeDeps` walks the link list and removes anything whose
version doesn't match the current cycle. These are deps that "weren't
used this fire" and are presumed stale.

Skipping reads → skipped parents' links don't get refreshed →
`purgeDeps` removes them → the fan-in stops receiving notifications
from those parents → silent correctness break.

This isn't a bug in the engine; it's the correct behavior for *computed*
cells whose dep set varies (e.g. `if (a.value) b.value else c.value` —
only one of b/c is read per fire and the engine correctly unsubscribes
from the other). But it's the wrong behavior for *fan-in* cells whose
dep set is fixed at construction.

### The fix: static-deps fan-in

Cells with fixed parent sets need permanent links — established at
construction, exempt from `purgeDeps`.

**Required changes** (~80-100 LOC):

1. **`Signal._staticDeps: boolean`** (new field).
2. **`_writeVersion: number`** on Signal. Bumped in
   `_setWithExclusion` (signal mode) when value actually changes, and
   in `_update` (computed/lens mode) when it returns true. *Not* bumped
   in signal-mode `_update` (the setter already did it).
3. **`purgeDeps`** branches on `_staticDeps`: skip when true.
4. **`Signal.installStatic(Cls, parents, getter, setter?)`** — new
   construction path. Walks `parents`, calls `link(parents[i], cell, sentinelVersion)`
   for each. Sets `cell._staticDeps = true`.
5. **`_fanin`'s arity-2 getter** uses version-skip:

   ```ts
   for (let i = 0; i < n; i++) {
     const p = parents[i];
     if (p._writeVersion !== lastVersions[i]) {
       vals[i] = p.value;             // permanent link, no purge concern
       if (lastVals[i] !== vals[i]) {
         dirty.add(i);
         lastVals[i] = vals[i];
       }
       lastVersions[i] = p._writeVersion;
     }
   }
   ```
6. **Disposal**: `_unwatched` for static-deps cells walks parent links
   and unlinks them. Otherwise they leak (the auto-GC via `purgeDeps`
   that dynamic-deps cells get doesn't fire).

### Expected impact

At N=10000, single-input change:

- Today's incremental (read-all + dirty hint): ~132 µs/op.
- With static-deps + version-skip: **~0.2 µs/op**. 500-1000× speedup.

### Risks

- **Link lifecycle bugs**: most engine concern. The static-deps path is
  new. Need tests for dispose, re-subscribe, re-entrant reads, and
  cycle-counter interactions while a fan-in is mid-fire.
- **Symmetric lens fan-in (`_symmetric`)**: structurally the same shape.
  Same change should apply (and would give symmetric lenses the same
  speedup for spec-style reads). Their complement-management code
  needs verification against static-deps assumptions.
- **Fusion (`_fusedOf` tracking)**: probably fine but needs check.

### Alternative: "N effects" instead of engine change

If the engine refactor feels too risky, there's a userland alternative.
Each input gets its own `effect()` that tracks just that input; when it
fires, it computes the delta and writes to a single output signal:

```ts
function groupAggregate(inputs, group, project): Signal<U> {
  const cell = signal(group.empty);
  const contribs = new Array(inputs.length).fill(group.empty);
  for (let i = 0; i < inputs.length; i++) {
    effect(() => {
      const new_ = project(inputs[i].value);
      cell.value = group.add(group.sub(cell.value, contribs[i]), new_);
      contribs[i] = new_;
    });
  }
  return cell;
}
```

**Pros**: no engine change; pure userland; true O(1) per change.

**Cons**: N effects per aggregate (memory); each effect fires
independently (potential glitches on multi-input updates unless batched);
re-entrancy / ordering subtleties.

Worth benching before the engine change. Maybe good enough.

---

## 7. Composition pitfalls

From the prototype's composition tests, what worked and what didn't.

### Works cleanly

- Aggregate downstream of a writable lens (writes propagate via lens
  bwd, aggregate sees new values on next read).
- Nested aggregates (`groupAggregate` feeding into another
  `groupAggregate`; `kahanSum` feeding into `groupAggregate`).
- Aggregate inside `effect()` / `network()` bodies — no infinite loop
  because effects only read, don't write back to inputs.
- Aggregate downstream of a bidirectional view — write to the view
  triggers parent writes, aggregate sees `dirty = {0..n-1}`, degrades
  to full recompute (correct).
- Self-read mid-fire — engine catches via `RecursedCheck` → throws.
  Same as today's computed cells.
- Lazy first fire — body doesn't run until first read; writes before
  first read are accumulated into the initial state correctly.
- Bulk write (all inputs change in one batch) — body sees full dirty
  set, degrades to full recompute.

### One real footgun

**Mutating values in place inside cells.** General signals footgun —
the engine uses `===` equality for cells, which misses in-place mutation
of the same object reference. For incremental aggregates the failure
mode is invisible: the cached `contribs[i]` is stale but the dirty set
doesn't flag it, so the accumulator is wrong AND nothing fires.

```ts
// BAD — silent corruption with incremental aggregates
const cell = signal({ value: 1 });
const sum = groupAggregate([cell], NumGroup, p => p.value);
sum.value;                       // = 1
cell.value.value = 100;          // mutation in place; engine doesn't see it
sum.value;                       // still 1 (cached contribs); WRONG

// GOOD — replace the reference
cell.value = { value: 100 };
sum.value;                       // = 100
```

This is documented in the prototype's composition test suite. Same
failure exists for any signal consumer that caches projections;
incremental aggregates just make it more visible.

**Mitigation**: don't mutate cell values. Always replace by reference.
Probably worth a runtime check in dev mode (compare object identity
across fires, warn if same identity but the body produced a different
projected value) — but the proper fix is structural in user code.

### What's not supported

- **Dynamic input sets**. The `inputs` array is captured at construction.
  Adding/removing inputs after the fact has no effect. For dynamic
  collections, the right pattern is `each(...)` over a meta-cell that
  holds the input array, re-constructing the aggregate when the set
  changes.

---

## 8. Roadmap

In order, smallest to largest:

### Step 1 — Confirm the demand exists

Don't build any of this speculatively. The current `centroidLens` /
`meanLens` are fine for the demos that exist. The right time to start
is when a concrete demo (N=10k particle sim, large constraint network,
type-inference visualization with hundreds of nodes) demonstrates the
perf problem in practice.

### Step 2 — Try the "N effects" userland approach

No engine change. Build `groupAggregate` and `kahanSum` as in §6's
alternative. Bench against naive recompute. If it wins, ship and stop
here.

### Step 3 — Engine refactor for static-deps fan-in (if needed)

If "N effects" doesn't perform well (effect-overhead-per-write is too
high, glitch behavior on multi-input updates is wrong, etc.), do the
engine refactor in §6. Permanent links + `_writeVersion`. ~80-100 LOC
across `signal.ts`. New tests for the static-deps lifecycle.

### Step 4 — Migrate existing aggregates

Once a fast incremental primitive exists, port `centroidLens`,
`meanLens`, `bboxLens`, `procrustesLens`, etc. The write paths stay the
same; only the read paths get incrementalized. Drop-in via:

```ts
// Inside centroidLens:
const c = kahanCentroid(parents);   // incremental read
return Cls.lens(
  parents,
  () => c.value,                    // fwd reads the incremental cell
  (target, vals) => /* distribute delta */,
);
```

### Step 5 — Tree aggregates for very large N (if ever)

Segment-tree aggregates: O(log N) per change, beats flat O(1)+constant
for N >> 1000 with many-changes-per-tick workloads. Userland-only.
Build only if a real demo motivates it.

---

## 9. References

Primary sources:

- Kahan, W. (1965). [Further remarks on reducing truncation errors](https://dl.acm.org/doi/10.1145/363707.363723).
  Communications of the ACM. The classical compensated summation.
- Neumaier, A. (1974). *Rundungsfehleranalyse einiger Verfahren zur
  Summation endlicher Summen*. Z. Angew. Math. Mech. 54. The variant
  that handles `|delta| > |sum|` correctly.
- Higham, N. J. (2002). [Accuracy and Stability of Numerical Algorithms](https://epubs.siam.org/doi/book/10.1137/1.9780898718027),
  2nd ed., SIAM. §4 covers summation error bounds.
- Mumick, I. S. & Quass, D. (1997). [Maintenance of Data Cubes and
  Summary Tables in a Warehouse](https://dl.acm.org/doi/10.1145/253260.253277).
  SIGMOD. The "self-maintainable" / "almost self-maintainable" /
  "not self-maintainable" classification of aggregates.

Connections to wider design space:

- [`DATAFLOW-EXPLORATIONS.md`](./DATAFLOW-EXPLORATIONS.md) — broader
  context (lattice cells, edit lenses, cyclic dataflow).
- McSherry, F. et al. (2013). [Differential dataflow](https://www.cidrdb.org/cidr2013/Papers/CIDR13_Paper111.pdf),
  CIDR. The production-grade incremental dataflow system; uses
  partially-ordered timestamps + monoidal multisets to handle
  arbitrarily nested incremental computation.
- Hellerstein, J. M. (2019). [Keeping CALM](https://cacm.acm.org/research/keeping-calm/),
  CACM. The lattice-based foundation for distributed monotonic
  computation; the lattice/semilattice row in §2 directly inherits
  from this.

---

## 10. Verdict

The substrate is well-understood:

- **Algebraic story is solid**: integer-exact, Kahan ε-bounded,
  non-monoidal aggregates fall back gracefully. Genuinely principled,
  not engineering hack.
- **Composition story is mostly solid**: one documented footgun
  (mutable values), the rest composes cleanly.
- **Implementation has a clear blocker**: the engine's auto-track
  dep-management model conflicts with read-skipping. A bounded engine
  refactor (static-deps fan-in with permanent links + `_writeVersion`)
  lifts the blocker and unlocks the dramatic speedup.

Worth doing eventually. **Not worth doing speculatively.** When the
demand surfaces, this file is the starting point.
