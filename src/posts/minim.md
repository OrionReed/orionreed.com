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
const event = yield* untilEvent(button, "click");
const next  = yield* untilChange(signal);
```

No polling, no per-frame work while suspended.

The runtime never knows about combinators like `race` or `endOn`. They're generators, written in the same vocabulary as the animations they coordinate:

```ts
yield race(orbit(centre, planets), untilEvent(stop, "click"));
yield endOn(untilChange(stopFlag), oscillate(y, 20, 1));
yield* fadeOut(s, 0.4);   // graceful exit, same generator
```

`race` is a dozen lines: spawn each child, wake on the first to finish, cancel the rest. `endOn(t, w)` is `race(w, t)` named so the trigger reads first. `firstN`, `all`, `sequence`, `stagger`, `splay` are all the same trick. Add your own and it composes the same way.

<md-cancel></md-cancel>

The reason this works at any depth is that `Anim` — the runtime — is itself a generator: `next(dt)`, `return()`, `[Symbol.iterator]`. You can `yield*` a sub-`Anim` from inside another generator, and each `Anim` has its own `timeScale`. Nesting an `Anim` is scoping time:

```ts
const slowmo = new Anim();
slowmo.timeScale.value = 0.25;
slowmo.run(orbit(centre, planets));

yield* slowmo;   // outer 1×, planets 0.25×
```

Pause, reverse playback, scrubbable timelines — same move, different `timeScale`.

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

`Signal.prototype.to` returns a generator that steps from the signal's current value to a target over a duration:

```ts
yield* x.to(100, 0.5, easeInOut);
```

A signal just produced a generator, and the runtime already knew what to do with it.

You can register richer value types, and the same method works on those too:

```ts
const Vec = struct<{x: number; y: number}>("Vec", { x: 0, y: 0 })
  .construct((x, y) => ({ x, y }))
  .ops({ add, sub, scale, lerp })
  .build();

yield* shape.translate.to({ x: 100, y: 50 }, 0.5, easeInOut);
```

`.to` doesn't know about `Vec`. It looks up the value type's `lerp` through a prototype slot and steps through it. Register `Pose`, `Quat`, `Camera` with a `lerp` op and they tween the same day.

<md-lerps></md-lerps>

<md-morph></md-morph>

Integrators work the same way. `spring`, `oscillate`, `drift`, `attract` are generators that read the value type's `add`/`sub`/`scale` from a sibling slot. Spring on a `Vec`, on a `Color`, on a custom `Pose` — same call, no special cases.

<md-behaviors></md-behaviors>

Aggregates aren't a feature, they're lenses:

```ts
const c = centroid(a, b, c, d);
yield* c.to({ x: 200, y: 100 }, 1);
```

`centroid` is a writable lens over four shapes' translates: read returns the mean, write distributes the delta. Tweening it is a rigid group translate. Roll your own in five lines: read returns whatever, write distributes whatever.

<md-aggregates></md-aggregates>

<md-choreography></md-choreography>

The same lens works as the read+write side of a UI primitive. `handle(point)` is a draggable circle that reads its position from the point and writes back on drag — a few lines of pointer events around a writable Point. Drop one on a centroid and you've got rigid group dragging:

```ts
const c = centroid(a, b, c, d);
s(handle(c));        // drag the centroid; all four shapes move
```

Anywhere a writable Point exists, a handle can sit on it.

<md-handles></md-handles>

`debug.*` goes the other way — read-only derived shapes. `debug.box(thing)` reads a shape's transform and box, derives a parent-frame outline, and renders dashed magenta. Drop them in while developing, delete when done:

```ts
s(debug.box(eq));
s(debug.center(c));
```

They update with everything else, because they're just signals deriving from signals.

Generators can suspend on signals too. `untilChange`, `untilTrue`, `untilFalse` are short wrappers around `effect` — animations wait on reactive state without polling:

```ts
yield* untilChange(stopFlag);
yield* fadeOut(s, 0.4);
```

<md-circuit></md-circuit>

Sources of intent that aren't built into the runtime are short to write, because the runtime doesn't impose anything on them. `EventBus` is the canonical example: `bus.emit(name, data)` fans out synchronously, `bus.until(name)` is one call to `suspend()`:

```ts
const data = yield* bus.until<Payload>("ready");
```

Just another callback-shaped source. No special integration.

A timeline is the same kind of user-space primitive on the time axis. A clock signal, a list of clips with `(at, dur)` ranges, each clip exposing a `t` signal in `[0, 1]` over its window. `yield* timeline` advances the clock to `duration`:

```ts
const tl = timeline({
  intro: { at: 0,   dur: 0.5 },
  hold:  { at: 0.5, dur: 1.0 },
  outro: { at: 1.5, dur: 0.4 },
});
effect(() => circle.opacity.value = tl.intro.t.value);
yield* tl;
```

<md-multitrack></md-multitrack>

<md-timeline-editor></md-timeline-editor>

<md-rand></md-rand>

The clock and `timeScale` are themselves signals, so the same `.to` works on them:

```ts
yield* anim.timeScale.to(0, 0.5, easeOut);   // ease into pause
slider.oninput = () => anim.timeScale.value = +slider.value;
```

The same `(wake) => dispose` shape carries out to native browser primitives. `untilAnimation(a)` wakes on a WAAPI `finish` event; `untilInView(el)` wakes when an element starts intersecting; `scrollProgress()` is a lazy signal that subscribes to `scroll` only when something reads it. WAAPI animations and minim animations interleave naturally:

```ts
yield* untilInView(el);
yield* fadeIn(circle, 0.5);
```

<md-waapi-demo></md-waapi-demo>

Nothing in this story is SVG-specific. The same generator + signal pipeline drives a `<canvas>` element with a per-frame for-loop just as well — the runtime is renderer-agnostic, and the SVG `Shape` graph is a convenience.

<md-canvas-field></md-canvas-field>

A `tex` template returns a Shape rendering MathML through Temml. Interpolated `part()` markers become addressable child shapes — `eq.parts.M` has its own translate, rotate, opacity, color. So a symbol in an inline equation can highlight on hover, pluck out and orbit, link to a corresponding circle on a diagram, or animate apart from the rest of the formula:

```ts
const eq = tex`E = ${part("M")} c^2`;
yield* eq.parts.M.translate.to({ x: 0, y: -20 }, 0.4);
```

<md-tex-demo></md-tex-demo>

<md-tex-correspond></md-tex-correspond>

<md-tex-matrix></md-tex-matrix>

<md-tex-live></md-tex-live>

Marker identity extends past the diagram. `PartMarker.register("id")` puts a marker into a global registry; `<md-tex sym="id">` looks it up on connect and subscribes to the same `color` and `highlighted` signals. Hover any term below and the corresponding part in the formula lights up — the diagram animation also drives the prose, because both ends share one signal:

The kinetic term ½<md-tex sym="minim:m">m</md-tex><md-tex sym="minim:v">v^2</md-tex> and the potential term <md-tex sym="minim:m">m</md-tex>g<md-tex sym="minim:h">h</md-tex> balance to give the total mechanical energy $E$.

<md-tex-prose></md-tex-prose>

A `claim` is a labeled `Signal<boolean>` over some predicate. `claim(c.opacity).stays.in([0, 1])` is true while the predicate holds, false on first violation. Claims compose via `.and`, `.or`, `.during(process)` because they *are* signals. A `process(factory, ...claims)` is an animator that resets the claims at scope entry and runs the body:

```ts
const bounded  = claim(c.opacity).stays.in([0, 1]);
const reaches1 = claim(c.opacity).becomes.equal(1);
const intro    = process(() => fadeIn(c, 0.3), bounded, reaches1);

yield* intro.run();
```

Live-checked specs without a separate test framework.

<md-claim-demo></md-claim-demo>

<md-trace-demo></md-trace-demo>

<md-layout-demo></md-layout-demo>

<md-centering></md-centering>

<md-runtime-tests></md-runtime-tests>
