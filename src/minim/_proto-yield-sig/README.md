# `_proto-yield-sig` — yield-the-signal prototype

Working prototype of "signals are first-class Yieldables." Demonstrates
the design discussed in the chat: `Signal` gets a `[Symbol.iterator]`
method whose iterator yields a Suspend-shaped function, the engine
already handles function-yields via its existing path, the bridge layer
loses its signal-special-case in `playableGen`, and `untilChange` /
`untilEvent` / `untilPromise` collapse to `yield* sig`.

**25 tests pass** covering change-wait, event semantics via `pulse()`,
race / all / play composition, immediate-truthy via `when()`, falsy-wait
composition, reactive predicates, cleanup, and a realistic mini-scene.

```
npx vitest run src/minim/_proto-yield-sig/
```

## Files

```
engine.ts          ~270 lines — minimal Anim runtime (vendored from core)
                                + isIterableYieldable + Yieldable union
                                  widened to include arbitrary iterables.
signal.ts          ~190 lines — hand-rolled Signal/computed/effect
                                with `[Symbol.iterator]` for change-wait.
helpers.ts         ~140 lines — playableGen simplified; raceFirst, all,
                                play, when, not + naming aliases.
yield-sig.test.ts  ~640 lines — comprehensive coverage.
```

## What this proves works

1. **`yield* sig` is change-wait.** Resumes with the new value when the
   signal next propagates non-equally. Equality is delegated to the
   signal's own `equals`, so primitive `signal()` deduplicates by
   `Object.is` while `pulse()` (always-non-equal) fires every write.

2. **`pulse()` for events.** A signal with `equals: () => false` is
   the natural shape for events-as-signals — every emit is one wake.
   DOM events, bus channels, promise resolutions all lift through it.

3. **Composition is uniform.** `raceFirst(timeout, sig)`, `yield [a, sig, sleep]`,
   `play(...).until(sig)` all work with no special branches in the
   engine or helpers — signals match the iterable-Yieldable case.

4. **`playableGen` collapses.** No `instanceof Signal` branch; everything
   that's `Iterable<Yieldable>` flows through one path:

   ```ts
   function* playableGen(p: Yieldable): Animator<unknown> {
     if (p === undefined || p === null) return undefined;
     if (typeof p === "object" && Symbol.iterator in (p as object)) {
       return yield* p as Animator<unknown>;
     }
     yield p as Yieldable;
     return undefined;
   }
   ```

5. **`when(sig)` keeps its semantic** — truthy-wait with immediate fire
   if already true. This is genuinely different from `yield* sig` (which
   doesn't immediate-fire). Both are useful; both stay.

6. **Reactive predicates.** `yield* when(computed(() => p(sig.value)))`
   is the natural way to wait for arbitrary conditions. Compound
   conditions become one yield, no nested suspends.

## The implementation move, exactly

```ts
// signal.ts — added to Signal class
import { type Suspend } from "./engine";

(Signal.prototype as any)[Symbol.iterator] = function* <T>(
  this: Signal<T>,
): Generator<Suspend<T>, T, T> {
  return yield (wake) => {
    let primed = false;
    return effect(() => {
      const v = this.value;       // tracks
      if (!primed) {
        primed = true;
        return;
      }
      wake(v);
    });
  };
};

declare module "./signal" {
  interface Signal<T> {
    [Symbol.iterator](): Generator<Suspend<T>, T, T>;
  }
}
```

5 lines plus the type declaration. Signal imports `type Suspend` from
the engine — same boundary `signals/clock.ts` and `signals/values/*.ts`
already cross via `Tween`. No new protocol, no new symbol, no engine
changes (the engine already accepts function-shaped yields as Suspends).

The one engine widening that surfaced during testing: `Yieldable` and
`isIterableYieldable` need to recognise iterable objects so that
**directly-yielded signals** (not via `yield*`) compose inside concurrent
arrays. Three lines:

```ts
export const isIterableYieldable = (v: unknown): boolean =>
  v !== null &&
  typeof v === "object" &&
  Symbol.iterator in (v as object) &&
  typeof (v as any)[Symbol.iterator] === "function";

// In advance():
if (isIterableYieldable(v)) {
  return this.awaitChild(a, (v as any)[Symbol.iterator]());
}
```

Without this, `yield [timeout, sig]` would throw because the engine's
array-concurrent branch wraps each non-generator into `asGen(k)` which
yields `k` directly — so the signal makes a round trip back through
`advance` and would die on "unsupported yield." Now it's recognised.

## Naming question — `when` + `not` vs `when` + `whenNot` vs `truthy` + `falsy`

The prototype exports all three for direct comparison:

| Pair                | Truthy-wait    | Falsy-wait                        |
| ------------------- | -------------- | --------------------------------- |
| `when` + `not`      | `when(sig)`    | `when(not(sig))` (composition)    |
| `when` + `whenNot`  | `when(sig)`    | `whenNot(sig)`                    |
| `truthy` + `falsy`  | `truthy(sig)`  | `falsy(sig)`                      |

All three pairs pass the same tests. Differences:

- **`when` + `not`** (current minim shape): one verb (`when`), one
  derived-signal helper (`not`). Composes naturally; `when(not(sig))`
  reads as "when sig is not truthy." The two helpers do different
  things — `when` is a verb returning an Animator, `not` is a
  derived-signal builder returning `Signal<boolean>`. Asymmetric but
  honest about what each does. **`not(sig)` is independently useful**
  for binding (`label.bind(not(visible))`) so it's worth keeping.

- **`when` + `whenNot`** (symmetric verb pair): both are Animators.
  Loses the ability to use `not(sig)` as a derived value elsewhere —
  you'd need a separate `not()` helper anyway. Adds a redundant export.

- **`truthy` + `falsy`** (adjective pair): two Animators. Reads less
  like a directive (`yield* truthy(sig)` is "yield falsy of sig" which
  is awkward phrasing). But: short, symmetric, and obvious what they do.

**Recommendation: keep `when` + `not`.** The redundancy of adding `whenNot`
isn't worth it because `when(not(sig))` is one-line, and `not(sig)` already
needs to exist as a derived-signal helper for non-gen contexts. The
composition is the feature, not a workaround.

If the asymmetry bothers you, alias both `truthy = when` and provide
`falsy = (sig) => when(not(sig))` as sugar — cheap, doesn't clutter the
core. The prototype shows this works (lines 168–179 of `helpers.ts`).

## Things that surfaced during prototyping

1. **`Yieldable` union must include `Iterable<Yieldable>`** for `yield sig`
   (not `yield* sig`) and `yield [timeout, sig]` to typecheck cleanly.
   This is a one-line type widening.

2. **`isIterableYieldable` branch in the engine's `advance` and
   `concurrent`** — required for signals yielded inline in concurrent
   arrays. Otherwise the engine throws on the wrapped yield.

3. **Primitive-Yieldable wrappers should drop the resume value.**
   `function* () { yield 0.05; return undefined; }` not `return yield 0.05`,
   because the engine resumes a sleep with a `Tick` object, and that Tick
   shouldn't bubble up as a "winner value" of `raceFirst(0.05, sig)`. Fixed
   in `toAnimator` for primitives; preserves resume value for generators
   and iterables.

4. **Non-reactive stop flags don't preempt parked `yield* sig`.**
   `while (!stopJsVar) { yield* click; ... }` will count one extra click
   after `stopJsVar = true` because the gen is currently parked; the click
   wakes it and the increment runs before the loop checks the flag. The
   right pattern is reactive: `raceFirst(click, when(stop))` with `stop`
   as a signal. Worth documenting.

5. **`equals` decides change-wait granularity.** Default `Object.is`
   means `signal({x: 1, y: 2}); sig.value = {x: 1, y: 2}` triggers a
   wake (different object refs). Users wanting structural equality opt
   into it via `signal(initial, { equals: deepEq })`. This is the same
   story as today — no change needed, just worth being aware of.

## What the prototype skipped

- The full alien-signals algorithm (used a simpler hand-rolled push-
  propagation that's easier to read). Behaviorally equivalent for the
  surface tested.
- `withNack` (cleanup-on-loss-of-race). Identified in the broader
  research as a real missing primitive but orthogonal to yield-the-signal.
  Worth a separate prototype.
- Stream operators (`debounce`, `throttle`, `take`). Trivial once
  signals are first-class but not the headline feature.

## Net diff vs current minim if shipped

**Additions**

- `[Symbol.iterator]` method on `Signal` (5 lines + type decl)
- `pulse()` factory next to `signal()` (2 lines)
- `isIterableYieldable` helper in `core/anim.ts` (5 lines)
- Two engine branches (~6 lines total) in `advance()` and `concurrent()`
- Optional: `truthy` / `falsy` aliases (2 lines)

**Deletions**

- `untilChange` (15 lines in `signals/anim.ts`) — `yield* sig` replaces
- `untilEvent` and `untilPromise` if they exist (similar size each)
- `instanceof Signal` branch in `playableGen` (~5 lines)
- `PlayTrigger = Yieldable | Read<unknown>` collapses to `Yieldable`

**Net**: probably +20 / −40 lines, plus the conceptual surface change
(one fewer abstraction in the user's head, one more uniform composition story).
