// Timeline + Clip. A timeline is a clock plus named clips (each an
// `[at, at + dur)` interval); `yield* tl` advances the clock to
// `duration`. `sequential({...})` produces cumulative-start specs.

import type { Animator } from "@minim/core";
import {
  type Cell,
  derive,
  type Init,
  isComputed,
  Num,
  num,
  Range,
  span,
  type Writable,
} from "@minim/signals";

/** A clip on a timeline. `t` clamps to 0 before / 1 after, so
 *  `derive(() => ease(clip.t.value))` needs no guards. Per-field
 *  writability flows through `ResolvedField` / `ResolvedSpan`: writable
 *  inputs yield draggable knobs, RO inputs (e.g. `sequential()`'s `at`)
 *  stay RO. */
export type Clip<A = number, D = number> = {
  readonly at: ResolvedField<A>;
  readonly dur: ResolvedField<D>;
  readonly end: Num;
  readonly span: ResolvedSpan<A, D>;
  /** Progress: 0 before `at`, 0..1 within, 1 after `end`. */
  readonly t: Num;
  readonly active: Cell<boolean>;
};

// Writability narrowing: `number`/`Writable<Num>` → `Writable<Num>`,
// bare `Num` stays RO. Brand check first (`Writable<Num>` is a `Num`).
type ResolvedField<A> = [A] extends [Writable<Num>]
  ? Writable<Num>
  : [A] extends [number]
    ? Writable<Num>
    : Num;

type IsWritable<A> = [A] extends [Writable<Num>] ? true : [A] extends [number] ? true : false;
type ResolvedSpan<A, D> =
  IsWritable<A> extends true ? (IsWritable<D> extends true ? Writable<Range> : Range) : Range;

type ClipSpec = { at: number | Num; dur: number | Num };

export interface Timeline {
  readonly clock: Writable<Num>;
  readonly duration: Num;
  /** `clock / duration`, clamped to `[0, 1]`. */
  readonly t: Num;
  readonly clips: readonly Clip[];
  /** `yield* tl` advances `clock` to `duration`. No auto-reset (use
   *  `snapshot(tl.clock)` for loops). */
  [Symbol.iterator](): Animator;
}

/** Type-preserving named-clip access. */
export type TimelineOf<T extends Record<string, ClipSpec>> = Timeline & {
  readonly [K in keyof T]: T[K] extends { at: infer A; dur: infer D } ? Clip<A, D> : Clip;
};

class TimelineImpl implements Timeline {
  readonly clock: Writable<Num>;
  readonly duration: Num;
  readonly t: Num;
  readonly clips: readonly Clip[];

  constructor(clock: Writable<Num>, clips: readonly Clip[]) {
    this.clock = clock;
    this.clips = clips;
    this.duration = Num.derive(() => {
      let max = 0;
      for (const c of clips) {
        const e = c.end.value;
        if (e > max) max = e;
      }
      return max;
    });
    this.t = Num.derive(() => {
      const d = this.duration.value;
      return d > 0 ? Math.min(this.clock.value / d, 1) : 0;
    });
  }

  *[Symbol.iterator](): Animator {
    while (this.clock.value < this.duration.value) {
      const { dt } = yield;
      this.clock.value += dt;
    }
  }
}

function makeClip(spec: ClipSpec, clock: Num): Clip {
  const at = Num.from(spec.at);
  const dur = Num.from(spec.dur);
  const end = Num.derive(() => at.value + dur.value);
  // Bidirectional span when both inputs are writable; RO derive when
  // either is computed. Mirrors `ResolvedSpan`.
  const sp =
    isComputed(at) || isComputed(dur)
      ? Range.derive(() => ({ lo: at.value, hi: at.value + dur.value }))
      : span(at as Writable<Num>, dur as Writable<Num>);
  const t = Num.derive(() => {
    const c = clock.value;
    const a = at.value;
    const d = dur.value;
    if (c <= a) return 0;
    if (c >= a + d) return 1;
    return d > 0 ? (c - a) / d : 1;
  });
  const active = derive(() => {
    const c = clock.value;
    return c >= at.value && c < end.value;
  });
  return { at, dur, span: sp, end, t, active } as Clip;
}

/** Build a timeline from clip specs. `at`/`dur` accept numbers or `Num`
 *  cells; clips may overlap or gap. See `sequential()` for cumulative starts. */
export function timeline<T extends Record<string, ClipSpec>>(specs: T): TimelineOf<T> {
  const clock = num(0);
  const clips: Clip[] = [];
  const named: Record<string, Clip> = {};
  for (const key of Object.keys(specs)) {
    const clip = makeClip(specs[key as keyof T] as ClipSpec, clock);
    clips.push(clip);
    named[key] = clip;
  }
  const tl = new TimelineImpl(clock, clips) as TimelineImpl & Record<string, Clip>;
  Object.assign(tl, named);
  return tl as TimelineOf<T>;
}

type Durations = Record<string, Init<Num>>;

/** Cumulative-start helper: each clip's `at` is the reactive sum of
 *  prior durations (RO). Use `timeline()` directly for draggable starts.
 *
 *      timeline(sequential({ intro: 0.7, hold: 1.2, outro: 0.5 }));
 */
export function sequential<T extends Durations>(
  durs: T,
): { [K in keyof T]: { at: Num; dur: ResolvedField<T[K]> } } {
  const keys = Object.keys(durs) as Array<keyof T>;
  const durSigs: Writable<Num>[] = keys.map(k => num(durs[k] as Init<Num>));
  const out = {} as Record<string, { at: Num; dur: Num }>;
  keys.forEach((key, i) => {
    const idx = i;
    const at = Num.derive(() => {
      let sum = 0;
      for (let j = 0; j < idx; j++) sum += durSigs[j].value;
      return sum;
    });
    out[key as string] = { at, dur: durSigs[i] };
  });
  return out as {
    [K in keyof T]: { at: Num; dur: ResolvedField<T[K]> };
  };
}
