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

<md-react></md-react>

The reason this works at any depth is that `Anim` — the runtime — is itself a generator: `next(dt)`, `return()`, `[Symbol.iterator]`. You can `yield*` a sub-`Anim` from inside another generator, and each `Anim` has its own `timeScale`. Nesting an `Anim` is scoping time:

```ts
const slowmo = new Anim();
slowmo.timeScale.value = 0.25;
slowmo.run(orbit(centre, planets));

yield* slowmo;   // outer 1×, planets 0.25×
```

Pause, reverse playback, scrubbable timelines — same move, different `timeScale`.

<md-multitrack></md-multitrack>

<md-timeline-editor></md-timeline-editor>

<span class="dinkus">\*\*\*</span>

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

Generators can suspend on signals too. `untilChange`, `untilTrue`, `untilFalse` are short wrappers around `effect` — animations wait on reactive state without polling:

```ts
yield* untilChange(stopFlag);
yield* fadeOut(s, 0.4);
```

<md-circuit></md-circuit>

<md-rand></md-rand>

The clock and `timeScale` are themselves signals, so the same `.to` works on them:

```ts
yield* anim.timeScale.to(0, 0.5, easeOut);   // ease into pause
slider.oninput = () => anim.timeScale.value = +slider.value;
```

<span class="dinkus">\*\*\*</span>

<md-orbits></md-orbits>

<md-handles></md-handles>

<md-canvas-field></md-canvas-field>

<md-waapi-demo></md-waapi-demo>

<md-tex-demo></md-tex-demo>

<md-tex-correspond></md-tex-correspond>

<md-tex-matrix></md-tex-matrix>

<md-tex-live></md-tex-live>

<md-layout-demo></md-layout-demo>

<md-centering></md-centering>

<md-trace-demo></md-trace-demo>

<md-claim-demo></md-claim-demo>

<md-runtime-tests></md-runtime-tests>
