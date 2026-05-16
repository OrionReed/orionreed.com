Looking at your runtime — sync generators only, yield contract of `number | undefined | Animator | Yieldable[] | SuspendFn`, push-driven `step(dt)` — here are angles from the iterator/generator universe you don't seem to have explored.

## 1. Yield `Promise` (co/redux-saga style)

Tiny addition, big leverage. Today async work goes through `SuspendFn`:

```ts
yield (wake) => { fetch(url).then(json => wake(json)); return () => {}; }
```

If you allow `Promise<T>` in `Yieldable`, this collapses to:

```ts
const data = yield fetch(url).then((r) => r.json());
```

Implementation is ~5 lines in `adv()`: detect thenable, call `.then(v => wake(v), e => gen.throw(e))`, park. It composes for free with arrays (`Promise.all`-style parallel) and with the cancel pipeline (your existing `cleanup` handles "ignore late resolution").

## 2. Pull-based driver via `AsyncIterator<dt>`

Right now ticking is external: someone calls `step(dt)`. Flip it. The engine consumes a frame source:

```ts
async function drive(anim: Anim, frames: AsyncIterable<number>) {
  for await (const dt of frames) anim.step(dt);
}
```

The win is that `frames` becomes a swappable interface:

- `rafFrames()` — wraps `requestAnimationFrame`
- `fixedDtFrames(1/60)` — deterministic for tests
- `replayFrames([0.016, 0.016, 0.5, 0.016])` — bug repro from a recorded trace
- `scrollFrames(el)` — scroll-driven animation
- `mergeFrames(rafFrames(), userInput())` — irregular event-driven

You already have `onFrame`; an async iterable is just the dual. It also makes "pause" trivial: don't pull. Closes off a class of `Anim.stop()` / time-zeroing edge cases.

## 3. ES2025 Iterator Helpers as a public surface

`.map / .take / .drop / .filter / .flatMap` on iterators landed in V8 / Safari recently. If you expose an animation's _frame values_ (not effects) as an iterator, you get a free combinator algebra:

```ts
const fade = frames(1.0).map(easeOutCubic).take(60);
const blink = frames(2.0).filter((t) => Math.sin(t * 10) > 0);
```

This is a different shape from your current "yields are control tokens, mutation happens in closures" — it's "the generator _is_ the value stream, the engine just clocks it." Worth experimenting in `_anim_proto/` as `v4_pull.ts`. The two models can coexist: pull-based for pure tweens, push-based for orchestration.

## 4. `gen.throw(reason)` for interruptible cancellation

You only have `cleanup` + `gen.return()` for cancel — no reason channel. `gen.throw(new CancelledError("user-pressed-escape"))` lets animations distinguish "completed normally" / "cancelled" / "preempted by newer anim". The user's `try/finally` blocks can branch on the reason. Cheap to add: pass `(reason?)` through `cx()` and call `.throw()` instead of `.return()` when reason is present.

## 5. `using` + `Symbol.dispose` (Stage 3, shipping)

Your `run()` returns a disposer. Make `Active` (or the handle) implement `Symbol.dispose`:

```ts
{
  using a = anim.run(myAnim());
  await something();
} // auto-cancelled at scope exit
```

This is the modern idiom for the exact pattern you have. Drop-in.

## 6. `yield*` to arbitrary `Iterable<Yieldable>`

Your `Yieldable` array case spawns in _parallel_. Sequential composition is a separate trick (nested generators). If you accept `Iterable<Yieldable>` as a sequential primitive — basically what `yield*` already does for generators — users can build sequence DSLs from arrays/lazy iterables without writing `function*` boilerplate:

```ts
yield * sequential([wait(0.5), spawn(fade), wait(0.2), spawn(slide)]);
// where sequential is a user-land helper that's just function*(xs) { for (const x of xs) yield x; }
```

## 7. Frame materialization for scrubbing / replay

Generators aren't replayable, but if a "leaf" tween is shaped as `Iterator<{t, value}>`, you can `Array.from()` it once and now you have a scrubbable timeline keyed by t. Combine with iterator helpers to splice / reverse / loop. This is how you'd build a proper timeline editor on top of the runtime without rewriting it.

## 8. Yield numeric-as-deadline vs duration

A subtle riff: today `yield 0.5` means "sleep 0.5s". Some libs let you yield an _absolute_ clock value (`yield { until: anim.clock + 0.5 }` or a sentinel). Lets you express "wake when global timeline hits 3.0" without recomputing offsets across nested compositions. Not strictly needed but pairs well with scrubbing.

---

Of these, **#1 (yield Promise)** and **#2 (AsyncIterator frame source)** are the highest-leverage and lowest-cost; both feel like natural extensions rather than rewrites. **#3 (iterator helpers)** is the most structurally novel — worth a `v4_pull.ts` prototype to see if the pull-based shape feels better for tween-heavy code while the existing push-based shape stays as the orchestration layer.

Want me to sketch any of these as a prototype (still in ask mode — happy to outline the diff)?
