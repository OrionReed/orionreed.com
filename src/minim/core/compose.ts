// Signal-free generator combinators that don't fit the fluent `Play`
// surface — they keep typed-tuple returns or pick branches at random,
// neither of which `play(...)` expresses. The fluent factories
// (`play`, `loop`, `every`) live in `signals/` because `Play` itself
// is signal-coupled (`.until(sig) / .while(sig) / .at(Val<number>)`).
//
//   const [a, b] = yield* all(workA(), workB());   // typed-tuple return
//   yield* rand(branch0, branch1, branch2);        // pick one uniformly

import {
  Anim,
  isGen,
  suspend,
  type Animator,
  type SpawnFn,
  type SuspendFn,
  type Yieldable,
  type PayloadOf,
} from "./anim";

// Local one-shot wrap. Engine has its own internal version for
// spawnKids; the duplication is one line each, which is less
// coupling than re-exporting an internal.
function* once(y: Yieldable): Animator<any> { yield y; }

/** Subscribe a Yieldable from inside a SuspendFn body — bare SuspendFns
 *  subscribe directly (sharing the parent's `spawn` so nested combinators
 *  don't re-wrap), other shapes go through `spawn(once(y))`. Returns the
 *  disposer. Used by `all`, `race`, and similar combinators. */
export function spawnYieldable(
  y: Yieldable,
  spawn: SpawnFn,
  anim: Anim,
  onDone: (v: any) => void,
): () => void {
  if (typeof y === "function" && !isGen(y)) {
    return (y as SuspendFn<any> as (
      w: (v: any) => void, s: SpawnFn, a: Anim,
    ) => () => void)(onDone, spawn, anim);
  }
  return spawn(once(y), onDone);
}

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
  return suspend<R>((wake, spawn, anim) => {
    if (children.length === 0) {
      wake([] as unknown as R);
      return () => {};
    }
    const results = new Array(children.length);
    let remaining = children.length;
    const disposers: (() => void)[] = [];
    for (let i = 0; i < children.length; i++) {
      const idx = i;
      disposers.push(spawnYieldable(children[i], spawn, anim, (v) => {
        results[idx] = v;
        if (--remaining === 0) wake(results as unknown as R);
      }));
    }
    return () => { for (const d of disposers) d(); };
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
