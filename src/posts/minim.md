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

The runtime adds two things on top. One is efficiency (single tick loop, time-scaled subtrees that actually freeze instead of multiplying their dt by zero). The other is a way to wait on something that doesn't have a fixed duration. Yield a function `(wake) => dispose` and the runtime parks the generator and passes it the wake callback. Calling `wake(value)` resumes the generator with `value` as the result of the yield. This is synchronous — call `wake()` from inside a DOM event handler and the generator advances re-entrantly, before the handler returns:

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
| yield scaled(r, g) | spawn child with time-scale r               |
| yield cut(v)       | from inside a group: settle group with v    |

`scaled` is the engine-native counterpart to the `halfSpeed` wrapper above — it installs the rate on a child active so it propagates through every orchestration boundary (kids spawned via `race`, `all`, `yield [...]`), which a hand-rolled wrapper can't reach. There's no global `timeScale`: any subtree can run slow, fast, paused, or reversed independently.

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

<md-anchors></md-anchors>

Signals and generators meet through a small set of generator-producing helpers. Some _write_ to a signal over time. Every value-typed signal carries `.to(target, dur, ease?)`, which returns a chainable `Tween<T>` that's also an `Animator<void>` — so it composes with sequencing, racing, and the rest of the generator vocabulary:

```ts
yield* x.to(100, 0.5, easeInOut);
yield* x.from(0).to(100, 0.5).to(0, 0.5).until(stop);
```

`tween(sig, target, dur, ease?)` is the free-fn form for plain signals where the method isn't installed. `spring(sig, target, opts?)`, `toward(sig, target, speed)`, `attract(sig, target, k)` are integrators that pull toward a (possibly reactive) target with different curves — overshoot-capable, constant-speed, exponential. `driven(sig, step)` is the escape hatch — write whatever per-frame function you want.

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
orbit(centre, shapes).at(playback); // orbit at playback rate
loop(() => fadeInOut(c)).until(done); // repeat, until done
```

`.until / .then / .at` are sugar — each composes with `race`, sequencing, and `scaled`. The runtime never sees the fluent surface; it sees the same `Yieldable` shapes it always has.

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

A `claim` is a labeled `Signal<boolean>` over a predicate: `true` while it holds, `false` on violation. Claims compose with `.and`, `.or`, `.not`, `.during(p)`, `.before(other)` — because they _are_ signals. A `process(factory, ...claims)` wraps a unit of work in lifecycle signals (`alive`, `started`, `completed`, `duration`) and re-arms the attached claims on each `.run()`:

```ts
const bounded = claim(c.opacity).stays.in([0, 1]);
const reaches1 = claim(c.opacity).becomes.equal(1);
const intro = process(() => fadeIn(c, 0.3), bounded, reaches1);

loop(() => intro.run());
```

Live-checked specs without a separate test framework.

<md-claim-demo></md-claim-demo>

<md-trace-demo></md-trace-demo>

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

Aggregates aren't a feature, they're lenses. `derived(Cls, getter, setter?)` returns a writable `Computed` that's also an instance of `Cls` — `derived(Vec, …)` is a Vec. `combine(parts, merge, distribute)` is the N-ary form; `mean(...sigs)` is five lines over `combine`; `centroid(a, b, c, d)` is `mean(a.translate, …)`. Reading returns the mean; writing distributes the delta. Tweening it is a rigid group translate:

```ts
const c = centroid(a, b, c, d);
yield* c.to({ x: 200, y: 100 }, 1);
```

<md-aggregates></md-aggregates>

The same lens is the read/write end of a UI primitive. `handle(point)` is a draggable circle that reads its position from the point and writes back on drag — a few lines of pointer events around a writable Point. Drop one on a centroid and you've got rigid group dragging:

```ts
const c = centroid(a, b, c, d);
s(handle(c)); // drag the centroid; all four shapes move
```

Anywhere a writable Point exists, a handle can sit on it.

<md-handles></md-handles>

<md-layout-demo></md-layout-demo>

`debug.*` goes the other way — read-only derived shapes. `debug.box(thing)` reads a shape's transform and box, derives a parent-frame outline, and renders dashed magenta. Drop them in while developing, delete when done:

```ts
s(debug.box(eq));
s(debug.center(c));
```

They update with everything else, because they're just signals deriving from signals.

`.to` works uniformly across value types because it dispatches on traits. `tween`, `spring`, `toward`, `attract` read `[LINEAR]` / `[LERP]` / `[METRIC]` from Symbol-keyed prototype slots on the signal — they don't know about `Vec` or `Color` specifically. So `.to` on a `Num`, a `Vec`, a `Box`, a `Color`, a `Transform`, a string — same call, dispatched through the slot:

<md-lerps></md-lerps>

Adding a value type is one class and a few stamps:

```ts
class Polygon extends Signal<PolygonValue> {}
defineTrait(Polygon, LERP, lerpPolygon);
defineTrait(Polygon, EQUALS, equalsPolygon);
```

…and `polygon.to(targetPolygon, dur)` falls out, on the same chain machinery, with the same combinator support. Stamp `[LINEAR]` and `[METRIC]` too and `spring`/`toward`/`attract` work on it the same day. A centroid of `Polygon`s is `mean(p1, p2, p3)`. No special cases anywhere in the pipeline.

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

<md-centering></md-centering>

<md-runtime-tests></md-runtime-tests>

<md-trails></md-trails>
