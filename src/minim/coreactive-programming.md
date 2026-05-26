# Coreactive Programming

The conceptual foundation of `@minim/signals`: what the substrate *is*,
why it is shaped the way it is, and how the shape is realised in code.

This document has two parts. **Part I — Theory** is implementation-free:
it describes the paradigm, the central result and what the
substrate can model. **Part II — Implementation** describes how the theory is  
realised — the lens cell, fusion, the cost model, and the open design  
questions.

# Part I — Theory

## 1. The one-sentence claim

Reactive programming is the *forward, acyclic fragment* of a larger
paradigm. The larger paradigm is obtained by making every dependency
edge a **lens** — a derivation bundled with its inverse — so that
information flows both ways across the same edge. We call this
**coreactive programming**.

A standard reactive system is a directed acyclic graph (DAG) of cells.
Edges mean "reads". Information flows one way: leaf to root, input to
output. A cell is permanently either an input (writable) or an output
(derived, read-only).

A coreactive system keeps the DAG, keeps the acyclicity, keeps the
glitch-free propagation — but every edge now carries a `put` as well as
a `get`. A derived cell can be *written*; the write flows back up the
edge and updates the source. No cell is permanently an input or an
output. You can drive either end.

> Naming note. The "co-" is the *lens dual* — `put` against `get` — and
> is unrelated to the comonadic "co-" of Uustalu & Vene's comonadic
> dataflow or Petricek's coeffects, where "co-" denotes a *temporal*
> dual (a value depending on its past or neighbours). 

## 2. The central result: edge-local bidirectionality

> **A derivation graph can be made fully bidirectional — every edge**  
> **traversable both ways — without becoming a cyclic constraint system.**  
> `put` **remains a bounded, one-way, upstream write.**

This is worth stating carefully because the obvious assumption is the  
opposite. "Bidirectional" intuitively suggests "the graph is now  
symmetric or cyclic, so it is a constraint network, so it needs a solver." [NOTE: strawman, should update]  
That is **graph-global bidirectionality** — no edge has a direction, the  
whole graph is one mutual relation, and satisfying it requires  
iteration to a fixpoint. Constraint systems work this way and pay for  
it.

Coreactive programming achieves **edge-local bidirectionality**
instead. Each edge *independently* carries both directions. The graph
stays a DAG; it stays oriented; `get` still flows leaf-to-root and
`put` still flows root-to-leaf along *individual* edges. Bidirectionality
is a property *of each edge in isolation*, not a property of the graph
as a whole.

The three regimes, by topology:


| Regime                   | Edges                         | Termination          |
| ------------------------ | ----------------------------- | -------------------- |
| Reactive (Solid, Vue, …) | one-way                       | acyclicity           |
| **Coreactive**           | **bidirectional, edge-local** | **acyclicity**       |
| Constraint system        | bidirectional, graph-global   | fixpoint convergence |


The middle row is the unoccupied corner that minim's lens tier fills.
It is the source of the performance story: a constraint system is slow
because *every* update may require global re-satisfaction; a coreactive
`put` is fast because it is one bounded upstream write down a DAG.

## 3. Equivalence to Reverse AD

A natural objection: "this is just reverse-mode automatic  
differentiation / a separate backward propagation pass, rephrased."

**Equivalence.** The lens-factored DAG (each edge `(get, put)`) computes  
the same class of relationships as a formulation with a separate  
forward computation and a separately-specified backward pass. This is  
the content of the known result that reverse-mode AD *is* a lens  
(profunctor-optics literature; "Backprop as Functor"). Nothing  
representable by separate forward/backward propagation is unreachable  
by composed lenses.

[Note: mehhh is this true?:]

**Superiority.** Equivalence of *computed results* is the weakest
equivalence. The two formulations differ as engineering artifacts, and
every difference favours the lens factoring:

1. **Locality of authorship.** A separate backward pass is a *global*
  object the framework coordinates; its correctness is a whole-graph
   property. A lens bundles `get` and `put` *at the edge*; the lens
   laws are *local* obligations on each edge, and lawful edges compose
   to lawful chains. Correctness becomes local and compositional.
2. **Single structure, no drift.** A separate backward pass is a
  *second structure* that can fall out of sync with the forward graph.
   A lens edge is *one* structure traversed two ways. There is nothing
   to keep synchronised because there is only one thing.
3. **The backward direction free-rides the forward engine.** Because
  `put` bottoms out in the engine's ordinary write path, it inherits —
   for free — every optimisation the forward engine already has:
   equality short-circuiting, glitch-freedom, batching, dirty-tracking.
   A separate backward pass must re-implement all of these.
4. **Composition is automatic.** Lenses compose by construction
  (fusion, Part II §3). Making a separate backward pass compositional  
   is the hard part of every such system. [Note: is this true? points 1,2,3 feel like they are correctness criteria that any other implementation with a backwards pass would need to do correctly, so i dont think they hold up, and its not clear that they CANT be as performant, or CANT be implemented well in languages like JS, but maybe so... need better research here to explore these claims]

The contribution is therefore **architectural, not expressive**: the
backward direction is local, single-structure, and free-riding, where
the alternative is global, dual-structure, and separately optimised.

## 4. What the substrate can model

### 4.1 The lens/fixpoint dichotomy

Define a relationship to be **lens-factorable** if it has a `put` that
is:

- **total** — defined for every value of the view that the view itself
admits;
- **single-pass** — computable in bounded steps, no iteration to a
fixpoint;
- **local** — needs only the written value and the current source(s),
nothing global.

Then:

> **Every relationship is either lens-factorable — in which case it is**  
> **an edge in the DAG (the lens tier) — or it is not — in which case it**  
> **requires the fixpoint tier.**

Modelling of non lens-factorable computation (fixpoint convergence) is addressed in (§5).

### 4.2 The three lens disciplines

We can sort lenses by how their forward map treats information:

1. **Invertible edges.** `f` is a bijection; `put` reconstructs the
  source exactly. `add(k)`, `scale(k≠0)`, affine maps, coordinate-frame
   and unit conversions. `put` does not even need the old source.
   Satisfies all lens laws. Composes and fuses perfectly. The heart of
   the tier.
2. **Residual edges.** `f` discards information, but the discarded part
  is still present in the live source, so `put` reconstructs by
   reading it back. `field(parent, "x")` (spread-replace, reading the
   other fields), `centroid`, `mean`, `pulleySum` (distribute-delta,
   reading the current configuration). The classical *constant-
   complement* lens. Modelable exactly when the
   complement is live-readable from the source.
3. **Idempotent edges.** `f` discards information that is *gone* from
  the source, and `put` does not reconstruct anything — it *projects*:
   it snaps the source into a constrained subset, idempotently
   (`put∘put = put`). `clamp`, `quantize`, `onLine`, `onCircle`,
   `snap`. The conceptually important class: **an idempotent edge is a
   constraint whose projection has a closed form, absorbed into a
   single edge.** It is a constraint that costs nothing — it never
   reaches the fixpoint tier because projecting onto its admissible set
   is a one-step closed-form operation.
4. [note: what about symmetric lenses?]

In §4.1: the fixpoint tier is needed not for "all constraints" but specifically for  
**constraints whose projection has no closed form** — a four-bar  
linkage, a coupled nonlinear system. A circle is a lens; a linkage is a  
fixpoint region*.  
  
[note:* depends on the linkage]

### 4.3 The two axes [note: i dont think we need this section]

[NOTE: i think all the mentions of fixpoint stuff dont need to be woven in, not as a first-class "tier" really...]

The full space has two decidable axes:

- **Is the inverse lens-factorable?** Yes → lens. No → fixpoint.
- **Is there an inherent direction at all?** A *function* has a
primary end (a lens, if factorable). A *relation* (`a+b = c+d`,
conservation laws, geometric constraints) has no primary end and
always needs the fixpoint tier.

Four quadrants:


|                    | Directed                                                                                               | Undirected                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Factorable**     | **Lens.** Coordinate changes, field access, affine views, closed-form aggregates. Fast, lawful, fuses. | Symmetric-but-factorable relations (`eq`). Small but real.                      |
| **Non-factorable** | Fixpoint region, directional regime. IK: tip is the view, joints the source, but the inverse iterates. | Fixpoint region, relational regime. Pulleys, conservation, physical simulation. |


### 4.4 Ergonomics is a gradient [note: meh on this section]

*Correctness* coverage is total — the fixpoint tier is universal, so
everything is modelable. That is true and uninformative.

*Ergonomics* is the real measure, and it is a smooth gradient that
**aligns with** the conceptual gradient — the sign of a good
abstraction:

- Invertible lens — zero overhead. Write the forward map; the inverse
is obvious.
- Residual lens — small overhead. A standard distribute-delta `put`.
- Idempotent lens — small overhead. A projection.
- Fixpoint region, directional — moderate. Declare reads/writes, trust
a fixpoint, accept the cost.
- Fixpoint region, relational — most. Strengths, convergence,
divergence handling.

The easy things are easy; the hard things are possible; the boundary
between them is a real property of the problem, not an artifact of the
API.

## 5. Why the fixpoint region is necessary, not bolted on [note: meh on this section existing, and also, why wouldnt this apply just as much to normal reactive systems? i do like some of the prose here though on fixpoint regimes, though it spends far too much time justifying its own existence. other note: i dont think we need the context of 'tier' in this doc]

The lens tier's guarantees rest on one precondition: **every edge has a
`put` that is a bounded single-pass function.** Ask when an edge *fails*
that precondition. Exactly three cases, and they are exhaustive:

1. The forward map is **non-injective and the lost information is
  unrecoverable** — `put` would have to invent information. No
   function can.
2. The forward map is **not invertible in closed form** — an inverse
  exists but is only reachable by iteration. Not single-pass.
3. There is **no forward map at all** — the relationship is a symmetric
  relation, no end is the source. Not even function-shaped.

In all three cases the lens tier *cannot represent the relationship* —
not "represents it poorly", cannot, because its load-bearing assumption
is violated. And the three cases are precisely the negation of
lens-factorability (§4.1).

Therefore the fixpoint region is not a feature added alongside lenses.
It is the **uniquely determined shape of everything that is not a
lens**. Given the dichotomy, once you commit to "edges are lenses," the
fixpoint region is *forced* — it is the completion of the architecture,
the way the irrationals complete the rationals.

This also fixes the fixpoint region's *minimal interface*: it must do
exactly, and only, what the lens tier cannot — reach a consistent
assignment over a set of cells with no functional inverse and possibly
no direction, by iteration. That is the spec. Propagators, an AVBD
solver, a relaxation loop — these are interchangeable *implementations*
of that one spec. The `network()` primitive is the substrate's name for
"a cyclic region governed by such a regime."

## 6. The topological picture

Three tiers, exhausting the shapes a dependency graph can take:

- **DAG of one-way edges** — ordinary computed signals. Termination by
acyclicity.
- **DAG of bidirectional edges** — lenses. *Still* a DAG, *still*
acyclic; each edge's `put` is a bounded upstream write. Termination
still by acyclicity. (The central result, §2.)
- **Cyclic regions under a fixpoint regime** — networks. Termination by
a convergence/exclusion contract that *replaces* acyclicity.

A reactive system's identity is *what topology it admits and how it
guarantees termination over that topology*. The three tiers exhaust
that question — one-way, bidirectional-acyclic, cyclic — which is why
the picture feels complete: it is.

## 7. Problem spaces [note: can drop this section]

The substrate's natural applications are the cross-product of the
topology with a domain. The diagnostic for a strong fit: a problem
where the current pain is that *the relationship between two
representations is maintained by hand-written, separately-authored,
drift-prone forward and backward code* — often with one direction
missing entirely, replaced by the user doing it in their head.

- **Interactive diagrams** — every element manipulable because the
relationships are lens edges. (The native demo.)
- **Editable projections** — a canonical model edited *through* a
derived view: timelines over event data, HSL sliders over an RGB
swatch, tables over a database.
- **Parametric design** — a model where the *outputs* are also
grabbable. CAD-lite, design-by-outcome.
- **Inverse-problem UIs** — calculators where you grab the *answer*:
retirement target → contributions, macros → ingredients, contrast
ratio → colours. A large, almost entirely unserved space, unserved
precisely because every framework's `computed` is one-way.
- **The document/code round-trip problem** — a structured artifact and
a projection of it (rendered prose ↔ AST, visual editor ↔ code),
edits to either side reflected in the other. A decades-old, genuinely
unsolved problem; bidirectional-transformation theory addressed it
but never had a reactive runtime to live in. The coreactive substrate
is a candidate for that runtime.
- **Live, manipulable simulation** — reach into a running simulation
and drag the state; constraints re-satisfy. Animation that is also
interaction.
- **Bidirectional data sync** — multiple representations kept
consistent without hand-written per-pair reconciliation.

The unifying observation: the pain is always the same pain. Two
representations, related by a rule, the relationship smeared across
hand-written getters and setters that drift. Coreactive programming
makes the *relationship* the unit of authorship — written once,
traversed both ways.

---

# Part II — Implementation

## 8. The lens cell

There is no separate `Lens` class. A `Signal<T>` is one cell in one of
three modes, determined by which fields are populated:


| Mode     | `getter` | `setter` | Truth                     |
| -------- | -------- | -------- | ------------------------- |
| signal   | unset    | unset    | `currentValue`            |
| computed | set      | unset    | `cachedValue` (lazy)      |
| lens     | set      | **set**  | the parent's stored value |


A lens is the third mode: a writable view. It stores no truth of its
own — the truth is the root signal's. It holds a *cache* of its last
computed value (§10), and a `getter`/`setter` pair.

Every lens operation — `.add(x)`, `.lens(f, g)`, `field(p, "k", C)`,
`Cls.derive(...)` — returns a **real, first-class, fully-installed
`Signal*`*. It has its own value, type, getter, setter, cache, and
subscriber list. There is no deferred or virtual cell, and no
"materialise" step. `a.add(x)` is a real node the instant it returns.

## 9. Fusion is edge re-rooting, not node merging

"Fusion" is a misleading name for a precise and narrow mechanism. It
does **not** merge cells. Every cell in a chain stays alive and
first-class.

What it does: **when a lens is built on top of another lens, the new
cell is re-rooted onto the original root signal, and it absorbs the
intermediate's transform into its own composed closures.**

Worked example. `a = vec(0,0)`, `b = a.add(x)`, `c = b.add(y)`:

- `b` is a real cell; `b._fusedOf.parent === a`.
- `c` is a real cell; `c._fusedOf.parent === a` — `**a`, not `b`.**
- `c`'s getter is `composedFwd = s => f_c(f_b(s))`.
- `c`'s setter inverts `g_b ∘ g_c` straight onto `a`.
- `a` has two subscribers: `b` *and* `c`, both directly.

The dependency graph is a **star**, not a chain. A logical chain
`a → b → c` of lenses is realised as `a → b` and `a → c`, where `c`'s
single edge carries the *composed* transform of the whole chain.

So "fusion" fuses the *edge*, collapsing a multi-hop dependency into one
re-rooted edge with a composed closure. It does not fuse nodes.

### 9.1 Consequence: fused chains do not share subexpressions

Because `c` is re-rooted onto `a` and recomputes `f_c(f_b(a))` itself,
`**c` does not use `b`'s cached value.** When `a` changes, `b` and `c`
are both marked dirty; reading `b` computes `f_b(a)`; reading `c`
computes `f_c(f_b(a))`, recomputing `f_b(a)` *again* inside its own
composite.

If you hold and read both `b` and `c`, the shared transform `f_b` runs
**twice** per change of `a`. This is correct (the result is always
right) but it trades subexpression-sharing for graph-flatness.

The trade is:

- **Right** when the intermediate is *private* — `a.add(x).add(y)` as
one expression, the `add(x)` result never bound. Nobody reads it; its
cache would never be hit; flattening removes a useless hop.
- **Wrong** when the intermediate is *shared* — out-degree ≥ 2. Then it
is a genuine common subexpression and should be a materialised node
whose cache both consumers read.

The principle: **fuse a chain segment iff every node in it has
out-degree 1.** Currently fusion is unconditional — every chained
`.lens()` fuses regardless of out-degree (§13, open).

### 9.2 Captured state is root-derived, so deleting intermediates is safe

A fused cell is **closed**: it depends only on the root signal and the
pure function values it captured at construction. `c`'s closures
capture `f_b` (the *function*, copied out of `b._fusedOf`), `f_c`, and
`a` — they do **not** capture `b` the object. `b` can be garbage
collected and `c` is unaffected.

The stateful-`bwd` `s` parameter does not break this. In the composed
stateful setter, "the intermediate's value" is obtained as
`priorFwd(parent.peek())` — *recomputed from the root through the
copied forward closure*, never read from the intermediate cell. The
invariant: **a stateful `bwd` always receives root-derived state, never
an intermediate cell's value.** Deleting intermediates therefore cannot
break a stateful chain.

(The symmetric lens is the deliberate exception: its complement is
retained mutable state — but it lives in `SymmetricMeta` on the *fused
cell itself*, not on an intermediate, so the invariant holds.)

## 10. The cache, and write-priming

Every computed/lens cell has a `cachedValue`. While the root is
unchanged, lens reads hit the cache — a lens read is as cheap as a
computed read. When the root changes, the lens is marked `Pending`/
`Dirty` and recomputes once, lazily, on next read.

A cell *must* cache, for two reasons: it must be a graph node (lenses
are writable, and only nodes have a `put` site and a subscriber list),
and nodes must cache to keep propagation `O(changed set)` rather than
`O(reads)`.

**Write-priming** (optimisation, see §13). After `view.value = v`, the
view is dirtied and will recompute its `get` on next read — rediscovering
a value already known. `put` could instead *prime* the view's cache and
mark it clean. The correctness rule is exact: prime with
`fwd(put(v))` — the value `put` already computed on its descent, which
equals `v` for an iso lens and the projection of `v` for a lossy one —
*after* the root write commits, on the *endpoint only* (priming interior
nodes conflicts with fusion, which discarded them). It is a
constant-factor latency win on the hot read-after-write path, not an
asymptotic one.

## 11. Lossy lenses and the agreement set

An idempotent/lossy lens need not have `fwd` and `bwd` agree
numerically — they may be different functions over different domains
(e.g. a saturating unit conversion). What they *must* agree on is the
**agreement set**: the set of values the view can *produce* must equal
the set it can *round-trip*.

Formally, a lossy lens is well-behaved iff, for every `v` the view
admits, `get(put(v)) = v`. A lens whose forward image and
put-round-trip image differ (e.g. `fwd` clamps to [10,100] but `bwd`
clamps to [5,50]) is **ill-formed**, not "asymmetric lossy": writing
`80` — a value the view advertised as valid — reads back `50`. PutGet
fails on the view's own admitted domain.

`laws.ts` should compute the agreement set first, then check PutGet on
it. A lens with an empty or undersized agreement set should fail
loudly — under fusion it poisons everything composed on top of it.

## 12. Cost model

A `put` to a depth-`D` fused chain costs:

- **Inverse descent** — `O(D)` arithmetic, fused inline into one
closure. `D` is *syntactic chain depth* — how long a method chain the
author typed — not a graph-size quantity. Effectively `O(1)`.
- **Root write + equality check** — `O(1)`.
- **Forward-cone refresh** — `O(|genuinely-changed cone|)`. The only
unbounded term, and it is *not* a cost of bidirectionality: a one-way
`signal.value = x` observed by the same `k` nodes pays the identical
`O(k)`. It is the cost of the answer being different.

So: a `put` is `O(D + |changed cone|)`, `D` syntactic-small, the cone
term irreducible and shared with one-way reactivity. **Bidirectionality
carries no asymptotic penalty.**

### 12.1 Why intermediate commit cannot help

A tempting optimisation: have `put` commit at an intermediate node and
stop, rather than descending to the root. It cannot strictly improve on
root-commit:

- If the inverse maps the write to a root value equal to the current
one, the **root equality check** already halts propagation — zero
refresh. Intermediate commit saves nothing.
- If the root value genuinely changes, every other branch off the root
*genuinely depends on the new value* and must refresh for
correctness. Intermediate commit that skips them *forks the truth* at
a non-dominator — incorrect.

So whenever intermediate commit would help, it is wrong; whenever it is
correct, the equality cutoff already delivered the saving. Root-write
plus two-sided equality cutoffs (at the root write and at every
downstream computed's recompute) is **already at the asymptotic
optimum**: every node that recomputes did so because its value really
moved.

### 12.2 Allocation

A depth-`N` chain currently allocates: `N` full `Signal` objects, `N`
`_fusedOf` records, `2N` leaf closures, `2N` composed closures, `N`
subscriber links into the root. All `O(N)`, nothing quadratic — but in
the chained-expression case `N−1` of the `Signal` objects are
*immediately unreachable garbage* (constructed, wired as a root
subscriber, never referenced). The composed getter is also a closure
stack `N`-deep — fusion removes node-hop indirection but the composed
`fwd` is still `N` nested calls.

## 13. Open design questions

- **Out-degree-aware fusion.** Fusion is currently unconditional. The
correct policy (§9.1) fuses only out-degree-1 segments and
materialises fan-out points so subexpressions are shared. Out-degree
is not known at construction time and evolves as subscribers are
added; a principled implementation is *lazy re-rooting* — build the
shared `a → b → c` chain, and collapse `b` away only once the engine
observes it has a single subscriber.
- **Descriptor / lazy-materialisation.** In `a.add(f).add(f).add(f)` as
a single expression, the intermediates are *provably unreferenceable*
— no binding escapes. They need not be built as real `Signal`s at
all. `.add` / `.lens` could return a lightweight **pending-lens
descriptor** (just the composed `{parent, fwd, bwd, stateful}`),
accumulating under chaining, and **reify to a real `Signal` lazily**
on first observation as a node (read in an effect/computed, `.value`
touched, passed to an animator/propagator). Forcing must be memoised
so a descriptor used twice still reifies once.
  This eliminates the `N−1` wasted allocations of §12.2 *and* dissolves
  the out-degree question: a chained-through intermediate is never
  forced and never becomes a node; a *bound and used* intermediate is
  forced into a shareable node by the act of using it. "Was the
  intermediate referenced" becomes observable — referencing it is what
  forces it. The out-degree-1 policy stops being a guess and becomes a
  consequence of evaluation order.
- **Arity-based statefulness inference.** A `bwd`'s statefulness is
currently inferred from `Function.length` (`≥ 2` → stateful). A
default parameter silently changes arity and misclassifies. Replace
with an explicit signal — a flag, or two differently-typed methods —
so the type system catches the mismatch.
- **Law-checking fused chains.** `laws.ts` checks primitive lenses.
Fusion *composes* lenses; the law tests should also run against fused
chains, where a closure-composition bug would hide. (Lawfulness is
preserved by composition in theory — iso∘iso = iso, the lossy/
numerical classes follow the weakest-layer rule — but the test
should pin the implementation.)

## 14. Glossary

- **Coreactive programming** — reactive programming where every
dependency edge is a lens; reactivity paired with its lens-dual.
- **Edge-local bidirectionality** — bidirectionality as an independent
property of each edge; the graph stays an oriented DAG. Contrast
*graph-global bidirectionality* (constraint systems).
- **Lens-factorable** — a relationship with a total, single-pass, local
`put`. The decidable property partitioning the lens tier from the
fixpoint tier.
- **Invertible / residual / idempotent edge** — the three lens
disciplines (§4.2): exact inverse / complement read back from the
live source / closed-form projection.
- **Fixpoint region** — a cyclic sub-graph deliberately exempted from
acyclicity, governed by a convergence regime instead; minim's
`network()`. Necessary by exhaustion (§5).
- **Fusion** — edge re-rooting: a lens built on a lens is re-rooted
onto the original root with composed closures. Not node merging
(§9).
- **Agreement set** — for a lossy lens, the set of view values that
round-trip; must equal the view's producible set for the lens to be
well-formed (§11).

