// Generator composers — sequence / parallel / loop / sleep / when /
// every — returning `Chained` so they compose fluently with
// `.until / .while / .for / .then / .at`. The fluent surface lives
// in `chain.ts`; this file is the factory layer.
//
//   loop(() => spring(w, rest).until(dragging))
//   sequence(fadeIn(a, 0.3), 0.5, fadeOut(a, 0.3))
//   parallel(lane0, lane1, lane2).until(hardStop)
//   sleep(0.5).then(work)
//   after(ready, work)
//   every(2, () => pulse(wire))
//
// `all(...)` keeps a typed-tuple return — the fluent surface loses
// per-child typing, so the raw form stays for callers that need it.

import {
  suspend,
  asGen,
  isGen,
  type Animator,
  type Yieldable,
  type SpawnFn,
} from "./anim";
import { type Signal, type ReadonlySignal } from "./signal";
import { snapshot } from "./store";
import { untilTrue } from "./suspensions";
import { chain, type Chained } from "./chain";

// ── Tuple-typed parallel (raw, not Chained) ─────────────────────────

/** Payload type of a `Yieldable`. Generators carry it in their `R`;
 *  everything else (numbers, arrays, raw suspend-fns, `undefined`)
 *  is `void`. */
type PayloadOf<Y> = Y extends Generator<any, infer R, any> ? R : void;

/** Run children in parallel; complete when all finish; resume with a
 *  typed tuple of their return values:
 *
 *      const [a, b] = yield* all(workA(), workB());
 *
 *  Each tuple slot is the corresponding child's `R`. For the fluent
 *  equivalent (no typed return), use `parallel(...)`. */
export function all<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<{ [K in keyof Cs]: PayloadOf<Cs[K]> }> {
  type R = { [K in keyof Cs]: PayloadOf<Cs[K]> };
  return suspend<R>((wake, spawn) => {
    if (children.length === 0) {
      wake([] as unknown as R);
      return () => {};
    }
    const results = new Array(children.length);
    let remaining = children.length;
    const disposers: (() => void)[] = [];
    const handle = (i: number) => (value: unknown) => {
      results[i] = value;
      if (--remaining === 0) wake(results as unknown as R);
    };
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (typeof c === "function" && !isGen(c)) {
        disposers.push(
          (c as (
            wake: (v: unknown) => void,
            spawn: SpawnFn,
          ) => () => void)(handle(i), spawn),
        );
      } else {
        disposers.push(spawn(asGen(c), handle(i)));
      }
    }
    return () => {
      for (const d of disposers) d();
    };
  });
}

// ── Chained factories ──────────────────────────────────────────────

/** Wait `n` seconds. Chainable: `sleep(0.5).then(work)`. */
export function sleep(n: number): Chained {
  return chain(
    (function* (): Animator {
      if (n > 0) yield n;
    })(),
  );
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
      for (const c of children) {
        if (c === undefined) continue;
        if (typeof c === "number") {
          if (c > 0) yield c;
        } else if (Array.isArray(c)) {
          yield c;
        } else if (typeof c === "function" && !isGen(c)) {
          yield c;
        } else {
          yield* c as Animator;
        }
      }
    })(),
  );
}

/** Repeat `factory()` forever — fresh generator each iteration.
 *  Replaces `Anim.loop()` as a value-returning factory: pass to
 *  `anim.run(loop(...))` at top level, or compose with `.until`,
 *  `.for`, etc. inside generators. */
export function loop(factory: () => Animator): Chained {
  return chain(
    (function* (): Animator {
      while (true) yield* factory();
    })(),
  );
}

/** Wait for `cond` to fire, then run `work`. Read: "after cond, work".
 *  Signal cond → wait for truthy; Animator cond → wait for completion.
 *  Replaces `startOn(trigger, work)` with English argument order. */
export function after(
  cond: ReadonlySignal<unknown> | Animator,
  work: Yieldable,
): Chained {
  return chain(
    (function* (): Animator {
      if (isGen(cond)) yield cond;
      else yield* untilTrue(cond);
      if (work === undefined) return;
      if (typeof work === "number") {
        if (work > 0) yield work;
        return;
      }
      if (Array.isArray(work)) {
        yield work;
        return;
      }
      if (typeof work === "function" && !isGen(work)) {
        yield work;
        return;
      }
      yield* work as Animator;
    })(),
  );
}

/** Run `fn` every `sec` seconds. `fn` may return a generator
 *  (awaited each cycle) or void (cycle is just sleep + fire). */
export function every(
  sec: number,
  fn: () => void | Animator,
): Chained {
  return chain(
    (function* (): Animator {
      while (true) {
        if (sec > 0) yield sec;
        const r = fn();
        if (r !== undefined && isGen(r)) yield* r;
      }
    })(),
  );
}

// ── Sequential utilities (kept raw — neither earns fluent surface) ─

/** Run `work`; on cancel, synchronously restore the snapshot. Natural
 *  completion discards it. For an animated unwind, write the exit as
 *  a sequel after `endOn(trigger, work)` instead. */
export function* transaction(
  work: Animator,
  ...sigs: Array<Signal<unknown> | Record<string, unknown>>
): Animator {
  const restore = snapshot(...sigs);
  let completed = false;
  try {
    yield* work;
    completed = true;
  } finally {
    if (!completed) restore();
  }
}

/** Pick one of `children` uniformly at random and run it. Construction
 *  must be side-effect free — unselected generators are never advanced
 *  (the convention for every factory in this stdlib). Combine with
 *  `loop(...)` for a fresh roll each iteration. */
export function* rand(...children: Animator[]): Animator {
  if (children.length === 0) return;
  const i = Math.floor(Math.random() * children.length);
  yield* children[i];
}
