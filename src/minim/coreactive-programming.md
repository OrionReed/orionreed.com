# Coreactive Programming

The conceptual foundation of `@minim/signals`: what the substrate *is*,
why it is shaped the way it is, and how the shape is realised in code.

This document has two parts. **Part I — Theory** is implementation-free:
the paradigm, the central result, and what the substrate can model.
**Part II — Implementation** describes how the theory is realised — the
lens cell, fusion, the cost model, and the open design questions.



# Part I — Theory

## 1. Introduction

Reactive programming, in the usual signal/computed sense, is the
*forward, acyclic fragment* of a larger picture. Coreactivity makes every\* dependency edge a **lens** — a derivation
bundled with its inverse — so that information flows both ways across
the same edge. **Coreactive programming** is we give to a reactive runtime whose edges are lenses.

\* When a dependency does *not* have an inverse, this is a break/partition in the backwards direction of the graph and behaves like a normal derived value.
[NOTE: what should the semantics be here? i guess you can't write to a readonly signal, which is fine...?]

A standard reactive system is a directed acyclic graph (DAG) of cells.
Edges mean "reads". Information flows one way: leaf to root, input to
output. A cell is permanently either an input (writable) or an output
(derived, read-only).

A coreactive system keeps the DAG, keeps the acyclicity, keeps the
glitch-free propagation — but every edge now carries a `put` as well as
a `get`. A derived cell can be *written*; the write flows back up the
edge and updates the source. No cell is permanently an input or an
output. You can drive either end.

The *model* underneath this — acyclic networks of edge-local two-way
constraints, with a least-change discipline on the backward direction —
is not new; see §3. What this document describes is one realisation of
it as a push-based reactive engine.

> Naming note. The "co-" is the *lens dual* — `put` against `get` — and
> is unrelated to the comonadic "co-" of Uustalu & Vene's comonadic
> dataflow or Petricek's coeffects, where "co-" denotes a *temporal*
> dual (a value depending on its past or neighbours).

## 2. Edge-local bidirectionality

The structural fact the engine relies on:

> **A derivation graph can be made fully bidirectional — every edge**
> **traversable both ways — without becoming a cyclic constraint system.**
> `put` **remains a bounded, one-way, upstream write.**

The natural assumption is the opposite. "Bidirectional" suggests the
graph has become symmetric — no edge has a direction, the whole graph
is one mutual relation — and that satisfying such a relation requires
iteration to a fixpoint. That is **graph-global bidirectionality**, and
constraint systems do work that way and pay for it.

Coreactive programming uses **edge-local bidirectionality** instead.
Each edge *independently* carries both directions. The graph stays a
DAG; it stays oriented; `get` still flows leaf-to-root and `put` still
flows root-to-leaf along *individual* edges. Bidirectionality is a
property *of each edge in isolation*, not a property of the graph as a
whole. This is the constraint-maintainer model of Meertens (§3): an
acyclic network of two-way maintainers, each restoring its own edge.

The contrast, by topology:

| Regime                   | Edges                         | Termination          |
| ------------------------ | ----------------------------- | -------------------- |
| Reactive (Solid, Vue, …) | one-way                       | acyclicity           |
| **Coreactive**           | **bidirectional, edge-local** | **acyclicity**       |
| Constraint system        | bidirectional, graph-global   | fixpoint convergence |

The middle row is the unoccupied corner. It is the source of the
performance story: a constraint system is slow because *any* update may
require global re-satisfaction; a coreactive `put` is fast because it
is one bounded upstream write down a DAG (cost model, §9).

## 3. Relation to prior work

The model is old. Lambert Meertens, *Designing Constraint Maintainers
for User Interaction* (1998, unpublished manuscript), describes acyclic
networks of two-way constraint maintainers for direct-manipulation user
interfaces: each edge is a pair of update functions taking the new value
at one end and the old value at the other, governed by a Principle of
Least Change, with the four laws this document's lens laws restate.
That is the conceptual core here — edge-local bidirectionality, the
laws, least-change — and minim does not claim it.

The backward-direction algebra was then developed for two decades by
the bidirectional-transformation field: lenses (Foster et al.),
symmetric lenses, delta lenses, the model-driven "bx" work. The lens
cell here uses their laws (GetPut / PutGet / PutPut) unchanged. It is
also folklore that reverse-mode automatic differentiation has the same
shape — forward `get`, Jacobian-transpose `put`, chain rule as
composition. None of this is novel to minim.

What that lineage produced were *invoked, batch* systems — Harmony,
Boomerang, Augeas — and theory. A synchroniser consumes whole states on
demand; a delta lens propagates a delta when called. What none of them
is, is a *standing, push-based reactive runtime*: a live graph with
automatic dependency tracking, glitch-free incremental propagation,
lazy caching, and effects, where a `put` is not an invoked
transformation but a write that enters ordinary propagation.

So the only thing minim offers beyond the prior work is **a reactive
runtime for the maintainer model** — the engineering of §§5–10. Whether
that is worth having is an empirical question (does it stay fast and
ergonomic at scale?), not a theoretical one. The model is Meertens'; the
laws are the bx field's; the runtime is the part to evaluate on its own
merits.

## 4. What the substrate can model

### 4.1 The lens-factorable boundary

Define a relationship to be **lens-factorable** if it has a `put` that
is:

- **total** — defined for every value of the view that the view itself
  admits;
- **single-pass** — computable in bounded steps, no iteration to a
  fixpoint;
- **local** — needs only the written value and the current source(s),
  nothing global.

A lens-factorable relationship is an *edge*. A relationship that is not
lens-factorable falls outside the lens model — concretely, it fails in
one of exactly three ways:

1. the forward map is **non-injective with unrecoverable loss** — `put`
   would have to invent information; no function can;
2. the forward map is **not invertible in closed form** — an inverse
   exists but only via iteration; not single-pass;
3. there is **no forward map at all** — the relationship is a symmetric
   relation, no end is the source; not function-shaped.

These three cases are the negation of lens-factorability, and they are
what the separate `network()` mechanism exists for — a cyclic region
under an iterative regime. `network()` is out of scope for this
document; it is named here only to mark the boundary. Everything below
concerns the lens model proper.

### 4.2 The four lens disciplines

Lenses sort by one question: **where does `put` get the information that
`get` discarded?**

1. **Invertible edges — needs none.** `f` is a bijection; `put`
   reconstructs the source exactly, from the written value alone.
   `add(k)`, `scale(k≠0)`, affine maps, coordinate-frame and unit
   conversions. Satisfies all lens laws. Composes and fuses perfectly.
   The heart of the model.

2. **Residual edges — reads the live source.** `f` discards
   information, but the discarded part is still present in the source,
   so `put` reads it back. `field(parent, "x")` (spread-replace,
   reading the other fields); `centroid`, `mean`, `pulleySum`
   (distribute-delta, reading the current configuration). The classical
   constant-complement lens. Works exactly when the complement is
   live-readable from the source.

3. **Idempotent edges — discards it, then projects.** `f` discards
   information that is *gone* from the source, and `put` does not
   reconstruct anything — it *projects*, snapping the source into a
   constrained subset, idempotently (`put∘put = put`). `clamp`,
   `quantize`, `onLine`, `onCircle`, `snap`. The conceptually important
   class: **an idempotent edge is a constraint whose projection has a
   closed form, absorbed into a single edge.** A circle constraint is a
   lens; it never needs iteration, because projecting onto a circle is
   a one-step closed-form operation. (Only constraints whose projection
   has *no* closed form — a four-bar linkage, a coupled nonlinear
   system — fall outside the lens model.)

4. **Symmetric edges — holds it in a complement.** `f` discards
   information recoverable from *neither* the view nor the live source
   — a collapsed cluster's radial directions, an eigenvector's sign.
   The lens carries an engine-managed **complement**: private bounded
   state on the edge, holding exactly the missing information,
   refreshed on read and consulted on write. This is the stateful
   presentation of Hofmann–Pierce–Wagner symmetric lenses. It is still
   a single-pass `put` and still inside the lens model — the complement
   is bounded state on an edge, not a fixpoint.

The four are a progression on the recoverability question: needs none /
reads the live source / discards and projects / holds privately.
Authoring cost rises gently along the same axis — an invertible edge is
trivial to write, a symmetric edge takes real care — and that gradient
is a property of the relationships themselves, not of the API.

---

# Part II — Implementation

## 5. The lens cell

There is no separate `Lens` class. A `Cell<T>` is one cell in one of
three modes, determined by which fields are populated:

| Mode     | `getter` | `setter` | Truth                     |
| -------- | -------- | -------- | ------------------------- |
| signal   | unset    | unset    | `currentValue`            |
| computed | set      | unset    | `cachedValue` (lazy)      |
| lens     | set      | **set**  | the parent's stored value |

A lens is the third mode: a writable view. It stores no truth of its
own — the truth is the root signal's. It holds a *cache* of its last
computed value (§7), and a `getter`/`setter` pair.

Every lens operation — `.add(x)`, `.lens(f, g)`, `field(p, "k", C)`,
`Cls.derive(...)` — returns a **real, first-class, fully-installed
`Cell`**. It has its own value, type, getter, setter, cache, and
subscriber list. There is no deferred or virtual cell, and no
"materialise" step. `a.add(x)` is a real node the instant it returns.

## 6. Fusion is edge re-rooting, not node merging

"Fusion" is a misleading name for a precise and narrow mechanism. It
does **not** merge cells. Every cell in a chain stays alive and
first-class.

What it does: **when a lens is built on top of another lens, the new
cell is re-rooted onto the original root signal, and it absorbs the
intermediate's transform into its own composed closures.**

Worked example. `a = vec(0,0)`, `b = a.add(x)`, `c = b.add(y)`:

- `b` is a real cell; `b._fusedOf.parent === a`.
- `c` is a real cell; `c._fusedOf.parent === a` — **`a`, not `b`**.
- `c`'s getter is `composedFwd = s => f_c(f_b(s))`.
- `c`'s setter inverts `g_b ∘ g_c` straight onto `a`.
- `a` has two subscribers: `b` *and* `c`, both directly.

The dependency graph is a **star**, not a chain. A logical chain
`a → b → c` of lenses is realised as `a → b` and `a → c`, where `c`'s
single edge carries the *composed* transform of the whole chain.

So "fusion" fuses the *edge*, collapsing a multi-hop dependency into one
re-rooted edge with a composed closure. It does not fuse nodes.

### 6.1 Consequence: fused chains do not share subexpressions

Because `c` is re-rooted onto `a` and recomputes `f_c(f_b(a))` itself,
**`c` does not use `b`'s cached value.** When `a` changes, `b` and `c`
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
`.lens()` fuses regardless of out-degree (§10, open).

### 6.2 Captured state is root-derived, so deleting intermediates is safe

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

## 7. The cache, and write-priming

Every computed/lens cell has a `cachedValue`. While the root is
unchanged, lens reads hit the cache — a lens read is as cheap as a
computed read. When the root changes, the lens is marked `Pending`/
`Dirty` and recomputes once, lazily, on next read.

A cell *must* cache, for two reasons: it must be a graph node (lenses
are writable, and only nodes have a `put` site and a subscriber list),
and nodes must cache to keep propagation `O(changed set)` rather than
`O(reads)`.

**Write-priming** (optimisation, see §10). After `view.value = v`, the
view is dirtied and will recompute its `get` on next read — rediscovering
a value already known. `put` could instead *prime* the view's cache and
mark it clean. The correctness rule is exact: prime with
`fwd(put(v))` — the value `put` already computed on its descent, which
equals `v` for an iso lens and the projection of `v` for a lossy one —
*after* the root write commits, on the *endpoint only* (priming interior
nodes conflicts with fusion, which discarded them). It is a
constant-factor latency win on the hot read-after-write path, not an
asymptotic one.

## 8. Lossy lenses and the agreement set

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

## 9. Cost model

A `put` to a depth-`D` fused chain costs:

- **Inverse descent** — `O(D)` arithmetic, fused inline into one
  closure. `D` is *syntactic chain depth* — how long a method chain the
  author typed — not a graph-size quantity. Effectively `O(1)`.
- **Root write + equality check** — `O(1)`.
- **Forward-cone refresh** — `O(|genuinely-changed cone|)`. The only
  unbounded term, and it is *not* a cost of bidirectionality: a one-way
  `cell.value = x` observed by the same `k` nodes pays the identical
  `O(k)`. It is the cost of the answer being different.

So: a `put` is `O(D + |changed cone|)`, `D` syntactic-small, the cone
term irreducible and shared with one-way reactivity. **Bidirectionality
carries no asymptotic penalty.**

### 9.1 Why intermediate commit cannot help

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

### 9.2 Allocation

A depth-`N` chain currently allocates: `N` full `Cell` objects, `N`
`_fusedOf` records, `2N` leaf closures, `2N` composed closures, `N`
subscriber links into the root. All `O(N)`, nothing quadratic — but in
the chained-expression case `N−1` of the `Cell` objects are
*immediately unreachable garbage* (constructed, wired as a root
subscriber, never referenced). The composed getter is also a closure
stack `N`-deep — fusion removes node-hop indirection but the composed
`fwd` is still `N` nested calls.

## 10. Open design questions

- **Out-degree-aware fusion.** Fusion is currently unconditional. The
  correct policy (§6.1) fuses only out-degree-1 segments and
  materialises fan-out points so subexpressions are shared. Out-degree
  is not known at construction time and evolves as subscribers are
  added; a principled implementation is *lazy re-rooting* — build the
  shared `a → b → c` chain, and collapse `b` away only once the engine
  observes it has a single subscriber.

- **Descriptor / lazy-materialisation.** In `a.add(f).add(f).add(f)` as
  a single expression, the intermediates are *provably unreferenceable*
  — no binding escapes. They need not be built as real `Cell`s at
  all. `.add` / `.lens` could return a lightweight **pending-lens
  descriptor** (just the composed `{parent, fwd, bwd, stateful}`),
  accumulating under chaining, and **reify to a real `Cell` lazily**
  on first observation as a node (read in an effect/computed, `.value`
  touched, passed to an animator/propagator). Forcing must be memoised
  so a descriptor used twice still reifies once.

  This eliminates the `N−1` wasted allocations of §9.2 *and* dissolves
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

## 11. Glossary

- **Coreactive programming** — reactive programming where every
  dependency edge is a lens; reactivity paired with its lens-dual.
- **Edge-local bidirectionality** — bidirectionality as an independent
  property of each edge; the graph stays an oriented DAG. Contrast
  *graph-global bidirectionality* (constraint systems).
- **Lens-factorable** — a relationship with a total, single-pass, local
  `put`. The decidable property marking the boundary of the lens model.
- **Invertible / residual / idempotent / symmetric edge** — the four
  lens disciplines (§4.2), sorted by where `put` recovers the
  information `get` discarded: from nothing / from the live source / by
  closed-form projection / from a private complement.
- **Fusion** — edge re-rooting: a lens built on a lens is re-rooted
  onto the original root with composed closures. Not node merging (§6).
- **Agreement set** — for a lossy lens, the set of view values that
  round-trip; must equal the view's producible set for the lens to be
  well-formed (§8).