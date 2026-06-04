# Context-Aware Backward Functions

A design note arising from a long exploration of how to express
multi-cell user intent (pinning, weighting, mode switching, priority
distribution) in coreactive lenses. The conclusion is that the substrate
already supports the whole space; what is missing is a single ergonomic
call-site shape and a clear vocabulary for it. This document records the
findings and the proposed design point.

It is exploratory. No code change has been made on the back of it. It is
written so the new signals implementation has the design captured
explicitly when the work lands.

---

## 1. The problem

A multi-input lens — say, `M = midpoint(A, B)` — has a backward direction
that must decide how to distribute a write across its parents. With a
fixed bwd, the lens encodes one policy: translate both, or
distribute-evenly, or absorb-into-the-last. But real usage requires the
policy to vary with user intent. The most concrete shape: the user pins
B (touches it, holds it) and drags M; A should follow such that the
midpoint hits M's new value and B is left alone.

The instinct is that something new is needed — a new propagation
direction, a "pinning" primitive, a constraint solver, or an amendment
construct from the multiary-delta-lens literature. The empirical
finding, verified across several probe scenarios, is that **none of that
is needed.** The mechanism is already in the substrate. What is missing
is the surface design.

## 2. The mechanism, stated precisely

A lens's backward function is a closure. It can read any reactive cell
via `peek()`. The N-ary bwd returns per-parent updates and may return
`undefined` for any parent it wishes to leave untouched. The engine
already supports per-parent skipping via the existing `_fanin` machinery
(`if (u === undefined) continue`).

Combining these three facts:

> **A lens's backward distribution policy is a closure that may read
> arbitrary reactive cells to make its decision, and may write any
> subset of its parents.**

That is the entire mechanism. Pinning, weighting, priority-ordered
distribution, mode-dependent dispatch, capacity waterfalls — all of
these are instances of this one shape with different closures. The
substrate is **already complete** for this entire family of behaviors.

This was verified in probes spanning four shapes: N-ary aggregates with
pin sets, capacity waterfalls with priority slot lists, continuous
weight vectors, and string-valued gesture modes. All four work with no
engine changes, no new constructs.

## 3. What this dissolves

A number of earlier design tensions resolve under this framing:

- **The writable-parameters experiment** (since removed from the
  repository) was attempting to make lens parameters writable so that
  writes could distribute across them. The mechanism above subsumes it:
  a "writable parameter" is just a parent of a fanin lens.
- **The "dependent lenses" probe** was looking for value-parameterized
  bwd behavior. The mechanism above is exactly that — the bwd's
  behavior is parameterized by whatever cells it reads.
- **The "orientable lens-factorable relations" framing** — relations
  with multiple closed-form orientations selected by a pin state —
  reduces to a bwd that branches on a pin cell.

The deeper realization: **almost every "we need a new primitive for X"
question in this design space turns out to be "X is expressible as a
bwd that reads a cell."** The substrate's contribution is narrower and
sharper than it first appeared: it's not "a runtime for bidirectional
reactivity" but specifically "a runtime where backward functions are
first-class citizens that can read context cells and return per-parent
updates with selective skips."

## 4. The pattern, named

The pattern is **context-aware backward functions**. A bwd may consult
reactive cells beyond its declared parents to determine how to distribute
a write. There is no special construct, no new cell type, no primitive
named "pin" or "weight." The pattern is composed of three existing
substrate features:

1. The bwd closure may read any cell (the substrate gives closures over
   reactive values for free).
2. The bwd is invoked with `activeSub = undefined` so its reads do not
   leak into surrounding dependency contexts (see §6).
3. The bwd may return `undefined` per parent to skip writing it.

Documentation should name this pattern explicitly and give canonical
examples — pin, weight, waterfall, mode — without elevating any one of
them to a substrate concept.

## 5. The ordering rule

A subsidiary finding worth stating clearly because users will ask: **how
does ordering work?**

The general rule is the same one that applies to any sequential
reactive code:

> **Set context cells before invoking the cells that consult them.
> Causes before effects.**

For sequential code outside a batch, this is automatic — the second
statement sees the first statement's writes. The probe confirmed:

```ts
pin.value = "b";   // commit the context
m.value = 50;      // bwd reads the new pin via peek()
// → A absorbs, B held. Correct.
```

A touch-down handler that sets the pin and a drag handler that sets the
value are simply two statements in sequence; the first commits before
the second runs.

Inside a batch, ordering does not matter. Lens bwds defer to flush, and
when they run during `flush()` they see the final state of all writes in
the batch via `peek()` returning `pendingValue` for any dirty source.
This means batched code like:

```ts
batch(() => {
  m.value = 50;     // bwd deferred
  pin.value = "b";  // pin write deferred
});
// → A absorbs, B held. Correct.
```

works identically to the reverse order. The user need not think about
ordering within a batch — the engine collapses time.

Stated together: **batching is an optimization for atomicity of multiple
writes; it is not required for correctness of the context-cell pattern.
Outside batches, sequential causation applies.**

## 6. The single engine-level change

There is one substantive engine change implied by this design, and it is
small but important:

**The bwd is invoked with the active subscription cleared.** Today, a
write inside an effect runs the bwd synchronously within the effect's
body, with the effect's `activeSub` still installed as the global
tracker. If the bwd reads a context cell via `.value` (tracked), the
context cell becomes a *dependency of the surrounding effect* — silently
and unintentionally. Subsequent writes to the context then re-fire the
effect for reasons the user did not author.

This was confirmed empirically: a bwd reading `ctx.value` from inside an
effect caused the effect to re-run on `ctx.value = x`, even though the
effect's body did not directly mention `ctx`.

The fix is to set `activeSub = undefined` at every bwd cascade entry
point. This makes `.value` and `.peek()` behave identically inside a
bwd, eliminating the asymmetry footgun where forward closures want
tracked reads (`.value`) and backward closures want untracked reads
(`.peek()`).

The rationale is unambiguous:

- **No expressive cost.** Reactive lens parameters (e.g. `vec.add(b)`
  where `b` is a writable signal) work fine without bwd tracking — the
  *forward* getter reads `b.value` (tracked, keeps the cell live), and
  the bwd reads `b.peek()` (untracked, just consults the value). The
  cell's reactivity is driven by the forward dep; the bwd is invoked on
  demand.
- **No use case is served by bwd tracking** that isn't already served
  correctly by forward tracking plus untracked bwd reads. The
  hypothetical "the write should re-fire when context changes" is a
  separate concept (a "standing write" or "reactive expression bound to
  a cell") and would be a deliberate construct, not bwd-dep leakage.
- **A real footgun is permanently removed.** The fwd/bwd peek-vs-value
  asymmetry inside a single lens construct stops mattering.

## 7. The ergonomic question: how does this appear at the call site?

The mechanism works today using the bare fanin factory:

```ts
const sum = Num.lens([a, b],
  ([av, bv]) => av + bv,
  (n, [av, bv]) => {
    const p = pin.peek();
    if (p === "a") return [undefined, n - av];
    if (p === "b") return [n - bv, undefined];
    const d = (n - (av + bv)) / 2;
    return [av + d, bv + d];
  });
```

But this is not the call site one wants to write inside an existing
chain. The existing chain — `a.add(b).scale(2)` — is ergonomic precisely
because each step is one method call on the receiver. Switching to a
bare `Num.lens([a, b], ...)` breaks the chain and forces the user to
re-spell the forward function that `add` already encodes.

The proposed design point: **each value-class method that accepts a
`Val<T>` parameter grows an optional `opts` argument** that, when
provided, promotes the parameter to a writable parent and accepts a
distribution policy:

```ts
a.add(b, { share: (n, av, bv) => [...] })
```

The `share` closure takes the target value and per-parent peeked values,
and returns per-parent updates (with `undefined` to skip). When `opts`
is omitted, behavior is identical to today — `b` is treated as a static
parameter, the lens is single-parent, the bwd is the canonical inverse.
When `opts.share` is provided, the lens becomes fanin over the elevated
parents and the share closure is the bwd.

A discovery from probing: **promoting the parameter and supplying the
policy are not two separate decisions.** Once a multi-parent share
closure is provided, the parameter *must* be writable for the share to
mean anything; the elevation is implied. An explicit `writable: true`
flag would be redundant. The presence of `share` is sufficient signal.

This was the conclusion after probing several alternative shapes:

- **`writable: true, bwd: ...`** — redundant; the bwd presence implies
  the elevation.
- **`bwd: ...`** — accurate but mathematically opaque; "bwd" doesn't
  suggest "this is the *policy* among possible inverses."
- **`inverse: ...`** — misleadingly suggests a unique inverse; this is
  a choice among possible distributions.
- **`distribute: ...`** — accurate, slightly heavy.
- **`share: ...`** — captures both the redistribution and the
  collaboration aspect; reads well in the multi-pin and weighted
  cases. Chosen.

## 8. Where the pattern applies and where it does not

Not every value-class method can or should accept a `share` opt. The
choice is a per-method decision by the value-class author, made on
algebraic grounds:

- **Applies cleanly** to two-arg invertible methods like `add(b)`,
  `sub(b)`, `mul(b)`, `affine(k, off)` — when `b` (or `k`, `off`) can
  meaningfully be a writable parent.
- **Applies cleanly** to N-ary aggregates: `Num.sum([...])`,
  `Vec.centroid([...])`, hypothetical `Num.mean([...])`. These are
  already fanin, the share closure simply customizes their bwd.
- **Does not apply** to self-only methods (`neg`, `recip`, `abs`) — no
  parameter to elevate.
- **Does not apply** to methods with literal-only parameters that don't
  make sense as cells (`quantize(step)` with step always a literal).
- **Does not apply** to methods whose elevation breaks invertibility:
  `scale(k)` is suspicious because `k = 0` collapses the lens; the
  author may refuse to accept a writable `k`.

The author opts in per method. There is no obligation to support `share`
universally — only where elevation has clean semantics.

## 9. The four canonical shapes, illustrated

To make the pattern concrete, four canonical uses of `share`:

**Pin by cell:**

```ts
a.add(b, {
  share: (n, av, bv) => {
    const p = pin.peek();
    if (p === "a") return [undefined, n - av];
    if (p === "b") return [n - bv, undefined];
    const d = (n - (av + bv)) / 2;
    return [av + d, bv + d];
  }
});
```

**Continuous weights** (pinning is the degenerate `[1, 0]` / `[0, 1]`
case):

```ts
a.add(b, {
  share: (n, av, bv) => {
    const [wa, wb] = weights.peek();
    const delta = n - (av + bv);
    return [av + wa * delta, bv + wb * delta];
  }
});
```

**Priority-ordered waterfall** (capacity-respecting distribution):

```ts
Num.sum([a, b, c], {
  share: (n, vals) => {
    const slots = order.peek(); // [{idx, cap}, ...] in priority order
    let remaining = n;
    const out = [undefined, undefined, undefined];
    for (const {idx, cap} of slots) {
      const give = Math.min(cap, Math.max(0, remaining));
      out[idx] = give;
      remaining -= give;
    }
    return out;
  }
});
```

**Mode dispatch** (string-valued context):

```ts
vec.lerp(b, t, {
  share: (newPoint, a, b, t) => {
    if (mode.peek() === "translate") return [translateA(...), translateB(...)];
    if (mode.peek() === "rotate") return [a, b];   // hold both
    // ...
  }
});
```

All four are instances of the same mechanism. The substrate makes no
distinction between them; only the closure differs.

## 10. Bound and unbound — what is and is not enshrined

A guiding principle: the substrate should not enshrine *any* specific
context type, name, or policy as a primitive. Pinning is not a substrate
concept; weighting is not a substrate concept; modes are not substrate
concepts. They are all user-space patterns built on the
context-aware-bwd mechanism.

What *is* enshrined:

- The `share` opt name (one method-level convention).
- The bwd-untracked engine guarantee (one engine-level change).
- Documentation of the four canonical shapes as examples (not as
  enumerated primitives).

What is **not** enshrined:

- A `pin()` primitive, a `Pinnable<T>` type, or any kind of pinning DSL.
- A `weight()` primitive, a `Weighted<T>` type, or normalized-weight
  semantics.
- A `mode()` primitive, a `Mode<T>` type, or state-machine machinery.
- A constraint solver, a relaxation engine, an amendment construct, or
  K-Putput semantics.
- Anything that would commit the substrate to one shape of user intent.

The substrate stays minimal. User-space libraries can grow factories
(`pinnable(...)`, `withWeights(...)`, `waterfall(...)`) that produce
`share` closures from higher-level declarations, but these are
convenience layers, not engine concepts.

## 11. Composition

The probe confirmed: chains over a context-aware lens compose cleanly.
A `sum` lens with a custom share, chained with `.scale(2)`, behaves
correctly — the scale's bwd applies inverse-scale, then the sum's share
closure receives the rescaled target and distributes. No special
machinery; ordinary lens composition does the right thing because the
share closure is just the cell's bwd.

The probe also confirmed: a context cell can itself be a derived cell
(a computed or another lens). The bwd's `peek()` works on any cell
type. So the context can be the output of a chain of touch-tracking
lenses, a state machine implemented as a lens, or any other reactive
expression. This compositionality is automatic; it is not something the
share mechanism needs to provide.

## 12. Footguns and their mitigations

Three footguns were identified in probes, of which two are real and one
turned out to be illusory:

- **Real: fwd/bwd peek-vs-value asymmetry.** Mitigated by the engine
  setting `activeSub = undefined` during bwd invocation (§6).
- **Real: lenses sharing parents racing in the same batch.** Two lenses
  with overlapping parents, both written in one batch, race for the
  shared parents. This is the diamond/merge problem and is not specific
  to the context-aware bwd pattern; it is addressed (or not) by the
  separate `merge()` mechanism work.
- **Illusory: "the pin must be set first within a batch."** The probe
  showed this is not the case. Inside a batch, lens bwds defer to flush
  and see the final state of all writes via `peek()`. Order within a
  batch is irrelevant. Outside a batch, sequential causation applies
  ordinarily — context cells should be set before the cells that
  consult them, as for any sequential code.

## 13. Higher-order constructs (orthogonal to this design)

A separate exploration of "higher-order lenses" surfaced four readings,
of which two are genuinely orthogonal extensions and two reduce to
substrate features the engine already has:

- **Cell-of-lens**: trivial; a signal whose value is a lens. Reduces
  to first-order with first-class values.
- **Lens-with-cell-fwd/bwd**: live-swappable behavior. Genuine
  higher-order; an interesting research direction; subtle
  invalidation semantics need their own probe. Not addressed here.
- **Lens combinators (lens → lens)**: user-space functions producing
  new lenses. The natural API for things like `rebind`, `pinnable`,
  `weighted` if they are ever needed. No engine change.
- **Lens-as-context-cell**: the context cell of a context-aware bwd
  can itself be a lens. Already works; reduces to substrate uniformity.

None of these blocks or alters the context-aware-bwd design. Higher-
order constructs, if pursued, would build on top.

## 14. Summary of proposed changes

If this design is adopted in the new signals implementation, three
concrete changes follow:

1. **Engine-level:** Set `activeSub = undefined` at every bwd cascade
   entry. Eliminates the fwd/bwd peek-vs-value asymmetry footgun. No
   expressive cost; one class of bug permanently removed.

2. **Method-level:** For value-class methods where it makes algebraic
   sense, grow an optional `opts: { share?: ShareFn }` argument that
   promotes the parameter(s) to writable parents and uses the share
   closure as the bwd. Default behavior unchanged when `opts` is
   omitted; existing call sites and tests are unaffected.

3. **Documentation:** Name and explain the context-aware-bwd pattern
   with the four canonical shapes (pin, weight, waterfall, mode) as
   examples — *not* as enumerated primitives. State the ordering rule
   plainly: causes before effects, the same rule that applies to any
   sequential reactive code. Cite the prior art neighborhood
   (Cunha 2014 for spreadsheet bidirectional formulas, Sketchpad14 for
   constraint-reactive direct manipulation, Diskin 2019 for the
   multiary delta lens with amendment) and position coreactive's
   approach as: the same problems the constraint and amendment
   literatures address, expressed in user code rather than requiring
   new substrate machinery.

That is the entire intervention. It is much smaller than any of the
prior design directions explored over the arc of this conversation, and
it appears, on the evidence of multiple probes, to be sufficient.