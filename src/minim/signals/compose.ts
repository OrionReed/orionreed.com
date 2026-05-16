// Distinct-shape factories that don't fit `play(...)`.
//
// `loop(factory)` repeats forever — the factory contract is required
// because Yieldables are single-shot (a generator passed to `play(g)`
// is exhausted after one run).
//
// `every(sec, fn)` is `play(suspend(...))` over `anim.onFrame` with a
// drift-correcting accumulator — fires `fn` whenever `acc >= sec`.
// One closure per frame, no per-iteration generator overhead.
//
// Everything else from the old vocabulary — `sleep` / `parallel` /
// `sequence` / `after` — collapsed into `play(...)`:
//
//   sleep(n)              → play(n)
//   parallel(a, b)        → play([a, b])
//   sequence(a, b, c)     → play(a, b, c)
//   after(cond, work)     → play(cond).then(work)

import { suspend, type Animator } from "../core/anim";
import { asReader, type Val } from "./arg";
import { play, type Play } from "./tween";

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
 *  per cycle, use `loop(() => play(sec).then(work()))`. Drift-corrects
 *  via accumulator: missed firings are caught up the next frame. */
export function every(sec: Val<number>, fn: () => void): Play {
  const getSec = typeof sec === "number" ? () => sec : asReader(sec);
  return play(
    suspend<void>((_wake, _spawn, anim) => {
      let acc = 0;
      return anim.onFrame((dt) => {
        acc += dt;
        const period = getSec();
        if (period <= 0) return;
        while (acc >= period) { fn(); acc -= period; }
      });
    }),
  );
}
