// propagator.ts — Propagator type + helpers. PROTOTYPE.
//
// A propagator is a triple: which signals it reads, which it writes,
// and a step() function that does the work. The network uses `reads`
// to subscribe (via `.value` reads inside step) and to determine
// when to re-run via freshness propagation; it uses `writes` to
// detect changes via peek-comparison.
//
// Crucial design choice: propagators are PLAIN OBJECTS with simple
// arrays of signals, not classes. This is the non-coloring entry
// point — any existing `Writable<Num>`, `Writable<Vec>`, lensed
// signal, or custom signal type can be a propagator participant
// without adopting any new type. The propagator wraps the operation;
// the signals stay as they are.

import type { Signal, Writable } from "../signals";

/** The propagator interface. Plain object, no new types required.
 *
 *  - `reads`: signals the propagator reads. Used by the network for
 *    subscription and freshness gating. Reading these inside `step()`
 *    via `.value` subscribes the network as a side-effect.
 *  - `writes`: signals the propagator writes. Used by the network for
 *    change detection (peek-based comparison around `step()`).
 *  - `step()`: imperative body. Reads inputs (typically via .value),
 *    computes, writes outputs (typically via .value =).
 *
 *  `Signal<any>` (not `Signal<unknown>`) so that variant subtypes
 *  (`Writable<Num>`, `Writable<Vec>`, lensed signals, …) all assign
 *  in cleanly without intermediate casts. The framework only uses
 *  identity / `peek()` on these references, never their type. */
export interface Propagator {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous topology
  readonly reads: readonly Signal<any>[];
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous topology
  readonly writes: readonly Signal<any>[];
  step(): void;
}

/** Convenience constructor. Signals can be of any type — the
 *  declaration doesn't constrain value classes, just the read/write
 *  topology. */
// biome-ignore lint/suspicious/noExplicitAny: see header
export function propagator(
  reads: readonly Signal<any>[],
  // biome-ignore lint/suspicious/noExplicitAny: see header
  writes: readonly Writable<Signal<any>>[],
  step: () => void,
): Propagator {
  return { reads, writes, step };
}
