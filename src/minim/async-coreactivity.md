# Async Coreactivity

Companion to `coreactive-programming.md`. The main document develops the
substrate under the standing assumption that lens edges are
**synchronous and single-pass** (§4.1, the lens-factorability boundary).
This document examines what happens when that assumption is relaxed —
when a `get` or `put` takes time to deliver its result. It is a notorious
soft spot in reactive substrates generally, and the coreactive case is
doubly exposed: every async failure mode lurks on *both* edges of every
lens.

The document is exploratory. It maps the design space, locates minim
inside it, and points at the open corner. It does not prescribe a single
realisation; it ends with a list of prototype questions.

---

# Part I — The problem

## 1. Async is not one thing

"Async" is a label that bundles several distinct concerns that happen
to share a *doesn't-return-immediately* property. Conflating them is why
the topic feels intractable. In a reactive setting the bundle decomposes
into eight concerns:

| Concern | What it is | Where it bites the lens model |
| --- | --- | --- |
| **Latency** | value will arrive later (one-shot) | the §4.1 single-pass requirement |
| **Streaming** | values arrive over time (repeated) | what does `cachedValue` even mean? |
| **Coordination** | multiple writes must be ordered | glitch-freeness is a same-tick property |
| **Cancellation** | request made, no longer wanted | least-change has no temporal reading |
| **Stale-write / identity** | which write "won"? | `put` is no longer a function |
| **Suspense** | value requested but not yet available | what do downstream readers see *during*? |
| **Effect echo** | write triggers effect, which writes again | network's self-exclusion is per-tick |
| **Clock domain** | different cells in different "frames" | the cycle counter is global |

Call this the **async octet**. Most prior art addresses only the first
two, and only on the read side. Cancellation, identity, and bidirectional
async are largely unexplored in production substrates.

## 2. Why coreactive is doubly exposed

A forward-only reactive system has one direction the user must reason
about. Coreactive has two. So every entry in the octet recurs on both
edges of every lens:

- An async `get` is the obvious case — a forward map that computes from
  a server. Downstream reads now don't know the value.
- An async `put` is the harder case — writing to a view requires
  geocoding, validation, server-side ID minting. The least-change
  discipline (§4) is undefined in wall-clock terms.

Re-read §4.1. A relationship is lens-factorable iff `put` is **total,
single-pass, local**. Async breaks single-pass by construction. The
entire elegance of edge-local bidirectionality is grounded in a
synchronous model. `network()` is the document's named escape hatch for
cyclic/iterative regimes; async is an *orthogonal* second escape that
the document does not name.

> "Use `network()`" is not the answer. Cyclic regimes solve a spatial
> problem (the graph has cycles); async solves a temporal one (the graph
> is acyclic but the edges take time). Putting an async `put` inside a
> network turns a clean lens into an effect-y soup with all the failure
> modes above and a worse mental model.

## 3. Function coloring, restated for signals

Bob Nystrom's "what color is your function?" critique is the wrong
framing for signal substrates. The colors are not `sync`/`async`. The
colors are *signal types*:

- `Cell<T>` — synchronously available
- `Cell<Promise<T>>` — almost always wrong (Promise *identity* is
  distinct from resolved value; subscribers fire on the wrong event)
- `AsyncSignal<T>` / `Resource<T>` — available eventually, with
  `loading`/`error`
- `Stream<T>` / `Observable<T>` — values arrive over time
- `Cell<Loading | Ready<T> | Error>` — discriminated union, every
  consumer must pattern-match

Each of these is a different type. Combinators don't compose across
them. `derive(a, b, fn)` doesn't compose with `derive(asyncA, b, fn)`
unless `fn` is also async, or unless a coercion exists. That is the
function coloring — *signal type coloring*, multiplicatively worse than
the sync/async binary.

In a coreactive system this is doubled again: every async color crossed
with every lens discipline (invertible / residual / idempotent /
symmetric, §4.2). A 4×5 matrix of cell types is, charitably, untenable.

## 4. Working theses

The framing the rest of this document tests against the literature:

> **T1.** Async is an edge-local property, not a value-local property.
> The cell holds `T`; the edge says "this transformation takes time".
> Downstream readers see a sync `T` at all times. The substrate decides
> what `T` they see *during the in-flight period*.

> **T2.** The during-flight semantics form a small taxonomy:
> *optimistic, pessimistic, suspended, streamed*. These look like a
> fifth lens discipline (alongside the four of §4.2), or an orthogonal
> axis crossed with all four.

> **T3.** Generators are the natural function-color-removal mechanism
> in JS. Inside a generator, there is no `Promise<T>` color — there is
> `T`. Minim's animator runtime already speaks generator; the same
> trick can be applied inside a lens body without coloring the cell
> type. (Note: the animator's *yield alphabet* — `Tick`, frame clock —
> is wrong for reactive async. The mechanism is shared; the alphabet is
> not.)

---

# Part II — The design space

## 5. Survey, by design choice

The realised systems sort cleanly along three axes — *runtime* (push /
pull), *direction* (read-only / bidirectional), *async mode* (none /
suspend-throw / union-typed / event-shaped):

| System | Runtime | Direction | Async mode | Notes |
| --- | --- | --- | --- | --- |
| TC39 Signals proposal | push | read-only | **none** — defers to consumer | "Async integration remains the responsibility of the consumer." |
| Solid 2.0 (beta, 2026) | push | read-only async + workflow-shaped writes | **suspend-throw** to `<Loading>` boundary | Computations may return `Promise` / `AsyncIterable`. `action()` + `createOptimisticStore` + `refresh()` for mutations. Two-phase effect mandatory. |
| React `use()` + Suspense | re-rendering | read-only | suspend-throw | Constraint: an async function re-rendering without new inputs must resolve within a microtask. |
| Riverpod `AsyncValue<T>` | push | read+write asymmetric | **union type** `Loading \| Data \| Error` | `unwrapPrevious`, `skipLoadingOnReload` — explicit "previous value while loading" pattern. |
| MobX `flow` | push | n/a | generator | Generator-of-Promise replaces async/await; gains cancellation via `gen.return()`. |
| Adapton / Salsa | pull | read-only queries | sync (Salvia is async, experimental) | Pull naturally waits; async fits cleanly. |
| Effekt / Koka / OCaml 5 | n/a | n/a | **algebraic effect handlers** | async is one handler among many; ~hundreds of lines, none in the compiler. |
| Concurrent ML / Hopac | n/a | n/a | **first-class composable events** | events are values; `choose`/`wrap`/`sync`; minim's `Suspend<T>` is morally a CML event. |
| Effectful Lenses (Xie–Schrijvers–Hu, ICFP'25) | batch, not reactive | bidirectional | **different monad per direction** | Distinguished paper. Round-trip *relations* (parameterised over Kleisli arrows) instead of equations. |
| **minim today** | **push** | **bidirectional sync** | **none** | The substrate is well-positioned; the async corner is empty. |

The empty cell is the same in every realised system: **bidirectional
async edges in a push-based reactive runtime with edge-local fusion.**
Solid 2.0 has the push runtime and first-class async, but read-only.
Effectful Lenses has bidirectional async, but batch. Nobody has both.

## 6. Solid 2.0: separating substrate from UI

The reactive ecosystem has rallied around Solid 2.0's design (released
2026-05) as the production answer to async-in-graph. It is worth
careful dissection — some of it is substrate-general and worth
adopting; some is UI-coupled and would mislead if generalised
directly.

### 6.1 Substrate-general moves (generalise)

These are forced by async-in-graph, regardless of whether the output
is UI:

1. **Two-phase effect: compute → apply.** Compute does only reads
   (tracking); apply does side effects (untracked). The split is
   structural: if the compute body can suspend, its deps must be
   registered *before* the suspension so the engine knows what the
   eventual apply will fire on. Single-phase effects break under async
   because a partial run leaves an inconsistent dep snapshot.

2. **Microtask batching as default.** Synchronous batching cannot span
   an `await`/`yield` boundary. `batch()` is removed; the batching unit
   is the microtask. `flush()` becomes the *imperative* synchronous
   escape, not the default.

3. **`isPending(fn)` as a traversal, not a tag.** Solid: "isPending
   performs the read you pass it and returns whether any value read by
   that function is currently pending." The pending bit does not live
   on the cell; it is discovered by walking the read graph. This is the
   move that keeps `Cell<T>` from becoming `Cell<Loading | T>`.

4. **`latest(fn)` for stale-value access.** Read the last known good
   through the same read path that normally suspends. Same shape as
   Riverpod's `unwrapPrevious`.

5. **`refresh(x)` as explicit invalidation.** Separates *value changed
   in upstream source* (handled by normal propagation) from *recompute
   me even though my source didn't change* (the explicit poke).
   Async-derived cells need both.

6. **Optimistic store resets to source when transaction completes.**
   `createOptimisticStore` is a *transaction frame on top of a canonical
   source*. Writes during the action are transient; they revert on
   completion. This is the operational shape of "complement-carried
   pending state" (see §7).

7. **Generators are the chosen action idiom.** Solid explicitly
   considered "manually passing in a resume function" and rejected it.
   `action(function*() { ... yield api.x() ... })` is the
   color-removed mutation surface.

8. **`unobserved`/autodispose hooks.** Critical for cancelling in-flight
   requests when the cell goes unobserved. Minim already has
   `unwatched` (`signals/signal.ts`); same shape.

### 6.2 UI-coupled moves (don't generalise — minim has no tree)

These work because rendering is *idempotent and discardable* — React /
Solid can throw mid-render, walk up the tree, render the fallback, and
replay the suspended subtree on settle. Minim cells are *not*
idempotent. They allocate, are subscribed-to, fire effects. You cannot
"throw mid-get and walk up to a boundary" — there is no tree, only a
graph, and the read path may already have committed work.

- `<Loading>` and `<Errored>` boundaries — depend on the component
  hierarchy.
- `Loading` `on` prop — UX for route-level transitions.
- SSR streaming / hydration / `deferStream` — irrelevant outside SSR.
- Strict top-level read warnings in component body — about JSX
  component lifecycle.

### 6.3 The honest assessment

Solid 2.0 is the most aggressive push-based-reactive-with-async system
that actually ships. They paid the structural costs (two-phase effect,
microtask batching, write-under-scope restrictions) and got read-side
async cleanly. **But the bidirectional story remains forward-only.**
Writes go through `action()` + `setOptimisticStore` + `refresh()`,
which is a *workflow*, not a substrate primitive. There is no async
lens. `createOptimisticStore` is the closest, but it is an explicit
transaction frame, not a bidirectional edge.

Solid 2.0 gives you the runtime engineering (§6.1, all eight items).
It does not give you bidirectional async semantics. That gap is where
the effectful-lens framework lives.

## 7. Effectful Lenses (Xie, Schrijvers, Hu — ICFP 2025)

The structural answer to "can lenses be effectful (and therefore
async)?" was answered in 2025. Three moves are essential.

### 7.1 Complement-based encoding is structurally required

The traditional `put : V → S → S` encoding makes `get` appear inside
`put`'s composition — to thread state through, composition has to call
`get`. When `get` carries effects, those duplicated computations break
round-trip preservation. The 2025 paper opens with: *"the lack of
symmetry in get and put is the culprit"*.

The fix is to switch to **complement-based encoding**:

```
record Lens (C X Y) where
  get : X → M (Y × C)        -- forward: returns view AND complement
  put : Y × Maybe C → N X    -- backward: takes view and optional complement
```

The complement `C` is *the information `get` discarded from `X` to
produce `Y`*. Bounded, private, edge-local state. Composition is:

```
get (f • g) x = do (y, c1) ← get g x; (z, c2) ← get f y; pure (z, (c1, c2))
put (f • g) (z, mc) = do y ← put f (z, map proj2 mc); put g (y, map proj1 mc)
```

`get` never appears in `put`. That is what lets `get` carry effects
safely.

> **The lucky coincidence.** Minim's symmetric-lens machinery
> (`signals-symmetric/`, `_symmetric` / `_fuseOnSymmetric` in
> `signals/signal.ts`) is *exactly this encoding*. `SymmetricLensSpecN`
> is `putr : X × C → Y` and `putl : Y × C × X → X`, plus an
> engine-managed complement. The structural cost the paper says is
> required has already been paid in minim — for a different reason
> (the symmetric-lens trap class, §4.2), in a different module. The
> work to support effectful lenses is widening, not rewriting.

### 7.2 Round-trip *relations* instead of equations

Get-Put `get(put(s, v)) = s` was an equation. For effectful lenses it
becomes a **relation** `RGP get (put ∘ Prod.map2 just)` — meaning: "the
Kleisli arrow `get` and the Kleisli arrow `put ∘ wrap-complement` are
related by `RGP`". Different effects give different relations:

- **Identity** → relation is equality (recovers standard lens laws).
- **Error** (non-cancellable) → "if `get` succeeds, `put` succeeds and
  recovers".
- **Reader** → relation transformer over a base R (compositional).
- **State** → relation transformer; state can be internal to one
  direction.
- **IO** → no complete relation; postulate axioms per use case
  ("ignore logging", "pair critical ops", "errors via `liftError`").

Five axioms (Identity, Composition, Product, Sum, Path-Irrelevance)
that any `R` must satisfy guarantee composition preserves round-trip
properties. Proof obligation per effect type, done once; all
combinator composition is free.

### 7.3 Different effects in each direction is supported, deliberately

`M_get ≠ M_put` is first-class. The paper's worked example uses
`Reader(Error)` in forward and `Reader(State(Error))` in backward —
backward has private mutable state for tracking generated names; that
state is invisible to forward.

**The asymmetric case is the realistic case.** A typical reactive cell
has a fast/sync read (cached) and a slow/async write (commits to a
server). The framework says: that's fine, here is the algebra.

### 7.4 Instantiation for async

Set `M_get = M_put = Promise` (or some `Async<T>` monad). Then:

- `get : X → Promise<Y × C>` — async forward
- `put : Y × Maybe C → Promise<X>` — async backward
- Round-trip relations become **temporal**: `RGP` says "the promised
  round-trip eventually recovers `x` if no concurrent writes
  intervene".

Asymmetric is more realistic:

- `M_get = Identity, M_put = Promise` — sync read, async commit. The
  Solid 2.0 case.
- `M_get = Promise, M_put = Identity` — async fetch, local cache write.
- `M_get = Reader<AbortSignal>(Promise), M_put = State(Promise)` —
  cancellable read, write with retry state.

## 8. The Solid ↔ Effectful-Lens connection

The two converge cleanly:

| Effectful Lens (theory) | Solid 2.0 (practice) | What it is |
| --- | --- | --- |
| Complement `C` | `createOptimisticStore` backing | Edge-local bounded state |
| `M_put = Promise` | `action(function*() { yield api.x() })` | Async backward direction |
| `M_get = Identity` | `createMemo(() => ...)` (sync read) | Sync forward in optimistic case |
| Round-trip relation under `Promise` | `refresh(x)` after `yield` | Re-establish consistency after settle |
| `Maybe C` in `put` | "Reset to source when transition completes" | Discard transient complement |
| Get-Put under effects | optimistic write → yield → refresh | Optimistic = complement; refresh = round-trip |
| Different effects each direction | `createMemo` (sync) + `action` (async) | Asymmetric in production already |

> Solid 2.0 is operationally a single hardcoded instance of the
> effectful-lens framework, with `M_get = Identity` and `M_put = Promise`,
> with optimistic complement materialised as an `OptimisticStore`. Their
> primitives (`action`, `setOptimisticStore`, `refresh`) implement one
> specific specialisation. The Xie–Schrijvers–Hu framework parameterises
> Solid's design.

Two practical implications:

1. Minim can give Solid 2.0's UX by instantiating the effectful-lens
   framework once for `M = Promise`, and then get *more* for free —
   bidirectional, asymmetric per direction, lens fusion across async
   boundaries.
2. Solid 2.0 tells us what the *runtime obligations* are for the
   framework to work at production scale.

---

# Part III — Implications for minim

## 9. Lens disciplines under effects

The four lens disciplines of §4.2 sort by *where `put` recovers the
information `get` discarded* — none / residual / idempotent / symmetric.
Async could be modelled either as a fifth discipline, or as an
orthogonal axis crossed with the existing four.

### 9.1 As a fifth discipline (deferred / effectful)

A new class: **the put is single-pass *modulo an effect monad***. The
`_fusedOf` shape gains an `effect: EffectSet | null` field. Sync edges
have `effect === null` and use the existing fast paths unchanged. When
either side of a fusion candidate is effectful, fall back to a
non-fast path (closure composition over Kleisli arrows).

Out-degree-aware fusion (§10 of `coreactive-programming.md`) becomes
moot at effectful boundaries — an async edge never fuses upward, because
the runtime needs to address the cell for cancellation, retries, and
suspension tracking. Materialisation at the async boundary is the right
default for the same reason out-degree ≥ 2 wants materialisation.

### 9.2 As an orthogonal axis

Each existing discipline becomes (sync, async). Sixteen cells in a
matrix. Fusion only composes within the same column. Probably the
cleaner conceptual model — async is *transverse* to the recoverability
question, not parallel to it.

The author leans (9.1) → (9.2) once enough cases are explored. The
fifth-discipline reading is the right *introduction* to readers who
have the four; the axis reading is the right *implementation*.

## 10. The agreement set, lifted

Section 8 of the main document defines the **agreement set** of a
lossy lens: the set of view values that round-trip. A lens is
ill-formed if its agreement set differs from the view's producible
set — PutGet fails on the view's own admitted domain.

Under async, the agreement set is the set of `v` such that the
*eventually-observed* `get(put(v))` equals `v`. The same definition,
under the temporal reading of the round-trip relation (§7.2). A lossy
async lens with an undersized agreement set is still ill-formed and
should still fail loudly under fusion. The shape of `laws.ts`
generalises.

## 11. Write-priming under async

§7 of the main document describes write-priming: after `view.value = v`,
prime the view's cache with `fwd(put(v))` to avoid the redundant
recompute on next read. Under async this becomes **optimistic priming**:
prime with `fwd(put(v))` *immediately*, before the async `put` settles,
on the endpoint only. On settle:

- If the settled value matches the predicted prime, no-op.
- If it differs (server-driven correction, validation rewrite, ID
  minting), commit the settled value and propagate the difference.
- If `put` rejects, roll back to the previous value.

This maps onto the optimistic-update *stack* pattern from the UI
literature — multiple writes in flight need an ordered queue with
intent IDs, not a single slot. Generalises §7's "constant-factor
latency win" to "the substrate's optimistic mutation primitive".

## 12. Generators as the JS color-removal mechanism

Minim already has generators, in `core/anim.ts`. **They are the right
mechanism, but the wrong alphabet for reactive async.** Three
commitments in `Animator<R>` are inappropriate:

- The resume value is `Tick = { dt, elapsed }` — bakes "frame clock"
  into the type. Reactive-async has no clock; it has *event sources*
  (signal change, Promise settle, dep invalidation).
- `yield <number>` means "sleep N seconds" — time-as-implicit. Useless
  for reactive.
- `Suspend` gets `spawn` for engine-root parking — long-running gens
  surviving parent cancel. Reactive-async gens are short-lived; they
  should not escape parent scope.

A reactive-async generator wants a *different alphabet*:

```ts
type ReactiveYieldable =
  | Read<unknown>                   // suspend until this cell settles
  | Promise<unknown>                 // await a Promise
  | { commit: unknown }              // optimistic apply-phase write
  | { refresh: Read<unknown> }       // explicit invalidation
  | { cancel: AbortSignal }          // cooperative cancellation
  | readonly ReactiveYieldable[]     // parallel; settle on all/first per opts
```

And a *different runtime*: not a frame-driver, but a reactive
scheduler that triggers gen advance on dep change, Promise settle, or
commit yield. Reads inside the gen body track deps (because the gen
runs with `activeSub = this`).

The architectural cut is two-tier:

- **Animator runtime** (`core/anim.ts`) — time-driven, frame-clock,
  long-lived gens; animations and choreography.
- **Reactive runtime** (`signals/...`) — event-driven, microtask-flushed,
  short-lived gens for async actions and async lens bodies, integrated
  with the signal graph.

Both use JS generators as the mechanism. They are distinct runtimes
with distinct alphabets. The shared part is small and may not be worth
sharing — the scheduling models are different enough.

## 13. The two-phase effect, considered for its own sake

Solid 2.0 elevates `createEffect(compute, apply)` because async demands
it. The reasoning generalises — and is worth taking up *before* the
async story stabilises:

- **`compute` is replayable.** No side effects, so it can run multiple
  times (graph change, transition coordination) without consequence.
- **`apply` sees the settled dep set.** All compute halves in the batch
  have run; the dep graph is consistent; the value is final.

For async: `compute` returns a Promise. The engine sees it, waits,
runs `apply` only on settle. Deps are *all* tracked before the await,
because compute does only pure reads. The await is glitch-free.

Minim's current `Effect._run` collapses both into one body
(`signals/signal.ts`). Single-phase is fine for sync but breaks under
async — a partial run leaves an inconsistent dep snapshot. The split
is a prerequisite to any async work, and is worth doing on its own
because:

- It surfaces a class of footguns (write-under-reactive-scope) that
  minim probably has.
- It makes dependency tracking explicit, simplifying `network()`
  interactions.
- It aligns with the predictability principles of §9 of the main
  document.

A backward-compatible path: existing `effect(fn)` keeps semantics;
new `effect.split(compute, apply)` opts into two-phase. Async cells
require the split; sync cells don't.

---

# Part IV — Open prototype questions

The above is map and survey. The actual design choices need
prototypes. Six questions, mostly independent, ordered by dependency:

**P1 — Two-phase effect.** Concrete shape of the API in minim. Can
the existing `effect(fn)` shape stay for sync, with `effect(compute,
apply)` as opt-in? How does this interact with `network()` bodies,
which are effectively single-phase right now? **Prerequisite to all
others.**

**P2 — Widen `SymmetricMeta.complement`.** Generalise from "complement
that recovers discarded info" to "complement that also carries
optimistic-pending state, in-flight cancellation tokens, previous
value for stale reads, etc." What does `Lens.async(parent, { get,
put, missing: { value, pending, prev } })` look like? Does
`_fuseOnSymmetric` still compose correctly?

**P3 — The reactive-generator alphabet.** Minimal viable shape (§12).
Just `yield Promise` or richer? Where does the runtime live (a new
module, not under `core/anim`)? What's the relationship to the
animator runtime — code-shared, conceptually-shared, or independent?

**P4 — `isPending(fn)` as a traversal.** Implementation: run `fn()`
in a special tracking context that surfaces async cells encountered.
How does this interact with fusion — fused cells lose intermediate
identity; does that affect `isPending` accuracy?

**P5 — `refresh(cell)` as a primitive.** Precise meaning given minim
cells are not source-of-truth-coupled the way Solid's resources are.
What is the analogue when the source-of-truth is an upstream lens,
not an external service?

**P6 — Microtask batching.** Replace synchronous `flush()` with
default-microtask, retain `flush()` as imperative escape. How does
this interact with the propagator / constraint layer
(`propagators/`, `constraints/`), which currently assumes sync flush?
What about generator-driven animation tests that snapshot per-tick?

P1 is the prerequisite. P2 is where the conceptual unification
happens (effectful lenses ≡ widened symmetric complement). P3 is the
mechanism. P4–P6 are mutually-implied and can be co-designed.

---

# Part V — Where this lands

The under-occupied cell in §5's table — **bidirectional async lenses
in a push-based reactive runtime with edge-local fusion** — is not
addressed in published work, as of late 2025. The closest pieces
exist:

- **Effectful Lenses (Xie–Schrijvers–Hu, ICFP'25)** — the algebra.
- **Solid 2.0** — the runtime.
- **Concurrent ML / Hopac** — the composition story.
- **JS generators** — the color-removal mechanism (and minim has them).

Nobody has assembled all four. The substrate minim has is unusually
well-positioned: three of the four pieces are sitting there. The
fourth (effectful-lens algebra) is published, with the
complement-based encoding it requires *already implemented* in
minim's symmetric-lens module — for a different reason.

Whether the assembly is worth doing is, as the main document says of
the coreactive runtime itself, *an empirical question* — does it
stay fast and ergonomic at scale? The theoretical scaffolding is
ready. The runtime engineering has been demonstrated by Solid 2.0.
The bidirectional case is the open contribution.

---

# 14. References

Primary sources cited above:

- Xie, R., Schrijvers, T., Hu, Z. (2025). *Effectful Lenses: There
  and Back with Different Monads.* Proc. ACM Program. Lang. 9, ICFP,
  Article 254. ([DOI](https://doi.org/10.1145/3747523),
  [artifact](https://doi.org/10.5281/zenodo.15656096)). Distinguished
  paper.
- SolidJS 2.0 RFCs (2026):
  - `01-reactivity-batching-effects.md` — two-phase effect, microtask
    batching, write-under-scope.
  - `05-async-data.md` — first-class async computations, `<Loading>`,
    `isPending`, `latest`, `refresh`, `resolve`.
  - `06-actions-optimistic.md` — `action()`, `createOptimistic`,
    `createOptimisticStore`.
- Gibbons, J. *Bidirectional Transformation is Effectful.* Position
  paper that anticipated the ICFP'25 result.
- Abou-Saleh, F., Cheney, J., Gibbons, J., McKinna, J., Stevens, P.
  (2016). *Reflections on Monadic Lenses.* The predecessor framework
  (forward effects disallowed).
- Leijen, D. (2017). *Structured Asynchrony with Algebraic Effects.*
  MSR-TR-2017-21. Cleanest exposition of "async is just one effect
  handler".
- Reppy, J. *Concurrent Programming in ML.* For first-class
  composable events.
- Elliott, C. (2009). *Push-Pull Functional Reactive Programming.*
  For the push-is-blocked-pull framing.
- Meertens, L. (1998). *Designing Constraint Maintainers for User
  Interaction.* (Already cited in §3 of the main document; relevant
  here because the least-change discipline is precisely what
  *doesn't* survive under async, and the question of what replaces it
  is open.)
