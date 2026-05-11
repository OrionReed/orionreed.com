// Generator composers — sequence/parallel/sugar over `Animator`s. For
// first-completion (`race`) and cancel-on-trigger (`endOn`), see
// `core/suspensions.ts`.

import type { Animator, Yieldable } from "./anim";
import { suspend, asGen, isGen, type SpawnFn } from "./anim";
import type { Signal } from "./signal";
import { snapshot } from "./store";

// ── Tuple-typed parallel ────────────────────────────────────────────

/** Payload type of a `Yieldable`. Generators carry it in their `R`;
 *  everything else (numbers, arrays, raw suspend-fns, `undefined`)
 *  is `void`. */
type PayloadOf<Y> = Y extends Generator<any, infer R, any> ? R : void;

/** Run children in parallel; complete when all finish; resume with a
 *  typed tuple of their return values:
 *
 *      const [a, b] = yield* all(workA(), workB());
 *
 *  Each tuple slot is the corresponding child's `R`. Children that
 *  don't carry a payload (numbers, raw suspend-fns) contribute
 *  `void`. For the resume-with-`0` array form, use the bare
 *  `yield [a, b]`. */
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

// ── Sequential / sugar ──────────────────────────────────────────────

export function* sequence(...children: Animator[]): Animator {
  for (const c of children) yield* c;
}

/** Pause `sec` seconds, then run `c`. */
export function* delay(sec: number, c: Animator): Animator {
  if (sec > 0) yield sec;
  yield* c;
}

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
 *  `Anim.loop` for a fresh roll each iteration. */
export function* rand(...children: Animator[]): Animator {
  if (children.length === 0) return;
  const i = Math.floor(Math.random() * children.length);
  yield* children[i];
}
