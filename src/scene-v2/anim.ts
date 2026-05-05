// Generator-driven animation runner. An Animator yields per frame and
// receives `dt` back. Yieldable: undefined (one frame), number (pause
// ms), Animator (delegate), or array (parallel).

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

  private wait(ms: number): Promise<void> {
    return this.promise<void>((finish) => this.timeout(finish, ms));
  }

  private frame(): Promise<void> {
    return this.promise<void>((finish) => this.raf(() => finish()));
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

  /** Run a generator once. */
  async run(genFn: () => Animator): Promise<void> {
    try {
      await this.runGen(genFn());
    } catch (e) {
      if (isAbortError(e)) return;
      throw e;
    }
  }

  private async runGen(gen: Animator): Promise<void> {
    let lastTime = performance.now();
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
        await Promise.all(v.map((item) => this.dispatchItem(item)));
        result = gen.next(0);
        lastTime = performance.now();
      } else {
        await this.runGen(v);
        result = gen.next(0);
        lastTime = performance.now();
      }
    }
  }

  private async dispatchItem(v: Yieldable): Promise<void> {
    if (typeof v === "number") {
      if (v > 0) await this.wait(v);
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

  /** Cancel pending operations and reset. Idempotent. Cascades to scopes. */
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
