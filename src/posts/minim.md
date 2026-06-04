---
title: Coreactive (Bireactive?) Programming
description: Bidirectional reactive programming with lenses.
---

Reactive systems are DAGs of cells where edges mean "reads": information flows one way and a cell is permanently input or output. **Coreactivity** keeps the DAG and the acyclicity, but every edge also carries a `put`. A derived cell can be written; the write flows back up the edge the read came down. No cell is permanently anything — drive either end.

Drag any cell on the left; watch the right.

<md-coreactive></md-coreactive>

Each lit edge is a real engine fire: red descends the inverse, blue refreshes the forward cone. Bidirectionality is a property of each edge in isolation, not of the graph — a `put` is one bounded upstream walk, no solver, no fixpoint.

| Regime            | Edges                         | Termination          |
| ----------------- | ----------------------------- | -------------------- |
| Reactive          | one-way                       | acyclicity           |
| **Coreactive**    | **bidirectional, edge-local** | **acyclicity**       |
| Constraint system | bidirectional, graph-global   | fixpoint convergence |

The middle row is the unoccupied corner. The rest of this post is what falls out.

---

The simplest edges are **invertible** — bijections with a closed-form inverse: reflections, rotations, scales, affines, polar↔cartesian, unit conversions. Every lens law for free.

Reflection across a line is an involution — its own inverse:

<md-mirror></md-mirror>

It generalises to the Poincaré disc: geodesics are circles ⟂ the boundary, reflection is inversion in them. Drag a vertex — sides curve, the three sister triangles reposition, and angle sum + area (π − sum, by Gauss–Bonnet) update live.

<md-conformal-disc></md-conformal-disc>

`polar(c, r, a)` is invertible under a policy choosing which input absorbs a write. Chain those into a solar system deterministic in one scalar — `time` — and dragging *any* body writes back into time; every other body re-derives.

<md-solar-system></md-solar-system>

Swap circles for real Kepler ellipses and invertibility survives, because the only transcendental step is on the read path: forward solves `M = E − e·sin E` by Newton, the drag is the closed-form inverse (`dM/dE = 1 − e·cos E > 0`, a bijection). Periapsis speed-up is Kepler's second law, free.

<md-kepler-system></md-kepler-system>

Meshed gears: `g[i+1] = g[i].scale(−teethᵢ / teethᵢ₊₁)` chained. Drag any gear; the integrator pauses mid-drag.

<md-gears></md-gears>

A pulley conserving rope length is `b = a.affine(−1, L)` — the conservation law written once, read both ways.

<md-pulley></md-pulley>

**Idempotent** edges have a closed-form projection (`clamp`, `quantize`, `snap`): `put` doesn't reconstruct, it projects (`put∘put = put`). `t.clamp(lo, hi).quantize(0.1)` fuses to one cell, and `lo`/`hi`/`step` are themselves `Val`, so the range can ride another slider:

<md-clamp-quantize></md-clamp-quantize>

**Residual** edges lose information, but the lost part stays live in the source, so `put` reads it back — the classical aggregate.

`Cls.lens([parents], fwd, bwd)` is the N-ary form: reads aggregate, writes split and apply atomically. A centroid is one line — `get` is the mean, `put` distributes the delta evenly; tweening it is a rigid group translate:

```ts
const c = centroid(a, b, c, d);
yield* c.to({ x: 200, y: 100 }, 1);
```

Two independent animations can share one position this way — neither knows the other, and the motion is the per-frame weighted mean:

<md-mix></md-mix>

Expose the weights and `meanOf` becomes `mix(weights, branches)`: read is the weighted sum, write is the min-norm split `daᵢ = wᵢ·δ / Σwⱼ²`, so a zero-weight branch stays put. `select` and `crossfade` are then *one* lens — the control just picks a point on the weight simplex. `Bool × ⟨A, B⟩ → A` sits on a vertex (snaps); `Num × ⟨A, B⟩ → A` slides an edge (blends position, colour and size at once):

<md-select></md-select>

The lens *is* the read/write end of a UI primitive. `handle(point)` wraps a writable point; drop one on a centroid for rigid group dragging:

<md-handles></md-handles>

A bwd is a closure, so it can peek any other cell to decide a write — context-aware, no extra graph. Each handle exposes a `dragging` cell; a midpoint lens reading them follows the gesture — hold one endpoint and drag the midpoint, the held point pins and the free one absorbs:

<md-multitouch></md-multitouch>

Aggregates aren't only N→1. An N→M decomposition gives M coupled writable views, each a group action on the cluster; cross-channel invariance follows from commutativity, exact by construction. A bounding box is `{center, size}` — drag a corner to scale about the center:

<md-bbox-handles></md-bbox-handles>

Two decompositions share a centroid: `bestFitLineLens → {point, direction}`, `bestFitCircleLens → {center, radius}`. Every write a single group action:

<md-best-fit></md-best-fit>

A cubic Bezier as `{start, end, startTangent, endTangent}` — handles on curve shape, not raw control points:

<md-bezier-gestalt></md-bezier-gestalt>

Trait-dispatched: `paletteLens(inputs) → {mean, spread}` works for any `Linear + Metric` class. Vecs, Colors, Poses — three domains, one primitive, wired together by `meanOf` over the normalised spreads:

<md-traits-cross-domain></md-traits-cross-domain>

Any writable point hosts a handle. Anchor points on a shape are derived; animate the shape and they track:

<md-anchors></md-anchors>

`b = a.right(160).up(80)` is two invertible edges chained. Drag either dot:

<md-invertible></md-invertible>

Each card's width through a `clamp(MIN_W, ∞)` lens gives width handles bounded below:

<md-layout-demo></md-layout-demo>

When the inverse isn't closed-form, the bwd runs a solver — still a single-pass `put` from outside. An N-link IK arm is a `Vec.lens([joints], fwd, bwd)` whose bwd runs FABRIK on every write:

<md-ik></md-ik>

For a single closed loop, parameterise each bar by angle; the closure `Σ rᵢ · u(θᵢ) = 0` is two scalar equations, Newton-solved from last frame's seed — continuous through the cycle, no branch-tracking:

<md-loop></md-loop>

A **bridge lens** drops the same-type constraint: a projection from a large domain onto a tiny codomain, most usefully `X → Bool`. The forward is the predicate (`v > t`, `box.contains(p)`, `a ≈ b`); the inverse nudges the source into the requested half-space — the cross-type cousin of `clamp`/`quantize`/`snap`. Click any indicator; the bwd projects the source into a consistent state:

<md-bool-bridges></md-bool-bridges>

Six shapes, one `Bool.lens(parents, fwd, bwd)`: two clamp-family (`Vec → Bool`, `Num → Bool`), two relations (`(Vec, Vec) → Bool` coincidence, `(Box, Box) → Bool` collision via min-translation), one aggregate (`Array<Vec> → Bool` broadcast), one classifier (`Num#isEven`). Predicates that were one-way readouts are now UI primitives — click `inside` and the point teleports.

The codomain can keep growing. `Bool` is two states; push to thirteen and you get Allen's interval algebra. `(Range, Range) → AllenRelation` is the bridge at its most structural — four DOF onto thirteen labels. Read classifies; click a relation and the bwd reshapes B to realize it:

<md-allen></md-allen>

The natural sum-type extension of Bool is `Tri` — three-valued logic with an "indeterminate" state. The UI primitive: a checkbox tree where each folder is the Kleene-AND of its descendants (all → checked, none → unchecked, partial → indeterminate). `Tri.allOf(leaves)` reads the aggregate and broadcasts on write — both halves of the indeterminate checkbox in one cell, the recursion in the data not the rendering:

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

Every folder is a cell of the same shape as a leaf, so rendering is a uniform loop — no per-render aggregate walk, no `useEffect` for `indeterminate`. Click a folder; the Tri's bwd broadcasts to every descendant in one batched pass.

The pattern generalises to `TreeNode<T>`: a graph of cells with behaviour layered via `Cls.lens` / `Cls.derive`. There's no `Cell<TreeShape>` — the tree value *is* the cell graph, so writes are O(1) field-lens, not O(N) tree-copy. Two directions: AGGREGATE (bottom-up, redistribute) and PROPAGATE (top-down, compose).

Aggregate: each category is `Num.lens([children], sum, redistribute)`, the root sums categories. Drag any boundary and siblings, the parent total, and downstream rows update — `Σ leaves = Σ categories = total`, no manual recompute:

<md-budget-tree></md-budget-tree>

Propagate: each bone holds a local `pose()`; world pose is `Pose.derive([parent.world, this.local], compose)`, and the joint handle is a `Vec.lens` that decomposes a world target back into local. The tree structure isolates branches — drag a hand and only that arm moves; drag the root and the whole figure translates:

<md-skeletal-rig></md-skeletal-rig>

One primitive, two demos: aggregate is recursive `Num.lens(sum, redistribute)`, propagate is recursive `Pose.derive(compose)` plus decompose. The tree is structure, not a value type.

Everything so far rides numeric value types with closed-form or numerical inverses. The engine has a second shape for *unstructured* domains — strings, arrays, sets — where the projection is irrecoverable by any closed form. Each cell carries a private `complement` (Hofmann–Pierce symmetric-lens style) threaded through every `put`; plain `.lens(F, B)` chains fuse on top without breaking it.

One source string, five live projections. Edit any pane; the source updates with the discarded detail recovered from the complement — padding, per-word case, separator runs, duplicate positions. Foster/Pierce case-preserving find-and-replace, live:

<md-string-pipeline></md-string-pipeline>

Each badge names the lens kind: `trim` stores padding, `lowercase` a case mask, `words` the separator runs, `sortedUnique` a `(key → [position, case]+)` map (one edit fans out to every occurrence), `rot13` the involution baseline. Chains compose into one cell with a composed complement.

## Fixpoint Networks

Some relationships aren't function-shaped — a four-bar linkage, a cloth, a sudoku have no source end. The lens model bottoms out and the *cluster* owns the solve. Two flavours, same `network()`: constraint clusters that project onto a manifold, propagators that narrow to a fixpoint.

### Constraints

`Constraints` binds `Cell`s and runs an [Augmented Vertex Block Descent](https://graphics.cs.utah.edu/research/projects/avbd/) solve per write. Factories — `distance`, `perpendicular`, `rightAngle`, `parallel`, `angle`, `onCircle`, `equalDist`, `clamp`, `leq`, plus `generic` — compose, and membership is reactive: `addWhile(flag, rel)` keeps a relation alive only while a cell is truthy.

Four side constraints give one internal DOF (the quad flexes); a fifth diagonal on `addWhile` toggles rigidity. Click the diagonal dot:

```ts
const braced = cell(true);
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

Push further and the sketchpad is the editor: two reactive collections (`cell<Point[]>`, `cell<Constraint[]>`) drive `forEach` blocks that mount and unmount visuals as you click.

<md-sketchpad-live></md-sketchpad-live>

Constraints describe loci too: `onCircle(P, center, r)`, `collinear(P, A, B)`. The bracket stacks six in one cluster — two incidences, two equal bars, an `equalDist` symmetry, a `rightAngle`:

<md-incidence></md-incidence>

Shape + locus constraints give classic mechanisms for free. A slider-crank is two `distance`s and a `collinear` on six cells, four pinned. Drag the crank tip, the piston tracks:

<md-slider-crank></md-slider-crank>

`physics({ gravity })` bakes a time-stepper into the pipeline; `step(dt)` per frame advances the scene. The cloth is a 14×10 grid, ~250 hard distance constraints, top corners pinned — under a millisecond a frame:

<md-cloth></md-cloth>

`gap(a, b, d)` keeps two points at least `d` apart, enforced only when violated. Soft edge springs + pairwise `gap` = force-directed layout in two factory calls:

<md-graph></md-graph>

Pair `gap` with `inside(P, …)` and gravity: 24 circles fall into a hex packing and shove each other when grabbed — 24 walls + 276 gaps a frame, under a millisecond:

<md-particles></md-particles>

Same engine, proper rigid bodies: a 3-DOF `(x, y, θ)` cell with mass `(m, m, I)`. Box-box collisions via SAT become `BoxContact` forces; the tangential clamp is `±μ·|λ_normal|` for Coulomb friction:

<md-rigid-stack></md-rigid-stack>

Joints make a chain of bars: each link a rigid body, hinged by a `Joint` whose position rows are hard and angle row free — bars, not beads on a string:

<md-rigid-rope></md-rigid-rope>

Same on a 1D submanifold in 2D: each circle has `P` and `t`, coupled by a `generic` fixing `P = (R·sin t, R·sin 2t / 2)` — the figure-8 map. Near the origin both branches are admissible and the solver may flip:

<md-figure8></md-figure8>

None of this is geometric. Cells of any dimension over any function of them: the engine that solves a 4-bar solves an equation. Three `Num`s, one `generic` for `a² + b² = c²` — drag any handle, the other two redistribute:

<md-equation></md-equation>

### Propagators

AVBD's sweet spot is many soft constraints solved fast. The opposite — few exact relations, instant fixpoint — wants a different traversal on the same `network()`: each propagator declares its read/write topology; the network runs to a freshness-driven fixpoint.

Combinators dispatch on type. `centroid(G, A, B, C)` runs both ways; `mid(A, B, M)` is the two-point form. Stack centroid + three midpoints for a triangle's medians:

```ts
const p = propagators();
p.add(centroid(G, A, B, C));
p.add(mid(A, B, Mab));
p.add(mid(B, C, Mbc));
p.add(mid(C, A, Mca));
```

<md-prop-geom></md-prop-geom>

Layout is one big propagator: `hstack(container, items, opts)` reads container/gap/widths and writes positions in a single flex-style pass. 100 items in 150µs, 1000 in 1.5ms:

<md-prop-flex></md-prop-flex>

It scales down too: set-narrowing on `Cell<Set<T>>` solves a 9×9 sudoku in half a millisecond — same `network()`, different value type and merge rule:

<md-prop-sudoku></md-prop-sudoku>

Narrowing-as-substrate makes type inference the same shape on a different lattice: each AST node a `SetCell<Tag>`, `+` forces `{Int}`, `(f x)` narrows `f` to `{Fn}` and unifies its domain with the argument. Hindley-Milner unification is `allDifferent`'s intersection lifted to structures:

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

The demo cycles four expressions, one fixpoint wave at a time. The fourth has no consistent typing — `λx. x + 1` forces `x : Int` but is applied to `"hi" : Str`, and the contradiction is the empty cell:

<md-prop-types></md-prop-types>

## Shapes

Every shape property is a Cell, so rendering composes with everything above for free.

`Path` is a reactive polyline; `Curve` is the same with `ellipseArc` segments. `ellipse(center, a, b, rotation?)` takes `Val` on every parameter, so a family of confocal conics falls out of two loops on two draggable foci:

```ts
const aE = computed(() => (r1.value + r2.value) / 2);
const bE = computed(() => Math.sqrt(aE.value ** 2 - cDist.value ** 2));
s(ellipse(center, aE, bE, rot, { stroke: ACCENT }));
```

<md-confocal></md-confocal>

`` tex`…` `` renders MathML through Temml; `part()` markers become addressable child shapes with their own `translate`/`rotate`/`opacity`/`color`:

```ts
const eq = tex`E = ${part("M")} c^2`;
yield* eq.parts.M.translate.to({ x: 0, y: -20 }, 0.4);
```

<md-tex-demo></md-tex-demo>

<md-tex-live></md-tex-live>

Markers cross diagrams: `marker.register("id")` + `<md-marker sym="id">` share one `marker.active` cell (a derived OR over every binding). Being a `Cell<boolean>`, `yield* play(marker.active)` parks a generator until any rendering activates.

Hover <md-marker sym="osc:gamma">damping</md-marker> for the decay envelope, <md-marker sym="osc:A">amplitude</md-marker> for the bounds, <md-marker sym="osc:omega">frequency</md-marker> for the period ticks:

<md-oscillator></md-oscillator>

`code` is `tex`'s sibling — a reactive `source` in a `<foreignObject>` text wrapper. `c.morphTo(src, dur)` LCS-diffs lines then tokens, wraps the changed ranges, and lerps their size; matched text reflows. Colours via CSS Custom Highlights:

<md-code></md-code>

## Animation

Minim is still an animation runtime: generators yield control up, the runtime passes `dt` down.

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

The runtime calls `.next(dt)`; the generator writes wherever values land. Composition is generators calling generators — sequencing, parallelism, time scope all fall out:

<md-transitions></md-transitions>

Any generator can pull `dt` and forward a transformed version. Six lines for half-speed; the same shape covers slow-mo, reverse, pause, jitter:

```ts
function* halfSpeed<R>(gen: Animator<R>): Animator<R> {
  let r = gen.next(0);
  while (!r.done) r = gen.next((yield) * 0.5);
  return r.value;
}
```

To wait on something without a fixed duration, yield `(wake) => dispose`; the runtime parks until `wake(value)` resumes synchronously — call it from a DOM handler and the generator advances re-entrantly:

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

Sequencing is `yield*`, parallel `yield [a, b, c]`. Cancellation is cooperative `.until(stop)` (resolves clean mid-step, runs a sequel) or hard (walks the tree calling `gen.return()`); `finally` runs either way:

<md-cancel></md-cancel>

`cut(v)` is Prolog's `!`: a kid returning `cut(v)` settles its group with `v` and cancels its siblings. `race`, `firstN`, `firstMatching`, `anySuccess`, `allSettled` are each one closure — `race` is six lines:

```ts
function* race(...kids) {
  return yield kids.map(k => commit(k));
}
```

<md-rand></md-rand>

Time-warp is per-animator: each integrator takes a `rate` multiplying its `dt`. `spring(sig, target, { rate: () => paused.value ? 0 : 1 })` freezes while `paused`:

<md-orbits></md-orbits>

Signals meet generators through a few helpers. Every value signal carries `.to(target, dur, ease?)`, returning a chainable `Tween<T>` that's also an `Animator<void>`:

```ts
yield* x.to(100, 0.5, easeInOut);
yield* x.from(0).to(100, 0.5).to(0, 0.5).until(stop);
```

`spring`, `toward`, `attract` pull toward a (reactive) target; `wave(sig, (t, initial) => …)` covers closed-form; `driven(sig, (dt, t, cur) => …)` is the escape hatch:

<md-behaviors></md-behaviors>

Others park until a signal acts: `when(sig)` waits for truthy, `untilChange(sig)` for the next change. `play(p)` lifts any Playable — number, array, generator, suspend-fn, signal — into a subject-first surface:

```ts
spring(w, rest).until(dragging);
play([lane0, lane1, lane2]).until(stop);
play(0.5).then(fadeIn(shape, 0.3));
loop(() => fadeInOut(c)).until(done);
```

<md-circuit></md-circuit>

Rigid group choreography is `centroid + meanRotation + meanScale` animated in parallel — one group-similarity line:

<md-choreography></md-choreography>

A timeline is a clock plus clips with `(at, dur)` ranges, each exposing `t ∈ [0, 1]`. `yield* tl` advances the clock to total duration:

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

A `claim` is a labeled `Cell<boolean>` over a predicate — `true` while it holds — composing with `.and`/`.or`/`.not`/`.during`/`.before` because it *is* a cell:

```ts
const fadeIn = scope("fadeIn", function* (s, dur) { /* ... */ });

const bounded  = claim(c.opacity).stays.in([0, 1]).during(fadeIn);
const reaches1 = claim(c.opacity).becomes.equal(1).during(fadeIn);

loop(() => fadeIn(c, 0.3));
```

The debugger pairs the trace (gantt of factory invocations, `yield*` calls visible) with `α(t)` coloured by `authorOf` and claim strips on the same axis. The buggy `nudge` overshoots `α=1`; step to see the offender name itself:

<md-debugger></md-debugger>

`.to` dispatches on traits: `tween`/`spring`/`toward`/`attract` read `linear`/`lerp`/`metric` from each class's `static traits`, knowing nothing of `Vec` or `Color`:

<md-lerps></md-lerps>

A new value type is one class with a trait dict:

```ts
class Polygon extends Cell<PolygonValue> {
  static traits = {
    lerp: lerpPolygon,
    equals: equalsPolygon,
  };
  to(target, dur, ease?) { return tween(this, target, dur, ease); }
}
```

…and `polygon.to(target, dur)` falls out on the same machinery. Add `linear` + `metric` and `spring`/`toward`/`attract` work too:

<md-morph></md-morph>

### Beyond SVG

The `(wake) => dispose` shape carries to native primitives: `untilAnimation(a)` wakes on a WAAPI `finish`, `untilInView(el)` on intersection, `scrollProgress()` is a lazy scroll signal. `native(el, keyframes, opts)` wraps `Element.animate` as an `Animator<void>`, composing with `stagger`/`race`/`try-finally`:

<md-waapi-demo></md-waapi-demo>

Nothing here is SVG-specific — the same pipeline drives `<canvas>` with a per-frame loop; the `Shape` graph is just a convenience:

<md-canvas-field></md-canvas-field>

A spring over a transform, with phantom poses leaking out as a trail:

<md-trails></md-trails>

A geometric construction on a timeline — axis, ticks, labels, bbox, centroid — from the same primitives:

<md-centering></md-centering>

The runtime test suite runs in-browser on a fresh `Anim` driven by `step(dt)`:

<md-runtime-tests></md-runtime-tests>
