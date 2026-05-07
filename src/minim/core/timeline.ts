// Timeline + Clip primitive. A timeline is a clock plus named clips
// (each a `[at, at + dur)` interval); progress within each clip is
// derived from the clock. Yieldable: `yield* tl` advances the clock
// from current to total `duration`, then completes.
//
// For the common "sequential phases" pattern, `sequential({...})`
// produces clip specs whose `at`s are reactive cumulative starts —
// editing one duration ripples through to subsequent starts.

import {
  signal,
  computed,
  type Signal,
  type ReadonlySignal,
} from "./signal";
import { toSig, type Arg, type NumSig, type ResolveSig } from "./arg";
import type { Animator } from "./anim";

// ── Types ────────────────────────────────────────────────────────────

/** A clip on a timeline: an interval `[at, at + dur)` whose progress
 *  `t` is derived from the timeline's clock. The `t` extends past the
 *  endpoints (0 before, 1 after) so derivations like
 *  `clip.t.derive(easeInOut)` work for fades, holds, and oscillations
 *  without conditional checks. */
export type Clip<A = number, D = number> = {
  /** Start time. Editable iff the user passed a writable signal/literal. */
  readonly at: ResolveSig<A, number>;
  /** Duration. Same writability rules as `at`. */
  readonly dur: ResolveSig<D, number>;
  /** `at + dur`, reactive. */
  readonly end: ReadonlySignal<number>;
  /** Progress: 0 before `at`, 0..1 from `at` to `end`, 1 after `end`. */
  readonly t: ReadonlySignal<number>;
  /** True iff `at <= clock < end`. */
  readonly active: ReadonlySignal<boolean>;
};

/** Internal — input shape for `timeline()`. Not exported; users either
 *  pass object literals (whose types are inferred) or feed `sequential()`'s
 *  output through. */
type ClipSpec = { at: Arg<number>; dur: Arg<number> };

export interface Timeline {
  /** Current playhead time in seconds; writable for scrubbing or reset. */
  readonly clock: Signal<number>;
  /** `max(end)` across all clips, reactive in clip durations and starts. */
  readonly duration: ReadonlySignal<number>;
  /** `clock / duration`, clamped to [0, 1]. */
  readonly t: ReadonlySignal<number>;
  /** All clips in insertion order. */
  readonly clips: readonly Clip[];
  /** Yielding the timeline advances `clock` from current to `duration`,
   *  then completes. No auto-reset — for loops, write `clock.value = 0`
   *  at the top of the loop body (or use `snapshot(tl.clock)`). */
  [Symbol.iterator](): Animator;
}

/** Type-preserving named-clip access: each named clip's at/dur
 *  writability is preserved from the input via `ResolveSig`. */
export type TimelineOf<T extends Record<string, ClipSpec>> = Timeline & {
  readonly [K in keyof T]: T[K] extends { at: infer A; dur: infer D }
    ? Clip<A, D>
    : Clip;
};

// ── Implementation ───────────────────────────────────────────────────

class TimelineImpl implements Timeline {
  readonly clock: Signal<number>;
  readonly duration: ReadonlySignal<number>;
  readonly t: ReadonlySignal<number>;
  readonly clips: readonly Clip[];

  constructor(clock: Signal<number>, clips: readonly Clip[]) {
    this.clock = clock;
    this.clips = clips;
    this.duration = computed(() => {
      let max = 0;
      for (const c of clips) {
        const e = c.end.value;
        if (e > max) max = e;
      }
      return max;
    });
    this.t = computed(() => {
      const d = this.duration.value;
      return d > 0 ? Math.min(this.clock.value / d, 1) : 0;
    });
  }

  *[Symbol.iterator](): Animator {
    while (this.clock.value < this.duration.value) {
      const dt: number = yield;
      this.clock.value += dt;
    }
  }
}

function makeClip(spec: ClipSpec, clock: Signal<number>): Clip {
  const at = toSig(spec.at) as NumSig;
  const dur = toSig(spec.dur) as NumSig;
  const end = computed(() => at.value + dur.value);
  const t = computed(() => {
    const c = clock.value;
    const a = at.value;
    const d = dur.value;
    if (c <= a) return 0;
    if (c >= a + d) return 1;
    return d > 0 ? (c - a) / d : 1;
  });
  const active = computed(() => {
    const c = clock.value;
    return c >= at.value && c < end.value;
  });
  return { at, dur, end, t, active } as Clip;
}

/** Construct a timeline from a record of clip specs. Each spec is
 *  `{ at, dur }` where both accept literal numbers, signals, or thunks.
 *  Clips can overlap freely and leave gaps — `at` is independent per
 *  clip (no auto-cumulative). For sequential clips, see `sequential()`. */
export function timeline<T extends Record<string, ClipSpec>>(
  specs: T,
): TimelineOf<T> {
  const clock = signal(0);
  const clips: Clip[] = [];
  const named: Record<string, Clip> = {};
  for (const key of Object.keys(specs)) {
    const clip = makeClip(specs[key as keyof T] as ClipSpec, clock);
    clips.push(clip);
    named[key] = clip;
  }
  const tl = new TimelineImpl(clock, clips) as TimelineImpl & Record<string, Clip>;
  // Attach named clips for `tl.intro` etc. (typed via TimelineOf).
  Object.assign(tl, named);
  return tl as TimelineOf<T>;
}

// ── sequential ───────────────────────────────────────────────────────

type Durations = Record<string, Arg<number>>;

/** Cumulative-start helper. Takes a record of durations and returns
 *  clip specs whose `at`s are reactive sums of prior durations.
 *
 *      const tl = timeline(sequential({ intro: 0.7, hold: 1.2, outro: 0.5 }));
 *      // tl.intro.at = 0; tl.hold.at = intro.dur; tl.outro.at = intro.dur + hold.dur.
 *
 *  Sequential clips' `at` is a derived `ReadonlySignal` (not writable);
 *  users edit `dur`s and starts ripple through. For independent draggable
 *  clip starts, pass explicit specs to `timeline()` instead. */
export function sequential<T extends Durations>(
  durs: T,
): { [K in keyof T]: { at: ReadonlySignal<number>; dur: ResolveSig<T[K], number> } } {
  const keys = Object.keys(durs) as Array<keyof T>;
  const durSigs: NumSig[] = keys.map((k) => toSig(durs[k] as Arg<number>) as NumSig);
  const out = {} as Record<string, { at: ReadonlySignal<number>; dur: NumSig }>;
  keys.forEach((key, i) => {
    const idx = i;
    const at = computed(() => {
      let sum = 0;
      for (let j = 0; j < idx; j++) sum += durSigs[j].value;
      return sum;
    });
    out[key as string] = { at, dur: durSigs[i] };
  });
  return out as {
    [K in keyof T]: { at: ReadonlySignal<number>; dur: ResolveSig<T[K], number> };
  };
}
