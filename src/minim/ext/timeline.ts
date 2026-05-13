// Timeline + Clip. A timeline is a clock plus named clips (each an
// `[at, at + dur)` interval); `yield* tl` advances the clock to
// `duration`. `sequential({...})` produces cumulative-start specs.

import {
  signal,
  computed,
  toSig,
  type Signal,
  type ReadonlySignal,
  type Arg,
  type NumSig,
  type ResolveSig,
  type Animator,
} from "@minim/core";

// ── Types ────────────────────────────────────────────────────────────

/** A clip on a timeline. `t` extends past the endpoints (0 before,
 *  1 after) so `clip.t.derive(ease)` works without conditional checks. */
export type Clip<A = number, D = number> = {
  /** Start. Writable iff caller passed a writable signal/literal. */
  readonly at: ResolveSig<A, number>;
  /** Duration. Same writability rules as `at`. */
  readonly dur: ResolveSig<D, number>;
  readonly end: ReadonlySignal<number>;
  /** Progress: 0 before `at`, 0..1 within, 1 after `end`. */
  readonly t: ReadonlySignal<number>;
  readonly active: ReadonlySignal<boolean>;
};

type ClipSpec = { at: Arg<number>; dur: Arg<number> };

export interface Timeline {
  readonly clock: Signal<number>;
  readonly duration: ReadonlySignal<number>;
  /** `clock / duration`, clamped to `[0, 1]`. */
  readonly t: ReadonlySignal<number>;
  readonly clips: readonly Clip[];
  /** `yield* tl` advances `clock` to `duration`. No auto-reset — for
   *  loops, use `snapshot(tl.clock)`. */
  [Symbol.iterator](): Animator;
}

/** Type-preserving named-clip access via `ResolveSig`. */
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
      const dt = yield;
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

/** Build a timeline from a record of clip specs. `at` and `dur` accept
 *  numbers, signals, or thunks; clips can overlap or leave gaps. For
 *  cumulative-start sequential clips, see `sequential()`. */
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
  const tl = new TimelineImpl(clock, clips) as TimelineImpl &
    Record<string, Clip>;
  Object.assign(tl, named);
  return tl as TimelineOf<T>;
}

// ── sequential ───────────────────────────────────────────────────────

type Durations = Record<string, Arg<number>>;

/** Cumulative-start helper. Each clip's `at` is the reactive sum of
 *  prior durations, so editing one duration ripples through. `at` is
 *  a `ReadonlySignal` (use `timeline()` directly for draggable starts).
 *
 *      timeline(sequential({ intro: 0.7, hold: 1.2, outro: 0.5 }));
 */
export function sequential<T extends Durations>(
  durs: T,
): {
  [K in keyof T]: { at: ReadonlySignal<number>; dur: ResolveSig<T[K], number> };
} {
  const keys = Object.keys(durs) as Array<keyof T>;
  const durSigs: NumSig[] = keys.map(
    (k) => toSig(durs[k] as Arg<number>) as NumSig,
  );
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
    [K in keyof T]: {
      at: ReadonlySignal<number>;
      dur: ResolveSig<T[K], number>;
    };
  };
}
