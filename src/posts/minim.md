---
title: Minim
description: Generator-driven animated SVG diagrams with reactive primitives.
---

Minim is a tiny animation library based on a simple idea: generators yield _control_ upward; _delta-time_ is passed back down.

```ts
function* fadeOut(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const dt = yield; // yield control upward; delta-time is captured on the way back down
    t += dt;
    opacity.value = 1 - t / secs;
  }
}
```

That's most of it. A tiny runtime calls `.next(dt)` and the generator writes to wherever its values need to land. What this buys you is composition: a util is a generator, and its descendants are generators. Sequencing, parallelism, and time scope all fall out of generators-calling-generators.

Aside (fmt as actual markdown aside thing, i forget how to do that): you could write the whole thing purely lexically, with `fadeOut` inside a for-loop driven by `raf` deltas, and never know there's a runtime at all.

<md-transitions></md-transitions>

Control flows up; time flows down. The runtime hands each generator a `dt` as the resume value of `yield`; any generator can pull that dt and forward a transformed version to a child:

```ts
function* halfSpeed<R>(gen: Animator<R>): Animator<R> {
  let r = gen.next(0);
  while (!r.done) r = gen.next((yield) * 0.5);
  return r.value;
}
```

Six lines, no engine work. The principle works just as well for slow-mo, reverse, pause, jitter, ease — whatever you can write as a function of `dt`.

The runtime adds two things on top. One is efficiency (a single tick loop, sub-frame wake accounting). The other is a way to wait on something that doesn't have a fixed duration. Yield a function `(wake) => dispose` and the runtime parks the generator and passes it the wake callback. Calling `wake(value)` resumes the generator with `value` as the result of the yield. This is synchronous — call `wake()` from inside a DOM event handler and the generator advances re-entrantly, before the handler returns:

```ts
const event = yield* untilEvent(button, "click");
const next = yield* untilChange(signal);
```

No polling, no per-frame work while suspended. Anything callback-shaped — DOM events, signal changes, promises, an event bus — fits the same contract.

The yield contract in full:

| Yield             | Means                               |
| ----------------- | ----------------------------------- |
| yield             | wait one frame, resume with dt      |
| yield 0.5         | sleep half a second                 |
| yield gen         | spawn a child, wait for it          |
| yield [a, b]      | spawn N in parallel, wait for all   |
| yield (wake) => … | suspend on a callback-shaped source |

Sequencing is `yield*`. Parallel is `yield [a, b, c]`. Cancel is whichever-finishes-first via `race`. Each concurrency combinator is itself a generator wrapping its kids; nothing in the engine knows what "race" means.

Cancellation lands in two flavours and both fall out of the model. Cooperative cancel is `.until(stop)` — when `stop` flips, the running step resolves cleanly and the next step runs as a sequel; mid-tween cleanup is whatever the generator's own `finally` says. Hard cancel comes from above: when an outer scope loses (a parent `race`, an `anim.stop()`, a disposer firing), the engine walks the active tree and calls `gen.return()` on each descendant. `finally` still runs, but mid-flight work is gone.

<md-cancel></md-cancel>

<md-rand></md-rand>

For more structural needs, a few extra yield-shapes:

| Yield              | Means                                       |
| ------------------ | ------------------------------------------- |
| yield detach(g)    | spawn at root; outlives the yielding parent |
| yield cut(v)       | from inside a group: settle group with v    |

Time-warping is a per-animator concern: each integrator (`spring`, `tween`, …) accepts a `rate` option that multiplies its `dt` each frame. `spring(sig, target, { rate: () => paused.value ? 0 : 1 })` freezes the spring while `paused` is true. There's no engine-level subtree scaling; each leaf opts in.

<md-orbits></md-orbits>

`cut(v)` is Prolog's `!`: a kid in a concurrent group whose return is `cut(v)` settles the group with `v` and cancels its siblings. Outside a group it's transparently unwrapped. From this one primitive `race`, `firstN`, `firstMatching`, `anySuccess`, and `allSettled` are each a single closure rule — `race` is six lines:

```ts
function* race(...kids) {
  return yield kids.map((k) => commit(k)); // commit ≡ `return cut(yield k)`
}
```

The runtime is signal-free, by the way. `Anim` exposes time as `anim.clock` (a number) and `anim.onStep(cb)` (a callback). You could drive an entire scene with generators mutating plain objects and never reach for a signal.

## Signals

You don't, though, because the other primitive — the signal — is a perfect fit. Read a signal inside a `computed` or `effect` and you've subscribed; write it and the subscribers update.

```ts
const x = signal(0);
effect(() => svg.setAttribute("x", String(x.value)));
x.value = 100;
```

Wire DOM attributes to signals at construction and DOM mutation stops being a thing you think about. Writes batch, identical writes drop, and describing a diagram reads like geometry:

```ts
const c = vec(100, 100);
const r = num(40);
const a = num(0);
const dot = circle(polar(c, r, a), 4); // reactive in c, r, a forever
```

Every animatable property of every shape is a signal. Animations don't touch the DOM; they write to signals.

<md-mirror></md-mirror>

The reflection lens generalises past flat geometry. In the Poincaré disc model, geodesics are circles perpendicular to the boundary and reflection across a geodesic is inversion in that same circle — still an involution, still one formula reading and writing. Three vertices, three sides, three sister triangles obtained by reflecting one vertex across the opposite side. Drag any vertex; sides curve, sisters reposition, the angle sum and area (= π − sum, Gauss–Bonnet on constant curvature) update live.

<md-conformal-disc></md-conformal-disc>

<md-anchors></md-anchors>

Signals and generators meet through a small set of generator-producing helpers. Some _write_ to a signal over time. Every value-typed signal carries `.to(target, dur, ease?)`, which returns a chainable `Tween<T>` that's also an `Animator<void>` — so it composes with sequencing, racing, and the rest of the generator vocabulary:

```ts
yield* x.to(100, 0.5, easeInOut);
yield* x.from(0).to(100, 0.5).to(0, 0.5).until(stop);
```

`tween(sig, target, dur, ease?)` is the free-fn form for plain signals where the method isn't installed. `spring(sig, target, opts?)`, `toward(sig, target, speed)`, `attract(sig, target, k)` are integrators that pull toward a (possibly reactive) target with different curves — overshoot-capable, constant-speed, exponential. `wave(sig, (t, initial) => f(t, initial))` covers anything that's a closed-form function of elapsed time and starting value — oscillators, sawtooths, lissajous, even `tween` itself is a special case (`(t, x0) => lerp(x0, target, ease(t/dur))`). `driven(sig, (dt, t, cur) => …)` is the full escape hatch when you need `dt` or live current state.

<md-behaviors></md-behaviors>

Others _park_ until a signal does something. `when(sig)` waits until `sig.value` is truthy; `untilChange(sig)` parks until the next change and resumes with the new value; `not(sig)` is a reactive negation for the falsy idiom. All wrap `effect` — animations wait on reactive state without polling:

```ts
yield* untilChange(stopFlag);
yield* fadeOut(s, 0.4);
```

`play(p)` then lifts any `Playable` — a number (sleep), an array (parallel), a generator, a bare suspend-fn, or a signal (`when`-style wait until truthy) — into a fluent surface that reads subject-first:

```ts
spring(w, rest).until(dragging); // spring, until dragging
play([lane0, lane1, lane2]).until(stop); // parallel lanes, until stop
play(0.5).then(fadeIn(shape, 0.3)); // sleep, then fade in
play(ready).then(work); // wait truthy, then work
loop(() => fadeInOut(c)).until(done); // repeat, until done
```

`.until / .then` are sugar — each composes with `race` and sequencing. The runtime never sees the fluent surface; it sees the same `Yieldable` shapes it always has.

<md-circuit></md-circuit>

<md-choreography></md-choreography>

## Userland

Because the gen+signal seam is loose, things that look like framework features turn out to be short userland primitives. Each fits in a file and composes with everything else.

A timeline is a clock signal, a list of clips with `(at, dur)` ranges, each clip exposing a `t` signal in `[0, 1]` over its window. `yield* tl` advances the clock to the total duration:

```ts
const tl = timeline({
  intro: { at: 0, dur: 0.5 },
  hold: { at: 0.5, dur: 1.0 },
  outro: { at: 1.5, dur: 0.4 },
});
effect(() => (circle.opacity.value = tl.intro.t.value));
yield* tl;
```

<md-multitrack></md-multitrack>

<md-timeline-editor></md-timeline-editor>

An event bus is one signal per name plus `bus.until(name)`, which is a single suspend call. A snapshot is a closure over a signal's value with a `restore()` method. None of these needed to be in the runtime; the seam was loose enough that they could live in userland and still feel native.

A `claim` is a labeled `Signal<boolean>` over a predicate: `true` while it holds, `false` on violation. Claims compose with `.and`, `.or`, `.not`, `.during(scope)`, `.before(other)` — because they _are_ signals. Wrap a factory with `scope(fn)` and you can attach a claim to its lifetime via `.during(fn)` — each invocation re-arms it. The factory carries lazy `alive` / `last` / `runs` / `duration` / `touched` signals; `authorOf(sig)` reports which span most recently wrote to a signal:

```ts
const fadeIn = scope("fadeIn", function* (s, dur) { /* ... */ });

const bounded  = claim(c.opacity).stays.in([0, 1]).during(fadeIn);
const reaches1 = claim(c.opacity).becomes.equal(1).during(fadeIn);

loop(() => fadeIn(c, 0.3));
```

Live-checked specs without a separate test framework. The debugger below pairs the trace (gantt of factory invocations, `yield*` calls visible) with `α(t)` colored by `authorOf`, with claim strips on the same axis. The `nudge` factory is buggy: it overshoots `α=1` mid-run. Pause and step to see the offender name itself.

<md-debugger></md-debugger>

## Lenses & traits

The other consequence of "every property is a signal" is that derivations get reactive ops for free. `Vec` has `.add`, `.sub`, `.scale`, `.lerp`, `.distance`, `.perp`, `.normalize` — each returns a derived signal:

```ts
const c = vec(100, 100);
const d = c.add(offset).scale(2); // reactive in c and offset
const x: Num = c.x; // typed lens onto the x axis
```

The chainable surface allocates one `Computed` per call. For tight loops, fuse with `.derive`:

```ts
const v = c.derive((c) => c.add(offset).scale(2).perp());
//                  ^ one Computed; mutating Chain inside the closure
```

`Cls.lens(parent, get, set)` is the underlying machinery. `vec.x` and `vec.y` are lazy getters that build `Num.lens(this, s => s.x, (v, s) => ({ ...s, x: v }))` — so they're full `Num` signals, and `vec.x.to(50, 0.3)` is a one-axis tween. Per-axis writes don't fire neighbouring effects.

Aggregates aren't a feature, they're lenses. `Cls.lens(getter, setter)` returns a writable computed view that's also an instance of `Cls` — `Vec.lens(get, set)` is a Vec. `Cls.lens([parents], fwd, bwd)` is the N-ary form: reads aggregate through `fwd`, writes split via `bwd` and apply atomically. The rigid-body centroid is one line of that pattern — read returns the mean, write distributes the delta evenly. `centroid(a, b, c, d)` packages it; tweening it is a rigid group translate:

```ts
const c = centroid(a, b, c, d);
yield* c.to({ x: 200, y: 100 }, 1);
```

<md-aggregates></md-aggregates>

Two independent animation sequences sharing one position via `Vec.derive([seqA, seqB, w], weightedMean)` — neither knows about the other, and the visible motion is the per-frame weighted mean:

<md-mix></md-mix>

The same lens is the read/write end of a UI primitive. `handle(point)` is a draggable circle that reads its position from the point and writes back on drag — a few lines of pointer events around a writable Point. Drop one on a centroid and you've got rigid group dragging:

```ts
const c = centroid(a, b, c, d);
s(handle(c)); // drag the centroid; all four shapes move
```

Anywhere a writable Point exists, a handle can sit on it.

<md-handles></md-handles>

<md-invertible></md-invertible>

<md-layout-demo></md-layout-demo>

The same idea generalises. `polar(c, r, a)` is `center + (r·cos a, r·sin a)` — and its inverse is one of four policies on which inputs absorb a write: `rotate` (c fixed, write r and a), `translate` (only c shifts), `radial` (only r), `circular` (only a). `handle.rotate` is one line of `polar(center, radius, angle, "circular")`.

The bidirectional story compounds when you chain it. A solar system is deterministic in one scalar — `time` — with each body's angle derived as `time.scale(τ/period)`. Both `.scale` and `polar` (under `"circular"`) are invertible, so dragging *any* body writes back through its chain into `time`. Every other body re-derives from the new time. Drag winds and unwinds the whole system through a single degree of freedom.

<md-solar-system></md-solar-system>

The bidirectional story extends to `vec(num, num)` (writes propagate to both axes), `up`/`down`/`left`/`right` (sugar over the invertible `offset`), and `.scale` (gear ratios). A meshed drivetrain is `g[i+1] = g[i].scale(-teeth_i / teeth_{i+1})` chained — every gear is writable both ways. Drag *anywhere* on a gear and the click point becomes an ephemeral grab handle (`dragRotate` captures the click's intrinsic angle once; subsequent drags solve `angle` so the same point follows the cursor). The drive integrator pauses while any gear is being dragged.

<md-gears></md-gears>

The lenses don't care what the values *mean*. A colour has two natural coordinate systems — HSL and RGB — and the conversion between them is a bijection. Make HSL canonical, expose each R/G/B as `Num.lens([h, s, l], hslToRgb, rgbToHsl)` — a 3-input lens that reads through the bijection on the way out and back through it on the way in — render the picker on a polar wheel and three RGB sliders, and you get five draggable inputs all manipulating the same state from different coordinate systems. Drag the wheel, the RGB sliders move. Drag a slider, the wheel picker moves. *Same colour, two views.*

<md-color></md-color>

The lenses don't even need to be numeric on both ends. A codec — `parse` and `format` paired up — IS a lens between a typed value and its string representation: read formats, write parses. `hexFromColor(c)` wraps a writable Color as a writable `#rrggbb` text view. `secondsFromText(t)` wraps a writable string as a writable seconds-Num. Drag the handle (numeric end) and the text reformats; click a chip to write a literal string into the text end and the codec parses back through to the typed source. Form inputs and labels are the same primitive as RGB sliders.

<md-codec-lens></md-codec-lens>

Constraints fall out of the same primitive. A pulley conserving rope length is just `b = a.affine(−1, L)` — the invertible chain IS the conservation law, written once and read both ways. When the relation needs to read multiple sources or distribute writes across them, the same N-input `Cls.lens([parents], fwd, bwd)` from above is the generalisation. The escape hatch for everything else is the closure form `Cls.lens(get, set)`, or `relate(a, b, fwd, bwd)` for re-orientable bidirectional bindings between two existing signals (either side can be the driver).

<md-pulley></md-pulley>

When the inverse isn't a closed form, `argminVec` does one Newton step per write — damped least squares against a finite-difference Jacobian. Forward is whatever you can compute; the put redistributes the residual into inputs by weight. An N-link IK arm is the forward kinematics plus weights, plus a target-clamp into the reachable workspace (the principled fix for the rank-deficient Jacobian at full extension):

```ts
const tip = argminVec(angles, fwdKin, angles.map(() => 1), {
  clampTarget: clampToDisc(root, N * L),
});
```

<md-ik></md-ik>

Closed kinematic loops are a different beast from the open IK chain — there's no "tip" you can solve forward, just a system of length constraints that all need to satisfy simultaneously. _Position-based dynamics_ takes the simplest line: every joint a writable Vec, every bar a length residual, Gauss–Seidel relaxation projects the graph onto its constraint manifold each frame. Forward and inverse become the same operation — drag any joint, residual propagates through the rest of the rig.

<md-truss></md-truss>

When the mechanism is a single closed loop, _vector-loop_ is the textbook angle-space approach. Parameterise each bar by its angle; the closure equation `Σ rᵢ · u(θᵢ) = 0` is two scalar equations in the unknown angles, solved by Newton-Raphson seeded with last frame's solution. Continuity is invariant in angle space (angles are unique up to 2π), so output angles evolve smoothly through the cycle without any branch-tracking machinery.

<md-loop></md-loop>

Each of the above is a hand-rolled approach to a specific constraint shape — a closed-form inverse, a single Newton step, Gauss–Seidel projections, or a vector loop. The general path lives in `constraints/`: a `Constraints` holder binds any number of `Signal`s and runs an [Augmented Vertex Block Descent](https://graphics.cs.utah.edu/research/projects/avbd/) solve on every write. Constraints are ordinary factory calls — `distance`, `perpendicular`, `parallel`, `angle`, `onCircle`, `equalDist`, `lensNum`, `clamp`, `leq`, plus `generic` for anything you can write a residual for — and they all compose:

```ts
const c = constraints({ iterations: 12 });
c.add(
  distance(A, B, 160),
  distance(B, C, 120),
  distance(C, D, 80),
  perpendicular(A, B, B, C),
);
```

Drag any handle; the cluster's settle re-fires, runs the solver, and writes the new positions back via the settle's auto-self-exclusion — so the writes propagate to the rendering effects but don't re-trigger the solver itself. Single solve per write, no convergence loop, no fragile self-mute.

<md-sketchpad></md-sketchpad>

Push that further and the sketchpad is the editor. Two reactive collections — `signal<Point[]>` and `signal<Constraint[]>` — drive `forEach` blocks that mount and unmount visuals as the user clicks; the cluster doesn't care that cells and forces are coming and going, every solver step picks up whatever force set is current.

<md-sketchpad-live></md-sketchpad-live>

Constraints can be added and removed at runtime — `cluster.add(rel)` returns the relation, `cluster.remove(rel)` tears it down. The square below is held by four side constraints and one toggleable diagonal: with the brace, the quad is rigid and only translates and rotates; without it, one internal degree of freedom returns and it flexes as a 4-bar linkage.

<md-rigid></md-rigid>

Constraints describe loci as readily as they describe shapes — and the same cluster handles both at once. `onCircle(P, center, r)` keeps `P` on a circle of fixed radius around a (possibly draggable) center; `collinear(P, A, B)` keeps `P` on the line through two anchors. The bracket below has six constraints stacked in one cluster: two locus incidences, two equal-length bars, an `equalDist` symmetry, and a `rightAngle` at the inner vertex. Drag any anchor and the loci move; drag the bracket and it reconfigures while staying valid.

<md-incidence></md-incidence>

The same primitive scales up to closed kinematic loops. A 4-bar linkage is just three distance constraints and two pinned ground pivots — the fourth side is the (implicit) line between the pinned points. The mechanism's single internal degree of freedom emerges from the constraint count without any branching machinery; drag any free joint and the rocker, coupler and crank coordinate through their shared loop.

<md-fourbar></md-fourbar>

Mix shape constraints with locus constraints and you get classic mechanisms more or less for free. A slider-crank — the heart of every internal-combustion engine — is a rotating crank arm `O1—A`, a rigid connecting rod `A—B`, and a piston `B` that slides along a guide. Three constraints (`distance` × 2 + `collinear`) on six cells, four of which are pinned: the result is a one-DOF mechanism that converts rotation into linear reciprocation. Drag the crank tip and watch the piston track.

<md-slider-crank></md-slider-crank>

The same path scales up to physics. `Simulation(cluster, { gravity })` wraps the cluster in a velocity-and-extrapolation time-stepper that calls `tick(dt)` per frame. The cloth below is a 14×10 grid of point masses linked by ~250 hard distance constraints — every horizontal and vertical neighbour gets its own length constraint, top corners are pinned, the rest swings under gravity. Each frame the solver projects the whole net back onto the constraint manifold, in well under a millisecond.

<md-cloth></md-cloth>

A hanging rope is the 1D special case: 40 point masses, 39 links, one anchor. Drag the blue tip or grab the rope by the middle and physics carries the rest of the chain.

<md-chain></md-chain>

Constraints describe what _shouldn't_ happen as readily as what should. `gap(a, b, d)` keeps two points at least `d` apart — a hard inequality the solver only enforces when violated. With soft `spring`s along edges and a pairwise `gap` on every node pair, a force-directed graph layout falls out in two factory calls. The cluster handles all 120 pair constraints plus the spring forces, every frame.

<md-graph></md-graph>

Pair `gap` with rectangular containment (`inside(P, xLo, yLo, xHi, yHi)` — four one-sided inequalities, dormant when the point is in the box) and a touch of gravity, and you have a 2D snowglobe: 24 colored circles fall, settle into a hex packing, and shove each other out of the way when you grab one. The cluster solves 24 wall constraints + 276 pairwise gaps every frame — under a millisecond.

<md-particles></md-particles>

The same engine handles **proper** rigid bodies just as well — boxes with full position + rotation, contact constraints with friction, stacking, the whole show. A rigid body in this version is a single 3-DOF cell `(x, y, θ)` with a diagonal mass matrix `(m, m, I)` (linear and rotational inertia). Box-box collisions are detected by SAT (the same algorithm Box2D uses) and turned into `BoxContact` forces with normal and tangential rows; the tangential clamp is set per-iteration to `±μ·|λ_normal|` for Coulomb friction. Edge identifiers carry across frames so penalty and λ warm-start correctly through contact events. Drop a pyramid of dynamic boxes onto a static floor and they stack and settle:

<md-rigid-stack></md-rigid-stack>

The same `Constraints` + `Simulation` that runs the cloth, the chain, and the algebraic equation solver runs this — only the constraint shapes and the cell dimension differ. The solver's `dim = 3` primal-sweep specialization (one hand-unrolled local Newton per body) means the rigid path doesn't pay any "generality tax" relative to a hand-rolled physics engine.

Joints between rigid bodies turn the same machinery into a chain of bars — AVBD's `sceneRope` setup. Each link is its own rigid body with rotational inertia, hinged to the next via a `Joint` force whose position rows are hard and angle row is free. Drag any link and the rest swings; the bars rotate the way bars do, not the way beads on a string do.

<md-rigid-rope></md-rigid-rope>

The same pattern works on a 1D submanifold inside 2D. Each circle gets a Vec position `P` and a scalar parameter `t`, coupled by a `generic` constraint that fixes `P = (R·sin t, R·sin 2t / 2)` — the figure-8 Lissajous map. Pairwise `gap` enforces non-overlap in 2D; the curve constraint enforces incidence. Drag any circle and it slides along the curve, scooting the others aside; near the self-intersection at the origin, the constraint admits both branches and the solver may flip from one to the other (the multi-solution caveat the factories header warns about).

<md-figure8></md-figure8>

None of this is fundamentally geometric. The cluster operates on cells of arbitrary dimension and constraints over any function of those cells, so the same engine that solves a 4-bar linkage will solve an algebraic equation with no positions in sight. The three sliders below are plain `Num` cells with one `generic` constraint enforcing `a² + b² = c²` — drag any handle and the other two redistribute to satisfy the equation. The "redistribution" is the local Newton step picking the (a, b, c) on the constraint surface closest to the current values; pinning the dragged cell turns that into a 1-out-of-3 underdetermined solve.

<md-equation></md-equation>

Curves matter too. `Path` is a reactive polyline — cheap, fast, plenty for line plots and node-to-node connectors. When ellipses or arcs are needed, the sibling `Curve` carries the same reactive plumbing but with `ellipseArc` segments rendered via SVG's native `A` command. The standalone `ellipse(center, a, b, rotation?)` factory accepts `Val<>` on every parameter, so a family of confocal conics — five ellipses through fixed eccentricities, four hyperbola pairs sampled as polylines — comes from a couple of loops driven by two draggable foci. Drag a focus; the whole grid re-rescales. Drag the probe; the unique ellipse and hyperbola through it track in real time:

```ts
const aE = computed(() => (r1.value + r2.value) / 2);   // 2a_e = r₁ + r₂
const bE = computed(() => Math.sqrt(aE.value ** 2 - cDist.value ** 2));
s(ellipse(center, aE, bE, rot, { stroke: ACCENT }));
```

<md-confocal></md-confocal>

`debug.*` goes the other way — read-only derived shapes. `debug.box(thing)` reads a shape's transform and box, derives a parent-frame outline, and renders dashed magenta. Drop them in while developing, delete when done:

```ts
s(debug.box(eq));
s(debug.center(c));
```

They update with everything else, because they're just signals deriving from signals.

`.to` works uniformly across value types because it dispatches on traits. `tween`, `spring`, `toward`, `attract` read `linear` / `lerp` / `metric` from each class's `static traits = {…}` dictionary — they don't know about `Vec` or `Color` specifically, and the constraint is enforced at compile time (`spring<T>(sig: Traits<T, "linear" | "metric">, …)` rejects classes without those traits). So `.to` on a `Num`, a `Vec`, a `Box`, a `Color`, a `Transform`, a string — same call, dispatched through the dict:

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
interface Polygon { readonly constructor: typeof Polygon }
```

…and `polygon.to(targetPolygon, dur)` falls out, on the same chain machinery, with the same combinator support. Add `linear` and `metric` to the dict and `spring`/`toward`/`attract` work on it the same day. A centroid of `Polygon`s is `mean(p1, p2, p3)`. No special cases anywhere in the pipeline.

<md-morph></md-morph>

## TeX

`` tex`…` `` returns a Shape rendering MathML through Temml. Interpolated `part()` markers become addressable child shapes — `eq.parts.M` has its own `translate`, `rotate`, `opacity`, `color`. So a symbol in an inline equation can highlight on hover, pluck out and orbit, link to a corresponding circle on a diagram, or animate apart from the rest of the formula:

```ts
const eq = tex`E = ${part("M")} c^2`;
yield* eq.parts.M.translate.to({ x: 0, y: -20 }, 0.4);
```

<md-tex-demo></md-tex-demo>

<md-tex-correspond></md-tex-correspond>

<md-tex-matrix></md-tex-matrix>

<md-tex-live></md-tex-live>

Marker identity extends past the diagram. `marker.register("id")` puts a marker into a global lookup; `<md-marker sym="id">` finds it on connect and subscribes to the same signals. Both ends share one `marker.active` signal — a derived OR over every bound rendering. Because it's a `Signal<boolean>`, the suspension vocabulary applies: `yield* play(marker.active)` pauses a generator until any rendering of the marker is activated — from prose, from the diagram, or from an animation holding the marker.

The <md-marker sym="minim:m">mass</md-marker>, <md-marker sym="minim:v">velocity</md-marker>, and <md-marker sym="minim:h">height</md-marker> terms in the formula below each have their own colour and hover state. Hover any term here.

<md-tex-prose></md-tex-prose>

The demo below uses the suspend-on-marker idiom: hover <md-marker sym="osc:gamma">damping</md-marker> to reveal the decay envelope, <md-marker sym="osc:A">amplitude</md-marker> for the bounds, <md-marker sym="osc:omega">frequency</md-marker> for the period tick marks.

<md-oscillator></md-oscillator>

## Beyond SVG

The same `(wake) => dispose` shape carries to native browser primitives. `untilAnimation(a)` wakes on a WAAPI `finish` event; `untilInView(el)` wakes when an element starts intersecting; `scrollProgress()` is a lazy signal that subscribes to `scroll` only when something reads it. WAAPI and minim animations interleave naturally:

```ts
yield* untilInView(el);
yield* fadeIn(circle, 0.5);
```

`native(el, keyframes, opts)` goes the other way — wraps an `Element.animate` call as an `Animator<void>`, so a compositor-driven tween composes with `stagger`, `all`, `race`, and `try/finally` like any other animator. The expensive properties — `filter`, `backdrop-filter`, multi-keyframe `transform` choreography across many elements — run off the main thread for free, while the surrounding scene still drives through signals.

<md-waapi-demo></md-waapi-demo>

Nothing here is SVG-specific. The same generator + signal pipeline drives `<canvas>` with a per-frame for-loop just as well — the runtime is renderer-agnostic, and the SVG `Shape` graph is a convenience.

<md-canvas-field></md-canvas-field>

The `code` package is a sibling of `tex` — same architecture (a reactive `source` signal driving a `<foreignObject>`-hosted text wrapper), different content. Writing `c.source.value = newSrc` re-renders; `c.morphTo(newSrc, dur)` runs a line-level LCS diff between old and new sources, then a token-level LCS within each modified line, surgically wraps the changed ranges in inline-block spans, and lerps their widths and heights over the duration. Matched content stays as plain text and reflows naturally. Lines whose trimmed content survives across positions are paired as moves and animate from their old visual position to their new flow position, with any indent change riding as an inline edit. Syntax colours come from CSS Custom Highlights painted over the wrapper's text ranges; they don't add DOM nodes — and the same substrate carries token-level decoration (highlight, underline) and per-token transform (pluck a Range into an inline-block span, animate its transform, restore) for free.

<md-code></md-code>

<md-centering></md-centering>

<md-runtime-tests></md-runtime-tests>

<md-trails></md-trails>