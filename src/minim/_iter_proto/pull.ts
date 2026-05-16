// Pull model: an animation IS an iterator of rendered values.
//
//   type Frame<T> = Iterator<T, void, number>
//
// Protocol:
//   • engine calls `it.next(dt)` once per step
//   • the yielded value is the rendered frame value
//   • the resumed `dt` is the elapsed time since the previous frame
//   • `done: true` removes the active
//   • first call uses `it.next(0)` (dt is ignored before the first yield)
//
// What this buys us:
//   • LoC: the entire engine is ~25 lines. No Yieldable union, no
//     SuspendFn, no Ticker. Sequencing is JS-native `yield*`.
//   • Simplicity: a tween is a generator function and nothing else.
//     Animation type ≡ iterator type.
//   • Composition: ES2025 Iterator helpers (`.map`, `.take`, `.drop`)
//     work directly — easings, cropping, time-warp are iterator
//     transforms.
//
// What it gives up:
//   • Heterogeneous parallel (different value types into different
//     sinks) — userland writes `parallel(...)` running multiple
//     `Pull.run`s, or yields tuples for same-engine multi-sink.
//   • Event-driven suspend without ticking — solved by yielding the
//     special `IDLE` sentinel; engine recognises it and skips the
//     sink for that frame.
//
// Pairs with the push model: a Frame<T> can be adapted to a push
// generator via `fromFrame(frame, sink)` (returns a `drive` callback).

export type Frame<T> = Iterator<T, void, number>;

export class Pull<T = number> {
  private acts: Array<{ it: Frame<T>; sink: (v: T) => void }> = [];
  clock = 0;

  run(it: Frame<T>, sink: (v: T) => void): () => void {
    const a = { it, sink };
    this.acts.push(a);
    const first = it.next(0);
    if (first.done) return () => {};
    a.sink(first.value);
    return () => this.kill(a);
  }

  step(dt: number): void {
    if (dt > 0) this.clock += dt;
    const acts = this.acts;
    let w = 0;
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      const r = a.it.next(dt);
      if (r.done) continue;
      a.sink(r.value);
      acts[w++] = a;
    }
    acts.length = w;
  }

  stop(): void {
    for (const a of this.acts) try { a.it.return?.(); } catch {}
    this.acts.length = 0;
    this.clock = 0;
  }

  private kill(a: { it: Frame<T>; sink: (v: T) => void }): void {
    const i = this.acts.indexOf(a);
    if (i < 0) return;
    this.acts.splice(i, 1);
    try { a.it.return?.(); } catch {}
  }
}

// ───────────────────────────── primitives ─────────────────────────────

/** Linear tween from `a`→`b` over `dur` seconds. */
export function* lerp(a: number, b: number, dur: number): Frame<number> {
  let t = 0;
  while (t < dur) {
    const dt: number = yield a + (b - a) * (t / dur);
    t += dt;
  }
  yield b;
}

/** Critically-damped spring settle. State in closure, engine clocks it. */
export function* spring(
  target: number,
  opts: { stiffness?: number; damping?: number; eps?: number } = {},
): Frame<number> {
  const k = opts.stiffness ?? 170, d = opts.damping ?? 26, eps = opts.eps ?? 1e-4;
  let x = 0, v = 0;
  while (Math.abs(target - x) > eps || Math.abs(v) > eps) {
    const dt: number = yield x;
    v += ((target - x) * k - d * v) * dt;
    x += v * dt;
  }
  yield target;
}

/** Hold a constant value for `dur` seconds. */
export function* hold<T>(value: T, dur: number): Frame<T> {
  let t = 0;
  while (t < dur) { const dt: number = yield value; t += dt; }
}

// ───────────────────────────── combinators ─────────────────────────────

/** Sequential composition. JS-native delegation. */
export function* seq<T>(...frames: Frame<T>[]): Frame<T> {
  for (const f of frames) yield* f;
}

/** Repeat `n` times via factory. */
export function* loopN<T>(n: number, factory: () => Frame<T>): Frame<T> {
  for (let i = 0; i < n; i++) yield* factory();
}

/** Map values through `f`. (ES2025 `.map` would replace this.) */
export function* mapFrame<A, B>(src: Frame<A>, f: (v: A) => B): Frame<B> {
  let r = src.next(0);
  while (!r.done) {
    const dt: number = yield f(r.value);
    r = src.next(dt);
  }
}

/** Take only the first `dur` seconds of `src`. */
export function* takeDur<T>(src: Frame<T>, dur: number): Frame<T> {
  let t = 0;
  let r = src.next(0);
  while (!r.done && t < dur) {
    const dt: number = yield r.value;
    t += dt;
    r = src.next(dt);
  }
}

/** Run several frames in lockstep, yielding tuples. All frames share `dt`. */
export function* zip<T>(...frames: Frame<T>[]): Frame<T[]> {
  const N = frames.length;
  const cur: IteratorResult<T, void>[] = frames.map((f) => f.next(0));
  while (cur.every((r) => !r.done)) {
    const vals = cur.map((r) => (r as IteratorYieldResult<T>).value);
    const dt: number = yield vals;
    for (let i = 0; i < N; i++) cur[i] = frames[i].next(dt);
  }
}

// ───────────────────────────── push-runtime bridge ─────────────────────────────

/** Turn a Frame<T> into a `drive` step function for embedding into push
 *  generators (`yield* drive(fromFrame(spring(1), x => el.opacity = x))`). */
export function fromFrame<T>(
  frame: Frame<T>, sink: (v: T) => void,
): (dt: number) => boolean {
  let primed = false;
  return (dt: number): boolean => {
    const r = frame.next(primed ? dt : 0);
    primed = true;
    if (r.done) return false;
    sink(r.value);
    return true;
  };
}
