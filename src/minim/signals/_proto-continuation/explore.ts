// _proto-continuation/explore.ts — sandbox exploring the marriage of
// signals/lenses and generators.
//
// Three framings to compare:
//
//   1. `smoothLens(target, dur)` — continuation lens whose put is a
//      tween generator. Writes start an animator. Tests whether the
//      "lens" framing holds up.
//
//   2. `goalChaser(rest, opts)` — separate input (target) from output
//      (state). Returns BOTH a writable target signal AND the
//      continuously-chasing source. Drag writes target; spring chases
//      passively. No "rate: 0" hack required.
//
//   3. `reactiveCoroutine(body)` — generator IS the lens. The body
//      yields to wait for input changes; decides what to do per
//      cycle. The closest fit for the drag-state problem.

import { Num } from "../values/num";
import { type Writable } from "../writable";

// ── (1) smoothLens — naive continuation lens ─────────────────────
//
// The put schedules a tween. Each write cancels the prior tween.
// Reads return the current (intermediate) value. Verifying whether the
// lens semantics survive.

export interface SmoothOpts {
  /** Tween duration on each write, in seconds. */
  duration?: number;
  /** Animation engine. Caller must pass `this.anim` from a Diagram, or
   *  any equivalent scheduler. */
  schedule: (fn: (dt: number) => boolean | void) => () => void;
}

/** Continuation lens: writes start a tween toward the new target.
 *  Reads return the current tween-interpolated value. */
export function smoothLens(target: Writable<Num>, opts: SmoothOpts): Writable<Num> {
  const dur = opts.duration ?? 0.3;
  let cancelCurrent: (() => void) | undefined;

  return Num.lens(
    () => target.value,
    newTarget => {
      // Cancel prior tween, start fresh from the *current* value
      // toward the new target.
      cancelCurrent?.();
      const start = target.peek();
      let t = 0;
      cancelCurrent = opts.schedule(dt => {
        t += dt;
        if (t >= dur) {
          target.value = newTarget;
          return false; // done
        }
        target.value = start + (newTarget - start) * (t / dur);
        return true;
      });
    },
  );
}

// ── (2) goalChaser — separation of intent and state ──────────────
//
// Returns BOTH the writable goal AND the auto-chasing source. The
// drag-vs-spring tug-of-war disappears because drag writes the goal,
// not the source. Pauses in drag = goal doesn't change = source
// settles at the held goal. Release: caller writes a different goal.
//
// This isn't really a single lens — it's a *pair*: an input signal
// and an output signal, with a continuous animator binding them. The
// "lens" framing for continuation may actually just be a less honest
// way of describing this.

export interface ChaserOpts {
  /** Stiffness (spring-like; bigger = faster). Default 8. */
  k?: number;
  schedule: (fn: (dt: number) => boolean | void) => () => void;
}

export function goalChaser(
  initialValue: number,
  initialGoal: number,
  opts: ChaserOpts,
): { state: Num; goal: Writable<Num>; stop: () => void } {
  const state = new Num(initialValue) as unknown as Writable<Num>;
  const goal = new Num(initialGoal) as unknown as Writable<Num>;
  const k = opts.k ?? 8;

  // Continuously chase `goal`. Frame-by-frame the source moves toward
  // the goal at exponential rate. Equivalent to `toward(state, goal, k)`.
  const stop = opts.schedule(dt => {
    const cur = state.peek();
    const g = goal.peek();
    const decay = Math.exp(-k * dt);
    state.value = g + (cur - g) * decay;
    return true; // never terminates on its own
  });

  return {
    state: state as unknown as Num,
    goal,
    stop,
  };
}

// ── (3) reactiveCoroutine — generator IS the body ────────────────
//
// The generator body has full reactive access — it can read signals,
// decide what to do, yield to wait, and write outputs. Closer to a
// process / dynamical system than a lens.
//
// In our existing system, generators are animators (anim.ts). What's
// new here: the generator's outputs are signals (so subscribers see
// the value), AND it can compose with the lens algebra.
//
// Note: we don't need new machinery for this — `drive((tick) => ...)`
// already does it. What's missing is conceptualising the generator's
// "output signal" as a first-class thing.

/** A "process" that produces a value over time. Constructed with a
 *  generator body that uses `drive(...)` (or any other yield-shape)
 *  to write to its output. The output is exposed as a regular Num.
 *
 *  Example: drag-tolerant spring.
 *
 *      const result = processNum(0, function* (out, { tick }) {
 *        const goal = num(0);
 *        while (true) {
 *          // Each frame: write out toward goal.
 *          const t = yield* tick();
 *          out.value = nudge(out.peek(), goal.peek(), t.dt);
 *        }
 *      });
 *      // result.output: Num (read-only from outside)
 *      // result.goal: Writable<Num> (set this, the process chases)
 */
export interface Process<T> {
  output: T;
  stop: () => void;
}
// Sketch only; we won't go fully implement this — sketching the shape.
