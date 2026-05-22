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

`field(parent, key, Type)` is the underlying machinery. `vec.x` and `vec.y` are returned by `field(this, "x", Num)` / `field(this, "y", Num)` — so they're full `Num` signals, and `vec.x.to(50, 0.3)` is a one-axis tween. Per-axis writes don't fire neighbouring effects.

Aggregates aren't a feature, they're lenses. `lens(getter, setter, Cls)` returns a writable computed view that's also an instance of `Cls` — `lens(get, set, Vec)` is a Vec. `mix(Cls, parts, merge, writeback)` is the N-ary form, parameterised by a *merge* (how reads aggregate) and a *writeback* (how writes distribute). `Mix.mean` + `Mix.deltaEven` gives you the rigid-body centroid: reading returns the mean, writing distributes the delta evenly. `centroid(a, b, c, d)` is one line of that pattern. Tweening it is a rigid group translate:

```ts
const c = centroid(a, b, c, d);
yield* c.to({ x: 200, y: 100 }, 1);
```

<md-aggregates></md-aggregates>

Merges and writebacks are first-class composable values. `Mix.mean`, `Mix.sum`, `Mix.priority`, `Mix.latest`, `Mix.firstNonNull` compose through combinators like `top(n, base)` and `above(threshold, base)`; `Mix.deltaEven`, `Mix.replaceFirst`, `Mix.proportional` do the dual job for writebacks. Two independent animation sequences sharing one position via `mix(Vec, [seqA, seqB], Mix.mean)` — neither knows about the other, and the visible motion is the per-frame weighted mean:

<md-mix></md-mix>

The same lens is the read/write end of a UI primitive. `handle(point)` is a draggable circle that reads its position from the point and writes back on drag — a few lines of pointer events around a writable Point. Drop one on a centroid and you've got rigid group dragging:

```ts
const c = centroid(a, b, c, d);
s(handle(c)); // drag the centroid; all four shapes move
```

Anywhere a writable Point exists, a handle can sit on it.

<md-handles></md-handles>

<md-layout-demo></md-layout-demo>

The same idea generalises. `polar(c, r, a)` is `center + (r·cos a, r·sin a)` — and its inverse is one of four policies on which inputs absorb a write: `rotate` (c fixed, write r and a), `translate` (only c shifts), `radial` (only r), `circular` (only a). `handle.rotate` is one line of `polar(center, radius, angle, "circular")`.

The bidirectional story compounds when you chain it. A solar system is deterministic in one scalar — `time` — with each body's angle derived as `time.scale(τ/period)`. Both `.scale` and `polar` (under `"circular"`) are invertible, so dragging *any* body writes back through its chain into `time`. Every other body re-derives from the new time. Drag winds and unwinds the whole system through a single degree of freedom.

<md-solar-system></md-solar-system>

The bidirectional story extends to `vec(num, num)` (writes propagate to both axes), `up`/`down`/`left`/`right` (sugar over the invertible `offset`), and `.scale` (gear ratios). A meshed drivetrain is `g[i+1] = g[i].scale(-teeth_i / teeth_{i+1})` chained — every gear is writable both ways. Drag *anywhere* on a gear and the click point becomes an ephemeral grab handle (`dragRotate` captures the click's intrinsic angle once; subsequent drags solve `angle` so the same point follows the cursor). The drive integrator pauses while any gear is being dragged.

<md-gears></md-gears>

The lenses don't care what the values *mean*. A colour has two natural coordinate systems — HSL and RGB — and the conversion between them is a bijection. Make HSL canonical, expose R/G/B as `Num.lens(hslToRgb, rgbToHsl)`, render the picker on a polar wheel and three RGB sliders, and you get five draggable inputs all manipulating the same state from different coordinate systems. Drag the wheel, the RGB sliders move. Drag a slider, the wheel picker moves. *Same colour, two views.*

<md-color></md-color>

Constraints fall out of the same primitive. A pulley conserving rope length is just `b = a.affine(−1, L)` — the invertible chain IS the conservation law, written once and read both ways. The escape hatch for relations that don't fit a chain is the explicit `Num.lens(get, set)` form: write the forward computation and the inverse, get the same bidirectional semantics.

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