// Signal-free combinators over `Anim`. Concurrency rules are expressed
// per-kid via `cut(v)` — no engine-side strategy abstraction.

import {
  cut,
  scaled,
  type Animator,
  type Cut,
  type Suspend,
  type Yieldable,
  type Resume,
} from "./anim";

/** Park each frame until `cb` returns `false`. */
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

/** Park until `wake(value)`; resume with the typed value. */
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

/** Wait for a promise; resume with its value (rejection → `gen.throw`). */
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

/** Wrap a Yieldable so it cuts its enclosing group with its result. */
export function* commit<T>(k: Yieldable): Animator<Cut<T>> {
  return cut((yield k) as T);
}

/** Run children in parallel; resume with a typed tuple of return values. */
export function* all<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<{ [K in keyof Cs]: Resume<Cs[K]> }> {
  return (yield children) as { [K in keyof Cs]: Resume<Cs[K]> };
}

/** First-completion race; resume with the winner's payload. */
export function* race<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<Resume<Cs[number]>> {
  return (yield children.map((c) => commit(c))) as Resume<Cs[number]>;
}

/** First N completions win; resume with their values in completion order. */
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

/** First kid whose value matches `pred` cuts the group with it;
 *  otherwise settles with the full results array. */
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

/** First kid to resolve wins; all-throw → `AggregateError` (~ `Promise.any`). */
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

/** Pick one child uniformly at random and run it; others never advance. */
export function* rand(...children: Animator[]): Animator {
  if (children.length === 0) return;
  const i = Math.floor(Math.random() * children.length);
  yield* children[i];
}

/** Spawn `gen` with `scaleFn` as its time-scale; descendants inherit. */
export function* withScale<R>(scaleFn: () => number, gen: Animator<R>): Animator<R> {
  return (yield scaled(scaleFn, gen)) as R;
}

/** RAF adapter; caps dt at 32 ms so tab-backgrounding doesn't deliver
 *  one giant frame. Returns a disposer. */
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
