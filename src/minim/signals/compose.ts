// Distinct-shape factories that don't fit `play(...)`.
//
// `loop(factory)` repeats forever — the factory contract is required
// because Yieldables are single-shot (a generator passed to `play(g)`
// is exhausted after one run).
//
// `every(sec, fn)` is sugar for `loop(() => play(sec).then(asGen(fn)))`
// — kept because every-N-seconds is a very common pattern and the
// inline form is noisier than the named call earns back.
//
// Everything else from the old vocabulary — `sleep` / `parallel` /
// `sequence` / `after` — collapsed into `play(...)`:
//
//   sleep(n)              → play(n)
//   parallel(a, b)        → play([a, b])
//   sequence(a, b, c)     → play(a, b, c)
//   after(cond, work)     → play(cond).then(work)

import { type Animator } from "../core/anim";
import { type Val } from "./arg";
import { play, sleepGen, type Play } from "./tween";

/** Repeat `factory()` forever — fresh generator each iteration. Pass
 *  to `anim.run(loop(...))` at top level, or compose with `.until`,
 *  etc. inside generators. */
export function loop(factory: () => Animator): Play {
  return play(
    (function* (): Animator {
      while (true) yield* factory();
    })(),
  );
}

/** Run `fn` every `sec` seconds. Side-effect only — for awaited work
 *  per cycle, use `loop(() => play(sec).then(work()))`. */
export function every(sec: Val<number>, fn: () => void): Play {
  return play(
    (function* (): Animator {
      while (true) {
        yield* sleepGen(sec);
        fn();
      }
    })(),
  );
}
