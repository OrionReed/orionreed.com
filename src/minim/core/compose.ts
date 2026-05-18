// Signal-free generator combinators on top of `Anim`.
//
//   Yieldable constructors:  drive, suspend
//   Concurrency:             all, race, rand
//   Wrappers:                mapDt, withScale
//   Bridges:                 untilEvent, untilPromise
//   RAF adapter:             attachRaf
//
// Notable absences: timeout/cancel wrappers (`withTimeout`, `unless`).
// They were 1-2 line compositions over `race` + a numeric sleep and
// metastasized into API sprawl. Inline the composition: `race(work, 5)`
// for a 5-second cap, `race(work, when(stop))` for a signal-bound cancel.

import {
  Anim,
  asGen,
  isGen,
  type Animator,
  type SpawnFn,
  type Suspend,
  type Yieldable,
  type Resume,
} from "./anim";

// ════════════════════════════════════════════════════════════════════
// Yieldable constructors
// ════════════════════════════════════════════════════════════════════

/** `yield* drive(cb)` parks each frame until `cb` returns `false`.
 *  Plain generator — composes with `mapDt`, `race`, etc. through the
 *  standard yield seam. */
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
// Concurrency combinators
// ════════════════════════════════════════════════════════════════════

/** Internal: subscribe a Yieldable from inside a Suspend body. Bare
 *  Suspend impls subscribe directly (sharing the parent's `spawn` so
 *  nested combinators don't re-wrap); generators pass through to
 *  preserve their return value; other shapes wrap via `asGen`. */
function spawnYieldable(
  y: Yieldable,
  spawn: SpawnFn,
  anim: Anim,
  onDone: (v: any) => void,
): () => void {
  if (isGen(y)) return spawn(y, onDone);
  if (typeof y === "function") {
    return (y as Suspend<any> as (
      w: (v: any) => void, s: SpawnFn, a: Anim,
    ) => () => void)(onDone, spawn, anim);
  }
  return spawn(asGen(y), onDone);
}

/** Run children in parallel; resume with a typed tuple of return values
 *  when all complete. Errors propagate from the first kid that throws. */
export function all<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<{ [K in keyof Cs]: Resume<Cs[K]> }> {
  type R = { [K in keyof Cs]: Resume<Cs[K]> };
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

/** First-completion race; resume with the winner's payload. Losers are
 *  cancelled. */
export function race<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<Resume<Cs[number]>> {
  type R = Resume<Cs[number]>;
  return suspend<R>((wake, spawn, anim) => {
    let won = false;
    const disposers: (() => void)[] = [];
    const safeWake = (v: any): void => {
      if (won) return;
      won = true;
      for (const d of disposers) try { d(); } catch {}
      wake(v as R);
    };
    for (const c of children) {
      disposers.push(spawnYieldable(c, spawn, anim, safeWake));
    }
    return () => {
      if (won) return;
      won = true;
      for (const d of disposers) try { d(); } catch {}
    };
  });
}

/** Pick one of `children` uniformly at random and run it. Construction
 *  must be side-effect free — unselected generators are never advanced. */
export function* rand(...children: Animator[]): Animator {
  if (children.length === 0) return;
  const i = Math.floor(Math.random() * children.length);
  yield* children[i];
}

// ════════════════════════════════════════════════════════════════════
// Wrappers — drive other gens via the standard yield seam
//
// `mapDt` is a generator-local wrapper: scale flows through the single
// gen's yields but does NOT propagate to children spawned by race/all
// inside it. For multi-active propagation use `withScale`.
//
// `withScale` is the engine-native time-scale primitive: it installs
// the scale on a child Active so the scale propagates through every
// orchestration boundary via the parent pointer.
// ════════════════════════════════════════════════════════════════════

/** Transform `dt` flowing through an inner gen.
 *
 *  Two cases:
 *    • Numeric yields (sleeps) expand into a per-frame accumulator that
 *      adds `fn(dt)` each tick until the original N is reached.
 *      Reactive `fn` (e.g. paused → 0) stalls the timer mid-flight.
 *    • Resume values (per-frame `dt` to the gen) pass through `fn` so
 *      frame-yielding generators see the scaled `dt`.
 *
 *  Generator-local — does NOT propagate to spawned children. Use
 *  `withScale` for scope-propagating scaling. */
export function* mapDt<R>(fn: (dt: number) => number, gen: Animator<R>): Animator<R> {
  let resume: number = 0;
  try {
    while (true) {
      const r = gen.next(resume);
      if (r.done) return r.value;
      const v = r.value;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        let acc = 0;
        while (acc < v) acc += fn(yield);
        resume = 0;
      } else {
        const back = (yield v) as unknown;
        resume = typeof back === "number" ? fn(back) : (back as number);
      }
    }
  } finally { gen.return(undefined as never); }
}

/** Spawn `gen` as a child Active with `scaleFn` as its time-scale.
 *
 *  Every descendant inherits the scale via the parent chain, so
 *  `withScale(() => 0, race(a, b))` truly pauses both children. This
 *  is the engine-native alternative to wrapping with `mapDt` — no
 *  per-frame accumulator, propagates through orchestration boundaries,
 *  and `scaleFn() === 0` skips the subtree entirely (gen.next is never
 *  called → frame counters freeze, drive callbacks don't fire). */
export function* withScale<R>(scaleFn: () => number, gen: Animator<R>): Animator<R> {
  return yield* suspend<R>((_wake, spawn) => {
    return spawn(gen, (v) => _wake(v as R), scaleFn);
  });
}

// ════════════════════════════════════════════════════════════════════
// RAF adapter
// ════════════════════════════════════════════════════════════════════

/** Browser RAF adapter; caps single-frame dt at 32 ms so tab-
 *  backgrounding (where browsers throttle then resume with the
 *  accumulated delta) doesn't deliver one giant frame. Returns a
 *  disposer that cancels the RAF loop. */
export function attachRaf(anim: Anim): () => void {
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
