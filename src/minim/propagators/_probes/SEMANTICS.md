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

## The freshness design space

The earlier "freshness through lens" finding was incomplete.
After more probing (`freshness-design-space.test.ts`,
`freshness-auto-expand.test.ts`, `freshness-enforcement.test.ts`),
the design space has at least five distinct contracts, each with
different semantic guarantees, install/runtime cost, and rules
the user must follow:

| Contract | Rule for users | Enforcement | Runtime cost | Guarantee |
|---|---|---|---|---|
| **TRUST** (current) | Declare every transitive dep yourself | None | Lowest | Only as good as user discipline |
| **VALIDATE** | Declare; framework warns/errors at install if reads not transitively closed | Install-time | Lowest | User catches own mistakes |
| **AUTO-EXPAND** | Declare logical reads; framework walks lens chains and adds parents at install | Install-time | Lowest (one-shot) | Strong; no runtime walk |
| **WALK-DEPENDENTS** | Declare logical reads; framework walks Computed dependents of fresh signals at runtime | Per-iteration | Medium | Strong; handles dynamic graphs |
| **POLL** | Declare reads (any granularity); framework peek-checks all reads vs snapshot every iteration | Per-iteration | High (technically) | Trivially strong |

Probe findings:

- **POLL is faster than TRUST** in microbenchmarks for medium
  chains — because TRUST's iteration scan + freshness-set bookkeeping
  has overhead, while POLL is just N peeks and comparisons. Worth
  re-measuring on production-shaped workloads before drawing
  strong conclusions, but the cost gap isn't 10× — it's comparable.

- **AUTO-EXPAND works cleanly** — the lens chain's parent set is
  walkable at install time via the engine's existing Computed deps
  list. Two-line introspection helper in `freshness-auto-expand.test.ts`
  shows it. Zero runtime overhead vs TRUST, plus the freshness gap
  is gone.

- **VALIDATE is cheap at install and useful as a warning level.**
  Same introspection as AUTO-EXPAND, but emits a warning instead of
  silently expanding. Good for debug builds.

- **The "lens chains fuse" property** simplifies AUTO-EXPAND: a
  chain like `a.add(b).scale(2)` has a single Computed cell with
  deps `{a, b}`, not three nested cells. So expanding is shallow,
  not deep.

### What gets enforced — design tradeoffs

Beyond freshness rules, the framework can also check:

- **Declared writes were used** (peek-before/after). Useful diagnostic;
  unreliable for "wrote-same" cases without setter interception.
- **Read set is transitively closed** (introspect lens chains). The
  freshness-gap detector — useful as a warn even without auto-expansion.
- **Body is deterministic** (run twice; compare). Slow but useful in
  test mode.
- **Network is acyclic on direct deps** (cycle detection). Catches
  obvious infinite loops at install.

The menu of policies an engine could expose:

| Policy | Default | Description |
|---|---|---|
| `off` | non-prod | trust the user (current behaviour) |
| `warn` | dev | warn at install on incomplete read sets |
| `auto` | maybe | silently expand at install |
| `strict` | tests | error at install on incomplete read sets |

### My recommendation

**Ship `auto` as default + `warn` in dev mode.**

- AUTO-EXPAND eliminates the freshness gap with no runtime cost.
- `warn` mode flags accidental incomplete declarations so users
  learn the model.
- `strict` is opt-in for users who want maximum control.
- TRUST stays available as `off` for advanced cases.

The principle: **the framework should make the right thing easy
and the wrong thing visible.** Auto-expand is right by default;
warn surfaces declarations the user might want to re-examine.

## Composability examples in real shapes

`composability-examples.test.ts` shows four worked compositions:

1. **Form validation:** field-level constraints expressed as
   residual lenses (`num(3).sub(usernameLen)` for "need length ≥ 3").
   UI subscribes via effect to show error messages. A submit
   propagator (or a derived "all-zero" predicate lens) gates the
   action. The constraint becomes data; the UI is just a
   subscriber.

2. **Coordinate-system change:** Cartesian (x, y) is primary;
   polar (r, θ) is a lens. A constraint expressed naturally in
   polar ("θ = π/4") translates back to Cartesian via the lens
   chain. The lens encapsulates the change of basis; the propagator
   only deals with the natural form.

3. **Animation × constraint:** a tween writes a target Vec, which
   is a centroid lens. Each tween write redistributes to underlying
   points. A clamp propagator keeps the target in a bounding box.
   Three independent concerns (tween / lens / clamp) compose into
   one declarative pipeline.

4. **Energy conservation:** total kinetic energy is a lens chain
   over (mass, velocity). A propagator enforces conservation: when
   one velocity changes, others adjust to preserve total E. The
   conserved quantity is a derived value; the conservation law is
   a constraint over it.

The unifying pattern: **a lens says "this IS true by construction";
a propagator says "this SHOULD be true by intervention."** The
composition lets you mix declarative derivations with imperative
corrections cleanly.

## The user-facing picture

After all the probes, here's what someone mixing the two should
think about. This is the MENTAL MODEL — what to ask yourself when
designing a relation.

### The three roles

When you have a "constraint," it splits into three orthogonal
pieces. Each is a different tool:

| Role | Tool | Question |
|---|---|---|
| Definition | **Lens** | "What VALUE do I care about?" |
| Predicate | **Lens** (residual) | "What should be TRUE about it?" |
| Solver | **Propagator** | "How do I MAKE it true?" |

Concrete: "the bar's length must be in [50, 200]."
- Definition: `length = Num.derive([A, B], distance)` — a lens.
- Predicate: out-of-range → `length < 50 || length > 200` — also
  a lens chain, observable by UI.
- Solver: a propagator that scales (B − A) about the midpoint
  when length is out of range. Writes A and B.

Each is independently swappable. Want a different "length" notion
(weighted, projected, etc.)? Change the lens. Want different
bounds? Change the predicate. Want a different correction (snap,
clamp, gradient, …)? Change the propagator.

### Decision tree

> "I want a derived value" → **lens.**
>
> "I want to constrain existing cells" → **propagator.**
>
> "I want multiple outputs / iteration / branching" → **propagator.**
>
> "Both" → **mix.** The lens defines the value; the propagator
> writes through the lens to enforce the property.

`decision-framework.test.ts` walks each branch with a worked
example.

### What you're optimising for

In order of how often it bites in real usage:

- **Expressiveness.** Lenses for definitions; propagators for
  constraints. Don't force a definitional relation through a
  propagator (you lose composability and pay 8× cost).
- **Performance.** Lenses are 8× faster than propagators on the
  same 1-output relation. Reach for lenses where you can.
- **Correctness.** Lenses are total functions, never inconsistent.
  Propagators iterate to fixpoint, can diverge or settle
  inconsistent (cycle case). Mix carefully across cycles.
- **Simplicity.** The three-role split keeps each piece short and
  swappable. The mental overhead is "which role?", not "which
  API?".

## The footgun catalog

`footgun-catalog.test.ts` reproduces all eight with workarounds.
The high-impact ones:

| # | Symptom | Workaround |
|---|---|---|
| 1 | In-fixpoint cascade through lens silently fails | List chain parents in reads, or ship AUTO-EXPAND |
| 2 | Bidirectional propagator's first-fire direction overwrites your driver | Write the canonical driver AFTER install |
| 3 | Cycle through lens silently leaves system inconsistent | Avoid such cycles, or use AVBD's iterative solve |
| 4 | Two propagators writing the same lens — last write wins | Combine into one propagator with explicit policy |
| 5 | Hot loop re-peeking a chain | Cache `chain.value` once at start of step body |
| 6 | Disposing the propagator doesn't dispose the lens | Separate concerns; dispose what you own |
| 7 | Writing through `centroidLens` moves ALL parents, not just one | Read the lens's bwd policy; use a custom Vec.lens if you want different distribution |
| 8 | Lens chain on cells outside the network: propagator observes but can't force | Recognise the boundary; use AVBD or another tool to force across boundaries |

Footguns 1 and 3 are the substantive ones — both are about the
freshness-through-lens semantics. AUTO-EXPAND fixes 1; cycles
through lens (3) need different machinery.

Footgun 2 is the eq/add initial-fire issue we already
documented in earlier rounds.

The rest are predictable consequences of the model — easy once
you know they exist.

## Open questions that the probes don't fully resolve

1. **Should AUTO-EXPAND replace TRUST as default?** It fixes the
   gap with zero runtime cost. The only downside is the engine
   now depends on lens-chain introspection, which currently uses
   private state (`getter`, `deps` fields). That contract should
   be public if AUTO-EXPAND becomes the default.

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
