// Composability superpowers that generators give you for free.
//
// Each of these is a *plain generator* that wraps another generator.
// Zero engine support. They compose with each other via `yield*`.
// They cost nothing when not used. They're 5-15 lines each.
//
// The thesis: generators aren't just syntactic sugar over `function* fn { }`
// — they're coroutines with bidirectional value flow, and that's a
// substrate for animation features that are awkward or impossible in
// callback/timeline-based libraries.
//
// What's here:
//
//   trace           log every yield (debugging)
//   tap             call fn on each yield, gen continues unchanged
//   mapDt           scale or transform the dt before the gen sees it
//                   (slow-motion, fast-forward, ease-of-time)
//   withTimeout     hard-cap duration; gen.return() if exceeded
//   record          capture (yield, resume) pairs into a trace
//   replay          reconstruct a generator from a trace (no source needed)
//   reverse         play a recorded trace backwards
//   forks           split one source generator into N independent forks
//
// All of these are coroutines manually driving an inner coroutine.
// They are the actual composability surface — not a DSL bolted on.

import "../_anim_lab/raf-polyfill";
import { Anim, type Animator } from "../core/anim";

// ── 1. trace ───────────────────────────────────────────────────────

/** Log every yield from `gen`. Pass through unchanged. The
 *  `try/finally` is essential: when the runtime calls `.return()`
 *  on a wrapper generator, JS does NOT automatically propagate that
 *  to the inner gen — every wrapper that drives another gen must
 *  cascade `.return()` itself for inner `try/finally` blocks to
 *  fire on cancel. */
export function* trace<R>(label: string, gen: Animator<R>): Animator<R> {
  let arg: any = undefined;
  try {
    while (true) {
      const r = gen.next(arg);
      if (r.done) {
        console.log(`[${label}] return`, r.value);
        return r.value;
      }
      console.log(`[${label}] yield`, r.value);
      arg = yield r.value;
    }
  } finally {
    gen.return(undefined as any);
  }
}

// ── 2. tap ────────────────────────────────────────────────────────

/** Call `fn(yieldedValue, dt)` on each yield. Like `trace` but
 *  user-defined side effect. Gen flows through untouched. */
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
  } finally {
    gen.return(undefined as any);
  }
}

// ── 3. mapDt ──────────────────────────────────────────────────────

/** Transform the `dt` (or other resume value) BEFORE the inner
 *  generator sees it. Slow-mo: `mapDt(dt => dt * 0.5, gen)`.
 *  Variable speed: `mapDt(dt => dt * curSpeed.value, gen)`. */
export function* mapDt<R>(
  fn: (resume: any) => any,
  gen: Animator<R>,
): Animator<R> {
  let arg: any = undefined;
  try {
    while (true) {
      const r = gen.next(arg);
      if (r.done) return r.value;
      arg = fn(yield r.value);
    }
  } finally {
    gen.return(undefined as any);
  }
}

// ── 4. withTimeout ────────────────────────────────────────────────

/** Hard-cap total scaled duration. After `seconds`, calls
 *  `gen.return()` and completes. Returns whatever the gen returned,
 *  or `undefined` on timeout. */
export function* withTimeout<R>(
  seconds: number,
  gen: Animator<R>,
): Animator<R | undefined> {
  let elapsed = 0;
  let arg: any = undefined;
  try {
    while (elapsed < seconds) {
      const r = gen.next(arg);
      if (r.done) return r.value;
      arg = yield r.value;
      if (typeof arg === "number") elapsed += arg;
    }
    return undefined;
  } finally {
    gen.return(undefined as any);
  }
}

// ── 5/6. record + replay ──────────────────────────────────────────

export interface TraceFrame {
  yieldValue: unknown;
  resume: unknown;
  done: boolean;
  returnValue?: unknown;
}

/** Run the gen and capture (yieldValue, resume, done) for every
 *  step. Passes yields through transparently. */
export function* record<R>(
  out: TraceFrame[],
  gen: Animator<R>,
): Animator<R> {
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
  } finally {
    gen.return(undefined as any);
  }
}

/** Reconstruct a generator from a trace. The source generator does
 *  NOT run — yields and durations are replayed verbatim. The replay
 *  is deterministic regardless of dt the runtime hands it (it
 *  consumes its own recorded resumes). */
export function* replay(trace: readonly TraceFrame[]): Animator<unknown> {
  for (let i = 0; i < trace.length; i++) {
    const f = trace[i];
    if (f.done) return f.returnValue;
    yield f.yieldValue as any;
    // Note: the resume value the runtime actually gives us is ignored.
    // The trace is self-contained; what the inner gen "saw" originally
    // is what we replay. (For frame-driven anims that means the same
    // sequence of dt values it originally received.)
  }
}

// ── 7. reverse ────────────────────────────────────────────────────

/** Play a recorded trace backwards. Most useful for traces of
 *  animations that write to signals — pair with a `tap` that
 *  records signal values, then reverse to scrub backwards. */
export function* reverse(trace: readonly TraceFrame[]): Animator<unknown> {
  for (let i = trace.length - 1; i >= 0; i--) {
    const f = trace[i];
    if (f.done) continue;
    yield f.yieldValue as any;
  }
}

// ── 8. forks ──────────────────────────────────────────────────────
//
// Run ONE source generator, broadcast its yields to N independent
// forks. Each fork can advance independently (they buffer yields
// they haven't consumed yet). Useful for "compute once, observe N
// times" patterns — e.g., one physics sim, multiple visualisers.

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

// ── Demo ──────────────────────────────────────────────────────────

{
  console.log("\n— DEMO 1: trace + slow-motion composition —\n");
  {
    function* myAnim(): Animator<string> {
      yield 0.1;
      yield 0.2;
      yield 0.05;
      return "done!";
    }
    const a = new Anim();
    a.run(trace("outer", mapDt((dt) => dt * 2, myAnim())));
    for (let f = 0; f < 30; f++) a.step(0.05);
    a.stop();
  }

  console.log("\n— DEMO 2: record + replay (no source rerun) —\n");
  {
    let runCount = 0;
    function* expensiveAnim(): Animator {
      runCount++;
      yield 0.1;
      yield 0.2;
    }
    const captured: TraceFrame[] = [];
    const a = new Anim();
    a.run(record(captured, expensiveAnim()));
    for (let f = 0; f < 20; f++) a.step(0.05);
    a.stop();
    console.log("source ran", runCount, "times; captured", captured.length, "frames");
    console.log("captured trace:", captured);

    // Replay 100 times — source is never re-entered.
    runCount = 0;
    for (let r = 0; r < 100; r++) {
      const a2 = new Anim();
      a2.run(replay(captured));
      for (let f = 0; f < 20; f++) a2.step(0.05);
      a2.stop();
    }
    console.log("after 100 replays, source ran", runCount, "more times (expected 0)");
  }

  console.log("\n— DEMO 3: forks (one source, three observers) —\n");
  {
    function* counter(): Animator {
      for (let i = 0; i < 5; i++) yield i;
    }
    const [a, b, c] = forks(counter() as any, 3);
    const out: any[] = [];
    function* logger(label: string, g: Animator) {
      let arg: any = undefined;
      while (true) {
        const r = g.next(arg);
        if (r.done) {
          out.push([label, "done"]);
          return;
        }
        out.push([label, r.value]);
        arg = yield r.value;
      }
    }
    const anim = new Anim();
    anim.run(logger("A", a as any));
    anim.run(logger("B", b as any));
    anim.run(logger("C", c as any));
    for (let f = 0; f < 30; f++) anim.step(1 / 60);
    anim.stop();
    console.log("interleaved log:", out);
  }

  console.log("\n— DEMO 4: composing the wrappers —\n");
  {
    function* base(): Animator<string> {
      yield 0.1;
      yield 0.1;
      yield 0.1;
      return "fin";
    }
    // Slow it down 4×, then cap at 0.25s of scaled time, traced.
    const a = new Anim();
    a.run(
      trace(
        "composed",
        withTimeout(0.25, mapDt((dt) => dt * 4, base())),
      ),
    );
    for (let f = 0; f < 30; f++) a.step(0.05);
    a.stop();
  }
}
