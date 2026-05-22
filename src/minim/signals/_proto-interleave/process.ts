// process.ts — making generator processes observable as signals.
//
// Today a generator is opaque: you can only call .next(). It has
// implicit state (alive, parked, current yield) that you can't read.
//
// What if every animator process exposed:
//   - alive:    Read<boolean>      — has the gen returned?
//   - producing: Read<boolean>     — actively writing (vs parked)?
//   - lastEmit: Read<T | undefined> — most recent yielded payload
//
// These primitives make the runtime's internal state available as
// signals — composable with everything else.
//
// Two flavors below:
//   A. observe() — wrap a regular Animator; manually call .step(tick).
//   B. signalGen() — a generator whose yields ARE the value of a Signal<T>.

import type { Animator, Tick } from "../../core";
import { computed, type Read, Signal } from "../signal";

// ── A. observe() — process-as-signals wrapper ────────────────────

export interface Process<T> {
  alive: Read<boolean>;
  producing: Read<boolean>;
  lastEmit: Read<T | undefined>;
  /** Drive one step. Returns whether the process is still alive. */
  step(tick: Tick): boolean;
}

/** Wrap an Animator<T> so its execution state is observable as signals.
 *  Caller is responsible for driving .step(tick) each frame. */
export function observe<T>(gen: Animator<T>): Process<T> {
  const alive = new Signal<boolean>(true);
  const producing = new Signal<boolean>(false);
  const lastEmit = new Signal<T | undefined>(undefined);

  return {
    alive,
    producing,
    lastEmit,
    step(tick: Tick): boolean {
      if (!alive.peek()) return false;
      producing.value = true;
      try {
        const r = gen.next(tick);
        if (r.done) {
          alive.value = false;
          producing.value = false;
          // Final return becomes the lastEmit, too.
          if (r.value !== undefined) lastEmit.value = r.value as T;
          return false;
        }
        // yielded value as the "emission" (only meaningful if T-shaped).
        if (r.value !== undefined) lastEmit.value = r.value as T;
      } catch (e) {
        alive.value = false;
        producing.value = false;
        throw e;
      } finally {
        producing.value = false;
      }
      return true;
    },
  };
}

// ── B. signalGen() — generator-driven signal ─────────────────────
//
// The generator yields VALUES of T (intermixed with explicit control
// markers). A driver gives it ticks; each yielded T becomes the
// signal's new value.
//
// Design lesson: we can't reuse Anim's "bare-number = sleep"
// convention here because T might be number. We need EXPLICIT
// control markers. This is itself a finding — the existing yield
// dispatch is value-class-fragile.

const SLEEP = Symbol("signalGen:sleep");
const WAIT_FRAME = Symbol("signalGen:wait");

type SleepMarker = { readonly [SLEEP]: number };
type WaitMarker = typeof WAIT_FRAME;

/** Yield this to wait `s` seconds. */
export const sleep = (s: number): SleepMarker => ({ [SLEEP]: s });
/** Yield this (or bare `yield`) to wait one frame. */
export const wait: WaitMarker = WAIT_FRAME;

type SignalGenYield<T> = T | SleepMarker | WaitMarker | undefined;

export interface SignalGen<T> {
  signal: Signal<T>;
  step(tick: Tick): boolean;
}

const isSleep = (v: unknown): v is SleepMarker =>
  v !== null && typeof v === "object" && SLEEP in (v as object);

export function signalGen<T>(
  body: () => Generator<SignalGenYield<T>, void, Tick>,
  initial: T,
): SignalGen<T> {
  const sig = new Signal<T>(initial);
  const gen = body();
  let sleepUntil = 0;
  let elapsed = 0;
  let firstStep = true;
  let done = false;

  return {
    signal: sig,
    step(tick: Tick): boolean {
      if (done) return false;
      elapsed += tick.dt;
      if (elapsed < sleepUntil) return true;

      let r = firstStep ? gen.next() : gen.next(tick);
      firstStep = false;
      while (!r.done) {
        const v = r.value;
        if (v === undefined || v === WAIT_FRAME) return true;
        if (isSleep(v)) {
          const s = (v as SleepMarker)[SLEEP];
          if (s > 0) sleepUntil = elapsed + s;
          return true;
        }
        sig.value = v as T;
        r = gen.next(tick);
      }
      done = true;
      return false;
    },
  };
}

// ── C. Process composition: derive a signal that depends on
//     several processes (alive, producing, etc.) ──────────────────

export function allAlive(procs: Process<unknown>[]): Read<boolean> {
  return computed(() => procs.every(p => p.alive.value));
}

export function anyProducing(procs: Process<unknown>[]): Read<boolean> {
  return computed(() => procs.some(p => p.producing.value));
}
