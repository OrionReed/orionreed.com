// Signal-free generator combinators on top of `Anim`.
//
// Three categories:
//
//   Yieldable constructors:  drive, suspend
//   Concurrency:             all, race, rand
//   Wrappers:                mapDt, withTimeout
//
// Plus the RAF adapter — `attachRaf(anim)` wires `anim.step(dt)` to
// `requestAnimationFrame`. None of these touch signals.

import {
  Anim,
  asGen,
  isGen,
  type Animator,
  type SpawnFn,
  type SuspendFn,
  type Yieldable,
  type PayloadOf,
} from "./anim";

// ════════════════════════════════════════════════════════════════════
// Yieldable constructors
// ════════════════════════════════════════════════════════════════════

/** `yield* drive(cb)` parks each frame until `cb` returns `false`.
 *  Plain generator — composes with `mapDt`, `withTimeout`, etc.
 *  through the standard yield seam. */
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
export function* suspend<T = void>(impl: SuspendFn<T>): Animator<T> {
  return (yield impl) as T;
}

// ════════════════════════════════════════════════════════════════════
// Concurrency combinators
// ════════════════════════════════════════════════════════════════════

/** Internal: subscribe a Yieldable from inside a SuspendFn body. Bare
 *  SuspendFns subscribe directly (sharing the parent's `spawn` so
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
    return (y as SuspendFn<any> as (
      w: (v: any) => void, s: SpawnFn, a: Anim,
    ) => () => void)(onDone, spawn, anim);
  }
  return spawn(asGen(y), onDone);
}

/** Run children in parallel; resume with a typed tuple of return values
 *  when all complete. Errors propagate from the first kid that throws. */
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

/** First-completion race; resume with the winner's payload. Losers are
 *  cancelled. */
export function race<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<PayloadOf<Cs[number]>> {
  type R = PayloadOf<Cs[number]>;
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
// Wrappers MUST `try/finally { gen.return() }`. JS doesn't propagate
// `.return()` across independently-driven gens — only across `yield*`
// delegation. Our wrappers iterate manually, so we own the cleanup.
// ════════════════════════════════════════════════════════════════════

/** Transform `dt` before the inner gen sees it: slow-mo, fast-forward,
 *  reactive time-scale. `fn` is called with whatever the runtime hands
 *  us; what `fn` returns is what the inner gen receives. */
export function* mapDt<R>(fn: (resume: any) => any, gen: Animator<R>): Animator<R> {
  let arg: any = undefined;
  try {
    while (true) {
      const r = gen.next(arg);
      if (r.done) return r.value;
      arg = fn(yield r.value);
    }
  } finally { gen.return(undefined as any); }
}

/** Hard-cap by engine time. `gen` and a sibling `seconds` sleep race;
 *  on timeout the inner is cancelled and the parent resumes with
 *  `undefined`. */
export function withTimeout<R>(
  seconds: number,
  gen: Animator<R>,
): Animator<R | undefined> {
  return suspend<R | undefined>((wake, spawn) => {
    let done = false;
    const finish = (v: R | undefined): void => { if (done) return; done = true; wake(v); };
    const stopChild = spawn(gen, (v) => finish(v as R | undefined));
    const stopTimer = spawn(
      (function* (): Animator { yield seconds; })(),
      () => finish(undefined),
    );
    return () => { stopTimer(); stopChild(); };
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
