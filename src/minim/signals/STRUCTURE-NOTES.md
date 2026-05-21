# What is the dependency structure, actually?

You said "DAG feels slightly inadequate." Right. This is a notes file
to pin down what the structure *is* in minim today, why cycles stay
hard to make accidentally, and what existing research points at if we
wanted to push further.

## What we have now

Three primitive shapes in r2:

```
signal(v)              cell with read + write
computed(get)          cell with read only, value derived from N parents
lens(get, set)         cell with read + write, both bidirectional through N parents
```

…and a higher-arity primitive:

```
combine(parts, merge, distribute)   one cell observes N parts, write distributes back
mean(...)                           special case of combine
```

If we draw the *read* dependencies, it's a DAG: cells point at the
cells they read from, and the engine's `RecursedCheck` flag prevents
self-loops at evaluation time.

If we draw the *write* propagation, it's a different DAG: writes to a
lens trigger writes to its parents; writes to a signal trigger
re-evaluation of its dependents. Both DAGs are acyclic.

But neither DAG alone describes the structure. A `lens` is one node
that lives on *both* edges of the read DAG (it reads from parent) and
the write DAG (it writes to parent). A `mean` is one node that lives
on the read DAG with fan-in N and on the write DAG with fan-out N.

So the right structural description is:

> **A bidirectional dataflow graph whose edges have an arity and a
> direction-of-flow that depend on which face of the cell (read vs
> write) you're using.**

This is a special case of a **hypergraph**: each "constraint" (lens,
combine, mean) is a hyperedge connecting one derived cell to N parent
cells, and the hyperedge has a `forward` projection (parents → derived)
and a `backward` projection (derived → parents).

## Why accidental cycles stay hard

Three structural facts:

1. **`lens.value = x` always terminates downward**. The setter writes
   to parent signals or to other lenses. Recursively, every chain of
   `set` calls hits a concrete signal (or throws on a computed).
   Lenses themselves cannot form a write-cycle because the setter only
   *goes up the parent chain*; the parent's own setter is independent.

2. **Reading does not write**. The reactive engine only triggers
   propagation on `set value`. Reading a derived cell never schedules
   a write. So no read path can re-enter itself through a write path
   in the same evaluation.

3. **Effects-that-write-into-their-own-deps are caught by the
   engine**. The `RecursedCheck` flag throws on direct re-entry
   (cycle in a computed). The `flush` re-entrancy guard prevents
   cascading bind-effects from blowing the stack even if they're
   structurally a chain. Effects that *do* want to write into their
   own dep are explicitly queued for the next flush rather than
   re-evaluated synchronously.

The remaining hazard is **semantic** cycles via `combine` (you could
write a `combine` whose `distribute` function returns parent values
that then cause `merge` to produce a different composite). The engine
won't recurse, but the system won't converge either. This is a
hyperedge that violates the lens laws (Put-Get: `get(set(s, a)) = a`)
and we don't enforce it structurally. Documentation says "your
distribute should be a right-inverse of merge"; we trust the author.

## "More than a DAG" — research worth knowing

A few literatures point at richer structures. Listed roughly by how
much we'd actually want to steal from each.

### Propagators (Sussman & Radul, 2009)

Closest to "what comes after lens-DAG." A propagator network is a
hypergraph of **cells** connected by **propagators** (constraint
nodes). Each propagator can run in *any* direction — given enough
inputs, it computes the rest. The classic example is a temperature
converter that works C→F or F→C depending on which cell you fill.

- **Strength**: arbitrary fan-in / fan-out, no canonical direction.
- **Weakness**: no canonical evaluation order, requires fixpoint
  semantics; cells need merge operators (lattice-style) to combine
  partial info; convergence is not automatic.
- **Relevance to minim**: layout constraints fit this naturally
  ("`a.x + b.w/2 = center.x`" should be solvable in any direction).
  The layout-combinators article you linked is doing exactly this.
- **Cost of adopting**: you give up the clean "value semantics" of a
  signal (a cell can be in a partial-information state) and need a
  fixpoint loop on every batch. Hard to keep the current perf
  envelope.

Key papers:
- Sussman & Radul, *The Art of the Propagator* (2009)
- *Propagation Networks: A Flexible and Expressive Substrate for
  Computation* (Radul thesis)

### Profunctor optics (Pickering, Gibbons, Wu)

Mathematical foundation for the lens family. A *lens* `s ↔ a` is a
profunctor `P (a, a) → P (s, s)`. Prisms (sum-of-products lenses),
traversals (lenses with effect-fan), folds, getters — all unify as
specific profunctor shapes.

- **Strength**: deeply compositional. `lens compose lens = lens`,
  `traversal compose lens = traversal`, etc. Categorically clean.
- **Relevance to minim**: we'd get a single composition operator
  for free if we re-implemented lenses as profunctors. The
  earlier `_proto-iso/` Chain<S, T, W> work was a step in that
  direction.
- **Cost**: heavy type machinery. The runtime is fine (just
  function composition); the *type system* gymnastics in TS to
  express profunctor constraints get ugly.

Key reading:
- Pickering, Gibbons, Wu, *Profunctor Optics: Modular Data
  Accessors* (2017)
- Boisseau & Gibbons, *What You Needa Know About Yoneda* (2018)

### Self-Adjusting Computation (Acar, Blelloch, Harper)

Generalization of dependency tracking to arbitrary computation: any
function can be re-run incrementally when its inputs change, with the
runtime tracking exactly which sub-computations need re-evaluation.

- **Strength**: subsumes reactive systems as a special case. Handles
  conditional branches, recursion, etc.
- **Relevance to minim**: our `computed` is a degenerate
  self-adjusting computation. Acar's literature has formal cycle
  detection and convergence proofs.
- **Cost**: implementation is *much* heavier than our alien-signals
  engine (needs persistent change-propagation logs).

Key reading:
- Acar, *Self-Adjusting Computation* (thesis, 2005)
- Hammer et al., *Adapton: Composable, Demand-Driven Incremental
  Computation* (2014)

### Differential dataflow (McSherry, Naiad)

Stream/collection-flavored. Operates on *changes* to relational
data; supports incremental joins, iterations to fixpoint, etc.

- **Strength**: scales to large datasets; explicit support for cycles
  via timely-dataflow's "loop" operator and a timestamp partial order.
- **Relevance to minim**: probably none for a single-page library.
  Worth knowing because it formalizes "cycles are OK if they're
  monotonic in some lattice."

### Concurrent constraint programming (Saraswat)

A whole branch of programming languages where the basic operation is
"tell the store that this constraint holds" and the runtime threads a
consistent assignment. Closely related to propagators.

- **Strength**: the constraint store is the *only* state; programs
  are descriptions of what must be true, not how to compute it.
- **Cost**: even harder to give predictable performance bounds than
  propagators.

### Categorical lens laws (foundational)

Regardless of which direction we go, the lens primitive obeys laws:

```
get(set(s, a))         = a         (PutGet — write-then-read sees the write)
set(s, get(s))         = s         (GetPut — read-then-write-back is identity)
set(set(s, a), b)      = set(s, b) (PutPut — last write wins)
```

minim's `field()` lens satisfies these. User-written lenses might
not. We could add an opt-in `lens.test(initial, sample, sample2)`
that property-tests these on construction in dev builds.

Reading: Foster, Pierce, Schmitt, *Combinators for Bi-Directional
Tree Transformations* (the original "well-behaved lens" paper, 2007).

## Concretely, what could we add to minim?

In rough order of "useful vs scary":

### 1. Optional lens-law dev assertions (small, useful)

On `lens()` construction in `import.meta.env.DEV`, run the three
round-trips against `parent.peek()` and a synthetic sample value.
Catches bad custom lenses at definition time.

### 2. `hyperLens<Ins, OutShape>` — generalised `combine` (medium, fun)

Today `combine(parts, merge, distribute)` is the only N→1 primitive.
A `hyperLens` cleanly generalises it to N→M (and ergonomically wraps
the N→1 case too). Below: five concrete examples that motivate why
this matters in practice, then the API sketch.

#### Example A — `pointOnLine(a, b, t)`

Two endpoints + a parameter `t ∈ [0, 1]` define a point along the
segment AB. Forward: `lerp(a, b, t)`. Backward (drag the point):
update `a` and `b` while preserving `t`, OR fix `b` and update `a`,
OR redistribute by `(1-t, t)` weighting. Several valid inverses; the
caller picks one as `distribute`.

```ts
const p = hyperLens([a, b, t],
  ([a, b, t]) => vAdd(a, vScale(vSub(b, a), t)),
  (next, [a, b, t]) => {
    const delta = vSub(next, vAdd(a, vScale(vSub(b, a), t)));
    return [vAdd(a, vScale(delta, 1 - t)), vAdd(b, vScale(delta, t)), t];
  });
// p is a Vec; dragging p moves a and b by complementary weights.
```

#### Example B — `boxFromCorners(topLeft, bottomRight)`

Reads two `Vec`s → produces a `Box`. Writing the `Box` (resize/move
in the UI) writes both corners back. This is N→1 and `combine` already
covers it; included to show that the trivial case stays trivial.

#### Example C — `wheel(center, radius, n)` → `Vec[]`

`n` points on a circle, defined by center + radius. Reads: 2 inputs.
Outputs: `n` `Vec`s. Drag any point and the system updates either
`(center, radius)` (preserve angle of dragged point), or just `radius`
(snap rotate), or rotate everything around the unchanged center
(distance from dragged point as the new radius). This is genuinely
2→N with a write-back policy decision per output.

```ts
const points = hyperLens([center, radius],
  ([c, r]) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  }),
  // distribute is per-output:
  {
    [Symbol.iterator]: ...,  // some convention for "which output was written"
    write(i, next, [c, _r]) {
      // policy: preserve center; radius is the distance from c to next
      const r = Math.hypot(next.x - c.x, next.y - c.y);
      return [c, r];
    },
  });
```

#### Example D — pinch/zoom (2 fingers → center, distance, rotation)

`(f1, f2)` → `(center: Vec, distance: Num, rotation: Num)`. 2→3.
Writing `distance` (e.g., snap-zoom) needs to update both fingers
preserving the midpoint and rotation. Writing `center` (drag)
translates both fingers together. Writing `rotation` rotates them
about the midpoint. Each output has a different inverse policy.

#### Example E — `ax + by = c` constraint (propagator-flavored)

Three cells related by an equation. Given any two, solve for the
third. This is the propagator-network case (next section); our
`hyperLens` can be a degenerate version where the "policy" picks one
fixed direction, with the other directions throwing.

#### API sketch

Three layers, each more general than the last:

```ts
// (a) N→1 — what combine already does, just with type-level help
function lens1<T, Ins extends readonly Read<unknown>[]>(
  parts: Ins,
  merge: (vs: { [K in keyof Ins]: ValueOf<Ins[K]> }) => T,
  distribute: (next: T, prev: { [K in keyof Ins]: ValueOf<Ins[K]> }) =>
    { [K in keyof Ins]: ValueOf<Ins[K]> },
): Reactive<T>;

// (b) N→M — same merge style but produces a record of outputs;
//     write paths are keyed per output
function lensN<Ins extends readonly Read<unknown>[], Outs extends Record<string, unknown>>(
  parts: Ins,
  forward: (vs: { [K in keyof Ins]: ValueOf<Ins[K]> }) => Outs,
  backward: { [K in keyof Outs]: (
    next: Outs[K],
    prev: { [I in keyof Ins]: ValueOf<Ins[I]> },
  ) => { [I in keyof Ins]: ValueOf<Ins[I]> } },
): { [K in keyof Outs]: Reactive<Outs[K]> };

// (c) hyperLens — explicit "any input can be the unknown" propagator-y form
//     (post 'hard to type cleanly' warning; revisit)
```

`(a)` is `combine` with prettier types. `(b)` is the new primitive
worth prototyping: a record of Reactives backed by a shared
forward/backward set. `(c)` is propagator territory and probably
belongs in its own primitive (see §3).

The interesting work for `(b)` is the inverse-policy keying. Today
`combine`'s `distribute` is a single function returning all parents;
for N→M we need to know *which output* was just written so we can
apply the right inverse policy. That's the surface I'd want to
prototype next on this thread.

### 3. Propagator-style cells with partial info (big, breaks model)

See §"Propagators" above. Worth a separate `_proto-…/` directory if
we want to explore. Don't try to retrofit into the current engine.

### 4. Profunctor optics layer (typing-heavy, runtime trivial)

This is the one I'd most want to actually prototype after `hyperLens`.
A few minutes' sketch of what the shape would be:

A lens, prism, traversal, fold, getter — all of these are
"transformations on data accessors." A *profunctor* `P` is a thing
that contravariantly accepts inputs and covariantly produces outputs:
`P (a, b)` means "given an `a`, produce a `b`." All optics are then:

```
optic : ∀ p. (constraint on p) ⇒ p a b → p s t
```

Different constraints pick different optics:

- `Strong p` (lens-style): can pair the input with extra context →
  lens.
- `Choice p` (prism-style): can switch on a sum type → prism.
- `Wander p` (traversal-style): can map over a container → traversal.

The huge win: **one `compose` operator that just works**.

```ts
vec.x                                    // Lens<Vec, number>
playlist.songs                           // Lens<Playlist, Song[]>
playlist.songs.compose(arrayElems)       // Traversal<Playlist, Song>
playlist.songs.compose(arrayElems).compose(song.title)
                                         // Traversal<Playlist, string>
```

The runtime cost is essentially "function composition" — each optic
is a `(p a b) → (p s t)` function and composing them is just
`g ∘ f`. The TypeScript types are the hard bit but they ARE
solvable; libraries like `monocle-ts` and `optics-ts` exist in
production TS today, with substantial type machinery but working.

For minim specifically the win would be:

1. `vec.x.compose(num.add(5))` style chaining for free (no need to
   hand-write each lens variant).
2. Prisms for sum types — would make discriminated-union reactive
   state way cleaner (e.g., `state` is `Loading | Loaded<T> | Error`,
   and `state.prism("Loaded").lens("data").lens("items")` gives a
   traversal into the data of any Loaded state without manual
   null-guards).
3. Traversals over collections — `shapes.each.box.center` would
   produce a reactive view that updates whenever any shape's center
   changes, with a write distributing to all shapes.

The hard parts:

1. **Types**. Profunctor encoding in TS works but the error messages
   are infamous. Need to invest in good named aliases (`Lens<S, A>`,
   `Prism<S, A>`, `Traversal<S, A>`) that hide the profunctor
   plumbing from end-users.
2. **Reactivity boundary**. `lens.compose(prism)` produces a
   `Traversal`, but a traversal over a reactive cell isn't trivially
   a `Reactive<…>`. Need to think about whether the optic produces a
   *reactive view* (a Lens/Traversal that *also* satisfies our
   `Reactive<T>` contract) or a *static lens* (just data) that can be
   *applied to* a reactive cell.
3. **Lens laws under reactivity**. PutGet/GetPut/PutPut interact
   with the dirty-tracking machinery — need to make sure
   `parent.peek().compose(lens).set(x)` is consistent with `parent.x.value = x`.

**Recommendation**: prototype in a new `_proto-r2-optics/` directory
parallel to r2. Don't try to retrofit; the type story is big enough
that it deserves its own clean slate to develop in. Start with
`Lens<S, A>` only (no prism/traversal) and the single-cell
reactive integration; expand only once the type ergonomics feel OK.

Key reading:
- Boisseau & Gibbons, *What You Needa Know About Yoneda* (2018) —
  the foundation paper for profunctor optics.
- Pickering, Gibbons, Wu, *Profunctor Optics: Modular Data
  Accessors* (2017) — the comprehensive treatment.
- `optics-ts` source — practical TS encoding; worth reading to see
  which corners they cut (and why).

## Verdict for now

minim's current shape — DAG-of-reads + DAG-of-writes joined at lens
nodes, with N-to-1 hyperedges via `combine`/`mean` — is structurally
sufficient for layout, animation, and the existing interaction
patterns. It's bigger than a DAG (because of the bidirectional lens
edges) but smaller than a full propagator network (no fixpoint, no
partial info). The benefit of staying here: predictable single-pass
evaluation per batch, ~ns-scale reads, no convergence loop.

The next interesting boundary is hyperLens for genuine N→M
constraints. Anything more (propagators, profunctor optics) is a
separate research-prototype scope and should live in its own
`_proto-…/` folder before any consumer touches it.
