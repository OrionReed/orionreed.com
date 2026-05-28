---
title: Coreactive (Bireactive?) Programming
description: Bidirectional reactive programming with lenses.
---

Reactive systems are DAGs of cells where edges mean "reads". Information flows one way — leaf to root, input to output — and a cell is permanently either input or output. **Coreactivity** keeps the DAG and the acyclicity, but every edge now carries a `put` as well as a `get`. A derived cell can be *written*; the write flows back up the same edge the read came down. No cell is permanently anything. You can drive either end.

Drag any cell on the left; watch the right.

<md-coreactive></md-coreactive>

Each lit edge is a real engine fire: red descends the inverse along reverse-capable edges, blue refreshes the forward cone. The graph stays an oriented DAG; bidirectionality is a property *of each edge in isolation*, not of the whole graph. There is no solver and no fixpoint loop — a `put` is one bounded upstream walk.

The natural worry is that two-way edges force a constraint-satisfaction regime. They don't, because the bidirectionality is **edge-local**: each edge independently carries both directions, and the graph stays acyclic.

| Regime            | Edges                         | Termination          |
| ----------------- | ----------------------------- | -------------------- |
| Reactive          | one-way                       | acyclicity           |
| **Coreactive**    | **bidirectional, edge-local** | **acyclicity**       |
| Constraint system | bidirectional, graph-global   | fixpoint convergence |

The middle row is the unoccupied corner. The rest of this post is what falls out.

---

The simplest edges are **invertible**: bijections whose inverse is a closed-form algebraic identity. Reflections, rotations, scales, affines, polar/cartesian conversions, unit conversions. They satisfy every lens law without breaking a sweat and compose perfectly.

Reflection across a line is an involution — its own inverse:

<md-mirror></md-mirror>

The same machinery generalises to the Poincaré disc, where geodesics are circles perpendicular to the boundary and reflection is inversion in that circle. Three vertices, three sides, three sister triangles obtained by reflecting one vertex across the opposite side. Drag any vertex; sides curve, sisters reposition, the angle sum and area (= π − sum, Gauss–Bonnet on constant curvature) update live.

<md-conformal-disc></md-conformal-disc>

`polar(c, r, a)` is invertible under one of four policies on which input absorbs a write. Chain those into a solar system that's deterministic in one scalar — `time` — and dragging *any* body writes back through its chain into time. Every other body re-derives:

<md-solar-system></md-solar-system>

Same idea meshed: `g[i+1] = g[i].scale(-teeth_i / teeth_{i+1})` chained. Drag anywhere on a gear; the click point becomes an ephemeral grab handle. The drive integrator pauses while any gear is dragged:

<md-gears></md-gears>

A pulley conserving rope length is `b = a.affine(−1, L)` — the invertible chain *is* the conservation law, written once, read both ways:

<md-pulley></md-pulley>

The next class up is **idempotent**: edges with a closed-form projection. `clamp`, `quantize`, `snap`, `onCircle`. Their `put` doesn't reconstruct anything — it projects, snapping the source into a constrained subset (`put∘put = put`). `t.clamp(lo, hi).quantize(0.1)` is one fused cell whose writes carry both projections back to the source at once. Both `lo`/`hi` and `step` are themselves `Val<number>`, so the clamp range can ride another slider:

<md-clamp-quantize></md-clamp-quantize>

Every parameter to a lens is read-only context by default. Wrap one in `w()` and it joins the bwd: writes to the result are routed through the wrapped parameter first, and any residual the parameter couldn't absorb flows to the receiver. For a bare-primitive parameter the residual is always zero — the parameter just absorbs. For a saturating parameter (a clamp, a quantize, anything with a projective `put`), the residual is the overflow, and the receiver catches it.

This is the bounded-slack pattern: two boxes whose gap is intrinsically clamped to `[30, 180]`. Drag B in-range and the slack absorbs; drag past either bound and the slack saturates while A picks up the rest:

```ts
const slack = num(80).clamp(30, 180);
const B = A.right(w(slack));
```

<md-bounded-slack></md-bounded-slack>

The clamp acts as a natural hard-stop, the receiver as the fallback absorber, and the entire pattern is one line of composition over `w()` and `.clamp()` — no custom lens, no merge primitive, no constraint solver. Every existing saturating lens (`clamp`, `quantize`, `snap`, predicate bridges) composes into the residual flow the same way.

Chain four boxes through three `own()`-claimed gaps with different dynamics — tight clamp, wide clamp, and a non-PG soft compress that progressively yields the residual to the receiver — and the same machinery cascades end-to-end in both directions:

<md-slack-chain></md-slack-chain>

The scene-graph idiom is one line per child: `child = parent.offset(w(dx), w(dy))`. Drag the parent — every child follows via forward propagation. Drag a child — only its local offset moves, parent and siblings unchanged:

<md-scene-graph></md-scene-graph>

The next is **residual**: edges that lose information, but the lost part is still live in the source, so `put` reads it back. The classical aggregate.

`Cls.lens([parents], fwd, bwd)` is the N-ary form: reads aggregate through `fwd`, writes split via `bwd` and apply atomically. A centroid is one line of that pattern — `get` returns the mean, `put` distributes the delta evenly. Tweening it is a rigid group translate:

```ts
const c = centroid(a, b, c, d);
yield* c.to({ x: 200, y: 100 }, 1);
```

Two independent animation sequences can share one position through this — neither knows about the other, and the visible motion is the per-frame weighted mean:

<md-mix></md-mix>

The lens *is* the read/write end of a UI primitive. `handle(point)` is a few lines of pointer code around a writable point. Drop one on a centroid and you've got rigid group dragging:

<md-handles></md-handles>

Aggregates aren't only N→1. An N→M decomposition gives M coupled writable views — each a closed-form group action on the cluster — and cross-channel invariance follows from action commutativity, exact by construction. A bounding box is `{center, size}`; drag a corner to scale about the center:

<md-bbox-handles></md-bbox-handles>

Two decompositions over the same cluster share the centroid: `bestFitLineLens` exposes `{point, direction}`, `bestFitCircleLens` exposes `{center, radius}`. Three handles, two fitted curves, every write a single group action:

<md-best-fit></md-best-fit>

A cubic Bezier becomes `{start, end, startTangent, endTangent}` — gestalt handles on curve shape, not on raw control-point positions:

<md-bezier-gestalt></md-bezier-gestalt>

The same machinery is trait-dispatched. `paletteLens(inputs) → {mean, spread}` works for any value class declaring `Linear + Metric`. Three rows of different value types — Vecs, Colors, Poses — each with its own `paletteLens` and mean/spread handles, all wired together by `meanOf` over the three normalised spreads:

<md-traits-cross-domain></md-traits-cross-domain>

A handle needs no special framework — any writable point can host one. Anchor points on a shape are derived; animate the shape and the anchors track:

<md-anchors></md-anchors>

`b = a.right(160).up(80)` is two invertible edges chained. Drag either dot:

<md-invertible></md-invertible>

A horizontal layout where each card's width passes through a `clamp(MIN_W, ∞)` lens lets you drag width handles bounded below:

<md-layout-demo></md-layout-demo>

When the inverse isn't a closed-form one-liner, the bwd can run a solver — the edge is still a single-pass `put` from the outside. An N-link IK arm is positions plus segment-length constraints; FABRIK alternates two geometric passes per iteration and converges in a handful of iterations from any configuration. Joints are Vec cells, the tip is a `Vec.lens([joints], fwd, bwd)`, the bwd runs FABRIK on every write:

<md-ik></md-ik>

When the mechanism is a single closed loop, vector-loop is the textbook angle-space approach. Parameterise each bar by its angle; the closure equation `Σ rᵢ · u(θᵢ) = 0` is two scalar equations in the unknown angles, solved by Newton-Raphson seeded with last frame's solution. Continuity in angle space means outputs evolve smoothly through the cycle without branch-tracking:

<md-loop></md-loop>

Lenses don't have to keep the value type fixed. A **bridge lens** projects across the type boundary — most usefully, from a continuous source to a boolean predicate. The forward direction is the predicate itself (`v > t`, `box.contains(p)`, `a ≈ b`); the inverse is a policy that nudges the source into the requested half-space. They're the cross-type cousin of `clamp` / `quantize` / `snap`: a Foster-style **quotient lens** with source equivalence `≈_S = "same boolean class"`, in the codebase's terms a stateful idempotent projection. Click any indicator below — the lens's bwd projects the source(s) into a state consistent with the new boolean:

<md-bool-bridges></md-bool-bridges>

Five distinct shapes flow through the same `Bool.lens(parents, fwd, bwd)` primitive. The first two are clamp-family — single source, threshold-style. The next three diverge: a two-source equality relation that writes both endpoints to a midpoint; an N-source aggregate that broadcasts a single click across every member of the cluster; a discrete classifier that rides on top of an integer-quantised slider and flips parity by ±1. Boolean predicates that used to be one-way derived values are now bidirectional UI primitives — click `inside` and the point teleports; click `even` and the knob snaps.

The natural sum-type extension of Bool is `Tri` — three-valued logic with an explicit "indeterminate" state. The motivating UI primitive: a nested checkbox tree where each folder's state is the Kleene-AND of its descendants. All-checked → checked; none-checked → unchecked; partial → indeterminate. `Tri.allOf(leaves)` is one writable cell that reads as the aggregate and broadcasts on write — both halves of the indeterminate-checkbox UI in one primitive. The recursion lives in the data structure, not the rendering code:

```ts
const leaf = (label, init = false) =>
  ({ kind: "leaf", label, checked: bool(init) });

const folder = (label, children) => ({
  kind: "folder", label, children,
  checked: Tri.allOf(collectLeaves(children)), // ← cascade + indeterminate, free
});

const tree = folder("Tasks", [
  folder("Work",     [leaf("Report"), leaf("Review", true), leaf("Email")]),
  folder("Personal", [leaf("Groceries"), leaf("Call mom", true), leaf("Laundry")]),
  folder("Reading",  [leaf("Chapter 4", true), leaf("Chapter 5", true)]),
]);
```

<md-tri-tree></md-tri-tree>

Every folder is just another reactive cell of the same shape as a leaf. Rendering is then a uniform loop — bind each checkbox's `.checked` and `.indeterminate` to its cell, write `cb.checked` back on change. No recursive aggregate-state computation per render, no `useEffect` for the `indeterminate` flag, no manual cascade walk. Click a folder; the Tri's bwd broadcasts to every descendant in one batched propagation, and the engine refreshes ancestor aggregates in the same pass.

The pattern generalises. A `TreeNode<T>` is a graph of cells with parent-child structure; reactive behaviour is layered on top via the existing `Cls.lens` / `Cls.derive` primitives. There's no `Signal<TreeShape>` anywhere — the tree value is the cell graph itself, so writes go through individual cells at the engine's normal O(1) field-lens cost, not O(N) tree-copy cost. Two canonical patterns over a `TreeNode<T>` cover most use cases: an AGGREGATE direction (bottom-up: each internal node is a lens that reads as the merge of descendants and writes by redistributing) and a PROPAGATE direction (top-down: each node has a local cell, the world view at each node composes parent-world with local). Two demos, same primitive.

Budget rollup is the aggregate direction. Each leaf is a writable `num()`; each category is `Num.lens([children], sum, redistributeProportional)`; the root is `Num.lens([categories], sum, …)`. Three nested stacked bars show one tree level each; widths are proportional to value cells, so the invariant `Σ leaves = Σ categories = total` is visible at a glance. Drag any boundary to reapportion the two adjacent cells; sibling shares update, the parent's total reflects the new sum, downstream rows redraw — all from the lens chain, no manual recomputation per row:

<md-budget-tree></md-budget-tree>

A skeletal armature is the propagate direction. Each bone holds a local `pose()` (offset + rotation relative to its parent); the world pose at each node is `Pose.derive([parent.world, this.local], compose)`. Compose is the standard 2-D rigid-body composition; decompose is its exact inverse. The drag handle at each joint is a `Vec.lens([parent.world, this.local], …)` whose read returns the joint's world position and whose write `decompose`'s a new target back into `this.local`. The TREE STRUCTURE is what makes this work: dragging the left hand updates only that arm's bones because everything else is in a structurally independent branch. The same lens for the root translates the entire figure:

<md-skeletal-rig></md-skeletal-rig>

One `TreeNode<T>` primitive, two utterly different visual demos. The aggregate side is a recursive `Num.lens([…], sum, redistribute)`; the propagate side is a recursive `Pose.derive([parent, local], compose)` plus its inverse via decompose. Both reuse the existing engine machinery — fan-in lenses for aggregate, fan-in derives + path lenses for propagate. The "tree" doesn't need to be a value type because the cells already are; the tree is structure.

The lenses up to here all ride on continuous numeric value types where the inverse is closed-form or numerical. The same engine has a second lens shape for *unstructured* domains — strings, arrays, sets — where the projection loses information no closed-form can recover. Each cell carries a private `complement` (Hofmann–Pierce symmetric-lens style) threaded through every `putr`/`putl`, and the engine fuses plain `.lens(F, B)` chains on top of it without breaking the complement's identity (see `_fuseOnSymmetric` in the signal core).

A single source string, five live projections. Edit any pane; the source updates with the discarded detail recovered from the complement — leading/trailing padding, per-word case patterns (Title / ALL CAPS / lower), separator runs, duplicate source positions. Editing the deduped pane broadcasts to every occurrence in the source with that occurrence's original case. Foster/Pierce's case-preserving find-and-replace, played live across the lens chain:

<md-string-pipeline></md-string-pipeline>

Each pane's badge names the lens kind. `trim` stores leading/trailing whitespace as its complement; `lowercase` stores a per-word case mask and applies a Title/ALL CAPS/lower rule on write; `words` stores the original separator runs (spaces, tabs, punctuation) and rebuilds them on write; `sortedUnique` stores a `(canonical key → [source position, original case]+)` map so a single edit fans out to every matching position with its own case mask preserved; `rot13` is the iso/involution baseline. Every chain composes — `source.trim().lowercase().words()` is one writable cell with its own composed complement, by construction.

## Fixpoint Networks

Some relationships aren't function-shaped at all. A four-bar linkage, a cloth, a sudoku — there's no "source" end. The lens model bottoms out and you reach for a substrate where the *cluster* owns the solve. Two flavours in minim, same `network()` primitive underneath: constraint clusters that project onto the manifold, propagator networks that narrow to a fixpoint.

### Constraints

`Constraints` binds any number of `Signal`s and runs an [Augmented Vertex Block Descent](https://graphics.cs.utah.edu/research/projects/avbd/) solve on every write. Constraints are ordinary factory calls — `distance`, `perpendicular`, `rightAngle`, `parallel`, `angle`, `onCircle`, `equalDist`, `clamp`, `leq`, plus `generic` for anything you can write a residual for — and they compose. Cluster membership is reactive too: `addWhile(flag, rel)` keeps a relation alive only while a signal is truthy, flipping structural shape at runtime.

The quad below is four side constraints — one internal DOF, the shape flexes when dragged — with a fifth diagonal-distance riding on `addWhile`. Click the dot on the diagonal to add or remove the brace and the quad snaps between rigid and flexible:

```ts
const braced = signal(true);
const c = constraints({ iterations: 20 });
c.add(
  distance(A, B, 160),
  distance(B, C, 120),
  distance(C, D, 160),
  distance(D, A, 120),
);
c.addWhile(braced, distance(A, C, diag));
```

<md-sketchpad></md-sketchpad>

Push further and the sketchpad is the editor. Two reactive collections — `signal<Point[]>` and `signal<Constraint[]>` — drive `forEach` blocks that mount and unmount visuals as you click; every solver step picks up whatever force set is current:

<md-sketchpad-live></md-sketchpad-live>

Constraints describe loci as readily as shapes. `onCircle(P, center, r)` keeps `P` on a circle of fixed radius around a (possibly draggable) center; `collinear(P, A, B)` keeps `P` on the line through two anchors. The bracket below stacks six constraints in one cluster — two locus incidences, two equal-length bars, an `equalDist` symmetry, and a `rightAngle` at the inner vertex:

<md-incidence></md-incidence>

Mix shape constraints with locus constraints and you get classic mechanisms more or less for free. A slider-crank is two `distance`s and a `collinear` on six cells, four pinned: one rotating crank arm, a rigid connecting rod, a piston sliding along a guide. Drag the crank tip and watch the piston track:

<md-slider-crank></md-slider-crank>

`physics({ gravity })` builds a Constraints with a velocity-and-extrapolation time-stepper baked into its pipeline; `step(dt)` per frame advances the whole scene. The cloth below is a 14×10 grid of point masses linked by ~250 hard distance constraints, top corners pinned, in well under a millisecond per frame:

<md-cloth></md-cloth>

`gap(a, b, d)` keeps two points at least `d` apart — a hard inequality the solver only enforces when violated. With soft springs along edges and a pairwise `gap` on every node pair, force-directed graph layout falls out in two factory calls:

<md-graph></md-graph>

Pair `gap` with rectangular containment (`inside(P, xLo, yLo, xHi, yHi)`) and a touch of gravity: 24 colored circles fall, settle into a hex packing, and shove each other out of the way when you grab one. 24 wall constraints + 276 pairwise gaps every frame, under a millisecond:

<md-particles></md-particles>

The same engine handles proper rigid bodies — boxes with full position + rotation, contacts with friction, stacking. A rigid body is a 3-DOF cell `(x, y, θ)` with diagonal mass matrix `(m, m, I)`. Box-box collisions are detected by SAT and turned into `BoxContact` forces with normal and tangential rows; the tangential clamp is set per-iteration to `±μ·|λ_normal|` for Coulomb friction:

<md-rigid-stack></md-rigid-stack>

Joints between rigid bodies turn the same machinery into a chain of bars. Each link is its own rigid body with rotational inertia, hinged to the next via a `Joint` force whose position rows are hard and angle row is free. The bars rotate the way bars do, not the way beads on a string do:

<md-rigid-rope></md-rigid-rope>

The same pattern on a 1D submanifold inside 2D. Each circle has a Vec position `P` and a scalar parameter `t`, coupled by a `generic` constraint that fixes `P = (R·sin t, R·sin 2t / 2)` — the figure-8 Lissajous map. Pairwise `gap` enforces non-overlap; near the self-intersection at the origin the constraint admits both branches and the solver may flip between them:

<md-figure8></md-figure8>

None of this is fundamentally geometric. The cluster operates on cells of arbitrary dimension over any function of those cells, so the same engine that solves a 4-bar linkage solves an algebraic equation. Three `Num` cells, one `generic` constraint enforcing `a² + b² = c²` — drag any handle and the other two redistribute:

<md-equation></md-equation>

### Propagators

AVBD's sweet spot is *many soft constraints, approximate solving fast* — cloth, contacts, graphs. The opposite shape — *few exact relations, instant fixpoint* — wants a different substrate. Same `network()` primitive underneath, different traversal: each propagator declares its read/write topology, the network runs them in a freshness-driven fixpoint until stable.

The same combinators dispatch on type. `centroid(G, A, B, C)` runs both directions: drag any vertex and the centroid follows; drag the centroid and all three vertices translate by its delta. `mid(A, B, M)` is the two-point version. Stack centroid + three midpoints and a triangle's medians come out for free:

```ts
const p = propagators();
p.add(centroid(G, A, B, C));
p.add(mid(A, B, Mab));
p.add(mid(B, C, Mbc));
p.add(mid(C, A, Mca));
```

<md-prop-geom></md-prop-geom>

The substrate is the right tool for layout. `hstack(container, items, opts)` is one big procedural propagator — reads `container.{x,w}`, gap, item widths; writes item positions via a single CSS-flex-style algorithm. 100 items in 150µs; 1000 in 1.5ms — competitive with native layout engines, on a substrate that composes with everything else:

<md-prop-flex></md-prop-flex>

It scales the other way too. Set-narrowing propagators on `Signal<Set<T>>` cells solve a 9×9 sudoku in half a millisecond. Same `network()` underneath; what changes is the value type and the merge rule:

<md-prop-sudoku></md-prop-sudoku>

Once you see narrowing-as-substrate, type inference falls out as the same shape on a different lattice. Each AST node gets a `SetCell<Tag>` over the possible kinds. A `+` forces both operands and the result to `{Int}`; an application `(f x)` narrows `f` to `{Fn}` and unifies its domain with the argument's type. Hindley-Milner unification is the same intersection-of-sets that drives `allDifferent`, lifted from atoms to structural lattices:

```ts
function unify(a: TypeNode, b: TypeNode) {
  return [
    propagator([a.tag], [b.tag], () => intersectInto(b.tag, a.tag)),
    propagator([b.tag], [a.tag], () => intersectInto(a.tag, b.tag)),
    ...(a.dom && b.dom ? unify(a.dom, b.dom) : []),
    ...(a.cod && b.cod ? unify(a.cod, b.cod) : []),
  ];
}
```

The demo below cycles through four expressions, stepping one fixpoint wave at a time. The fourth has no consistent typing — `λx. x + 1` forces `x : Int`, but it's applied to `"hi" : Str`. The contradiction is the empty cell:

<md-prop-types></md-prop-types>

## Shapes

Every shape property is a Signal, so the rendering layer composes with everything above for free. Reactive geometry, curves, TeX, code morphing.

`Path` is a reactive polyline; the sibling `Curve` carries the same plumbing but with `ellipseArc` segments via SVG's native `A` command. The standalone `ellipse(center, a, b, rotation?)` accepts `Val<>` on every parameter, so a family of confocal conics — five ellipses through fixed eccentricities, four hyperbola pairs — falls out of two loops driven by two draggable foci:

```ts
const aE = computed(() => (r1.value + r2.value) / 2);
const bE = computed(() => Math.sqrt(aE.value ** 2 - cDist.value ** 2));
s(ellipse(center, aE, bE, rot, { stroke: ACCENT }));
```

<md-confocal></md-confocal>

`` tex`…` `` returns a Shape rendering MathML through Temml. Interpolated `part()` markers become addressable child shapes — `eq.parts.M` has its own `translate`, `rotate`, `opacity`, `color`. So a symbol in an inline equation can highlight on hover, pluck out and orbit, link to a corresponding circle on a diagram, or animate apart from the rest of the formula:

```ts
const eq = tex`E = ${part("M")} c^2`;
yield* eq.parts.M.translate.to({ x: 0, y: -20 }, 0.4);
```

<md-tex-demo></md-tex-demo>

<md-tex-live></md-tex-live>

Marker identity extends past the diagram. `marker.register("id")` puts a marker into a global lookup; `<md-marker sym="id">` finds it on connect and shares one `marker.active` signal — a derived OR over every bound rendering. Because it's a `Signal<boolean>`, the suspension vocabulary applies: `yield* play(marker.active)` pauses a generator until any rendering is activated.

Hover <md-marker sym="osc:gamma">damping</md-marker> to reveal the decay envelope, <md-marker sym="osc:A">amplitude</md-marker> for the bounds, <md-marker sym="osc:omega">frequency</md-marker> for the period tick marks:

<md-oscillator></md-oscillator>

The `code` package is a sibling of `tex` — same architecture (a reactive `source` driving a `<foreignObject>`-hosted text wrapper), different content. `c.morphTo(newSrc, dur)` runs a line-level LCS diff between old and new sources, then a token-level LCS within each modified line, wraps the changed ranges in inline-block spans, and lerps their widths and heights over the duration. Matched content stays as plain text and reflows naturally. Syntax colours come from CSS Custom Highlights, no extra DOM:

<md-code></md-code>

## Animation

Minim started as an animation library and the runtime is still that. Generators yield control upward; the runtime passes `dt` back down.

```ts
function* fadeOut(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    opacity.value = 1 - t / secs;
  }
}
```

A tiny runtime calls `.next(dt)` and the generator writes wherever its values need to land. Composition is generators-calling-generators — sequencing, parallelism, and time scope all fall out:

<md-transitions></md-transitions>

Any generator can pull the `dt` and forward a transformed version to a child. Six lines for half-speed; the same shape covers slow-mo, reverse, pause, jitter, ease:

```ts
function* halfSpeed<R>(gen: Animator<R>): Animator<R> {
  let r = gen.next(0);
  while (!r.done) r = gen.next((yield) * 0.5);
  return r.value;
}
```

The runtime adds a way to wait on something that doesn't have a fixed duration. Yield a function `(wake) => dispose` and the runtime parks the generator. Calling `wake(value)` resumes synchronously — call it from inside a DOM handler and the generator advances re-entrantly, before the handler returns:

```ts
const event = yield* untilEvent(button, "click");
const next = yield* untilChange(signal);
```

| Yield             | Means                                       |
| ----------------- | ------------------------------------------- |
| yield             | wait one frame, resume with dt              |
| yield 0.5         | sleep half a second                         |
| yield gen         | spawn a child, wait for it                  |
| yield [a, b]      | spawn N in parallel, wait for all           |
| yield (wake) => … | suspend on a callback-shaped source         |
| yield detach(g)   | spawn at root; outlives the yielding parent |
| yield cut(v)      | from inside a group: settle group with v    |

Sequencing is `yield*`. Parallel is `yield [a, b, c]`. Cancellation lands in two flavours: cooperative `.until(stop)` resolves cleanly mid-step and runs the next as a sequel; hard cancel walks the active tree and calls `gen.return()` on each descendant. `finally` runs either way:

<md-cancel></md-cancel>

`cut(v)` is Prolog's `!`: a kid in a concurrent group whose return is `cut(v)` settles the group with `v` and cancels its siblings. From this one primitive `race`, `firstN`, `firstMatching`, `anySuccess`, and `allSettled` are each a single closure rule — `race` is six lines:

```ts
function* race(...kids) {
  return yield kids.map(k => commit(k));
}
```

<md-rand></md-rand>

Time-warping is per-animator: each integrator (`spring`, `tween`, …) accepts a `rate` option that multiplies its `dt` each frame. `spring(sig, target, { rate: () => paused.value ? 0 : 1 })` freezes the spring while `paused` is true:

<md-orbits></md-orbits>

Signals and generators meet through a small set of generator-producing helpers. Every value-typed signal carries `.to(target, dur, ease?)`, which returns a chainable `Tween<T>` that's also an `Animator<void>`:

```ts
yield* x.to(100, 0.5, easeInOut);
yield* x.from(0).to(100, 0.5).to(0, 0.5).until(stop);
```

`spring(sig, target, opts?)`, `toward(sig, target, speed)`, `attract(sig, target, k)` are integrators that pull toward a (possibly reactive) target. `wave(sig, (t, initial) => f(t, initial))` covers anything closed-form. `driven(sig, (dt, t, cur) => …)` is the full escape hatch when you need `dt` or live current state:

<md-behaviors></md-behaviors>

Others *park* until a signal does something. `when(sig)` waits until `sig.value` is truthy; `untilChange(sig)` parks until the next change. `play(p)` lifts any `Playable` — a number (sleep), an array (parallel), a generator, a bare suspend-fn, or a signal — into a fluent surface that reads subject-first:

```ts
spring(w, rest).until(dragging);
play([lane0, lane1, lane2]).until(stop);
play(0.5).then(fadeIn(shape, 0.3));
loop(() => fadeInOut(c)).until(done);
```

<md-circuit></md-circuit>

Rigid group choreography is `centroid + meanRotation + meanScale` animated in parallel — one line of group similarity transform:

<md-choreography></md-choreography>

A timeline is a clock signal plus a list of clips with `(at, dur)` ranges, each clip exposing a `t` signal in `[0, 1]` over its window. `yield* tl` advances the clock to the total duration:

```ts
const tl = timeline({
  intro: { at: 0, dur: 0.5 },
  hold:  { at: 0.5, dur: 1.0 },
  outro: { at: 1.5, dur: 0.4 },
});
effect(() => (circle.opacity.value = tl.intro.t.value));
yield* tl;
```

<md-multitrack></md-multitrack>

<md-timeline-editor></md-timeline-editor>

A `claim` is a labeled `Signal<boolean>` over a predicate: `true` while it holds, `false` on violation. Claims compose with `.and`, `.or`, `.not`, `.during(scope)`, `.before(other)` — because they *are* signals. Wrap a factory with `scope(fn)` and attach a claim to its lifetime via `.during(fn)`:

```ts
const fadeIn = scope("fadeIn", function* (s, dur) { /* ... */ });

const bounded  = claim(c.opacity).stays.in([0, 1]).during(fadeIn);
const reaches1 = claim(c.opacity).becomes.equal(1).during(fadeIn);

loop(() => fadeIn(c, 0.3));
```

The debugger below pairs the trace (gantt of factory invocations, `yield*` calls visible) with `α(t)` colored by `authorOf`, with claim strips on the same axis. The `nudge` factory is buggy: it overshoots `α=1` mid-run. Pause and step to see the offender name itself:

<md-debugger></md-debugger>

`.to` works uniformly across value types because it dispatches on traits. `tween`, `spring`, `toward`, `attract` read `linear` / `lerp` / `metric` from each class's `static traits = {…}` dictionary — they don't know about `Vec` or `Color` specifically:

<md-lerps></md-lerps>

Adding a value type is one class with a single trait dictionary:

```ts
class Polygon extends Signal<PolygonValue> {
  static traits = {
    lerp: lerpPolygon,
    equals: equalsPolygon,
  };
  to(target, dur, ease?) { return tween(this, target, dur, ease); }
}
```

…and `polygon.to(targetPolygon, dur)` falls out, on the same chain machinery, with the same combinator support. Add `linear` and `metric` to the dict and `spring`/`toward`/`attract` work on it the same day:

<md-morph></md-morph>

### Beyond SVG

The same `(wake) => dispose` shape carries to native browser primitives. `untilAnimation(a)` wakes on a WAAPI `finish` event; `untilInView(el)` wakes when an element starts intersecting; `scrollProgress()` is a lazy signal that subscribes to `scroll` only when something reads it. `native(el, keyframes, opts)` goes the other way — wraps `Element.animate` as an `Animator<void>`, so a compositor-driven tween composes with `stagger`, `all`, `race`, and `try/finally` like any other animator:

<md-waapi-demo></md-waapi-demo>

Nothing here is SVG-specific. The same generator + signal pipeline drives `<canvas>` with a per-frame for-loop just as well — the runtime is renderer-agnostic, and the SVG `Shape` graph is a convenience:

<md-canvas-field></md-canvas-field>

A spring over a transform, with phantom poses leaking out as a trail:

<md-trails></md-trails>

A small geometric construction emerging on a timeline — axis, ticks, labels, then a bbox, then a centroid — built from the same shape primitives as everything above:

<md-centering></md-centering>

The runtime test suite runs in-browser on a fresh `Anim` driven by `step(dt)`:

<md-runtime-tests></md-runtime-tests>
