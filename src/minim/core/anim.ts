// Generator-driven animation runner. Yield contract:
//   undefined        → wait one frame, receive `dt` (seconds).
//   number           → pause that many seconds.
//   Animator         → delegate.
//   Yieldable[]      → run children in parallel.

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

  /** Resolves on the next animation frame with `dt` in seconds (0 on
   *  the first frame of an active period). */
  private frame(): Promise<number> {
    return this.promise<number>((finish) => {
      this.waiters.push(finish);
      this.scheduleFrame();
    });
  }

  private scheduleFrame(): void {
    if (this.rafId !== 0 || this.aborted) return;
    // Re-entering after a quiet period (>1 frame stale): reset so the
    // upcoming RAF reports dt=0 — pauses don't accumulate logical time.
    if (performance.now() - this.lastFrame > 32) this.lastFrame = 0;
    this.rafId = requestAnimationFrame((rafNow) => {
      this.rafId = 0;
      if (this.aborted) return;
      // First frame: dt=0. Subsequent frames: wall-clock interval,
      // clamped at 32ms for stutter recovery.
      const dt =
        this.lastFrame === 0
          ? 0
          : Math.min(rafNow - this.lastFrame, 32) / 1000;
      this.lastFrame = rafNow;
      // Snapshot — handlers may push fresh waiters for the next frame.
      const batch = this.waiters;
      this.waiters = [];
      for (const w of batch) w(dt);
    });
  }

  /** Run a generator forever, restarting on completion. */
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

  /** Run an animator once. Accepts a generator or a factory. */
  async run(arg: Animator | (() => Animator)): Promise<void> {
    const gen = typeof arg === "function" ? arg() : arg;
    try {
      await this.runGen(gen);
    } catch (e) {
      if (isAbortError(e)) return;
      throw e;
    }
  }

  /** Run `fn` every `sec` seconds. */
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

  /** Cancel pending operations. Idempotent; cascades to scopes. */
  stop(): void {
    this.controller.abort();
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.timerIds.forEach((id) => clearTimeout(id));
    this.timerIds.clear();
    // Pending frame() promises reject via the abort listener.
    this.waiters = [];
    this.scopes.forEach((s) => s.stop());
    this.scopes.clear();
    this.controller = new AbortController();
  }
}
