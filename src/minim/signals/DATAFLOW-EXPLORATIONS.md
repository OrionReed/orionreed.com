# Dataflow Explorations

Companion to [`BIDIRECTIONAL-LENSES.md`](./BIDIRECTIONAL-LENSES.md). That doc
describes the lens algorithm as it exists; this one is a notebook of
explorations into how the system could grow. **None of this is implemented.**
Read this when thinking about cycles, transactions, lattice cells, or edit
lenses; ignore it when shipping features.

For the specific design exploration around incremental aggregates (the
algebraic story, the engine extension that was prototyped and reverted,
and the deeper engine change that would unlock the perf win), see
[`INCREMENTAL-AGGREGATES.md`](./INCREMENTAL-AGGREGATES.md).

---

## 1. What `network()` actually does

The `network()` primitive bundles four orthogonal concerns. Each is useful
on its own; users today reach for `network()` because it's the only tool
that covers any of them.

| Concern | What it does | Why you want it |
| --- | --- | --- |
| Self-write tolerance | Writes inside the body don't re-trigger the body | Cycles don't loop |
| Atomic commit | Downstream sees one final value | Glitch-free; effects fire once |
| Coalesced cascade | N internal writes don't fire N propagations | Solver loops run un-reactive-fast |
| Subscribed body | Body re-fires on dep change | The body itself is reactive |

Two observations:

1. The first three are **scope concerns**: "inside this scope, propagation
   is deferred." `batch()` already covers atomic commit and coalesced
   cascade for synchronous writes. Self-write tolerance is the only
   genuinely cycle-related thing.
2. The fourth is **what `network()` is uniquely for**: an effect-like
   body that mutates the cells it reads. Without the bundled scope
   semantics, this is just `effect()` with sharper teeth.

The AVBD solver case (pack → solve → unpack) only needs concerns 2 and 3.
It uses `network()` today because there's no cheaper alternative. A naked
`batch(() => solver())` would be the right tool.

---

## 2. Adjacent systems (the lineage)

Where minim sits in the wider design space of cyclic reactive systems:

| System | Cycle handling | Notes |
| --- | --- | --- |
| Solid / Vue / MobX / Preact / TC39 signals | **Forbid** writes in effects | Single-source-of-truth; cycles considered an antipattern |
| minim `network()` | Self-exclusion per body | Termination informal; no convergence proof |
| [Fluid Signals](https://ponder.org.uk/docs/fluid-signals/) (Antranig Basman) | Per-edge `_consumedSources` + source-tagged writes | Auto-fits coalesce overlapping cascades |
| [Propagators](https://dspace.mit.edu/handle/1721.1/44215) (Sussman/Radul) | Monotonic merge on join-semilattice cells | Convergence by construction; no cycle-break needed |
| [Esterel / Lustre](https://www.di.ens.fr/~pouzet/cours/mpri/synch_ProcIEEE_2002.pdf) | Static causality analysis | Compile-time proof that cycles are constructive |
| [Naiad / differential dataflow](https://sigops.org/s/conferences/sosp/2013/papers/p439-murray.pdf) | Partially-ordered timestamps | Production-grade; cycles via iteration counter |
| [Bloom / CALM](https://cacm.acm.org/research/keeping-calm/) | Monotonicity ⇒ coordination-free consistency | Theoretical foundation |

Fluid Signals is the closest live cousin to minim's `network()`. Key
differences:

- Per-edge `_consumedSources` (finer than per-body `activeNetwork`).
- Auto-opened **fits** (implicit transactions) that coalesce when overlapping.
- Multiple `_inEdges` per cell ⇒ bidirectional pairs are two first-class
  edges, not one body that writes to both sides.
- Source-tagged writes (`set(v, {source: "scrollbar"})`) with
  `excludeSource` on effects — application-layer cycle break.
- First-time wiring trust: setting up a bidirectional pair on already-
  consistent cells doesn't mark them stale.

---

## 3. Lattice cells (CRDT-flavored signals)

A `Lattice<T>` cell holds a value from a join-semilattice `(S, ⊔)`. Writes
**merge** rather than replace.

```ts
const seen = lattice.set<N>();   // powerset lattice
seen.value = new Set([1, 2]);    // → {1, 2}
seen.value = new Set([3]);       // → {1, 2, 3}, not {3}
```

Three laws make this work:

| Law | Statement | Effect |
| --- | --- | --- |
| Commutative | `a ⊔ b = b ⊔ a` | Order doesn't matter |
| Associative | `(a ⊔ b) ⊔ c = a ⊔ (b ⊔ c)` | Grouping doesn't matter |
| Idempotent | `a ⊔ a = a` | Replay is free |

Together they give:

- **Convergence** in cycles, automatically.
- **Order-independence** of merges.
- **Determinism** of final state.
- **No need for self-exclusion** (a no-op merge propagates nothing).

If the lattice has the **ascending chain condition** (ACC — finite chains),
you also get **termination in bounded time**. "Page-freeze" guarantees are
structural, not user-discipline.

### A four-tier safety design

| Tier | Constraint | Guarantee |
| --- | --- | --- |
| 1 — Discrete | `===` or custom equals | None |
| 2 — Lattice | Merge is C/A/I | Convergence, determinism |
| 3 — Bounded lattice | Lattice + ACC | + termination |
| 4 — Monotone-fn closed | Only monotone fns over lattice cells | + composition stays safe |

Tier 3 is the sweet spot. Tier 4 needs phantom-branded `Monotone<A, B>`
function types throughout the lattice API — solid theory ([Monotonicity
Types for Distributed Dataflow](https://infoscience.epfl.ch/nanna/record/229896/files/MonotonicityPMLDC2017.pdf))
but heavy in TypeScript.

### Curated constructors

Verify the laws once; let users compose:

```ts
lattice.set<T>()              // powerset (union)
lattice.max(n: number)        // max-monoid
lattice.min(n: number)        // min-monoid
lattice.first<T>()            // first-non-null-wins
lattice.counter()             // G-counter (monotone increment)
lattice.flag()                // false → true (one-way switch)
lattice.option<T>(eq?)        // bottom = undefined
lattice.product<A, B>(a, b)   // component-wise lattice
```

User-supplied `lattice(spec)` is the escape hatch; misuse is on them.

### Bridging discrete and lattice

```ts
snapshot(l: Lattice<T>): Cell<T>          // explicit "leaving the safe zone"
liftToLattice(s: Cell<T>, spec): Lattice<T>   // explicit "entering"
```

The CALM rule expressed in the type system: stay monotonic and you stay
safe; crossing is a typed boundary.

### Use cases

- Constraint propagation (set narrowing in `propagators/`).
- Type inference (the AST cells in `md-prop-types.ts`).
- Aggregation (max-seen, has-arrived, error accumulation).
- CRDTs (any commutative+associative+idempotent merge — collaborative state).
- Self-stabilizing networks (anything with fixpoint semantics).

### Where they don't fit

UI state, animations, mouse position, form values — these are
last-write-wins. Lattice cells are for monotonic information growth, not
for "what value is the cell at right now."

---

## 4. Edit lenses (delta-based bidirectional transformations)

State lenses (today's minim) move whole values: `fwd: S → V, bwd: (V, S) → S`.
**Edit lenses** move changes: `fwdEdit: (E_p, S_p) → E_v, bwdEdit: (E_v, S_v) → E_p`.
Edits form a monoid `(E, ∘, ε)`.

Why this matters:

- **Incremental propagation**: "x changed by 5" propagates an O(1) delta
  rather than re-computing the view from scratch.
- **Multi-writer composition**: concurrent edits compose via `∘`. State
  lenses just see "the state is different."
- **CRDT bridge**: op-based CRDTs are edit lenses where edit composition
  is commutative+idempotent.

### Lineage

- [Diskin/Xiong/Czarnecki, JOT 2011](https://www.jot.fm/issues/issue_2011_01/article6.pdf) — delta lenses (asymmetric).
- [Hofmann/Pierce/Wagner, POPL 2012](https://www.cis.upenn.edu/~bcpierce/papers/symmetric.pdf) — edit lenses (symmetric, monoid edits). Same paper as the symmetric-lens basis already in minim.
- [Johnson/Rosebrugh — Unifying Set-Based, Delta-Based and Edit-Based Lenses](https://ceur-ws.org/Vol-1571/paper_13.pdf) — proves state lenses are a full subcategory of delta lenses.

### The `Editable` trait

Each value class declares an edit type and operations:

```ts
interface Editable<T, E> {
  diff:    (a: T, b: T) => E;
  apply:   (s: T, edit: E) => T;
  compose: (e1: E, e2: E) => E;     // monoid
  empty:   E;
}
```

For `Vec`: edit is `{ dx, dy }`. For `Set<T>`: edit is `{ add, remove }`.
For `Num`: edit is `{ to: number }` (trivial monoid — state-as-edit).

### Edits-as-lattice

If `Editable.compose` is commutative and idempotent (not just associative
with unit), the edit monoid is a join-semilattice. Cells with such edits
are CRDTs. The two stories — lattice cells and edit lenses — converge here.

---

## 5. The unified picture

Four tiers of cell semantics, each strictly refining the one below:

```
┌──────────────────────────────────────────────────────────────┐
│ TIER 4 — Lattice cells with monotone-fn discipline           │
│ Provably safe in cycles; composition preserves safety        │
│ Use for: type inference, constraint propagation, CRDTs       │
├──────────────────────────────────────────────────────────────┤
│ TIER 3 — Lattice cells (CRDT)                                 │
│ Convergence by construction; ACC ⇒ termination               │
│ Use for: any subgraph with cycles                             │
├──────────────────────────────────────────────────────────────┤
│ TIER 2 — Edit lenses over Editable value classes              │
│ Incremental propagation; concurrent edits compose             │
│ Use for: large structured values, undo/redo, sync             │
├──────────────────────────────────────────────────────────────┤
│ TIER 1 — State lenses (today's minim)                          │
│ Last-write-wins; informal termination in cycles                │
│ Use for: UI state, animations, the common case                 │
└──────────────────────────────────────────────────────────────┘
```

Users stay on Tier 1 by default. Library authors writing propagators or
type inference drop to Tier 3. Collaborative-editing layers reach Tier 2
or 4. Each tier is opt-in; nothing forces an upgrade.

---

## 6. Decomposing `network()` into smaller primitives

If `network()`'s four concerns (§1) are split apart:

| Want | Use |
| --- | --- |
| Cyclic 1↔1 relationship | `relate(a, b, fwd, bwd)` (Fluid-style; two edges, per-fit cycle break) |
| Cyclic N-ary relationship | propagator (existing `propagators/`) |
| Bulk atomic write | `batch(() => …)` (existing) |
| Subscribed mutating body | `network(deps, body)` (existing — narrower role) |
| Monotonic narrowing | lattice cell + monotone combinators |

`network()` doesn't disappear — it keeps its niche (subscribed body that
writes). But the perceived role shrinks because other primitives handle
the other three concerns more cleanly.

### Implicit transactions ("fits")

Adopting Fluid's fit model under the hood: any write opens an implicit
transaction; subsequent synchronous writes join; the transaction closes
when the cascade settles. Effects fire once at the end. Auto-coalesce on
overlap.

Cost: one branch per write ("is there an active fit? if not, open one").
Negligible.

Benefit: the AVBD case "just works" without `network()`, and overlapping
cascades compose rather than conflict.

### Naming

`flush()` is engine-side ("push notifications"). `commit()` is user-side
("publish my transaction"). The user-facing API should probably be
`commit()` / `transaction()`. Keep `flush()` as the internal engine
operation.

---

## 7. Speculative roadmap

In rough order of expected payoff, not commitment:

### A — Document the `network()` boundary (cheap, immediate)

Explicitly write down what `network()` guarantees and what it doesn't:
single-body termination via self-exclusion; no convergence proof for
overlapping networks; no determinism for multi-network writes. Surface
the "use `batch()` instead when you don't need a subscribed body"
guidance.

### B — Lattice cells (Tier 3) as a sibling type

`lattice.set<T>()`, `lattice.max(n)`, etc. Implementation: ~150-line
`Cell<T>` subclass with merge-on-set semantics. Curated constructors
verified by hand. Optional `isBounded` annotation.

Migrate `propagators/` and `constraints/` set-narrowing code to use
these. `network()` no longer needed for monotonic convergent computation.

### B' — Incremental aggregates

Aggregates like `centroidLens`, `meanLens`, `bboxLens` currently
re-compute fully on any input change. There's a clean algebraic story
for incrementalising them (group/monoid/lattice structure) — and a
specific engine-side blocker (auto-track dep management) that needs a
bounded refactor to unlock. Worked out in detail in
[`INCREMENTAL-AGGREGATES.md`](./INCREMENTAL-AGGREGATES.md), including
a prototype that was built and reverted.

### C — Declarative bidirectional pairs

`relate(a, b, fwd, bwd)` that installs two symmetric lenses with shared
cycle-break bookkeeping. Same as the Fluid temperature-conversion case.
Replaces `network()` for the 1↔1 case.

### D — Implicit transactions (Fluid-style fits)

Engine-level. Every write opens or joins a fit; effects fire once per
fit. `batch()` becomes a way to keep a fit open across multiple
synchronous calls.

After this, `network()` is purely the "subscribed-body" subset of effect
with self-write tolerance. The other three concerns are absorbed.

### E — Edit lenses (Tier 2)

Add `Editable` trait to value classes. `Cls.editLens(parent, fwd_e, bwd_e)`
alongside `Cls.lens(...)`. Engine learns to propagate edits instead of
states where the trait is present.

Only worth doing if a concrete use case demands incremental propagation
of large values. Elegance alone isn't enough.

### F — Tier 4 (monotone-fn type discipline)

Phantom-branded `Monotone<A, B>` types throughout the lattice API. Safe
composition by construction.

Defer until Tier 3 is well-used and the type-system friction has a
clear payoff.

---

## 8. References

Primary sources:

- Sussman & Radul, [_The Art of the Propagator_](https://dspace.mit.edu/handle/1721.1/44215), MIT-CSAIL 2009.
- Hofmann, Pierce, Wagner, [_Edit Lenses_](https://www.cis.upenn.edu/~bcpierce/papers/symmetric.pdf), POPL 2012.
- Diskin, Xiong, Czarnecki, [_From State- to Delta-Based Bidirectional Model Transformations_](https://www.jot.fm/issues/issue_2011_01/article6.pdf), JOT 2011.
- Johnson & Rosebrugh, [_Unifying Set-Based, Delta-Based and Edit-Based Lenses_](https://ceur-ws.org/Vol-1571/paper_13.pdf).
- Hellerstein & Alvaro, [_Keeping CALM_](https://cacm.acm.org/research/keeping-calm/), CACM 2020.
- Murray et al., [_Naiad: a timely dataflow system_](https://sigops.org/s/conferences/sosp/2013/papers/p439-murray.pdf), SOSP 2013.
- McSherry et al., [_Differential dataflow_](https://www.cidrdb.org/cidr2013/Papers/CIDR13_Paper111.pdf), CIDR 2013.

Live systems:

- [Fluid Signals](https://github.com/fluid-project/infusion-6/blob/main/src/framework/core/js/FluidSignals.js) — Antranig Basman. Closest cousin to `network()`.
- [Reactively](https://github.com/milomg/reactively) — Milo Mighdoll. The push/pull algorithm Fluid (and many others) builds on.
- [Lasp](https://lasp-lang.readme.io/) — distributed programming with CRDTs as first-class types.
- [Yjs](https://github.com/yjs/yjs) — production CRDT library; reference for op-based edit semantics.

Background:

- Hellerstein, [_CRDTs #2: Turtles All The Way Down_](https://jhellerstein.github.io/blog/crdt-turtles/) — the cleanest articulation of "lattice as the foundation."
- Basman, [_fluid.cell: A reactive implementation supporting malleable substrates_](https://ponder.org.uk/post/2026-02-20-reactivity-for-malleability/) — design rationale for Fluid Signals.
- Mighdoll, [_Super Charging Fine-Grained Reactive Performance_](https://milomg.dev/2022-12-01/reactivity) — the Reactively algorithm.
- Edwards, [_Coherent Reaction_](https://www.subtext-lang.org/OnwardEssay2009.pdf), Onward! 2009 — earlier exploration of the same problem space.
