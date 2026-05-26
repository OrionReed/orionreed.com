# Lens × propagator composition — semantic findings

What can we *say* now, having lenses and propagators side by side
in the same system, that we couldn't say before?

These aren't correctness questions — those live in
`correctness.test.ts`. These are about **what the composition
gives us as a thinking tool**.

## The core distinction

| Lens | Propagator |
|---|---|
| A **value** defined by a computation | A **constraint** imposed on cells |
| `c = a.add(b)` — `c` IS `a + b`, by construction | `add(a, b, c)` — these three should satisfy `a+b=c` |
| Total function (always defined) | Relation (may iterate, may fail) |
| Single fused Computed cell | Network node + fixpoint loop |
| One output, deterministic bwd | M:N, multi-valued / iterative inverses |
| ~0.15 µs per drag | ~1.2 µs per drag |

This is the substance: **lenses define values; propagators enforce
properties.** Lenses make claims about identity ("c is the centroid
of these"); propagators make claims about state ("centroid should
equal this target").

## What composition enables

The semantic gain isn't "lenses replace propagators" or vice versa.
It's that the two paradigms can compose to separate concerns that
are usually conflated.

### A. Definition vs constraint as separable concerns

Without composition, "constrain the midpoint of these to lie on
that line" requires either:
- A custom propagator step body that computes midpoint internally
  AND projects it onto the line.
- A constraint library with a built-in "midpoint-on-line" primitive.

With composition, you write:
```ts
const m = midpointLens(A, B);   // definition
p.add(onLine(m, L1, L2));        // constraint
```

The midpoint is a derived value (lens). The constraint is on that
derived value (propagator writing through the lens). The lens's
bwd handles the algebra of "translate this delta back to the
endpoints."

`semantic-A-definition-vs-constraint.test.ts` walks through this
with concrete examples.

### B. Lens encapsulates write POLICY; propagator decides write TRIGGER

When a propagator writes through a lens, the lens's bwd determines
HOW the write propagates to underlying cells. The propagator only
decides WHAT to write (the target value).

```ts
function followGoal(target: Writable<Vec>, goal: Writable<Vec>) {
  return propagator([goal], [target], () => {
    target.value = goal.value;
  });
}
// Same propagator body works for:
//   target = single Vec        → one cell moves
//   target = midpointLens(a,b) → two cells move
//   target = centroidLens(...) → N cells move
//   target = customLens        → custom distribution
```

The propagator becomes **polymorphic over write policies** by
accepting any writable lens. This is genuinely new — without
lenses, the propagator body would have to embed the distribution
logic.

`semantic-B-lens-as-bwd-policy.test.ts` demonstrates this with
single-cell, midpoint, centroid, and a custom 70/30-biased lens —
all driven by the same propagator body.

### C. Constraints become first-class data via residual lenses

A constraint can be expressed as a derived value: "the residual"
(how far off we are). This is just a lens chain.

```ts
const dist = a.distance(b);
const residual = dist.sub(targetDist);   // lens — the violation
```

`residual` is a reactive signal:
- UIs can subscribe and **show** the violation.
- Debuggers can plot it over time.
- Other propagators can branch on its magnitude.
- A solver propagator drives it to zero.

This separates **the constraint as data** from **the action that
maintains it**. With propagators only, the constraint logic is
locked inside the step body; outsiders can't see "how far off
we are."

`semantic-C-lens-as-residual.test.ts` shows this for distance
constraints, clamp constraints, and multi-residual systems.

### D. Three-way separation: definition / predicate / solver

Putting A, B, C together: a "constraint" decomposes into three
independently swappable pieces.

| Concern | Form | Swappable axis |
|---|---|---|
| **Definition** | Lens chain | "How is the value computed?" |
| **Predicate** | Residual lens (= 0 ↔ satisfied) | "What should be true about it?" |
| **Solver** | Propagator | "How do we make it true?" |

`semantic-D-three-way-separation.test.ts` shows the same
"triangle area = 100" constraint with each axis swapped:
- Definition: shoelace vs base×height (same value, two formulas).
- Predicate: area = 100 vs area = 25 (same definition, different
  target).
- Solver: snap c.y vs snap c.x-to-midpoint (same constraint, two
  different correction policies).

In a traditional constraint library, all three are coupled. With
lens × propagator, they're orthogonal.

## Why "lens equivalents exist" doesn't kill propagator variants

Earlier I argued that `vCentroid`, `vMidpoint` etc. were redundant
with `centroidLens`, `midpointLens`. Looking again through the
composition lens (no pun intended):

- The LENS form is the **definition role**.
- The PROPAGATOR form is the **solver role**.

They're the SAME relation viewed through different concerns. Some
use cases want one; some want the other; some want both:

```ts
// Definition: m IS the midpoint.
const m = midpointLens(a, b);

// Solver: maintain "midpoint of x, y == midpoint of a, b".
p.add(propagator([m], [midpointLens(x, y)], () => {
  midpointLens(x, y).value = m.value;
}));
```

The propagator is a SOLVER over lens-shaped values. The lens is a
DEFINITION. Both are first-class.

When ALL you want is "c is the midpoint of a and b" — use the
lens. When you want "the midpoint of x and y must follow the
midpoint of a and b" — you need the propagator (because you have
two pre-existing lens-derived values that can't be the same cell).

So both stay. The earlier audit ("delete vec-ops") was too
aggressive — they read more naturally as solver-role helpers in
the composition story.

## Where the gap is — and what it tells us

`correctness.test.ts` § 5 documents a real limitation:

**Freshness propagation through lens chains works for EXTERNAL
writes but NOT for in-fixpoint cascades.**

Concretely: if propagator A writes a cell `x`, and propagator B
reads `x.scale(2)` (a lens), B does NOT fire within the same
fixpoint iteration. The fresh set has `x`, not the lens chain
that depends on it.

Workarounds today:
- List the chain's parents in propagator reads (loses the
  abstraction).
- Split into separate `Propagators` instances (re-fires via
  external write boundary).

The proper fix would be: the network's freshness algorithm walks
through Computed dependents to find which propagator-tracked reads
are transitively fresh. Doable but requires engine work.

**Implication for the composition story:** lens × propagator
composition is sound for ONE-DIRECTION pipelines (lens → propagator
→ lens), but cycles through both have non-obvious termination
semantics. We documented the gap; we haven't fixed it.

## What I'd recommend about the propagators package now

Revising the previous rounds:

1. **DO NOT delete `vCentroid`, `vMidpoint`, `vAdd`, `vSub`** —
   they fill the solver role even when lens equivalents exist for
   the definition role. Both are useful.

2. **Document the role split.** The propagators package should
   frame combinators as "solvers over relations." Lenses are
   primary for derived values; propagators primary for solving
   constraints.

3. **Fix the freshness-through-lens gap** (engine-level work) —
   this would make composition work cleanly even in cycles.
   Until then, document the workaround.

4. **Add a `residual` helper** that makes "constraint as a lens"
   ergonomic: `residual(dist(a, b), targetDist)` returns a lens
   chain that's the violation. Trivial; just sugar.

5. **Show the three-way separation in a real demo.** A draggable
   triangle with a dropdown to swap definition / predicate /
   solver. The demo is the SELLING POINT: users see they can
   change one without touching the others.

The propagator package's value isn't "do everything lenses can't."
It's "be the solver-role half of constraint composition." That's
a clearer pitch and a more honest one.

## Open questions that the probes don't fully resolve

1. **Is the freshness gap fixable cleanly?** Or does it require
   walking arbitrary Computed graphs from inside the fixpoint loop
   (potentially expensive)?

2. **Are there cases where the lens approach is OUT-classed** —
   even for definitions — and propagators are the right
   primitive even there? Probably yes for certain bidirectional
   N:M patterns; haven't probed exhaustively.

3. **What does a "constraint as lens" library look like?** If
   residual-as-lens is the right shape, there's room for a small
   toolkit: `residual(...)`, `clamped(...)`, `equalTo(...)`,
   `between(...)` — all returning lens chains that can be fed
   into solver propagators.

4. **Do the existing AVBD `Constraints` fit the same pattern?**
   AVBD constraints DO have "residuals" internally (the violation
   the solver minimizes). Could AVBD's residual computation be
   exposed as a lens chain? That would unify AVBD with the
   composition story.

These are real probes for next sessions, not loose ends to clean
up here.
