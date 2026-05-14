// Signal-free generator combinators that don't fit the fluent `Play`
// surface — they keep typed-tuple returns or pick branches at random,
// neither of which `play(...)` expresses. The fluent factories
// (`play`, `loop`, `every`) live in `signals/` because `Play` itself
// is signal-coupled (`.until(sig) / .while(sig) / .at(Val<number>)`).
//
//   const [a, b] = yield* all(workA(), workB());   // typed-tuple return
//   yield* rand(branch0, branch1, branch2);        // pick one uniformly

import {
  suspend,
  asGen,
  isGen,
  type Animator,
  type Yieldable,
  type SpawnFn,
  type PayloadOf,
} from "./anim";

/** Run children in parallel; complete when all finish; resume with a
 *  typed tuple of their return values:
 *
 *      const [a, b] = yield* all(workA(), workB());
 *
 *  Each tuple slot is the corresponding child's `R`. For the fluent
 *  equivalent (no typed return), use `play([...])` from
 *  `@minim/signals`. */
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
          (c as (wake: (v: unknown) => void, spawn: SpawnFn) => () => void)(
            handle(i),
            spawn,
          ),
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

/** Pick one of `children` uniformly at random and run it. Construction
 *  must be side-effect free — unselected generators are never advanced
 *  (the convention for every factory in this stdlib). Combine with
 *  `loop(...)` for a fresh roll each iteration. */
export function* rand(...children: Animator[]): Animator {
  if (children.length === 0) return;
  const i = Math.floor(Math.random() * children.length);
  yield* children[i];
}
