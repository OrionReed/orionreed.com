// Range + Timeline. Layer-B userland on top of signals + Anim:
//   - `range(dur, body?)` — a one-shot generator with introspectable
//     `elapsed` / `duration` / `t` signals. Default body advances elapsed
//     each frame until duration is reached (a plain sleep). Custom body
//     drives side effects (write a signal, call fn(t), etc.).
//   - `Timeline` — a writable composition of Ranged entries with their
//     own start times. Itself a generator; its `t` and `duration`
//     signals are reactive over entries' positions and durations.
//   - `durations({ a: 0.7, b: 1.2 })` — sugar for `{ a: signal(0.7),
//     b: signal(1.2) }`. The simple "named editable durations" pattern.

import { signal, computed, type Signal, type ReadonlySignal } from "./signal";
import { toSig, type Arg } from "./arg";
import type { Animator, Anim } from "./anim";

// ── Range ────────────────────────────────────────────────────────────

/** A generator with introspectable temporal state. Plain animators
 *  (springs, free integrators) don't carry these — they stay outside
 *  the Range vocabulary and can't be placed on a Timeline. */
export type Ranged = Animator & {
  readonly elapsed: ReadonlySignal<number>;
  readonly duration: ReadonlySignal<number>;
  readonly t: ReadonlySignal<number>;
};

interface RangeState {
  readonly t: ReadonlySignal<number>;
  readonly elapsed: Signal<number>;
  readonly duration: ReadonlySignal<number>;
}

/** Build a Range. Without a body, the default behaviour is to advance
 *  `elapsed` each frame until `duration` is reached — equivalent to
 *  `yield duration`, but with introspectable state. With a body, the
 *  body controls advancement and side effects:
 *
 *      range(0.5, ({ t, elapsed, duration }) => function* () {
 *        while (elapsed.value < duration.value) {
 *          const dt: number = yield;
 *          elapsed.value += dt;
 *          mySig.value = lerp(start, end, t.value);
 *        }
 *      }())
 *
 *  Single-use: once iterated to completion, the generator is exhausted.
 *  For looping animations, construct a fresh range inside the loop body. */
export function range(
  durArg: Arg<number>,
  body?: (state: RangeState) => Animator,
): Ranged {
  const duration = toSig(durArg);
  const elapsed = signal(0);
  const t = computed(() =>
    duration.value > 0 ? Math.min(elapsed.value / duration.value, 1) : 1,
  );
  const state: RangeState = { t, elapsed, duration };

  const gen = (
    body
      ? body(state)
      : (function* (): Animator {
          while (elapsed.value < duration.value) {
            const dt: number = yield;
            elapsed.value += dt;
          }
        })()
  ) as Ranged;

  return Object.assign(gen, { elapsed, duration, t });
}

// ── Timeline ─────────────────────────────────────────────────────────

export interface TimelineEntry {
  readonly at: Signal<number>;
  readonly range: Ranged;
}

/** A writable composition of Ranged entries. Each entry has a start
 *  time (signal-backed) and a Range that runs from that start. The
 *  Timeline is itself a generator: `yield* tl` plays it. Its
 *  `duration` signal is `max(at + range.duration)` reactively; `t` is
 *  `elapsed / duration` for a global playhead. */
export class Timeline {
  private _entries = signal<TimelineEntry[]>([]);
  readonly elapsed = signal(0);
  readonly duration = computed(() => {
    let max = 0;
    for (const e of this._entries.value) {
      const end = e.at.value + e.range.duration.value;
      if (end > max) max = end;
    }
    return max;
  });
  readonly t = computed(() =>
    this.duration.value > 0
      ? Math.min(this.elapsed.value / this.duration.value, 1)
      : 1,
  );

  get entries(): readonly TimelineEntry[] {
    return this._entries.value;
  }

  /** Append a Range. `at` defaults to the current `duration` (i.e.
   *  appends to the end of the timeline). Pass an explicit number or
   *  `Signal<number>` to overlap with earlier entries. Returns the
   *  entry so callers can mutate `at` later. */
  add(
    r: Ranged,
    opts: { at?: number | Signal<number> | "end" } = {},
  ): TimelineEntry {
    const at =
      opts.at === undefined || opts.at === "end"
        ? signal(this.duration.peek())
        : typeof opts.at === "number"
          ? signal(opts.at)
          : opts.at;
    const entry: TimelineEntry = { at, range: r };
    this._entries.value = [...this._entries.value, entry];
    return entry;
  }

  remove(entry: TimelineEntry): void {
    this._entries.value = this._entries.value.filter((e) => e !== entry);
  }

  /** Run the timeline from start to finish. Each `yield* tl` resets
   *  `elapsed` to 0 and walks until every active range completes.
   *  Single-pass — entries' ranges are consumed once. */
  *[Symbol.iterator](): Animator {
    const started = new Set<TimelineEntry>();
    const live = new Set<TimelineEntry>();
    this.elapsed.value = 0;

    while (true) {
      // Activate entries whose start time has been reached.
      for (const e of this._entries.value) {
        if (!started.has(e) && this.elapsed.value >= e.at.value) {
          started.add(e);
          live.add(e);
        }
      }

      const total = this.duration.value;
      if (this.elapsed.value >= total && live.size === 0) return;

      const dt: number = yield;
      this.elapsed.value += dt;

      // Step each live range one frame.
      for (const e of [...live]) {
        const r = e.range.next(dt);
        if (r.done) live.delete(e);
      }
    }
  }
}

export const timeline = (): Timeline => new Timeline();

// ── durations ────────────────────────────────────────────────────────

/** Sugar for `{ a: signal(initial.a), b: signal(initial.b), ... }`.
 *  Common pattern for "named editable durations" — slider knobs in a
 *  timeline editor, named phases in a sequence with editable timing. */
export function durations<const T extends Record<string, number>>(
  initial: T,
): { readonly [K in keyof T]: Signal<number> } {
  const out: Record<string, Signal<number>> = {};
  for (const key of Object.keys(initial)) {
    out[key] = signal(initial[key]);
  }
  return out as { [K in keyof T]: Signal<number> };
}

// ── pulse ────────────────────────────────────────────────────────────

/** Tick signal — increments every `sec` seconds while `anim` is active.
 *  Free function so the `Anim` runtime stays signal-free (layer-A pure);
 *  the bridge from runtime to reactivity lives at layer B with the rest
 *  of the temporal helpers. */
export function pulse(anim: Anim, sec: number): Signal<number> {
  const sig = signal(0);
  anim.loop(function* () {
    yield sec;
    sig.value = sig.peek() + 1;
  });
  return sig;
}
