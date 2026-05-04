// v2 Anim — generator-driven animation runner.
//
// An animation is a generator that yields per-frame, receives `dt`
// (ms since last frame) back via `.next(dt)`, and `return`s when done.
// JS's `yield*` delegation propagates yields up and dt back down, so
// composing animations is just JS:
//
//   function* tween(sig, target, ms, ease?) {
//     const start = sig.peek();          // lazy: runs at iteration time
//     let elapsed = 0;
//     while (elapsed < ms) {
//       const dt: number = yield;        // wait one frame, get dt back
//       elapsed += dt;
//       sig.value = start + (target - start) * (ease?.(...) ?? ...);
//     }
//   }
//
// Yields can be:
//   - undefined (bare `yield`) — wait one frame, runner resumes with dt
//   - number   (`yield 240`)   — pause N ms, runner resumes with 0
//   - Animator (`yield gen`)   — drive sub-animation to completion
//   - Yieldable[] (`yield [a, b]`) — run all in parallel
//
// `yield* otherGen()` delegates via JS — leaf yields propagate up to
// the runner and dt flows back down to the leaf. Sub-scripts compose
// "for free."

export class AbortError extends Error {
  constructor() {
    super("Anim stopped");
    this.name = "AbortError";
  }
}

function isAbortError(e: unknown): e is AbortError {
  return e instanceof AbortError;
}

export type Yieldable = number | undefined | Animator | Yieldable[];
export type Animator = Generator<Yieldable, void, number>;

function isAnimator(x: unknown): x is Animator {
  return (
    x !== null &&
    typeof x === "object" &&
    typeof (x as { next?: unknown }).next === "function" &&
    typeof (x as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function"
  );
}

export class Anim {
  private controller = new AbortController();
  private rafIds = new Set<number>();
  private timerIds = new Set<number>();
  private scopes = new Set<Anim>();

  private get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  private raf(fn: (now: number) => void): void {
    let id = 0;
    id = requestAnimationFrame((now) => {
      this.rafIds.delete(id);
      if (!this.aborted) fn(now);
    });
    this.rafIds.add(id);
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

  /** Pause for `ms`. */
  wait(ms: number): Promise<void> {
    return this.promise<void>((finish) => this.timeout(finish, ms));
  }

  /** Wait for a condition to become truthy (50ms poll). */
  until(condition: () => boolean): Promise<void> {
    return this.promise<void>((finish) => {
      if (condition()) {
        finish();
        return;
      }
      const poll = () => {
        if (condition()) finish();
        else this.timeout(poll, 50);
      };
      this.timeout(poll, 50);
    });
  }

  /** Run a generator animation forever. Swallows AbortError. */
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

  /** Run a generator animation once. Swallows AbortError. */
  async run(genFn: () => Animator): Promise<void> {
    try {
      await this.runGen(genFn());
    } catch (e) {
      if (isAbortError(e)) return;
      throw e;
    }
  }

  /** Walk a generator: dispatch each yield, advance with dt or 0. */
  private async runGen(gen: Animator): Promise<void> {
    let lastTime = performance.now();
    let result = gen.next();
    while (!result.done) {
      if (this.aborted) {
        try {
          gen.throw(new AbortError());
        } catch {
          /* ignore secondary cleanup errors */
        }
        throw new AbortError();
      }
      const v = result.value;

      if (typeof v === "number") {
        if (v > 0) await this.wait(v);
        result = gen.next(0);
        lastTime = performance.now();
      } else if (v === undefined) {
        await this.frame();
        const now = performance.now();
        const dt = now - lastTime;
        lastTime = now;
        result = gen.next(dt);
      } else if (Array.isArray(v)) {
        await this.dispatchArray(v);
        result = gen.next(0);
        lastTime = performance.now();
      } else {
        // It's an Animator (sub-generator). Drive it to completion.
        await this.runGen(v);
        result = gen.next(0);
        lastTime = performance.now();
      }
    }
  }

  /** Run multiple Yieldables concurrently; resolve when all complete. */
  private async dispatchArray(items: Yieldable[]): Promise<void> {
    await Promise.all(items.map((item) => this.dispatchItem(item)));
  }

  private async dispatchItem(v: Yieldable): Promise<void> {
    if (typeof v === "number") {
      if (v > 0) await this.wait(v);
      return;
    }
    if (v === undefined) {
      await this.frame();
      return;
    }
    if (Array.isArray(v)) {
      await this.dispatchArray(v);
      return;
    }
    if (isAnimator(v)) {
      await this.runGen(v);
      return;
    }
  }

  /** Wait one rAF. */
  private frame(): Promise<void> {
    return this.promise<void>((finish) => this.raf(() => finish()));
  }

  /** Child Anim scoped to this one — stopped when parent stops. */
  scope(): Anim {
    const child = new Anim();
    this.scopes.add(child);
    return child;
  }

  /** Cancel all pending operations and reset for reuse. Idempotent. */
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
