---
title: Minim
description: Generator-driven animated SVG diagrams with reactive primitives.
---

Animations in minim are JavaScript generators. They yield upward; the runtime resumes them with the seconds elapsed since the last frame.

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

Roughly, the runtime is `for (const g of active) g.next(dt)`, and the generator decides what to do with the dt it gets back. You can write every animation in the library this way — count up to a duration, write to a signal, return — and many of the originals still are.

<md-transitions></md-transitions>

A few other shapes are accepted in yield position. Each is shorthand for something you could write with the loop above, and each gives the runtime more information to work with:

| Yield                | Means                                |
| -------------------- | ------------------------------------ |
| `yield;`             | wait one frame, resume with `dt`     |
| `yield 0.5;`         | sleep half a second                  |
| `yield gen;`         | spawn a child generator, wait for it |
| `yield [a, b];`      | spawn N in parallel, wait for all    |
| `yield (wake) => …;` | suspend on a callback-shaped source  |

A function `(wake) => dispose` covers everything that doesn't have a fixed duration. Anything callback-shaped — DOM events, signal changes, promises, an event bus — fits the contract. Yield one and the runtime takes you off the tick loop entirely; when `wake(value)` fires it puts you back on, with `value` as the resume of the `yield`:

```ts
const event = yield * untilEvent(button, "click");
const next = yield * untilChange(signal);
```

No polling, no per-frame work while suspended.

Generators compose through one entry point. `play(p)` lifts any `Playable` — a number (sleep), an array (parallel), a generator, a bare suspend-fn, or a reactive cell (wait truthy) — into the fluent surface. `loop(factory)` is its iterating cousin. Methods read subject-first — the running process comes first, the temporal qualifier follows:

```ts
spring(w, rest).until(dragging);             // spring, until dragging
play([lane0, lane1, lane2]).until(hardStop); // parallel lanes, until hardStop
play(0.5).then(fadeIn(shape, 0.3));          // sleep, then fade in
play(ready).then(work);                      // wait truthy, then work
orbit(centre, shapes).at(playback);          // orbit at playback rate
```

`.until / .then / .at` are sugar — each composes with existing primitives (`race`, internal until-truthy, sleep). For the "while truthy" idiom use `.until(not(sig))`. The runtime never sees the fluent surface; it sees the same `Yieldable` shapes it always has.

<md-cancel></md-cancel>

Time scoping is per-generator. `.at(scale)` accepts a number, a signal, or a thunk; the child's `dt` becomes `dt × parent.scale × own`. No global `timeScale` — any subtree can run slow, fast, paused, or reversed independently:

```ts
const playback = num(1);
yield* play([intro, hold, outro]).at(playback);   // whole scene rate-controlled
playback.value = 0;                               // pause everything
```

`Anim` itself has no signal dependency: the runtime exposes time as `anim.clockMs` (a plain number) and `anim.onClock(cb)` (a callback subscription). For reactive access, the signals layer ships `clockSignal(anim)` — a tiny adapter that mirrors the number into a `ReadonlyCell<number>`.

<md-orbits></md-orbits>

The other primitive in minim is the signal — a reactive cell. Read it inside a `computed` or `effect` and you've subscribed; write it and the subscribers update.

```ts
const x = signal(0);
effect(() => svg.setAttribute("x", String(x.value)));
x.value = 100;
```

Every animatable property of every shape is a signal. The DOM is wired to them once, at construction. Animations don't touch the DOM — they write to signals.

<md-mirror></md-mirror>

<md-anchors></md-anchors>

`.to(target, dur, ease?)` is installed by the struct framework on each registered Reactive's prototype — not on plain `Signal`. So `num(0).to(100, 0.5)` works (Num is a registered struct); plain `signal(0)` does not. The standalone `tween(sig, target, dur, ease?, lerp?)` is the escape hatch for value types you don't want to declare as a full struct.

```ts
yield* x.to(100, 0.5, easeInOut);    // x is `Num.signal` (has `.to`)
yield* tween(plainSig, 100, 0.5);    // escape hatch for plain Signal
```

`.to(...)` returns a `Tween<T> extends Play<void>` — it composes with the rest of the fluent vocabulary, and chains another segment via `.to`:

```ts
yield* x.to(100, 0.5).to(0, 0.5).until(stop);
//          ^ tween     ^ tween   ^ Play method — stops whichever
//                                  segment is currently running
```

Register value types and the same method works on those too:

```ts
const Vec = struct<{ x: number; y: number }>("Vec", { x: 0, y: 0 })
  .construct((x, y) => ({ x, y }))
  .ops({ add, sub, scale, lerp })
  .build();

yield * shape.translate.to({ x: 100, y: 50 }, 0.5, easeInOut);
```

`.to` doesn't know about `Vec`. It looks up the value type's `lerp` through the per-struct prototype slot and steps through it. Register `Pose`, `Quat`, `Camera` with a `lerp` op and they tween the same day.

<md-lerps></md-lerps>

<md-morph></md-morph>

Integrators work the same way. `spring`, `oscillate`, `drift`, `attract` are generators that read the value type's `add`/`sub`/`scale` from a sibling slot. Spring on a `Vec`, on a `Color`, on a custom `Pose` — same call, no special cases.

<md-behaviors></md-behaviors>

Aggregates aren't a feature, they're lenses:

```ts
const c = centroid(a, b, c, d);
yield * c.to({ x: 200, y: 100 }, 1);
```

`centroid` is a writable lens over four shapes' translates: read returns the mean, write distributes the delta. Tweening it is a rigid group translate. Roll your own in five lines: read returns whatever, write distributes whatever.

<md-aggregates></md-aggregates>

<md-choreography></md-choreography>

The same lens works as the read+write side of a UI primitive. `handle(point)` is a draggable circle that reads its position from the point and writes back on drag — a few lines of pointer events around a writable Point. Drop one on a centroid and you've got rigid group dragging:

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

Generators can suspend on signals too. `untilChange(sig)` waits for the next change and resumes with the new value; `play(sig)` waits until truthy (`play(work).until(not(sig))` for the falsy case). All wrap `effect` — animations wait on reactive state without polling:

```ts
yield * untilChange(stopFlag);
yield * fadeOut(s, 0.4);
```

<md-circuit></md-circuit>

Sources of intent that aren't built into the runtime are short to write, because the runtime doesn't impose anything on them. `EventBus` is the canonical example: `bus.emit(name, data)` fans out synchronously, `bus.until(name)` is one call to `suspend()`:

```ts
const data = yield * bus.until<Payload>("ready");
```

Just another callback-shaped source. No special integration.

A timeline is the same kind of user-space primitive on the time axis. A clock signal, a list of clips with `(at, dur)` ranges, each clip exposing a `t` signal in `[0, 1]` over its window. `yield* timeline` advances the clock to `duration`:

```ts
const tl = timeline({
  intro: { at: 0, dur: 0.5 },
  hold: { at: 0.5, dur: 1.0 },
  outro: { at: 1.5, dur: 0.4 },
});
effect(() => (circle.opacity.value = tl.intro.t.value));
yield * tl;
```

<md-multitrack></md-multitrack>

<md-timeline-editor></md-timeline-editor>

<md-rand></md-rand>

Rate-controlled playback is just `.at(scale)` on whatever generator owns the work — the scale is a Num signal, so the same `.to` machinery eases it in and out:

```ts
const playback = num(1);
yield* play([intro, hold, outro]).at(playback);
yield* playback.to(0, 0.5, easeOut);         // ease into pause
slider.oninput = () => (playback.value = +slider.value);
```

The same `(wake) => dispose` shape carries out to native browser primitives. `untilAnimation(a)` wakes on a WAAPI `finish` event; `untilInView(el)` wakes when an element starts intersecting; `scrollProgress()` is a lazy signal that subscribes to `scroll` only when something reads it. WAAPI animations and minim animations interleave naturally:

```ts
yield * untilInView(el);
yield * fadeIn(circle, 0.5);
```

<md-waapi-demo></md-waapi-demo>

Nothing in this story is SVG-specific. The same generator + signal pipeline drives a `<canvas>` element with a per-frame for-loop just as well — the runtime is renderer-agnostic, and the SVG `Shape` graph is a convenience.

<md-canvas-field></md-canvas-field>

A `tex` template returns a Shape rendering MathML through Temml. Interpolated `part()` markers become addressable child shapes — `eq.parts.M` has its own translate, rotate, opacity, color. So a symbol in an inline equation can highlight on hover, pluck out and orbit, link to a corresponding circle on a diagram, or animate apart from the rest of the formula:

```ts
const eq = tex`E = ${part("M")} c^2`;
yield * eq.parts.M.translate.to({ x: 0, y: -20 }, 0.4);
```

<md-tex-demo></md-tex-demo>

<md-tex-correspond></md-tex-correspond>

<md-tex-matrix></md-tex-matrix>

<md-tex-live></md-tex-live>

Marker identity extends past the diagram. `marker.register("id")` puts any marker into a global lookup; `<md-marker sym="id">` finds it on connect and subscribes to the same signals. Both ends share one `marker.active` cell — a derived OR over every bound rendering. Hover in either direction; neither can cancel the other.

The <md-marker sym="minim:m">mass</md-marker>, <md-marker sym="minim:v">velocity</md-marker>, and <md-marker sym="minim:h">height</md-marker> terms in the formula below each have their own color and hover state. Hover any term here.

<md-tex-prose></md-tex-prose>

Because `marker.active` is a `ReadonlyCell<boolean>`, the full suspension vocabulary applies to it directly. `yield* play(marker.active)` pauses a generator until any rendering is activated — from prose, from the diagram, or from an animation holding the marker. The demo below uses this: hover <md-marker sym="osc:gamma">damping</md-marker> to reveal the decay envelope, or hover <md-marker sym="osc:A">amplitude</md-marker> to show the bounds. Hover <md-marker sym="osc:omega">frequency</md-marker> to see the period tick marks scrolling across the trace.

<md-oscillator></md-oscillator>

A `claim` is a labeled `Signal<boolean>` over some predicate. `claim(c.opacity).stays.in([0, 1])` is true while the predicate holds, false on first violation. Claims compose via `.and`, `.or`, `.during(process)` because they _are_ signals. A `process(factory, ...claims)` is an animator that resets the claims at scope entry and runs the body:

```ts
const bounded = claim(c.opacity).stays.in([0, 1]);
const reaches1 = claim(c.opacity).becomes.equal(1);
const intro = process(() => fadeIn(c, 0.3), bounded, reaches1);

yield * intro.run();
```

Live-checked specs without a separate test framework.

<md-claim-demo></md-claim-demo>

<md-trace-demo></md-trace-demo>

<md-centering></md-centering>

<md-runtime-tests></md-runtime-tests>
