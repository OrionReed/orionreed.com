// propagator.ts — Propagator type + helpers.
//
// A propagator is a triple: `reads`, `writes`, and `step()`. The
// network subscribes to `reads` and freshness-gates on them, and
// detects output changes by peek-comparing `writes`.
//
// Propagators are plain objects over plain signal arrays (not
// classes) — the non-coloring entry point: any existing signal can
// participate without adopting a new type.

import type { Cell, Writable } from "../signals";

/** Plain object, no new types required: `reads`/`writes` declare the
 *  topology, `step()` does the work.
 *
 *  `Cell<any>` (not `unknown`) lets variant subtypes assign without
 *  casts; the framework only uses identity / `peek()`, never the type. */
export interface Propagator {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous topology
  readonly reads: readonly Cell<any>[];
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous topology
  readonly writes: readonly Cell<any>[];
  step(): void;
}

/** Convenience constructor. */
// biome-ignore lint/suspicious/noExplicitAny: see header
export function propagator(
  reads: readonly Cell<any>[],
  // biome-ignore lint/suspicious/noExplicitAny: see header
  writes: readonly Writable<Cell<any>>[],
  step: () => void,
): Propagator {
  return { reads, writes, step };
}
