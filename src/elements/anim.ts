export class AbortError extends Error {
  constructor() {
    super("Anim stopped");
    this.name = "AbortError";
  }
}

function isAbortError(e: unknown): e is AbortError {
  return e instanceof AbortError;
}

// --- Helpers ---

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 2);
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

// --- Anim ---

export class Anim {
  private controller = new AbortController();
  private rafIds = new Set<number>();
  private timerIds = new Set<number>();
  private scopes = new Set<Anim>();

  private get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  // Internal tracked rAF — cleans itself from the set when it fires
  private raf(fn: (now: number) => void): void {
    let id = 0;
    id = requestAnimationFrame((now) => {
      this.rafIds.delete(id);
      if (!this.aborted) fn(now);
    });
    this.rafIds.add(id);
  }

  // Internal tracked setTimeout — cleans itself from the set when it fires
  private timeout(fn: () => void, ms: number): void {
    let id = 0;
    id = window.setTimeout(() => {
      this.timerIds.delete(id);
      if (!this.aborted) fn();
    }, ms);
    this.timerIds.add(id);
  }

  // Shared promise setup: abort listener + finish/abort callbacks
  private promise<T>(
    fn: (finish: (value: T) => void) => void
  ): Promise<T> {
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

  /**
   * Wait for a fixed or dynamic delay.
   *
   *   await anim.wait(500)
   *   await anim.wait(() => rand(300, 800))
   */
  wait(arg: number | (() => number)): Promise<void> {
    return this.promise<void>((finish) => {
      const ms = typeof arg === "number" ? arg : arg();
      this.timeout(finish, ms);
    });
  }

  /**
   * Wait until a condition becomes truthy. Polls at 50ms intervals.
   *
   *   await anim.until(() => this.state.done)
   */
  until(condition: () => boolean): Promise<void> {
    return this.promise<void>((finish) => {
      if (condition()) { finish(); return; }
      const poll = () => {
        if (condition()) finish();
        else this.timeout(poll, 50);
      };
      this.timeout(poll, 50);
    });
  }

  /**
   * Animate over a fixed duration. t goes from 0 to 1.
   *
   *   await anim.tween(500, t => { state.x = lerp(0, 100, easeOut(t)) })
   */
  tween(ms: number, fn: (t: number) => void): Promise<void> {
    return this.promise<void>((finish) => {
      const start = performance.now();

      const frame = (now: number) => {
        const t = Math.min((now - start) / ms, 1);
        fn(t);
        if (t >= 1) finish();
        else this.raf(frame);
      };

      this.raf(frame);
    });
  }

  /**
   * Open-ended rAF loop driven by delta time (seconds). Return true to stop.
   *
   *   await anim.tick(dt => {
   *     state.velocity += 9.8 * dt
   *     state.y += state.velocity * dt
   *     return state.y >= floor
   *   })
   */
  tick(fn: (dt: number) => boolean): Promise<void> {
    return this.promise<void>((finish) => {
      let last: number | null = null;

      const frame = (now: number) => {
        const dt = last !== null ? (now - last) / 1000 : 0;
        last = now;
        if (fn(dt)) finish();
        else this.raf(frame);
      };

      this.raf(frame);
    });
  }

  /**
   * Run an async function in a loop until stopped.
   * Automatically swallows AbortError, re-throws anything else.
   *
   *   await anim.loop(async () => {
   *     state.phase = 'on'
   *     render()
   *     await anim.wait(500)
   *     state.phase = 'off'
   *     render()
   *     await anim.wait(() => rand(200, 600))
   *   })
   */
  async loop(fn: () => Promise<void>): Promise<void> {
    while (!this.aborted) {
      try {
        await fn();
      } catch (e) {
        if (isAbortError(e)) return;
        throw e;
      }
    }
  }

  /**
   * Create a child Anim scoped to this one's lifetime.
   * Stopped automatically when the parent is stopped, or independently.
   *
   *   const child = this.anim.scope()
   *   child.loop(async () => { ... })
   *   child.stop() // stop just this scope
   *   this.anim.stop() // stops parent and all scopes
   */
  scope(): Anim {
    const child = new Anim();
    this.scopes.add(child);
    return child;
  }

  /**
   * Cancel all pending operations and reset for reuse.
   * Also stops and clears all child scopes.
   * Safe to call multiple times.
   */
  stop(): void {
    this.controller.abort();
    this.rafIds.forEach((id) => cancelAnimationFrame(id));
    this.timerIds.forEach((id) => clearTimeout(id));
    this.rafIds.clear();
    this.timerIds.clear();
    this.scopes.forEach((s) => s.stop());
    this.scopes.clear();
    this.controller = new AbortController();
  }
}
