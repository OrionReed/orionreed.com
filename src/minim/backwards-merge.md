# Backward Merge — Exploration

Companion to [`BIDIRECTIONAL-LENSES.md`](./BIDIRECTIONAL-LENSES.md) (the
shipped lens algorithm) and [`DATAFLOW-EXPLORATIONS.md`](./DATAFLOW-EXPLORATIONS.md)
(the broader speculative landscape). **None of this is implemented, and
none of it is known to work.** It is a record of a line of reasoning
about one hard problem, written down so the prototype has somewhere to
start and something to falsify. Treat every claim here as a hypothesis,
not a result. Several of the steps may be wrong; the point of writing it
down is to find out which.

---

## 1. The problem

A backward write that reaches a node from more than one path is
underdetermined. Forward, a node combines several inputs into one value
with a total function (`get`). Backward, that same node must split one
written value into several upstream writes — and splitting is not the
dual of combining. `get(a,b,c) = a+b+c` is total; "given the new sum,
what are `a,b,c`" is a solution *space*, not a solution.

So wherever the backward direction fans out, *something* has to decide
how the contributions combine. Today the engine has no such decision
point: a lens write is a synchronous closure descent that bottoms out at
a root (see §8 below), and when two backward paths reach the same root
they arrive as two separate writes — last-write-wins, by default, not by
choice.

We want a **merge**: a named point on the backward path where multiple
contributions are combined by a user-supplied function before the write
continues upstream. The open question is not what `merge` *means* — it
means "apply `fn` to the contributions that reach here" — but whether the
engine can know *which* contributions reach a given merge, on a given
backward propagation, **without** imposing batch boundaries at call
sites and **without** heavy per-write bookkeeping.

That "which contributions, this propagation" question is the whole
difficulty. Everything else is downstream of it.

## 2. What `merge` is, structurally (hypothesis)

A `merge` node appears to be, structurally, a **computed read backward**.

- A forward computed has several deps, a combining `get`, and one cached
  output. It is resolved lazily: marked `Pending` when a dep changes,
  recomputed at read.
- A backward merge has several *contributions* (arriving from the paths
  below it), a combining `fn`, and one output handed further upstream.
  The conjecture is that it can be resolved the same way: marked pending
  when a contribution arrives, combined when its upstream value is
  pulled.

If that analogy holds operationally — a big *if*, see §7 — then the
backward merge is not a new scheduler. It is the existing lazy resolver
run on transposed edges, and the bookkeeping it needs is mostly
bookkeeping the engine already does for the forward direction.

Placement matters and is meaningful, not cosmetic:

```
b = a.right().merge(fn).up()
```

In the backward direction (view → root) the order is `up`, then `merge`,
then `right`, then write `a`. So `fn` sees contributions *after* `up`'s
bwd has mapped them into merge-coordinates, and *before* `right`'s bwd
carries the combined result to the root. "The part of the chain below
the merge is applied per-contribution; the merge combines; the part
above is applied once on the result." Where you place the merge is where
in the coordinate chain the conflict gets resolved.

## 3. The cost gradient we are aiming for

The design is only worth having if it is free when you are not using it
and cheap when your merge does not need coordination:

- **No merge in the graph** → engine entirely unchanged; backward writes
  descend to root exactly as today.
- **Order-independent merge** (associative + commutative `fn`: a
  semilattice join, sum, count-weighted mean) → no buffering, no
  ordering, no epoch. Fold each contribution into an accumulator on
  arrival and let it descend eagerly; the existing equality short-circuit
  converges it. This is the case where merge "passes straight through."
  The merge function's *shape* (declared, e.g. via a trait) is what
  licenses this fast path.
- **Order-dependent merge** (anything non-commutative: last-write-wins,
  arrival-weighted, "first wins") → must wait until its contributions
  for this propagation are known, then combine. This is the only case
  that needs the machinery in §6, and it pays only at the merge nodes.

The hypothesis is that the order-independent case covers a large fraction
of real uses and costs almost nothing, and the order-dependent case is
contained to its own nodes.

## 4. Why not a microtask / call-site batch

Two non-options were considered and rejected.

**Call-site `batch()`** — requiring users to wrap writes so a merge knows
its epoch — is rejected outright. It pushes the substrate's internal
problem onto every call site.

**A default microtask flush** (the approach the newest Solid signals core
takes: defer all recomputation to the microtask boundary so multiple
synchronous writes settle together) is rejected because it fights this
engine's identity. See §5 — this engine deliberately has no scheduled
flush, and adding one to solve the backward problem would regress the
forward one.

The epoch boundary we actually have is **read-time resolution** (§5). The
conjecture in §6 is that the backward merge can use the same boundary.

## 5. Why the engine has no microtask (and what that buys us)

The current engine (alien-signals v2 lineage) is **push-for-marking,
pull-for-recomputation**:

- A write stamps `pendingValue` and runs `propagate`, which only *sets
  flags* (`Pending` / `Dirty`) on the reachable cone. It does not
  recompute anything.
- A computed recomputes **at read**: the `value` getter checks its flags
  and, if `Dirty` (or `Pending` and confirmed dirty by `checkDirty`
  walking up its deps), runs `_update()` then and there.
- The only thing pushed to completion is *effects*, drained by `flush()`
  synchronously when `batchDepth === 0`. Computeds are never queued; they
  wait to be pulled.

A microtask exists, in systems that use one, to answer "when is it safe
to recompute, given more synchronous writes may still come?" This engine
never needs that answer because it never eagerly recomputes. Resolution
happens at read, by which point every synchronous write earlier in the
turn has already landed. The epoch is implicit and retroactive: "whatever
writes happened before this read." Glitch-freedom comes from the
`Pending`/`Dirty` + `checkDirty` dirty-walk at read, not from scheduling.

So the engine's existing answer to "epoch boundary without a call-site
batch" is **read-time resolution**, and it is microtask-free and
batch-free already. The whole bet of §6 is that the backward direction
can reuse that same answer rather than introduce a scheduler the forward
direction was specifically designed to avoid.

## 6. The sketch (reusing forward machinery)

Strictly a sketch. Unverified.

1. A `merge` node is a real materialised cell. Fusion must not re-root
   through it (fusion is an optimisation, not load-bearing, so a merge is
   simply a fusion barrier — the segments above and below it fuse
   independently).

2. A backward write that would cross a merge does **not** recurse to the
   root. Instead it resolves the below-merge bwd to a contribution in the
   merge's coordinate space, **deposits it in a per-input slot on the
   merge, and marks the merge pending** — the same flag-set that a
   forward write does to a computed's subscribers. `_setWithExclusion`
   already branches on `getter !== undefined` (lens vs root); "is a merge"
   would be one more branch: deposit-and-mark instead of call-setter /
   write-pending.

3. The merge's combined value is produced by an `_update`-shaped step:
   gather the currently-pending contributions, run `fn` once, hand the
   result upstream. For an order-independent `fn` this collapses to
   fold-on-arrival (step 2 and 3 merge; no waiting). For an
   order-dependent `fn` it must wait until its contributions for this
   propagation are settled.

4. "Settled" reuses the existing vocabulary. Forward, `checkDirty` walks
   *up* a node's deps to decide whether a `Pending` node is really dirty.
   The conjecture is that the merge's resolution is the same walk run the
   other way along the same `Link` records (each `Link` already stores
   both `dep`/`sub` and `nextDep`/`nextSub`, so the scaffolding for
   bidirectional traversal is already present — see §7 for why this might
   not hold).

New state, if the sketch is right, is small and local: a contribution
slot per merge input (the same shape as a computed caching its last-seen
deps), one branch in the setter, and — for order-dependent merges only —
a resolution step that reuses the flag vocabulary. Merge-free graphs and
order-independent merges touch none of it.

## 7. The part most likely to be wrong

The load-bearing unknown is **what triggers an order-dependent merge's
resolution**.

Forward, the trigger is obvious: the user reads `.value`. Backward, the
root write is a *push*, not a pull — there is no natural reader on the
upstream side to force the merge. Two candidate triggers, neither
obviously right:

- **(a) Lazy / read-driven.** The root is not actually written until
  someone next reads the root or a forward-derived value, at which point
  pending backward merges resolve on the way. Most faithful to the
  engine's pull identity, but it inverts causality in a way that may be
  surprising: a backward write that does not "take effect" until a later,
  unrelated read.
- **(b) Turn-end sweep.** After the writing statement completes, a
  synchronous pass resolves pending merges in backward-height order and
  finishes the descent. More predictable; less lazy; reintroduces a
  notion of ordering (height) that the rest of the engine mostly avoids.

There is also the question of whether `checkDirty` actually transposes.
It is written for the up-toward-roots direction; the claim that it "just
runs the other way" along the `sub`-links is plausible from the `Link`
shape but unproven, and the flag semantics (`Recursed`, `RecursedCheck`,
the `innerWrite` handling) may not have a clean dual. This is the first
thing a prototype should test, in isolation, before anything else is
built on it.

If neither (a) nor (b) is clean, the fallback is the heavier mechanism
considered and set aside earlier — a genuine backward propagation epoch
with its own barrier — which is real new scheduler work and should be
treated as the expensive last resort, not the default.

## 8. Context: how a backward write works today

For grounding, the current mechanism (this *is* implemented, in
`signal.ts`):

- A lens stores no truth; it is re-rooted by fusion onto the originating
  root signal, and its setter is a composed closure that writes the root
  directly via `parent._setWithExclusion(...)`.
- `_setWithExclusion` branches: if `getter !== undefined` (lens/computed)
  it calls the installed setter and returns — no propagation here. The
  setter recurses down composed closures until it reaches a real signal
  (`getter === undefined`), and only there does `pendingValue` get
  stamped and `propagate` run.
- So the backward direction is *pure synchronous closure recursion to a
  root*. There are no intermediate backward nodes to "pass through"
  today; the merge proposal is precisely the introduction of one.

This is why a diamond degrades to last-write-wins now: the two paths meet
only at the root's single `pendingValue` slot, which holds one value, not
a set of contributions. A merge is the attempt to give them a place to
meet *before* the root.

## 9. An observation worth recording: unfolding

A conceptual reframing, possibly only conceptual.

The system is a forward DAG of `get` edges plus a backward DAG of `put`
edges over the same nodes. One way to think about the backward direction:
**unfold it.** Place the backward DAG "above" the forward one and flip it
upside down, so that every node appears twice — once as a forward cell,
once as its backward image — and the `put` edges, which pointed
root-ward in the original, now point *leaf-ward* in the unfolded picture.

In that unfolded graph, *all* propagation is forward. The backward pass
is not a special reverse traversal; it is ordinary forward propagation
through the reflected upper half. A merge node, which is a backward
fan-*in* (many contributions, one result), becomes in the unfolded
picture a forward fan-in — exactly the shape the engine's forward
machinery already handles, glitch-free, at read.

If that reframing is faithful, it would explain *why* §6's "reuse the
forward machinery" conjecture might work at all: the backward merge is
not analogous to a forward computed by coincidence — it *is* a forward
computed, in the unfolded graph. The transposition in §6 step 4 would
then be the implementation shadow of this unfolding.

Two cautions. First, this may be true and still not be useful: "unfold
the graph" is not an implementation — the engine does not literally
duplicate every node, and the cost of doing so could swamp any
conceptual tidiness. Second, the unfolding has to account for the fact
that the two halves share *truth* (the root's value is one value, read
forward and written backward), so the reflected node is not independent
of its original — they are the same `pendingValue`. Whether the unfolding
survives that sharing, or whether the sharing is exactly where the clean
picture breaks, is unknown. It is recorded here because it is suggestive,
not because it is established.

## 10. What a prototype should try, in order

1. **Test the transposition in isolation.** Can `checkDirty`'s walk be
   pointed along `sub`-links to gather contributions, reusing the
   existing flag vocabulary, on a hand-built two-path backward case?
   Before building anything, find out whether the dual exists. (§7)
2. **Order-independent merge first.** Fold-on-arrival for a commutative
   `fn` (a lattice join). It needs none of the hard machinery and would
   confirm the cheap path is genuinely cheap and correct.
3. **Decide the trigger (a) vs (b)** for order-dependent merges
   empirically, on a small diamond, watching for the causality-inversion
   surprise in (a) and the ordering cost in (b).
4. **Only then** consider whether anything heavier (a real backward
   epoch) is justified by cases the above cannot reach.

Each step can fail and falsify the approach. That is the intended use of
this document.

If we manage this, then it also opens the door to TS-level changes, such as branding nodes with a merge(), so downstrean readers/writers know more in their types (there's a nice, large design space here, but this is deferred until after the prototype is working, IF the prototype is working)