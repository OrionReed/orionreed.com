// Composability wrappers — generators that drive other generators.
// Zero engine support; each is a plain `function*` that re-yields
// what its inner gen yields.
//
//   trace        log every yield (debugging)
//   tap          fn called on each yield, gen passes through
//   mapDt        transform `dt` before the inner gen sees it
//                (slow-mo, fast-forward, time-warp, frame-cap)
//   withTimeout  hard-cap total elapsed; cancels inner if exceeded
//   record       capture (yield, resume) pairs into a trace
//   replay       replay a recorded trace (no source re-run)
//   reverse      replay a trace backwards (scrub)
//   forks        broadcast one source to N independent consumers
//
// A wrapper that drives an inner gen MUST `try/finally { gen.return() }`.
// JS does not propagate `.return()` across independently-driven gens —
// only across `yield*` delegation. The wrappers below all do this.

import { suspend, type Animator } from "./anim";

export const trace = <R>(label: string, gen: Animator<R>): Animator<R> =>
  tap((v) => console.log(`[${label}]`, v), gen);

export function* tap<R>(
  fn: (value: unknown, resume: unknown) => void,
  gen: Animator<R>,
): Animator<R> {
  let arg: any = undefined;
  try {
    while (true) {
      const r = gen.next(arg);
      if (r.done) return r.value;
      fn(r.value, arg);
      arg = yield r.value;
    }
  } finally { gen.return(undefined as any); }
}

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

/** Hard-cap by engine time. The inner gen runs unscaled as a tracked
 *  child; a ticker watches `anim.clock`. On timeout the child is
 *  cancelled and parent resumes with `undefined`. For gen-time caps
 *  (respecting `mapDt` etc.), wrap with `mapDt` outside `withTimeout`. */
export function withTimeout<R>(seconds: number, gen: Animator<R>): Animator<R | undefined> {
  return suspend<R | undefined>((wake, spawn, anim) => {
    const deadline = anim.clock + seconds;
    let done = false;
    const finish = (v: R | undefined): void => { if (done) return; done = true; wake(v); };
    const stopTicker = anim.onFrame(() => {
      if (anim.clock >= deadline) finish(undefined);
    });
    const stopChild = spawn(gen, (v) => finish(v as R | undefined));
    return () => { stopTicker(); stopChild(); };
  });
}

export interface TraceFrame {
  yieldValue: unknown;
  resume: unknown;
  done: boolean;
  returnValue?: unknown;
}

export function* record<R>(out: TraceFrame[], gen: Animator<R>): Animator<R> {
  let arg: any = undefined;
  try {
    while (true) {
      const r = gen.next(arg);
      if (r.done) {
        out.push({ yieldValue: undefined, resume: arg, done: true, returnValue: r.value });
        return r.value;
      }
      arg = yield r.value;
      out.push({ yieldValue: r.value, resume: arg, done: false });
    }
  } finally { gen.return(undefined as any); }
}

/** Replay a recorded trace; the source generator is NOT re-run. The
 *  resume value the runtime hands us is ignored — replays consume the
 *  trace's recorded resumes. */
export function* replay(trace: readonly TraceFrame[]): Animator<unknown> {
  for (let i = 0; i < trace.length; i++) {
    const f = trace[i];
    if (f.done) return f.returnValue;
    yield f.yieldValue as any;
  }
  return undefined;
}

/** Replay a recorded trace backwards. Pair with `tap` recording
 *  signal values, then reverse to scrub. */
export function* reverse(trace: readonly TraceFrame[]): Animator {
  for (let i = trace.length - 1; i >= 0; i--) {
    const f = trace[i];
    if (f.done) continue;
    yield f.yieldValue as any;
  }
}

/** Broadcast one source generator to N independent forks. Each fork
 *  buffers yields it hasn't consumed; `compute once, observe N times`. */
export function forks<R>(source: Animator<R>, n: number): Animator<R>[] {
  const buffers: any[][] = Array.from({ length: n }, () => []);
  let sourceDone = false;
  let returnValue: R | undefined;
  function pull() {
    if (sourceDone) return;
    const r = source.next();
    if (r.done) {
      sourceDone = true;
      returnValue = r.value;
      for (const b of buffers) b.push({ done: true });
    } else {
      for (const b of buffers) b.push({ value: r.value, done: false });
    }
  }
  function* mkFork(idx: number): Animator<R> {
    const buf = buffers[idx];
    while (true) {
      if (buf.length === 0) pull();
      const item = buf.shift();
      if (item.done) return returnValue as R;
      yield item.value;
    }
  }
  return Array.from({ length: n }, (_, i) => mkFork(i));
}
