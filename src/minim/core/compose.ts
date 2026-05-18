// Signal-free generator combinators on top of `Anim`.
//
//   Yieldable constructors:  drive, suspend, untilEvent, untilPromise
//   Concurrency (over cut):  all, race, firstN, firstMatching,
//                            anySuccess, allSettled, commit, rand
//   Time-scale:              withScale (engine-native, propagates)
//   RAF adapter:             attachRaf
//
// Every concurrency combinator is a generator that wraps each kid in
// a function that decides what its completion means for the group
// (via `cut(v)`). No `spawnYieldable`, no SuspendFn boilerplate, no
// engine-side strategy abstraction.
//
// `mapDt` is gone: the control-up/time-down principle it illustrated
// (a generator forwarding scaled dt to a child) is shown inline in
// the post. `withScale` is the engine-native version that propagates
// through orchestration boundaries.

import {
  cut,
  scaled,
  type Animator,
  type Cut,
  type Suspend,
  type Yieldable,
  type Resume,
} from "./anim";

// ════════════════════════════════════════════════════════════════════
// Yieldable constructors
// ════════════════════════════════════════════════════════════════════

/** `yield* drive(cb)` parks each frame until `cb` returns `false`.
 *  Plain generator — composes with `withScale`, `race`, etc. through
 *  the standard yield seam. */
export function* drive(
  cb: (dt: number, t: number) => boolean | void,
): Animator<void> {
  let t = 0;
  while (true) {
    const dt = yield;
    t += dt;
    if (cb(dt, t) === false) return;
  }
}

/** `yield* suspend(impl)` parks until `wake(value)`; resumes with the
 *  typed `value`. Pure type-narrowing sugar over `(yield impl) as T`. */
export function* suspend<T = void>(impl: Suspend<T>): Animator<T> {
  return (yield impl) as T;
}

/** Wait for a DOM event on `target`; resume with the event. */
export function untilEvent<E extends Event = Event>(
  target: EventTarget,
  name: string,
  opts?: AddEventListenerOptions,
): Animator<E> {
  return suspend<E>((wake) => {
    const handler = (e: Event): void => wake(e as E);
    target.addEventListener(name, handler, opts);
    return () => target.removeEventListener(name, handler, opts);
  });
}

/** Wait for a promise; resume with its resolved value (rejection
 *  propagates via `gen.throw`). The engine does not recognize raw
 *  thenables — this is the user-space bridge. */
export function untilPromise<T>(p: PromiseLike<T>): Animator<T> {
  return suspend<T>((wake) => {
    let cancelled = false;
    p.then(
      (v) => { if (!cancelled) wake(v); },
      (e) => { if (!cancelled) wake.throw(e); },
    );
    return () => { cancelled = true; };
  });
}

// ════════════════════════════════════════════════════════════════════
// Concurrency combinators — all express settlement rules via `cut`.
// ════════════════════════════════════════════════════════════════════

/** Wrap a Yieldable so it cuts its enclosing group with its own result.
 *  `yield k` directly dispatches on `k`'s shape (gen → child + return,
 *  number → sleep + dt, etc.) — this is the engine seam. */
export function* commit<T>(k: Yieldable): Animator<Cut<T>> {
  return cut((yield k) as T);
}

/** Run children in parallel; resume with a typed tuple of return values
 *  when all complete. Pure pass-through over the engine primitive. */
export function* all<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<{ [K in keyof Cs]: Resume<Cs[K]> }> {
  return (yield children) as { [K in keyof Cs]: Resume<Cs[K]> };
}

/** First-completion race; resume with the winner's payload. Each kid
 *  is wrapped in `commit` so its completion cuts the group. */
export function* race<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<Resume<Cs[number]>> {
  return (yield children.map((c) => commit(c))) as Resume<Cs[number]>;
}

/** First N completions win; resume with the first N return values in
 *  completion order. Closure counter shared across kid wrappers. */
export function* firstN<R>(
  n: number,
  kids: readonly Yieldable[],
): Animator<R[]> {
  const collected: R[] = [];
  return (yield kids.map((k) =>
    (function* (): Animator<R | Cut<R[]>> {
      const v = (yield k) as R;
      collected.push(v);
      return collected.length >= n ? cut(collected) : v;
    })(),
  )) as unknown as R[];
}

/** First kid whose value matches `pred` cuts the group with that value.
 *  Non-matching kids contribute their value; if no kid matches, the
 *  group settles with the full results array. */
export function* firstMatching<R>(
  pred: (v: R) => boolean,
  kids: readonly Yieldable[],
): Animator<R | R[]> {
  return (yield kids.map((k) =>
    (function* (): Animator<R | Cut<R>> {
      const v = (yield k) as R;
      return pred(v) ? cut(v) : v;
    })(),
  )) as unknown as R | R[];
}

/** First kid to fulfil (resolve, not throw) cuts the group. If every
 *  kid throws, settles with `AggregateError` (mirrors `Promise.any`). */
export function* anySuccess<R>(...kids: readonly Yieldable[]): Animator<R> {
  const errors: unknown[] = [];
  return (yield kids.map((k) =>
    (function* (): Animator<Cut<R> | undefined> {
      try {
        return cut((yield k) as R);
      } catch (e) {
        errors.push(e);
        if (errors.length === kids.length) {
          throw new AggregateError(errors, "anySuccess: all kids failed");
        }
        return undefined;
      }
    })(),
  )) as unknown as R;
}

/** Run every kid; collect results and errors. Never throws. */
export type Settled<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly error: unknown };

export function* allSettled<R>(
  ...kids: readonly Yieldable[]
): Animator<Settled<R>[]> {
  return (yield kids.map((k) =>
    (function* (): Animator<Settled<R>> {
      try {
        return { ok: true, value: (yield k) as R };
      } catch (e) {
        return { ok: false, error: e };
      }
    })(),
  )) as unknown as Settled<R>[];
}

/** Pick one of `children` uniformly at random and run it. Construction
 *  must be side-effect free — unselected generators are never advanced. */
export function* rand(...children: Animator[]): Animator {
  if (children.length === 0) return;
  const i = Math.floor(Math.random() * children.length);
  yield* children[i];
}

// ════════════════════════════════════════════════════════════════════
// Time-scale — one primitive. `mapDt` is gone; the control-up/time-down
// idiom (a generator forwarding scaled dt to a child) is illustrated
// inline in the post and doesn't need its own helper.
// ════════════════════════════════════════════════════════════════════

/** Spawn `gen` as a child active with `scaleFn` as its time-scale. All
 *  of gen's descendants inherit the scale through the parent chain, so
 *  `withScale(() => 0, race(a, b))` truly pauses both children. */
export function* withScale<R>(scaleFn: () => number, gen: Animator<R>): Animator<R> {
  return (yield scaled(scaleFn, gen)) as R;
}

// ════════════════════════════════════════════════════════════════════
// RAF adapter
// ════════════════════════════════════════════════════════════════════

/** Browser RAF adapter; caps single-frame dt at 32 ms so tab-
 *  backgrounding (where browsers throttle then resume with the
 *  accumulated delta) doesn't deliver one giant frame. Returns a
 *  disposer that cancels the RAF loop. */
export function attachRaf(anim: { step(dt: number): void }): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  const FRAME_CAP_MS = 32;
  let rafId = 0, last = 0;
  const tick = (now: number): void => {
    rafId = requestAnimationFrame(tick);
    const dt = last ? Math.min(now - last, FRAME_CAP_MS) / 1000 : 0;
    last = now;
    anim.step(dt);
  };
  rafId = requestAnimationFrame(tick);
  return () => { if (rafId) cancelAnimationFrame(rafId); rafId = 0; last = 0; };
}
