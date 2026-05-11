// Claims — a one-file, one-idea testing/spec layer.
//
// A claim is a labeled `Signal<boolean>`. `true` = currently holding;
// `false` = violated (or not yet fulfilled, for liveness claims).
// Claims compose by chaining — `.and`, `.or`, `.not`, `.during(p)`,
// `.before(other)`, `.labelled(...)` — each returning a fresh Claim.
// There is no Witness, no Verdict object, no Policy enum.
//
//     const bounded  = claim(c.opacity, "α").stays.in([0, 1]);
//     const reaches1 = claim(c.opacity, "α").becomes.equal(1);
//     const introOk  = bounded.and(reaches1).labelled("intro spec");
//
//     const intro = process(function* () {
//       yield* fadeIn(c, 0.3);
//     }, bounded, reaches1);
//
//     this.anim.loop(function* () {
//       yield* intro.run();
//     });
//
// `process(factory, ...claims)` returns a persistent handle whose
// lifecycle signals (`alive` / `started` / `completed` / `duration`)
// survive across `.run()` calls. Cross-process and `.during(p)`
// claims subscribe to those signals once and observe every run.
//
// Everything reduces to bool signals. There's nothing else to learn.

import {
  signal,
  computed,
  effect,
  Signal,
  type ReadonlySignal,
} from "./core/signal";
import { race } from "./core/suspensions";
import type { Animator } from "./core/anim";
import type { Vec } from "./core/vec";
import { Bounds, type AABB } from "./scene/bounds";
import { circle } from "./shapes/circle";
import { pt, type Pointlike } from "./scene/point";

// ── Types ────────────────────────────────────────────────────────────

/** A claim is a labeled `Signal<boolean>` with a small chain algebra
 *  for composition. `.value === true` while the claim holds; flips to
 *  `false` on violation (or `false → true` once fulfilled, for liveness
 *  claims).
 *
 *  Management hooks:
 *  - `reset()` clears the latched state — `process()` calls this at
 *    scope entry; you can also call it directly to re-arm a claim.
 *  - `dispose()` tears down the underlying `effect` subscription. Not
 *    called by `process`; persistent claims outlive their scopes by
 *    default. */
export type Claim = ReadonlySignal<boolean> & {
  readonly label?: string;
  reset(): void;
  dispose(): void;

  // Logical composition. Each returns a new Claim built over the
  // signal algebra; the input claims are unaffected.
  and(other: Claim): Claim;
  or(other: Claim): Claim;
  not(): Claim;

  // Modifiers.
  /** Gate this claim by a process's lifetime — vacuously `true` when
   *  `p` is sleeping. Re-arms the underlying claim when `p` enters. */
  during(p: Process): Claim;
  /** Re-label without changing the underlying signal. */
  labelled(name: string): Claim;

  // Temporal ordering. Both operands are bool-signal events ("X
  // becomes true").
  /** This event becomes true before `other`'s does. Holds vacuously
   *  if neither has become true. */
  before(other: Claim): Claim;
  /** This event becomes true only after `other`'s already has. */
  after(other: Claim): Claim;
};

/** Persistent handle for a reusable named process. Signals stay alive
 *  across calls to `.run()` (each `.run()` resets them and produces a
 *  fresh Animator), so claims that reference them — `intro.duration`,
 *  `intro.completed.before(...)`, etc. — survive loop iterations. */
export type Process = {
  readonly label?: string;
  /** True while the wrapped work is running. */
  readonly alive: ReadonlySignal<boolean>;
  /** True once the work has started in the current run. Reset at
   *  each `.run()`. */
  readonly started: ReadonlySignal<boolean>;
  /** True once the work has both started and ended in the current
   *  run. Reset at each `.run()`. */
  readonly completed: ReadonlySignal<boolean>;
  /** Elapsed alive-time in seconds, integrated from `dt`. Reset to
   *  0 at each `.run()`. */
  readonly duration: ReadonlySignal<number>;
  /** Build a fresh Animator for one execution. Reset-arms the attached
   *  claims and the lifecycle signals on entry. */
  run(): Animator;
};

// ── Latching helpers ─────────────────────────────────────────────────

/** Invariant latch: signal is `true` until `p` is ever `false`, then
 *  latches `false` until `reset`. Used for `stays.X` / `never.X`. */
function latchFalse(p: ReadonlySignal<boolean>, label?: string): Claim {
  const held = signal(true);
  const stop = effect(() => {
    if (held.peek() && !p.value) held.value = false;
  });
  return finalize(held, label, () => {
    held.value = true;
    // Re-evaluate immediately in case the predicate is already false.
    if (!p.peek()) held.value = false;
  }, stop);
}

/** Liveness latch: signal is `false` until `p` is ever `true`, then
 *  latches `true` until `reset`. Used for `becomes.X`. */
function latchTrue(p: ReadonlySignal<boolean>, label?: string): Claim {
  const held = signal(false);
  const stop = effect(() => {
    if (!held.peek() && p.value) held.value = true;
  });
  return finalize(held, label, () => {
    held.value = p.peek() ? true : false;
  }, stop);
}

/** No latching — the claim is just `p`. Used for `ends.X`: read the
 *  predicate at scope close. Resetting is a no-op. */
function passthrough(p: ReadonlySignal<boolean>, label?: string): Claim {
  const wrapped = computed(() => p.value);
  return finalize(wrapped as Signal<boolean>, label, () => {}, () => {});
}

// ── finalize: tack metadata + chain methods onto a bool signal ───────

function finalize(
  sig: ReadonlySignal<boolean>,
  label: string | undefined,
  reset: () => void,
  dispose: () => void,
): Claim {
  const meta: Record<string, unknown> = { reset, dispose };
  if (label !== undefined) meta.label = label;

  meta.and = function (this: Claim, other: Claim): Claim {
    return _and(this, other);
  };
  meta.or = function (this: Claim, other: Claim): Claim {
    return _or(this, other);
  };
  meta.not = function (this: Claim): Claim {
    return _not(this);
  };
  meta.during = function (this: Claim, p: Process): Claim {
    return _during(this, p);
  };
  meta.labelled = function (this: Claim, name: string): Claim {
    return finalize(sig, name, reset, dispose);
  };
  meta.before = function (this: Claim, other: Claim): Claim {
    return _before(this, other);
  };
  meta.after = function (this: Claim, other: Claim): Claim {
    return _before(other, this);
  };

  return Object.assign(sig, meta) as unknown as Claim;
}

// ── Chain helpers ────────────────────────────────────────────────────

function _and(a: Claim, b: Claim): Claim {
  return finalize(
    computed(() => a.value && b.value),
    `${labelOf(a)} ∧ ${labelOf(b)}`,
    () => { a.reset(); b.reset(); },
    () => {},
  );
}

function _or(a: Claim, b: Claim): Claim {
  return finalize(
    computed(() => a.value || b.value),
    `${labelOf(a)} ∨ ${labelOf(b)}`,
    () => { a.reset(); b.reset(); },
    () => {},
  );
}

function _not(c: Claim): Claim {
  return finalize(
    computed(() => !c.value),
    `¬${labelOf(c)}`,
    () => c.reset(),
    () => {},
  );
}

/** Gate a claim by a process's lifetime. Vacuously `true` when `p`
 *  sleeps; underlying claim is re-armed at each `p` entry. */
function _during(c: Claim, p: Process): Claim {
  let wasAlive = false;
  const stop = effect(() => {
    const a = p.alive.value;
    if (a && !wasAlive) c.reset();
    wasAlive = a;
  });
  return finalize(
    computed(() => !p.alive.value || c.value),
    `(${labelOf(c)}) during ${p.label ?? "process"}`,
    () => c.reset(),
    stop,
  );
}

/** "a becomes true before b becomes true." Verdict is `true` until
 *  `b` is observed `true` while `a` hasn't been; holds vacuously if
 *  neither ever becomes true. */
function _before(a: Claim, b: Claim): Claim {
  const held = signal(true);
  let aFirst = false;
  let decided = false;
  const stop = effect(() => {
    if (decided) return;
    // Read both to register deps even on the won branch.
    const av = a.value;
    const bv = b.value;
    if (av && !aFirst && !bv) {
      aFirst = true;
      decided = true;
    } else if (bv && !aFirst) {
      decided = true;
      held.value = false;
    }
  });
  return finalize(
    held,
    `${labelOf(a)} before ${labelOf(b)}`,
    () => {
      aFirst = false;
      decided = false;
      held.value = true;
      a.reset();
      b.reset();
    },
    stop,
  );
}

function labelOf(c: Claim | Process): string {
  return c.label ?? "?";
}

// ── Fluent entry: claim(sig).stays.X / .becomes.X / .never.X / .ends.X

/** Start a claim sentence about a signal: `claim(sig, "α").stays.in([0, 1])`.
 *  The optional `label` shows up in failure metadata and rendered labels. */
export function claim<T>(sig: ReadonlySignal<T>, label?: string): SignalClaim<T> {
  return new SignalClaim(sig, label);
}

/** Mood selector — chooses how the predicate latches. Returns a
 *  predicate builder; pick the verb (`.in`, `.equal`, …) to finish. */
export class SignalClaim<T> {
  constructor(
    readonly sig: ReadonlySignal<T>,
    readonly lbl?: string,
  ) {}

  /** Invariant — must hold every frame. Latches `false` on first
   *  violation; reset clears the latch. */
  get stays(): Predicates<T> {
    return new Predicates(this.sig, "stays", this.lbl);
  }
  /** Liveness — must hold at least once before scope end. Latches
   *  `true` on first fulfillment. */
  get becomes(): Predicates<T> {
    return new Predicates(this.sig, "becomes", this.lbl);
  }
  /** Anti-invariant — predicate must remain `false` every frame.
   *  Latches `false` on first `true`. */
  get never(): Predicates<T> {
    return new Predicates(this.sig, "never", this.lbl);
  }
  /** Endpoint check — predicate is evaluated at scope close.
   *  Doesn't latch. */
  get ends(): Predicates<T> {
    return new Predicates(this.sig, "ends", this.lbl);
  }
}

type Mood = "stays" | "becomes" | "never" | "ends";

/** Predicate vocabulary. Many methods are typed via `this:` so they're
 *  only callable when `T` matches the predicate's domain — e.g.
 *  `.in([0, 1])` only compiles on `Predicates<number>`. */
export class Predicates<T> {
  constructor(
    readonly sig: ReadonlySignal<T>,
    readonly mood: Mood,
    readonly lbl?: string,
  ) {}

  private build(pred: ReadonlySignal<boolean>, what: string): Claim {
    const label = `${this.lbl ?? "signal"} ${this.mood} ${what}`;
    switch (this.mood) {
      case "stays":   return latchFalse(pred, label);
      case "never":   return latchFalse(computed(() => !pred.value), label);
      case "becomes": return latchTrue(pred, label);
      case "ends":    return passthrough(pred, label);
    }
  }

  // ── Generic (any T) ───────────────────────────────────────────────

  /** Exact equality (`===`). */
  equal(v: T): Claim {
    return this.build(
      computed(() => this.sig.value === v),
      `= ${fmt(v)}`,
    );
  }

  /** Arbitrary predicate. Provide `label` for richer failure messages. */
  satisfies(fn: (v: T) => boolean, label = "predicate"): Claim {
    return this.build(
      computed(() => fn(this.sig.value)),
      label,
    );
  }

  // ── Numeric (T = number) ──────────────────────────────────────────

  /** Inclusive range. Only callable on `Predicates<number>`. */
  in(this: Predicates<number>, range: [number, number]): Claim {
    const [lo, hi] = range;
    return this.build(
      computed(() => {
        const v = this.sig.value;
        return v >= lo && v <= hi;
      }),
      `∈ [${lo}, ${hi}]`,
    );
  }

  above(this: Predicates<number>, n: number): Claim {
    return this.build(
      computed(() => this.sig.value > n),
      `> ${n}`,
    );
  }

  below(this: Predicates<number>, n: number): Claim {
    return this.build(
      computed(() => this.sig.value < n),
      `< ${n}`,
    );
  }

  near(this: Predicates<number>, n: number, tol = 1e-6): Claim {
    return this.build(
      computed(() => Math.abs(this.sig.value - n) <= tol),
      `≈ ${n}`,
    );
  }

  // ── Point / Vec ────────────────────────────────────────────────────

  /** Predicate that the point lies inside `bounds`. Accepts a
   *  `Bounds` or a `ReadonlySignal<AABB>`. */
  inside(
    this: Predicates<Vec>,
    bounds: Bounds | ReadonlySignal<AABB>,
  ): Claim {
    const aabbSig: ReadonlySignal<AABB> =
      bounds instanceof Bounds
        ? computed(() => bounds.value)
        : bounds;
    return this.build(
      computed(() => {
        const v = this.sig.value;
        const b = aabbSig.value;
        return v.x >= b.x && v.x <= b.x + b.w && v.y >= b.y && v.y <= b.y + b.h;
      }),
      `inside bounds`,
    );
  }

  // ── Signal-vs-signal ───────────────────────────────────────────────

  /** Pointwise equality with another signal of the same type. */
  equalTo(other: ReadonlySignal<T>): Claim {
    return this.build(
      computed(() => this.sig.value === other.value),
      `= other`,
    );
  }

  /** Pointwise closeness (numeric). Useful for bisimulation. */
  following(
    this: Predicates<number>,
    other: ReadonlySignal<number>,
    tol = 1e-9,
  ): Claim {
    return this.build(
      computed(() => Math.abs(this.sig.value - other.value) <= tol),
      `≈ other`,
    );
  }
}

// ── process() — persistent scope binding for a unit of work ──────────

/** Build a reusable named process. The factory is invoked once per
 *  `.run()` call; the returned `Process` has persistent lifecycle
 *  signals (`alive`, `started`, `completed`, `duration`) that any
 *  cross-process claim, `.during(p)` modifier, or process-duration
 *  claim can subscribe to once and observe across many runs.
 *
 *  Pattern:
 *
 *      const intro = process(function* () {
 *        yield* fadeIn(c, 0.3);
 *      }, bounded, reachesOne);
 *
 *      this.anim.loop(function* () {
 *        yield* intro.run();
 *        yield 1;
 *      });
 *
 *  Each `.run()` resets the attached claims and re-evaluates the
 *  predicates against a fresh execution. `process()` does not dispose
 *  the claims; they're values that outlive any single run. */
export function process(
  factory: () => Animator,
  ...claims: readonly Claim[]
): Process {
  return makeProcess(undefined, factory, claims);
}

/** `process` with an explicit label — appears in `.during(p)` and
 *  `.before/.after` failure messages. */
export function labelledProcess(
  label: string,
  factory: () => Animator,
  ...claims: readonly Claim[]
): Process {
  return makeProcess(label, factory, claims);
}

function makeProcess(
  label: string | undefined,
  factory: () => Animator,
  claims: readonly Claim[],
): Process {
  const alive = signal(false);
  const started = signal(false);
  const elapsed = signal(0);
  const completed = computed(() => started.value && !alive.value);

  const run = (): Animator =>
    (function* (): Animator {
      // Reset signals + claims so a fresh execution observes a
      // clean slate. Writes are independent — preact-signals
      // batches notifications within this synchronous block.
      for (const c of claims) c.reset();
      if (started.peek()) started.value = false;
      if (alive.peek()) alive.value = false;
      if (elapsed.peek() !== 0) elapsed.value = 0;
      started.value = true;
      alive.value = true;
      try {
        // Race work against a perpetual frame counter so we can
        // integrate dt for `duration` without changing work's
        // yield semantics. Work winning the race cancels the counter.
        yield race(
          factory(),
          (function* (): Animator {
            while (true) {
              const dt = yield;
              elapsed.value = elapsed.peek() + dt;
            }
          })(),
        );
      } finally {
        alive.value = false;
      }
    })();

  const proc: Record<string, unknown> = {
    alive,
    started,
    completed,
    duration: elapsed,
    run,
  };
  if (label !== undefined) proc.label = label;
  return proc as unknown as Process;
}

// ── n-ary composition (handy for spread cases) ───────────────────────

/** AND-reduction over claim signals. Returns a `ReadonlySignal<boolean>`
 *  that's `true` iff every claim is currently `true`. Force-reads all
 *  values so the computed registers them all as deps (plain
 *  `Array.every` short-circuits, breaking reactivity). */
export function held(
  ...claims: readonly ReadonlySignal<boolean>[]
): ReadonlySignal<boolean> {
  return computed(() => {
    let all = true;
    for (const c of claims) {
      if (!c.value) all = false;
    }
    return all;
  });
}

/** OR-reduction. `true` iff at least one is `true`. */
export function any(
  ...claims: readonly ReadonlySignal<boolean>[]
): ReadonlySignal<boolean> {
  return computed(() => {
    let some = false;
    for (const c of claims) {
      if (c.value) some = true;
    }
    return some;
  });
}

/** Negation of a bool signal. */
export function not(p: ReadonlySignal<boolean>): ReadonlySignal<boolean> {
  return computed(() => !p.value);
}

// ── Bisimulation ─────────────────────────────────────────────────────

/** Pointwise tracking — produces a `stays`-style claim that the two
 *  numeric signals agree within `tol` at every observation. */
export function track(
  actual: ReadonlySignal<number>,
  expected: ReadonlySignal<number>,
  opts: { tol?: number; label?: string } = {},
): Claim {
  const tol = opts.tol ?? 1e-9;
  const label = opts.label ?? "track";
  const pred = computed(
    () => Math.abs(actual.value - expected.value) <= tol,
  );
  return latchFalse(pred, label);
}

// ── Rendering ────────────────────────────────────────────────────────

/** A single dot that turns red when its bound bool signal is `false`,
 *  green when `true`. Useful for live pass/fail readouts inside a
 *  diagram — the test renders itself. */
export function verdictDot(
  source: ReadonlySignal<boolean>,
  opts: {
    at?: Pointlike;
    r?: number;
    pass?: string;
    fail?: string;
  } = {},
) {
  const at = opts.at ?? pt(0, 0);
  const r = opts.r ?? 5;
  const pass = opts.pass ?? "#2ecc71";
  const fail = opts.fail ?? "#e74c3c";
  return circle(at, r, {
    fill: source.derive((v) => (v ? pass : fail)),
    stroke: "none",
  });
}

// ── Internals ────────────────────────────────────────────────────────

function fmt(v: unknown): string {
  if (typeof v === "number") return String(+v.toFixed(6));
  if (typeof v === "string") return JSON.stringify(v);
  if (v && typeof v === "object" && "x" in v && "y" in v) {
    const p = v as Vec;
    return `(${fmt(p.x)}, ${fmt(p.y)})`;
  }
  return String(v);
}
