// Claims — a one-file, one-idea testing/spec layer.
//
// A claim is a labeled `Signal<boolean>`. `true` = currently holding;
// `false` = violated (or not yet fulfilled, for liveness claims).
// Compose by signal composition (`held`, `any`, `not`); render by
// signal binding; scope to a process with `during`. That's the whole
// story — there is no Witness, no Verdict object, no Policy enum.
//
//     const bounded  = claim(c.opacity, "α").stays.in([0, 1]);
//     const reaches1 = claim(c.opacity, "α").becomes.equal(1);
//     const allOk    = held(bounded, reaches1);
//
//     yield* during(fadeIn(c, 0.3), bounded, reaches1);
//
// Each claim wires one `effect` and exposes a couple of management
// hooks (`reset`, `dispose`) tacked onto the underlying signal. The
// signal is the API; everything else is metadata.

import {
  signal,
  computed,
  effect,
  Signal,
  type ReadonlySignal,
} from "./core/signal";
import type { Animator } from "./core/anim";
import type { Vec } from "./core/vec";
import { Bounds, type AABB } from "./scene/bounds";
import { circle } from "./shapes/circle";
import { pt, type Pointlike } from "./scene/point";

// ── Types ────────────────────────────────────────────────────────────

/** A claim is a labeled `Signal<boolean>`. `.value === true` while the
 *  claim holds; flips to `false` on violation (or `false → true` once
 *  fulfilled, for liveness claims).
 *
 *  - `reset()` clears the latched state — call at the top of each
 *    scope to re-check the claim against a fresh run.
 *  - `dispose()` tears down the underlying `effect` subscription.
 *    `during` does not call this; persistent claims outlive their
 *    scopes by default. */
export type Claim = ReadonlySignal<boolean> & {
  readonly label?: string;
  reset(): void;
  dispose(): void;
};

/** Handle returned by `during`. Wraps the work as an Animator, plus
 *  exposes `alive` — `true` while the work is running, useful for
 *  cross-process claims. */
export type DuringHandle = Animator & {
  /** True while the wrapped work is running. Use in predicates that
   *  talk about another process: `claim(other.alive).never.true()`. */
  readonly alive: ReadonlySignal<boolean>;
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
 *  latches `true` until `reset`. Used for `becomes.X`. At scope close
 *  a `false` value means the eventual never happened. */
function latchTrue(p: ReadonlySignal<boolean>, label?: string): Claim {
  const held = signal(false);
  const stop = effect(() => {
    if (!held.peek() && p.value) held.value = true;
  });
  return finalize(held, label, () => {
    held.value = p.peek() ? true : false;
  }, stop);
}

/** No latching — the claim is just `p`. Used for `ends.X`: the
 *  predicate is read at scope close. Resetting is a no-op. */
function passthrough(p: ReadonlySignal<boolean>, label?: string): Claim {
  const wrapped = computed(() => p.value);
  return finalize(wrapped as Signal<boolean>, label, () => {}, () => {});
}

/** Tack `label`, `reset`, `dispose` onto a bool signal to make it a
 *  `Claim`. The signal-ness is preserved. */
function finalize(
  sig: ReadonlySignal<boolean>,
  label: string | undefined,
  reset: () => void,
  dispose: () => void,
): Claim {
  const meta: { label?: string; reset: () => void; dispose: () => void } = {
    reset,
    dispose,
  };
  if (label !== undefined) meta.label = label;
  return Object.assign(sig, meta) as Claim;
}

// ── Fluent entry ─────────────────────────────────────────────────────

/** Start a claim sentence: `claim(sig, "α").stays.in([0, 1])`. The
 *  optional `label` shows up in failure metadata and rendered labels. */
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
   *  `true` on first fulfillment; `false` at scope end means the
   *  eventual never happened. */
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
      case "never":   return latchFalse(invert(pred), label);
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

// ── Scope binding ────────────────────────────────────────────────────

/** Run `work`, resetting each claim's latch at scope entry so the run
 *  starts from a clean verdict. Returns an `Animator & { alive }`.
 *
 *  `during` does not dispose the claims — they're values you keep
 *  hold of and re-use. Each loop iteration re-resets them so the
 *  pip flickers per-iteration. For one-shot use, call `.dispose()`
 *  on the claim explicitly when you're done. */
export function during(
  work: Animator,
  ...claims: readonly Claim[]
): DuringHandle {
  const alive = signal(false);
  const gen = (function* () {
    for (const c of claims) c.reset();
    alive.value = true;
    try {
      yield* work;
    } finally {
      alive.value = false;
    }
  })() as DuringHandle & { alive: Signal<boolean> };
  (gen as { alive: ReadonlySignal<boolean> }).alive = alive;
  return gen;
}

// ── Composition (signal algebra) ─────────────────────────────────────

/** AND-reduction over claim signals. Returns a `ReadonlySignal<boolean>`
 *  that's `true` iff every claim is currently `true`. */
export function held(
  ...claims: readonly ReadonlySignal<boolean>[]
): ReadonlySignal<boolean> {
  // Force-read every value so the computed registers all as deps.
  // Plain `Array.every` short-circuits, which would mean signals
  // past the first `false` wouldn't be tracked — flipping them
  // wouldn't re-fire the aggregate.
  return computed(() => {
    let all = true;
    for (const c of claims) {
      if (!c.value) all = false;
    }
    return all;
  });
}

/** OR-reduction over claim signals. `true` iff at least one is `true`. */
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

function invert(p: ReadonlySignal<boolean>): ReadonlySignal<boolean> {
  return computed(() => !p.value);
}

// ── Bisimulation ─────────────────────────────────────────────────────

/** Pointwise tracking — produces a `stays`-style claim that the two
 *  numeric signals agree within `tol` at every observation. Failure
 *  metadata uses `opts.label` if provided. */
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
