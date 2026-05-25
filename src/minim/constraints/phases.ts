// phases.ts — pipeline phases for the `Constraints` step.
//
// A `Phase` is a function `(c, dt) => void` that does one piece of
// the work between "user wrote a signal" (or "frame ticked") and
// "downstream observers see the new state." Constraints' `step(dt)`
// just runs the pipeline in order.
//
// The four built-ins below cover the reactive sketchpad pipeline.
// Specialised factories (`physics`, `world`, …) declare their own
// pipelines wholesale, typically by interleaving these built-ins
// with their own integration / contact phases.
//
// Phase functions are always plain `(c, dt) => void` — no async,
// no return value, no middleware. The pipeline is just an array
// you can read top-to-bottom.

import type { Pack, Signal, Writable } from "../signals";
import type { Constraints } from "./cluster";

/** A single step in the `Constraints` pipeline. */
export type Phase = (c: Constraints, dt: number) => void;

interface Binding {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  readonly sig: Signal<any>;
  // biome-ignore lint/suspicious/noExplicitAny: same
  readonly pack: Pack<any>;
}

/** Read each bound signal into the solver's `positions` buffer.
 *  When called from inside a network body, `.value` reads subscribe
 *  the network — that's what makes the reactive driver react. */
export const snapshot: Phase = c => {
  const solver = c.solver;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  const bindings = (c as any)._bindings as readonly (Binding | undefined)[];
  const N = solver.cellCount;
  for (let id = 0; id < N; id++) {
    const b = bindings[id];
    if (!b) continue;
    b.pack.read(b.sig.value, solver.positions, solver.offsets[id]!);
  }
};

/** `solver.prepare()` — warm-start λ/penalty, snapshot positions
 *  into `initials`, and reset `anchors = positions`. Factories
 *  that integrate (physics, Adam, …) overwrite `anchors` after
 *  this phase but before `solve`. */
export const prepare: Phase = c => {
  c.solver.prepare();
};

/** `solver.solve(dt)` — the iteration loop. */
export const solve: Phase = (c, dt) => {
  c.solver.solve(dt);
};

/** Write solved positions back into bound signals. The auto-self-
 *  exclusion of the running network keeps these writes from re-firing
 *  the body; the auto-batch keeps them atomic for downstream observers. */
export const writeback: Phase = c => {
  const solver = c.solver;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  const bindings = (c as any)._bindings as readonly (Binding | undefined)[];
  const N = solver.cellCount;
  for (let id = 0; id < N; id++) {
    const b = bindings[id];
    if (!b) continue;
    // biome-ignore lint/suspicious/noExplicitAny: dynamic pack
    (b.sig as Writable<Signal<any>>).value = b.pack.write(solver.positions, solver.offsets[id]!);
  }
};

/** The default pipeline for a freshly-constructed `Constraints`:
 *  snapshot → prepare → solve → writeback. No time integration,
 *  no specialised state. Sketchpad / IK / Cassowary-style scenes
 *  use this as-is; physics-flavored factories declare their own. */
export const reactivePipeline: readonly Phase[] = [snapshot, prepare, solve, writeback];

/** Helper: grow a Float64Array buffer to at least `n` slots. Used
 *  by subsystems with per-cell state (velocity, gradient EMAs, etc.)
 *  that need to track cell additions. */
export function ensureCapacity(
  buf: Float64Array<ArrayBuffer>,
  n: number,
): Float64Array<ArrayBuffer> {
  if (buf.length >= n) return buf;
  const next = new Float64Array(Math.max(n, buf.length * 2));
  next.set(buf);
  return next;
}
