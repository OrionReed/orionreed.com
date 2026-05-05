// Generator-driven animation runner.
//
// An Animator:
//   - yields undefined → wait one frame, receives `dt` (seconds) back.
//   - yields a number → pause that many seconds.
//   - yields an Animator/Generator → delegate.
//   - yields an array → run all in parallel.

import { signal, type Signal } from "./signal";

export class AbortError extends Error {
  constructor() {
    super("Anim stopped");
    this.name = "AbortError";
  }
}

const isAbortError = (e: unknown): e is AbortError => e instanceof AbortError;

export type Yieldable = number | undefined | Animator | Yieldable[];
export type Animator = Generator<Yieldable, void, number>;

export class Anim {
  private controller = new AbortController();
  private timerIds = new Set<number>();
  private scopes = new Set<Anim>();
  private rafId = 0;
  private lastFrame = 0;
  private waiters: Array<(dt: number) => void> = [];

  private get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  private timeout(fn: () => void, ms: number): void {
    let id = 0;
    id = window.setTimeout(() => {
      this.timerIds.delete(id);
      if (!this.aborted) fn();
    }, ms);
    this.timerIds.add(id);
  }

  private promise<T>(fn: (finish: (value: T) => void) => void): Promise<T> {
    if (this.aborted) return Promise.reject(new AbortError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        this.controller.signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new AbortError());
      };
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      fn(finish);
    });
  }

  private wait(ms: number): Promise<void> {
    return this.promise<void>((finish) => this.timeout(finish, ms));
  }

  /** Resolves on the next animation frame with `dt` (seconds since the
   *  previous master-RAF firing, or 0 on the very first frame). */
  private frame(): Promise<number> {
    return this.promise<number>((finish) => {
      this.waiters.push(finish);
      this.scheduleFrame();
    });
  }

  private scheduleFrame(): void {
    if (this.rafId !== 0 || this.aborted) return;
    // If we're entering active animation after a quiet period (the
    // clock is older than ~one frame), drop `lastFrame` to its
    // sentinel. This expresses that no animation time elapsed during
    // the pause — the upcoming RAF reports `dt = 0`, and only after
    // that do real frame intervals start flowing again. Active-flow
    // re-schedules happen ≪ 32ms after the last RAF and fall through.
    if (performance.now() - this.lastFrame > 32) this.lastFrame = 0;
    this.rafId = requestAnimationFrame((rafNow) => {
      this.rafId = 0;
      if (this.aborted) return;
      // First frame of an active period: dt=0 (no logical time has
      // elapsed yet). Subsequent frames: real wall-clock interval,
      // clamped at ~32ms as a safety net for genuine browser stutter.
      const dt =
        this.lastFrame === 0
          ? 0
          : Math.min(rafNow - this.lastFrame, 32) / 1000;
      this.lastFrame = rafNow;
      // Snapshot — handlers may push fresh waiters for the next frame
      // and we don't want to drain those into this firing.
      const batch = this.waiters;
      this.waiters = [];
      for (const w of batch) w(dt);
    });
  }

  /** Run a generator forever, restarting on completion. Pass a factory
   *  (`() => Animator`) so each iteration gets a fresh generator. */
  async loop(genFn: () => Animator): Promise<void> {
    while (!this.aborted) {
      try {
        await this.runGen(genFn());
      } catch (e) {
        if (isAbortError(e)) return;
        throw e;
      }
    }
  }

  /** Run an animator once. Accepts an Animator directly (e.g.
   *  `chain.repeat(3)`) or a `() => Animator` factory. */
  async run(arg: Animator | (() => Animator)): Promise<void> {
    const gen = typeof arg === "function" ? arg() : arg;
    try {
      await this.runGen(gen);
    } catch (e) {
      if (isAbortError(e)) return;
      throw e;
    }
  }

  /** Run `fn` every `sec` seconds (after each interval). Convenience
   *  over `this.loop(function*() { fn(); yield sec })`. */
  every(sec: number, fn: () => void): Promise<void> {
    return this.loop(function* () {
      fn();
      yield sec;
    });
  }

  private async runGen(gen: Animator): Promise<void> {
    let result = gen.next();
    while (!result.done) {
      if (this.aborted) {
        try {
          gen.throw(new AbortError());
        } catch {
          /* secondary cleanup errors */
        }
        throw new AbortError();
      }
      const v = result.value;

      if (typeof v === "number") {
        // Numeric yield is seconds — convert to ms for setTimeout.
        if (v > 0) await this.wait(v * 1000);
        result = gen.next(0);
      } else if (v === undefined) {
        const dt = await this.frame();
        result = gen.next(dt);
      } else if (Array.isArray(v)) {
        await Promise.all(v.map((item) => this.dispatchItem(item)));
        result = gen.next(0);
      } else {
        await this.runGen(v);
        result = gen.next(0);
      }
    }
  }

  private async dispatchItem(v: Yieldable): Promise<void> {
    if (typeof v === "number") {
      if (v > 0) await this.wait(v * 1000);
    } else if (v === undefined) {
      await this.frame();
    } else if (Array.isArray(v)) {
      await Promise.all(v.map((item) => this.dispatchItem(item)));
    } else {
      await this.runGen(v);
    }
  }

  /** Child Anim scoped to this one — stopped when the parent stops. */
  scope(): Anim {
    const child = new Anim();
    this.scopes.add(child);
    return child;
  }

  /** Periodic tick signal — increments every `sec` seconds. Stops with this Anim. */
  pulse(sec: number): Signal<number> {
    const sig = signal(0);
    this.loop(function* () {
      yield sec;
      sig.value = sig.peek() + 1;
    });
    return sig;
  }

  /** Cancel pending operations and reset. Idempotent. Cascades to scopes. */
  stop(): void {
    this.controller.abort();
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.timerIds.forEach((id) => clearTimeout(id));
    this.timerIds.clear();
    // Pending frame() promises reject via the abort listener in
    // `promise()`. Drop our reference so they GC promptly.
    this.waiters = [];
    this.scopes.forEach((s) => s.stop());
    this.scopes.clear();
    this.controller = new AbortController();
  }
}
