// Timeline + Clip. A timeline is a clock plus named clips (each an
// `[at, at + dur)` interval); `yield* tl` advances the clock to
// `duration`. `sequential({...})` produces cumulative-start specs.

import {type Animator} from "@minim/core";
import { num,type Val} from "@minim/signals";
import {signal, computed, type Signal} from "@minim/signals";

// ── Types ────────────────────────────────────────────────────────────

/** A clip on a timeline. `t` extends past the endpoints (0 before,
 *  1 after) so `computed(() => (ease)(clip.t.value))` works without conditional checks.
 *  Generic over input flavor — passing a literal or writable `Cell`
 *  gives a writable `at`/`dur`; passing a `ReadonlyCell` or thunk
 *  gives the read-only flavor. */
export type Clip<A = number, D = number> = {
  readonly at: ResolvedField<A>;
  readonly dur: ResolvedField<D>;
  readonly end: Signal<number>;
  /** Progress: 0 before `at`, 0..1 within, 1 after `end`. */
  readonly t: Signal<number>;
  readonly active: Signal<boolean>;
};

// Inlined per-field flavor narrowing (replaces the dropped `ResolveSig`
// helper). A writable `Signal<number>` or a literal number gives back a
// `Signal<number>`; anything that's only readable (or a thunk) gives back
// `Signal<number>`. The order matters: `Cell` is checked before
// `ReadonlyCell` because `Signal<T>` is structurally a `Signal<T>`.
type ResolvedField<A> = [A] extends [Signal<number>]
  ? Signal<number>
  : [A] extends [Signal<number> | (() => number)]
    ? Signal<number>
    : Signal<number>;

type ClipSpec = { at: Val<number>; dur: Val<number> };

export interface Timeline {
  readonly clock: Signal<number>;
  readonly duration: Signal<number>;
  /** `clock / duration`, clamped to `[0, 1]`. */
  readonly t: Signal<number>;
  readonly clips: readonly Clip[];
  /** `yield* tl` advances `clock` to `duration`. No auto-reset — for
   *  loops, use `snapshot(tl.clock)`. */
  [Symbol.iterator](): Animator;
}

/** Type-preserving named-clip access. */
export type TimelineOf<T extends Record<string, ClipSpec>> = Timeline & {
  readonly [K in keyof T]: T[K] extends { at: infer A; dur: infer D }
    ? Clip<A, D>
    : Clip;
};

// ── Implementation ───────────────────────────────────────────────────

class TimelineImpl implements Timeline {
  readonly clock: Signal<number>;
  readonly duration: Signal<number>;
  readonly t: Signal<number>;
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
  const at = num(spec.at);
  const dur = num(spec.dur);
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

type Durations = Record<string, Val<number>>;

/** Cumulative-start helper. Each clip's `at` is the reactive sum of
 *  prior durations, so editing one duration ripples through. `at` is
 *  a `ReadonlySignal` (use `timeline()` directly for draggable starts).
 *
 *      timeline(sequential({ intro: 0.7, hold: 1.2, outro: 0.5 }));
 */
export function sequential<T extends Durations>(
  durs: T,
): { [K in keyof T]: { at: Signal<number>; dur: ResolvedField<T[K]> } } {
  const keys = Object.keys(durs) as Array<keyof T>;
  const durSigs: Signal<number>[] = keys.map((k) =>
    num(durs[k] as Val<number>),
  );
  const out = {} as Record<
    string,
    { at: Signal<number>; dur: Signal<number> }
  >;
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
    [K in keyof T]: { at: Signal<number>; dur: ResolvedField<T[K]> };
  };
}
