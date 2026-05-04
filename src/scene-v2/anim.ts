// v2 Anim. Generator-driven animation runner with cooperative
// cancellation. Animations compose as generators yielding `Yieldable`s;
// the runner walks them and dispatches:
//   - number      → pause in ms
//   - TweenDesc   → single tween (`{ ms, ease?, step }`)
//   - Yieldable[] → run all in parallel
//   - AnimGen     → run a sub-animation (usually reached via `yield*`)
//
// Animation primitives (tween/fadeIn/fadeOut etc., in `anims.ts`) are
// generator functions that yield TweenDescs. The runner is what owns
// the `Anim` instance and frame scheduling, so primitive code never
// has to thread `anim` through call sites.

export class AbortError extends Error {
  constructor() {
    super("Anim stopped");
    this.name = "AbortError";
  }
}

function isAbortError(e: unknown): e is AbortError {
  return e instanceof AbortError;
}

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 2);
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** A single tween — one frame loop driving `step(t)` for `ms` ms. */
export interface TweenDesc {
  ms: number;
  ease?: (t: number) => number;
  /** Called per frame with t in [0, 1]. */
  step: (t: number) => void;
}

export type Yieldable = number | TweenDesc | AnimGen | Yieldable[];

export type AnimGen = Generator<Yieldable, void, unknown>;

function isGenerator(x: unknown): x is AnimGen {
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

  // Tracked rAF/timeout that self-clean from the set on fire.
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

  /** Pause for `ms`. Public so ad-hoc `await anim.wait(N)` works outside scripts. */
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
  async loop(genFn: () => AnimGen): Promise<void> {
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
  async run(genFn: () => AnimGen): Promise<void> {
    try {
      await this.runGen(genFn());
    } catch (e) {
      if (isAbortError(e)) return;
      throw e;
    }
  }

  private async runGen(gen: AnimGen): Promise<void> {
    let next = gen.next();
    while (!next.done) {
      try {
        await this.dispatch(next.value);
      } catch (e) {
        // Inject into the generator so try/finally cleanup runs.
        try {
          gen.throw(e);
        } catch {
          /* secondary cleanup errors are swallowed */
        }
        throw e;
      }
      next = gen.next();
    }
  }

  private async dispatch(v: Yieldable): Promise<void> {
    if (typeof v === "number") {
      if (v > 0) await this.wait(v);
      return;
    }
    if (Array.isArray(v)) {
      await Promise.all(v.map((x) => this.dispatch(x)));
      return;
    }
    if (isGenerator(v)) {
      await this.runGen(v);
      return;
    }
    await this.tweenFrame(v);
  }

  /** Internal raw frame loop driving a TweenDesc to completion. */
  private tweenFrame(d: TweenDesc): Promise<void> {
    return this.promise<void>((finish) => {
      const start = performance.now();
      const frame = (now: number) => {
        const t = Math.min((now - start) / d.ms, 1);
        d.step(d.ease ? d.ease(t) : t);
        if (t >= 1) finish();
        else this.raf(frame);
      };
      this.raf(frame);
    });
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
