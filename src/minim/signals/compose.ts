// Distinct-shape factories that don't fit `play(...)`.
//
// `loop(factory)` repeats forever — the factory contract is required
// because Yieldables are single-shot (a generator passed to `play(g)`
// is exhausted after one run).
//
// `every(sec, fn)` parks each frame, accumulates `dt` from the resume
// value, and fires `fn` whenever the accumulator crosses `sec`. Drift-
// corrects: missed firings are caught up the next frame.
//
// Everything else from the old vocabulary — `sleep` / `parallel` /
// `sequence` / `after` — collapsed into `play(...)`:
//
//   sleep(n)              → play(n)
//   parallel(a, b)        → play([a, b])
//   sequence(a, b, c)     → play(a, b, c)
//   after(cond, work)     → play(cond).then(work)

import { type Animator } from "../core/anim";
import { asReader, type Val } from "./arg";
import { play, type Play } from "./tween";

/** Repeat `factory()` forever — fresh generator each iteration. Pass
 *  to `anim.start(loop(...))` at top level, or compose with `.until`,
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
  const getSec = typeof sec === "number" ? () => sec : asReader(sec);
  return play((function* (): Animator {
    let acc = 0;
    while (true) {
      const dt = yield;
      acc += dt;
      const period = getSec();
      if (period <= 0) continue;
      while (acc >= period) { fn(); acc -= period; }
    }
  })());
}
