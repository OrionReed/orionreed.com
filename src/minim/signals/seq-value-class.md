# Generators / Sequences as a Value Class

A design note from two parallel "breadth-first" explorations of the
same idea: what a **generator-** or **iterator-flavoured value class**
(`Gen<T>` / `Iter<T>` / `Seq<T>`) would mean for the bireactive
signals engine, what its lenses could create, and whether it earns its
keep.

It is exploratory. **No code change has been made on the back of it.**
It is written so the design is captured explicitly if/when the work
lands. The two threads it merges:

- the **generator framing** — a coroutine as the temporal dual of a
  lens, and what that implies for the engine;
- the **iterator/combinator framing** — standard sequence combinators
  (`map`/`filter`/`sort`/`scan`/…) re-read as the writable lens kinds
  the engine already has.

They land in the same place: a sequence value class realised almost
entirely on the existing complement-carrying (stateful) lens path that
`Str` already proves out — i.e. **plausibly zero engine changes** for
the useful core.

---

## 1. The core reframe: a generator IS a direct-style stateful lens

The whole engine rests on one duality (stated at the top of
`signal.ts`): forward is implicit/pull, backward is explicit/push. A
lens is `(fwd: A→B, bwd: B→A)`.

A generator is the same duality rotated onto **time / sequence**: it
`yield`s (`state → Y`) and is resumed (`I → state`). The single
expression `const input = yield output` is *exactly* a lens's fwd/bwd
pair, fused at one syntactic point and **iterated**.

So the slot a generator fills in the algebra:

> **`Gen` is the Kleene-star of `Lens`.** Lens : Gen :: statement :
> loop. A plain `.lens(fwd, bwd)` is the stateless one-shot; a
> generator is the looped, state-threading version.

And the engine already has the defunctionalised form of exactly this —
the complement-carrying stateful lens. `Str`'s `complementLens` helper
is a hand-rolled coroutine:

```ts
Str.lens([parent], {
  init: ([s]) => record(s),                  // seed the locals
  step: ([s], c, external) => external ? record(s) : c,  // advance state
  fwd:  ([s]) => project(s),                  // the yield
  bwd:  (target, _s, c) => ({ updates: [reconstruct(target, c)], complement: c }), // the resume
});
```

The complement is "memory the view discards" — i.e. the suspended
generator frame turned inside-out into an explicit record because there
was no other way to hold it. A `function*` would let you write the same
machine in direct style with local variables; the frame *is* the
complement.

## 2. The new terrain: the backward-sequence quadrant

What the engine can fold over today:

|                     | over **space** (N cells)            | over **sequence** (N writes) |
| ------------------- | ----------------------------------- | ---------------------------- |
| **forward** (pull)  | `derive([a,b], …)` computed-N       | —                            |
| **backward** (push) | `merge` policy / multi-parent split | **← empty**                  |

`merge` folds backward contributions across *contributors*. Nothing
folds backward across *the history of writes to one cell*. A generator
fills that quadrant: its forward value is a function of the **whole
write history**. That unlocks backward semantics impossible as pure
lenses — ratchets/monotone cells, hysteresis, debounce-by-count, undo
stacks, incremental bidirectional parse/print (the parked parser
continuation is the incremental state).

Plus two shapes only generators give:

- **Linear / affine cells** — generators `return`; a returned cell is
  *spent* and freezes (expose `done: Bool` via the `Num#isEven`
  lazy-getter bridge). A reactive value with a finite write budget:
  one-shot latch, fuse, commit-once-then-immutable node. New capability
  for the constraint/`network` graphs (topology as a function of
  write-history; self-rewiring via `done`).
- **Protocol / session cells** — a generator with `if`/`while`/early-
  `return` is a state machine whose *control flow* branches on inputs.
  The cell enforces a legal *sequence* of writes, not just a legal
  *value*. Session types inside a signal graph.

## 3. The unification (conceptual, not necessarily runtime)

Pushed to its limit, a single generator primitive subsumes the engine's
three exotic backward modes:

- yield a **tuple**, resume with a tuple ⇒ **multi-parent lens** (split).
- **accumulate resumes before yielding** ⇒ **merge** (`let acc; while(1) acc = combine(acc, yield acc)`).
- thread one local across yields ⇒ **stateful lens**.

So `BwdSpec`'s `{ parent | merge | stateful }` union is plausibly the
**defunctionalised fast-paths of one coroutine**. You'd never ship "a
frame per cell" (too heavy), but it gives a single semantic story the
specialised fast paths *implement*. Recontextualises the "sugar vs
foundation" question: the generator may be the foundation, and
merge/lens/stateful its hand-optimised specialisations.

## 4. The crux: state-based → history-based reactivity

Everything interesting and everything dangerous comes from one shift.
The engine assumes **a cell's value is a pure function of its sources'
current values** — that's what makes `_update` re-runs, `checkDirty`
speculation, and the fixpoint flush safe.

A generator's value depends on the **path**, not the position. The
reconciliation: the generator frame is *complement* — engine-owned
state, so the cell stays referentially transparent if you treat the
frame as part of its identity. But raw JS generators are **one-shot,
non-clonable, irreversibly mutated by `next()`** — you cannot speculate
through them. So the design fork you can't avoid:

- **Commit-only advancement.** Advance the frame *only* in the
  finalised backward commit; every speculative read (`settled`, the
  GetPut no-op check) uses the *cached last yield*. More expressive
  (protocols, linear cells, true non-idempotence) but you owe a
  soundness proof.
- **Replayable folds.** Restrict to generators that are secretly folds
  (`{init, step, fwd, bwd}` with the complement implicit). Pure,
  checkpointable, **slots into the existing stateful path with zero
  engine change**. This is the safe, immediately-buildable choice and
  the basis of `Seq<T>` below.

Note: **disposal == replayability** seen twice. An unwatched `Gen`
should `gen.return()` (release the frame). Replayable ⇒ re-subscription
replays the log; non-replayable ⇒ an unwatched `Gen` is spent.

A second invariant generators force: **advance-count determinism.**
Glitch-freedom today = "no inconsistent value combination seen." A
history cell adds "the frame must advance exactly once per settled
write." The cure already exists for another purpose — the `_queueIdx`
last-write-wins bwd-queue coalescing — but it gets promoted from
optimisation to **correctness requirement**.

Consequence: the graph gets **two-coloured** into pure (speculatable,
full alien-signals speed) and stateful (commit-only) regions, with the
hazard being transitive (a `Gen` downstream of a non-idempotent cell
inherits the constraint). A "history-dependent" marker that propagates
through the graph is the key new metadata.

## 5. The combinators ARE the lens vocabulary

The heart of the concrete design. Each standard sequence combinator
maps onto exactly one writable lens kind already in the engine, and the
lens's **complement is precisely the information the combinator
destroys**. `Str` is essentially `Iter<word>` with bespoke complements
(`parseWords`/`rebuildWords` separators; the case mask). Generalising
off `string` to `readonly T[]`:

| combinator             | lens kind (existing machinery)        | complement = what's destroyed                  |
| ---------------------- | ------------------------------------- | ---------------------------------------------- |
| `map(f)` invertible    | pure endo `.lens(f, f⁻¹)` — **fuses** | nothing                                        |
| `map(f)` lossy         | `complementLens`                      | per-element recovered data (cf. `lowercase`)   |
| `reverse`              | involution `.lens(rev, rev)` — fuses  | nothing                                        |
| `filter(p)`            | `buildStateful`                       | **interleaving** of dropped elements (cf seps) |
| `take/drop/slice`      | `complementLens`                      | sliced-off tail/head (cf. `trim` lead/trail)   |
| `sort(cmp)`            | `buildStateful`                       | the **permutation** (cf. `sortedUnique`)       |
| `dedup/unique`         | `buildStateful`                       | duplicate run positions (cf. `sortedUnique`)   |
| `zip / concat`         | multi-parent `buildLensN` + split     | which parent each element came from            |
| `scan` invertible step | endo lens over a group                | nothing (!) — see below                        |
| `reduce` to scalar     | read-only `derive` (or merge)         | everything — generally not invertible          |

Three are worth singling out because they're genuinely elegant, not
just mechanical:

### filter as an interleaving prism

Near-exact replay of `parseWords`. Forward drops elements failing `p`;
the complement records the dropped elements *and positions* so a write
to the filtered view splices back in place. "Show only incomplete
todos, edit one, the completed ones stay exactly where they were."
Reactive predicate (a threshold `Num`) is where it gets lively.
**Rejection is free:** an illegal/no-op edit yields the current value,
which the `propagateBwd` GetPut stop already prunes.

### scan as an invertible group lens — ties in the trait system

Prefix-sum and adjacent-difference are mutual inverses. So `scan(+)`
over a sequence of a **group** element type (the `Linear` trait, which
gives `sub`) is a complement-free bijection sequence↔sequence:

```
fwd: cumulative   [a,b,c] → [a, a+b, a+b+c]
bwd: difference   [p,q,r] → [p, q-p, r-q]
```

`Num#add`'s invertibility lifted to a whole sequence: discrete
integral/derivative as one bidirectional lens. Edit the integral, the
deltas update. Fuses with other endo lenses for free.

### reactive infinite streams windowed by reactive `take`

With a lazy-recipe carrier (`() => Iterable<T>`, re-runnable), a
generator driven by upstream reactive params, windowed by a reactive
count, gives scrubbable infinite sequences. The pull model guarantees
`take(n)` never forces more than `n`, so infinity is safe **iff**
equality is version- or prefix-based (see §6).

## 6. The value class: `Seq<T>` — `Str` generalised off strings

Carried value `readonly T[]` (eager) or `() => Iterable<T>` (lazy
recipe). It would be the **first categorical value class**: every
existing one carries vector-space structure (`linear`/`lerp`/`metric`/
`pack`); `Seq` carries a **monoid under concatenation** (identity `[]`,
combine `concat`) — the `Composable`/`Sequenceable` trait's first
inhabitant. `yield*`-style sequencing of two coroutines is `a.concat(b)`
at the value level; the control-flow algebra and the value algebra are
the same monoid. (The animator combinators `then`/`race`/`all`, stripped
of any clock, are the categorical operations on `Gen`.)

**Equality is the defining decision** (the engine leans hard on
`_equals` to prune). Pick one before building:

- eager `readonly T[]` + structural/length equality — finite only,
  simplest, every combinator works.
- lazy recipe + **version** equality (`a.v === b.v`) — allows infinite
  streams, gives up "recompute produced the same sequence" pruning.
- lazy recipe + **prefix** equality up to forced demand `n` — matches
  the pull model, subtle.

`Cell` already takes per-instance `equals` via `super(v, { equals })`,
so this is a first-class knob.

## 7. Hazards / constraints to respect

- **Read-purity.** Reads must NEVER advance state — `peek`/`settled`
  must stay side-effect-free or the backward no-op machinery corrupts.
  Forward value = last yield, cached in `currentValue`; the backward
  pass is the only pump. (Fits bireactive perfectly.)
- **`next()` cannot live in `getter`.** `_update` re-runs getters and
  must be idempotent; advancement happens once, in the committed
  backward `put`.
- **Equality cost.** Materialising + structurally comparing on every
  propagation turns the O(1) short-circuit into O(n)/hop. Version or
  identity equality is near-mandatory for the lazy variant.
- **Write-back through infinity.** Only ever write a bounded edit (the
  forced prefix); the complement/recipe carries the unforced tail.
  `bwd` must never force the whole source.
- **No-op pruning vs counting.** The GetPut/`settled` stops eat writes
  whose visible value didn't change, so a pure `Seq` lens can't "react
  to an identical write" (counting). That needs the commit-only engine
  tier — out of scope for the zero-change version.

## 8. Does it earn its keep? The discriminating test

A demo earns the abstraction only if **both** hold:

1. the bidirectional **write-back bookkeeping** is the genuinely hard
   part (not the forward render), and
2. that hard part is **reusable** — it compounds across *composed*
   stages rather than living in one place.

A single lossy lens is always hand-rollable (`md-fourier` proves it:
`a.lens(synthesize, analyze)` + a per-bar splice is ~6 lines). The
leverage appears when **multiple lossy/permuting lenses compose and you
edit the *final* view**, because then the complements must compose and
the index bookkeeping explodes. Be suspicious of any single-stage or
read-only demo as justification.

**The make-or-break spike (~1 day, do this before building anything):**

> Stack two `buildStateful` lenses — `filter` then `sort` — as
> **separate** cells, write to the final view, assert it round-trips to
> the source.

The risk lives in `propagateBwd → forkInto → re-entrant propagateBwd`
on a parent that is *itself* a stateful lens, where each lens's
`external`-detection (`StatefulCore.lastBwd`) and the `settled` no-op
pruning must behave through the chain. Tell-tale: `Str.sortedUnique` is
`sort ∘ unique ∘ words` **fused into one monolithic complement**, not
three composed lenses — evidence the bookkeeping is expressible, but
also a hint it may have been monolithed because independent composition
was untested/awkward. **If two stacked stateful lenses compose cleanly,
every demo below is tractable. If you're forced to monolith each
combination, the leverage evaporates and it's not worth it.**

## 9. Demos (gated on the spike)

Earn their keep (composition + editable downstream view):

- **Filtered + sorted editable table.** `data.filter(aboveThreshold)
  .sort(byColumn)` → drag a row; the edit inverts through sort's
  permutation **and** filter's interleaving complement, in order. The
  flagship correctness proof.
- **Live data-pipeline explorable.** raw → filter → group → aggregate
  as linked views; drag any *downstream* view, ripple back to raw.
  "Spreadsheet meets lenses." Effectively impossible as bespoke code.
- **Lens-laws explorable.** GetPut/PutGet/PutPut visualised with
  filter/sort/scan as live examples. Earns its keep *because* it's
  about the framework (Foster–Pierce lineage already in the `Str`
  header).

Beautiful but DON'T use as justification (single-stage / read-only):

- **Bidirectional integral** (`scan` as fundamental-theorem-of-calculus;
  drag the curve ↔ drag the slopes). One invertible lens — build it
  because it's pretty, not to validate the framework. Strong fit beside
  `md-fourier` / `md-curve-bases`.
- **Edit-through-sort** with visible permutation connector lines —
  great teaching of "complement = discarded structure," still one lens.
- **History scrubber on `md-sketchpad`** — `Seq<Snapshot>` + a `cursor`
  field lens; scrub/branch. Cheapest "wow," reuses existing code, sells
  "history is a value you lens into."
- **Case-preserving glossary** — finish the `Str.sortedUnique`
  Foster/Pierce demo (edit one glossary entry, every occurrence in the
  prose rewrites keeping its own casing). ~90% built already.
- **Read-only generative streams** (primes, φ/π convergents, L-systems,
  cellular automata via `scan`, fountain/Luby codes windowed by
  `take`). Lovely, but they exercise `Iter`-as-read-only, not the lens
  half.

## 10. Lineage

This is **Boomerang generalised from strings to arbitrary element types
via traits** (the `Str` header already cites Foster/Pierce). The
`buildStateful` complement IS their asymmetric-lens complement; the
multi-parent split is the symmetric-edit-lens move. Two threads to pull:

- **Symmetric edit lenses** (Hofmann/Pierce/Wagner) — propagate
  *edits*, not states. The engine is state-based, but a sequence is
  precisely where edit-propagation (insert/delete/move) would
  outperform recompute.
- **Incremental dataflow** (differential dataflow; Jane Street
  `Incr_map`) — `filter`/`map`/`join` over *changing* collections by
  delta. The natural "v2" once the state-based version exists.

## 11. Verdict & next step

Pursue it, **but gate it on the two-stacked-stateful-lens spike.** Don't
write the table or pipeline demo until that round-trip passes. The
replayable-fold `Seq<T>` is an ergonomics + composition win over what
exists today at (plausibly) zero engine cost; the commit-only generator
tier (linear cells, protocols, true non-idempotence) is a separate,
clearly-scoped future engine project that this note deliberately leaves
out of the critical path.
