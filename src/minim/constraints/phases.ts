// phases.ts — pipeline phases for the `Constraints` step.
//
// A `Phase` is a plain `(c, dt) => void` doing one piece of work
// between a signal write (or frame tick) and downstream observers
// seeing the new state. `step(dt)` runs the pipeline in order.
//
// The four built-ins below form the reactive sketchpad pipeline.
// Specialised factories (`physics`, `world`, …) declare their own
// pipelines, interleaving these with integration / contact phases.

import type { Cell, Pack, Writable } from "../signals";
import type { Constraints } from "./cluster";

/** A single step in the `Constraints` pipeline. */
export type Phase = (c: Constraints, dt: number) => void;

interface Binding {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  readonly sig: Cell<any>;
  // biome-ignore lint/suspicious/noExplicitAny: same
  readonly pack: Pack<any>;
}

/** Read each bound signal into the solver's `positions` buffer. The
 *  `.value` reads subscribe the network when run inside its body. */
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

/** `solver.prepare()` — warm-start λ/penalty, snapshot `initials`,
 *  reset `anchors = positions`. Integrating factories overwrite
 *  `anchors` after this phase but before `solve`. */
export const prepare: Phase = c => {
  c.solver.prepare();
};

/** `solver.solve(dt)` — the iteration loop. */
export const solve: Phase = (c, dt) => {
  c.solver.solve(dt);
};

/** Write solved positions back into bound signals. The network's
 *  self-exclusion stops these writes from re-firing the body; the
 *  auto-batch keeps them atomic for observers. */
export const writeback: Phase = c => {
  const solver = c.solver;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous binding registry
  const bindings = (c as any)._bindings as readonly (Binding | undefined)[];
  const N = solver.cellCount;
  for (let id = 0; id < N; id++) {
    const b = bindings[id];
    if (!b) continue;
    // biome-ignore lint/suspicious/noExplicitAny: dynamic pack
    (b.sig as Writable<Cell<any>>).value = b.pack.write(solver.positions, solver.offsets[id]!);
  }
};

/** Default pipeline: snapshot → prepare → solve → writeback. No time
 *  integration. Sketchpad / IK / Cassowary scenes use it as-is. */
export const reactivePipeline: readonly Phase[] = [snapshot, prepare, solve, writeback];

/** Grow a Float64Array to at least `n` slots, preserving contents. */
export function ensureCapacity(
  buf: Float64Array<ArrayBuffer>,
  n: number,
): Float64Array<ArrayBuffer> {
  if (buf.length >= n) return buf;
  const next = new Float64Array(Math.max(n, buf.length * 2));
  next.set(buf);
  return next;
}
