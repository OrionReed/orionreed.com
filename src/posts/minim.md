---
title: Bireactive Programming
description: Reactive programming where every edge runs both ways.
---

<md-coreactive></md-coreactive>

Reactive values flow one way: write an input and everything derived from it updates. A *bireactive* edge also runs backward — write the derived value and the input adjusts to match. No cell is fixed as input or output; either end can be driven.[^edge]

The diagram above is the whole idea. Each edge carries a forward map and an inverse, so a change at any node travels both down to its readers and back up to its source.

Here is the same idea in a more familiar setting: a solar system placed entirely by one number, `time`.

<md-solar-system></md-solar-system>

Each body's position chains polar coordinates off `time`. The chain is invertible, so moving any body runs it backward to a new `time`, and the rest of the system follows from there.

[^edge]: A write is a single bounded walk up the edge it came down — no global solver, no fixpoint, and the graph stays acyclic. That is what separates it from a constraint system, where relations are bidirectional but global and have to converge to a fixpoint (the subject of a later section).

## Reversible edges

The plainest edges are exact bijections: reflections, rotations, scales, affine maps, polar/cartesian, unit conversions. The inverse is closed-form, so the backward direction involves no search.

The simplest is a single affine edge. A pulley that conserves rope length is `b = a.affine(−1, L)` — the conservation law written once and read in both directions. Chaining a second pulley composes it: a third weight reads `c = b.affine(−1, L₂)`, so dragging any weight ripples through the rest, the middle one opposing the outer two:

<md-pulley></md-pulley>

Edges chain. `b = a.right(160).up(80)` is two invertible steps composed, and either dot drives the other:

<md-invertible></md-invertible>

Reflection across a line is its own inverse:

<md-mirror></md-mirror>

The same construction carries to the Poincaré disc,[^poincare] where geodesics are circles meeting the boundary at right angles and reflection becomes inversion in them. Moving a vertex curves the sides and repositions the sister triangles, and the angle sum and area update with them.[^gaussbonnet]

<md-conformal-disc></md-conformal-disc>

Gears branch into a tree, each child meshing through `child = parent.scale(−teethₚ / teeth_c)`, so the speed along any path is the product of its ratios. A compound wheel — two gears on one shaft — makes that product real instead of telescoping away. Turning any gear turns the rest; the integrator pauses while one is held.

<md-gears></md-gears>

Not every edge is a bijection. A projection like `clamp`, `quantize`, or `snap` discards information, but it does so idempotently — applying it twice changes nothing more than once — so the backward direction simply projects again. `t.clamp(lo, hi).quantize(0.1)` fuses into one cell, and the bounds are themselves cells, so the range can ride another control:

<md-clamp-quantize></md-clamp-quantize>

Units are their own small value type — an SI scale paired with a vector of dimension exponents. A converter is several edges onto one canonical SI-base cell, `field = si.lens(u.fromBase, u.toBase)`: no master field and no swap button, so editing any field re-derives the rest. Temperature is the affine case; speed, area, and volume are compound:

<md-units></md-units>

The same one-canonical-cell pattern covers a change of basis. A waveform and its spectrum are one signal in two coordinate systems, and `samples = coeffs.lens(synthesize, analyze)` is a unitary bijection: drag a harmonic to resynthesise the wave, or pick a waveform to analyse it back into harmonics (the square wave's overshoot is Gibbs ringing from the truncated series):

<md-fourier></md-fourier>

## Aggregates

A residual edge loses information too, but the lost part stays in the source, so the backward direction can read it back. The familiar case is an aggregate: a centroid reads as the average of its points, and writing to it moves the points with it, splitting the change evenly.

A lens like this is the read/write end of a UI handle. `handle(point)` wraps a writable point; placed on a centroid, it drags the whole group rigidly:

<md-handles></md-handles>

A backward function is a closure, so it can read other cells. A midpoint that reads each handle's `dragging` cell follows the gesture: holding one endpoint while moving the midpoint pins the held end and lets the free one absorb the difference:

<md-multitouch></md-multitouch>

Aggregates needn't collapse to a single value. An N→M decomposition gives several coupled views, each a group action on the cluster. A bounding box is `{center, size}`, so a corner scales the box about its center:

<md-bbox-handles></md-bbox-handles>

Two decompositions can share a centroid — a best-fit line as `{point, direction}`, a best-fit circle as `{center, radius}` — and each write is a single group action:

<md-best-fit></md-best-fit>

The decomposition is dispatched by trait, so `paletteLens(inputs) → {mean, spread}` works for any type that is linear with a metric. Vectors, colours, and poses all run through the one primitive:

<md-traits-cross-domain></md-traits-cross-domain>

## Crossing types

Until now an edge's two ends shared a type. They needn't — a lens can map between different value types, and because each side is still an ordinary cell, those cross-type edges compose with everything else. The most useful target is a boolean: the forward direction is a predicate — `v > t`, `box.contains(p)`, `a ≈ b` — and the backward direction nudges the source into the state that satisfies it, so a read-only readout becomes writable:

<md-bool-bridges></md-bool-bridges>

Six shapes share one `Bool.lens`: two thresholds (`Vec → Bool`, `Num → Bool`), two relations (coincidence and box collision), one aggregate over an array, and one parity classifier — and writing to `inside` moves the point into the region.

The target type can grow richer. Two states become thirteen and the edge lands on Allen's interval algebra:[^allen] `(Range, Range) → AllenRelation` reads four degrees of freedom as one of thirteen labels. The forward direction classifies; setting a relation reshapes the second interval to realize it:

<md-allen></md-allen>

A second axis multiplies the labels. A box is a range on each axis, so `(Box, Box) → RCC-8`[^rcc8] is two Allen classifications, and the 2D relation factors into the per-axis ones:

<md-rcc8></md-rcc8>

Coarsening instead of classifying turns the same shape into a histogram: `Array<Num> → Array<BinCount>` keeps the counts and drops the positions. The backward direction is mass transport, where moving a bar sends the fewest samples across the nearest boundary:

<md-histogram></md-histogram>

In two dimensions it is a heatmap, `Array<Vec> → Grid<Count>`: moving a point re-bins it, and selecting a cell pulls the nearest point into it:

<md-heatmap></md-heatmap>

Crossing types also gives combinators. `mix(weights, branches)` reads as a weighted sum and writes a change back split by weight; `select` and `crossfade` are the same lens with the control picking a point on the weight simplex, so a boolean snaps between branches and a number blends them — position, colour, and size at once:

<md-select></md-select>

## Trees

Extending boolean to a sum type gives `Tri`, three-valued logic with an indeterminate state. A checkbox tree is its natural home: each folder is the Kleene-AND of its descendants — all checked, none checked, or partial. `Tri.allOf(leaves)` reads the aggregate and broadcasts on write, so both halves of the indeterminate checkbox live in one cell:

```ts
const leaf = (label, init = false) =>
  ({ kind: "leaf", label, checked: bool(init) });

const folder = (label, children) => ({
  kind: "folder", label, children,
  checked: Tri.allOf(collectLeaves(children)),
});

const tree = folder("Tasks", [
  folder("Work",     [leaf("Report"), leaf("Review", true), leaf("Email")]),
  folder("Personal", [leaf("Groceries"), leaf("Call mom", true), leaf("Laundry")]),
  folder("Reading",  [leaf("Chapter 4", true), leaf("Chapter 5", true)]),
]);
```

<md-tri-tree></md-tri-tree>

Every folder is a cell of the same shape as a leaf, so rendering is one uniform loop with no separate aggregate pass. Setting a folder broadcasts down to its descendants in a single batch.

This generalizes to `TreeNode<T>`: the tree value is the cell graph itself, so a write is a field update rather than a copy of the whole tree. Two directions read out of it — aggregate (bottom-up) and propagate (top-down).

In the aggregate direction each category sums its children and the root sums the categories. Moving a boundary adjusts the siblings, the parent total, and the rows downstream, with the sums kept consistent throughout:

<md-budget-tree></md-budget-tree>

In the propagate direction each bone holds a local pose, world pose composes down the chain, and the joint handle decomposes a world target back into the local frame. Branches stay isolated: moving a hand bends one arm, moving the root translates the whole figure:

<md-skeletal-rig></md-skeletal-rig>

Both build a tree from cells; a bridge runs the other way, reading a tree *out* of flat geometry. `Array<Box> → Forest` nests each box in the smallest one that contains it. Moving a box carries its subtree along and reforms the forest; dragging a node onto another rescales its subtree to nest inside the target:

<md-containment-forest></md-containment-forest>

## Text

Everything so far rides numeric types with closed-form or numerical inverses. Unstructured domains — strings, arrays, sets — need a different mechanism, because the discarded detail can't be recovered from the result alone. Each cell carries a private complement[^lens] threaded through every write, and ordinary lens chains compose on top of it.

One source string feeds five live projections. Editing any pane updates the source, with the detail each projection dropped — padding, per-word case, separator runs, duplicate positions — restored from the complement:

<md-string-pipeline></md-string-pipeline>

Each badge names the lens: `trim` stores the padding, `lowercase` a case mask, `words` the separator runs, `sortedUnique` a map from key to positions and case (so one edit fans out to every occurrence), and `rot13` is the involution baseline.

The same complement mechanism scales to rasters. A `Canvas` value carries its pixels as a mutable buffer behind a small header — the reactive graph compares a monotonic `epoch`, so propagation never touches a pixel. One source flows through `brightness(k) → grayscale → invert`; the grayscale lens is the image twin of `lowercase`, storing per-pixel chroma so editing the luma view recolours the source. Paint on any panel and the edit routes backward through the chain; the knob drives it forward:

<md-canvas-lenses></md-canvas-lenses>

## Solvers

When the inverse has no closed form, the backward direction runs a solver. It is still a single pass from the outside — the cluster doesn't own the state, the edge just works harder. An N-link arm is a `Vec.lens` whose backward direction runs inverse kinematics on every write:

<md-ik></md-ik>

A closed loop parameterizes each bar by angle and solves `Σ rᵢ · u(θᵢ) = 0` from the previous frame's seed, staying continuous as it travels around the cycle:

<md-loop></md-loop>

## Fixpoint networks

Some relationships have no source end at all — a four-bar linkage, a cloth, a sudoku. The lens model bottoms out and the cluster owns the solve. Both flavours share one `network()`: propagators narrow to a fixpoint, constraints settle onto a manifold.

### Propagators

A propagator declares which cells it reads and which it writes, and the network runs them to a fixpoint driven by what's stale. Combinators dispatch on type — `centroid(G, A, B, C)` runs both ways, `mid(A, B, M)` is the two-point form — so a triangle's medians stack from a centroid and three midpoints:

```ts
const p = propagators();
p.add(centroid(G, A, B, C));
p.add(mid(A, B, Mab));
p.add(mid(B, C, Mbc));
p.add(mid(C, A, Mca));
```

<md-prop-geom></md-prop-geom>

Layout is one large propagator: `hstack(container, items, opts)` reads the container, gap, and widths and writes positions in a single pass:

<md-prop-flex></md-prop-flex>

The same network narrows sets. A 9×9 sudoku is set-narrowing on `Cell<Set<T>>` — the same `network()` with a different value type and merge rule:

<md-prop-sudoku></md-prop-sudoku>

Narrowing on a different lattice is type inference. Each AST node is a cell of candidate types: `+` forces `{Int}`, an application narrows the function to `{Fn}` and unifies its domain with the argument. Unification[^hm] is set intersection lifted to structures:

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

The demo steps through four expressions one fixpoint wave at a time. The fourth has no consistent typing — `λx. x + 1` forces `x : Int` but is applied to a string — and the contradiction shows up as an empty cell:

<md-prop-types></md-prop-types>

### Constraints

`Constraints` binds cells and runs an Augmented Vertex Block Descent[^avbd] solve per write. The factories — `distance`, `perpendicular`, `rightAngle`, `parallel`, `angle`, `onCircle`, `equalDist`, `clamp`, `leq`, and `generic` — compose, and membership is reactive: `addWhile(flag, rel)` keeps a relation alive only while a cell is truthy.

Four side constraints leave the quad one internal degree of freedom; a fifth diagonal toggles it rigid:

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

The same parts make an editor. Two reactive collections of points and constraints drive `forEach` blocks that mount and unmount visuals as the sketch is built:

<md-sketchpad-live></md-sketchpad-live>

Constraints describe loci as well — `onCircle(P, center, r)`, `collinear(P, A, B)`. This bracket stacks six in one cluster: two incidences, two equal bars, a symmetry, and a right angle:

<md-incidence></md-incidence>

Shape and locus constraints give classic mechanisms. A slider-crank is two distances and a `collinear` over six cells, four of them pinned, and the piston tracks the crank:

<md-slider-crank></md-slider-crank>

`physics({ gravity })` bakes a time-stepper into the pipeline and `step(dt)` advances it each frame. The cloth is a grid of points held by distance constraints with the top corners pinned:

<md-cloth></md-cloth>

`gap(a, b, d)` keeps two points at least `d` apart, enforced only when violated. Soft edge springs plus pairwise gaps make a force-directed layout:

<md-graph></md-graph>

Gaps with `inside(P, …)` and gravity pack circles into a region, shoving each other aside when one is moved:

<md-particles></md-particles>

The same engine carries proper rigid bodies: a 3-DOF `(x, y, θ)` cell with mass `(m, m, I)`, box-box collisions via SAT, and a tangential clamp for Coulomb friction:

<md-rigid-stack></md-rigid-stack>

Joints chain rigid bars — each link a body hinged by a `Joint` whose position rows are hard and angle row free — so they behave like bars rather than beads on a string:

<md-rigid-rope></md-rigid-rope>

The same setup on a 1D submanifold fixes each circle's position to `(R·sin t, R·sin 2t / 2)` by a `generic` constraint. Near the origin both branches are admissible and the solver can flip between them:

<md-figure8></md-figure8>

None of this is specific to geometry. Cells of any dimension over any function of them solve the same way — three numbers and one `generic` for `a² + b² = c²`, where moving any handle redistributes the other two:

<md-equation></md-equation>

## Animation

Underneath all of this, Minim is an animation runtime. Generators yield control up and the runtime passes `dt` back down:

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

The runtime calls `.next(dt)` and the generator writes wherever its values land. Generators compose by calling each other, which is where sequencing, parallelism, and time scope come from:

<md-transitions></md-transitions>

A generator can pull `dt` and forward a changed version of it. Halving it is a few lines, and the same shape covers slow motion, reverse, pause, and jitter:

```ts
function* halfSpeed<R>(gen: Animator<R>): Animator<R> {
  let r = gen.next(0);
  while (!r.done) r = gen.next((yield) * 0.5);
  return r.value;
}
```

To wait on something without a fixed duration, a generator yields `(wake) => dispose`; the runtime parks it until `wake(value)` is called, which can happen straight from a DOM handler:

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

Sequencing is `yield*` and parallelism is `yield [a, b, c]`. Cancellation is either cooperative through `.until(stop)`, which resolves cleanly mid-step and can run a sequel, or hard, which walks the tree calling `gen.return()`; `finally` runs either way:

<md-cancel></md-cancel>

`cut(v)` is Prolog's cut:[^cut] a child returning it settles its group with `v` and cancels its siblings. `race`, `firstN`, `firstMatching`, `anySuccess`, and `allSettled` are each a single closure over it:

```ts
function* race(...kids) {
  return yield kids.map(k => commit(k));
}
```

<md-rand></md-rand>

Signals meet generators through a few helpers. Every value signal has `.to(target, dur, ease?)`, a chainable tween that is also an animator:

```ts
yield* x.to(100, 0.5, easeInOut);
yield* x.from(0).to(100, 0.5).to(0, 0.5).until(stop);
```

`spring`, `toward`, and `attract` pull toward a reactive target; `wave` covers closed-form motion and `driven` is the escape hatch:

<md-behaviors></md-behaviors>

Others park until a signal acts — `when(sig)` for truthy, `untilChange(sig)` for the next change. `play(p)` lifts any playable thing — a number, array, generator, suspend function, or signal — into one surface:

```ts
spring(w, rest).until(dragging);
play([lane0, lane1, lane2]).until(stop);
play(0.5).then(fadeIn(shape, 0.3));
loop(() => fadeInOut(c)).until(done);
```

<md-circuit></md-circuit>

A row of cards, each width behind a `clamp(MIN_W, ∞)` edge so a handle can't drag it below the minimum:

<md-layout-demo></md-layout-demo>

Rigid group choreography is a centroid, mean rotation, and mean scale animated in parallel:

<md-choreography></md-choreography>

A timeline is a clock with clips over `(at, dur)` ranges, each exposing a normalized `t`. `yield* tl` runs the clock to the total duration:

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

A `claim` is a labeled boolean over a predicate — true while it holds — and composes with `.and`/`.or`/`.not`/`.during`/`.before` because it is itself a cell:

```ts
const fadeIn = scope("fadeIn", function* (s, dur) { /* ... */ });

const bounded  = claim(c.opacity).stays.in([0, 1]).during(fadeIn);
const reaches1 = claim(c.opacity).becomes.equal(1).during(fadeIn);

loop(() => fadeIn(c, 0.3));
```

The debugger lays the trace — a gantt of factory invocations — beside `α(t)` coloured by author, with the claim strips on the same axis. A buggy `nudge` overshoots `α = 1`, and stepping through names the offender:

<md-debugger></md-debugger>

`.to` dispatches on traits: `tween`, `spring`, `toward`, and `attract` read `linear`, `lerp`, and `metric` from each class's `static traits`, knowing nothing about `Vec` or `Color`:

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

and `polygon.to(target, dur)` works on the same machinery; adding `linear` and `metric` brings `spring`, `toward`, and `attract` along too:

<md-morph></md-morph>

The shape types compose the same way. `tex` renders MathML through Temml, and `part()` markers become addressable child shapes with their own transform, opacity, and colour:

```ts
const eq = tex`E = ${part("M")} c^2`;
yield* eq.parts.M.translate.to({ x: 0, y: -20 }, 0.4);
```

<md-tex-demo></md-tex-demo>

<md-tex-live></md-tex-live>

Markers cross diagrams: `marker.register("id")` and `<md-marker sym="id">` share one `marker.active` cell, a derived OR over every binding. Because it is a `Cell<boolean>`, `yield* play(marker.active)` parks a generator until any rendering activates it. Three markers tie this prose to the diagram — <md-marker sym="osc:gamma">damping</md-marker> lights the decay envelope, <md-marker sym="osc:A">amplitude</md-marker> the bounds, <md-marker sym="osc:omega">frequency</md-marker> the period ticks:

<md-oscillator></md-oscillator>

`code` is `tex`'s sibling — a reactive source in a text wrapper. `c.morphTo(src, dur)` diffs lines then tokens, wraps the changed ranges, and interpolates their size while matched text reflows:

<md-code></md-code>

### Beyond SVG

The `(wake) => dispose` shape carries to native primitives: `untilAnimation(a)` wakes on a WAAPI finish, `untilInView(el)` on intersection, and `scrollProgress()` is a lazy scroll signal. `native(el, keyframes, opts)` wraps `Element.animate` as an animator that composes with `stagger`, `race`, and `try`/`finally`:

<md-waapi-demo></md-waapi-demo>

None of it is SVG-specific. The same pipeline drives a `<canvas>` with a per-frame loop; the shape graph is just a convenience:

<md-canvas-field></md-canvas-field>

A spring over a transform, with phantom poses trailing behind it:

<md-trails></md-trails>

A geometric construction on a timeline — axis, ticks, labels, bounding box, centroid — from the same primitives:

<md-centering></md-centering>

The runtime's test suite runs in the browser on a fresh `Anim` driven by `step(dt)`:

<md-runtime-tests></md-runtime-tests>

## Misc

Loose demos that may not survive the final cut.

Real Kepler orbits keep the invertibility: the forward direction solves `M = E − e·sin E` numerically on the read path, while the backward direction is the closed-form inverse, so a body stays exact as it moves and the periapsis speed-up comes out on its own.

<md-kepler-system></md-kepler-system>

A confocal family of ellipses is two foci and a derived shape; `ellipse(center, a, b, rotation?)` takes a reactive value on every parameter:

```ts
const aE = computed(() => (r1.value + r2.value) / 2);
const bE = computed(() => Math.sqrt(aE.value ** 2 - cDist.value ** 2));
s(ellipse(center, aE, bE, rot, { stroke: ACCENT }));
```

<md-confocal></md-confocal>

Because a centroid is an ordinary cell, two independent animations can share one position; the motion is their per-frame weighted mean:

```ts
const c = centroid(a, b, c, d);
yield* c.to({ x: 200, y: 100 }, 1);
```

<md-mix></md-mix>

Any writable point can host a handle, including a derived one. Anchor points on a shape track it as it animates:

<md-anchors></md-anchors>

Units form a vector space under multiplication, so `times`/`div` add and subtract dimension vectors and `pow` scales them; two quantities convert exactly when their vectors match:

```ts
const km     = meter.scaled(1000);                       // prefix
const knot   = nmi.div(hour);                            // compound
const litre  = meter.pow(3).scaled(0.001);               // m³ → L
const newton = kilogram.times(meter).div(second.pow(2)); // kg·m·s⁻²
const joule  = newton.times(meter);                      // energy
const watt   = joule.div(second);                        // power
```

<md-unit-algebra></md-unit-algebra>

A cubic Bézier reads as `{start, end, startTangent, endTangent}`, putting the handles on the curve's shape rather than its raw control points:

<md-bezier-gestalt></md-bezier-gestalt>

<!-- Pushed further, a cubic is four DOF and every spline basis is just a different coordinate system for the same curve, related by a constant matrix. Each net's handles are a `Vec.lens` onto the shared coefficients, so dragging a handle in any basis remaps the others while the curve stays put: -->

<!-- <md-curve-bases></md-curve-bases> -->

[^poincare]: [Poincaré disc model](https://en.wikipedia.org/wiki/Poincar%C3%A9_disk_model).

[^gaussbonnet]: The area is π minus the angle sum, by the [Gauss–Bonnet theorem](https://en.wikipedia.org/wiki/Gauss%E2%80%93Bonnet_theorem).

[^allen]: [Allen's interval algebra](https://en.wikipedia.org/wiki/Allen%27s_interval_algebra) — thirteen ways two intervals can relate on a line.

[^rcc8]: [Region connection calculus](https://en.wikipedia.org/wiki/Region_connection_calculus), the eight base relations between two regions.

[^lens]: A symmetric lens in the [Hofmann–Pierce–Wagner](https://www.cis.upenn.edu/~bcpierce/papers/symmetric-full.pdf) sense; the case-preserving find-and-replace follows Foster and Pierce's work on bidirectional transformations.

[^hm]: [Hindley–Milner](https://en.wikipedia.org/wiki/Hindley%E2%80%93Milner_type_system) type inference, whose unification step is structural set intersection.

[^avbd]: [Augmented Vertex Block Descent](https://graphics.cs.utah.edu/research/projects/avbd/).

[^cut]: [The cut](https://en.wikipedia.org/wiki/Cut_(logic_programming)) in logic programming, which commits to choices made so far and prunes the alternatives.
