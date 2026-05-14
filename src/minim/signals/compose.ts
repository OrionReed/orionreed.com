// Fluent generator factories. Each returns `Chained` so the result
// composes with `.until / .while / .for / .then / .at`:
//
//   loop(() => spring(w, rest).until(dragging))
//   sequence(fadeIn(a, 0.3), 0.5, fadeOut(a, 0.3))
//   parallel(lane0, lane1, lane2).until(hardStop)
//   sleep(0.5).then(work)
//   after(ready, work)
//   every(2, () => fire())
//
// Lives in `signals/` rather than `core/` because `Chained` itself is
// signal-coupled (`.until(sig) / .at(Val<number>)`). The signal-free
// typed-tuple `all(...)` and `rand(...)` live in `core/compose.ts`.

import { isGen, type Animator, type Yieldable } from "../core/anim";
import { type Val } from "./arg";
import { untilTrue } from "./suspensions";
import { chain, sleepGen, yieldableGen, type Chained } from "./tween";
import { type ReadonlyCell } from "./cell";

/** Wait `n` seconds. Chainable: `sleep(0.5).then(work)`. */
export function sleep(n: Val<number>): Chained {
  return chain(sleepGen(n));
}

/** Run children in parallel; complete when all finish. The fluent
 *  form of `yield [a, b, ...]` — composable with `.until`, `.for`,
 *  etc. For typed-tuple return values, use `all(...)` and `yield*`. */
export function parallel(...children: Yieldable[]): Chained {
  return chain(
    (function* (): Animator {
      yield children;
    })(),
  );
}

/** Run children in sequence. Numbers sleep; arrays run in parallel;
 *  generators run via `yield*`; bare suspend-fns are yielded directly. */
export function sequence(...children: Yieldable[]): Chained {
  return chain(
    (function* (): Animator {
      for (const c of children) yield* yieldableGen(c);
    })(),
  );
}

/** Repeat `factory()` forever — fresh generator each iteration. Pass
 *  to `anim.run(loop(...))` at top level, or compose with `.until`,
 *  `.for`, etc. inside generators. */
export function loop(factory: () => Animator): Chained {
  return chain(
    (function* (): Animator {
      while (true) yield* factory();
    })(),
  );
}

/** Wait for `cond` to fire, then run `work`. Read: "after cond, work".
 *  Cell cond → wait for truthy; Animator cond → wait for completion.
 *  Replaces `startOn(trigger, work)` with English argument order. */
export function after(
  cond: ReadonlyCell<unknown> | Animator,
  work: Yieldable,
): Chained {
  return chain(
    (function* (): Animator {
      if (isGen(cond)) yield cond;
      else yield* untilTrue(cond);
      yield* yieldableGen(work);
    })(),
  );
}

/** Run `fn` every `sec` seconds. Side-effect only — for awaited work
 *  per cycle, use `loop(() => sleep(sec).then(work()))`. */
export function every(sec: Val<number>, fn: () => void): Chained {
  return chain(
    (function* (): Animator {
      while (true) {
        yield* sleepGen(sec);
        fn();
      }
    })(),
  );
}
