// merge.ts — backward-merge prototype, slot-keyed variant.
// Companion to ../../backwards-merge.md.
//
// Design (revised after the fold-on-arrival prototype failed for
// arbitrary DAGs):
//
// A backward write that arrives at a merged signal carries an
// implicit slot identity: the lens immediately upstream of it on the
// bwd path. The engine now exposes that as `activeBwdWriter` — set
// while a lens's setter is on the call stack, undefined for direct
// (non-lens) writes. The merge intercept records the latest
// contribution PER SLOT into a Map keyed by writer identity, then
// folds the Map's values via `policy.combine` and commits the
// combined result downstream.
//
// What this buys vs. the previous fold-on-arrival approach:
//
//   - Same-slot repeats are dedupe'd. A user-authored lens whose
//     setter writes its parent five times in one batch counts as
//     ONE contribution (the last one) — not five. Sum no longer
//     multiplies on its own.
//   - Works for any way of constructing a lens — `_fuse`, `_fanin`,
//     `_symmetric`, `field`, raw `Signal.install`, user-authored
//     setters. The only thing the merge requires of a lens is that
//     it writes via `_setWithExclusion`, which is the only legal way
//     to write a Signal.
//   - DAG-shape-agnostic. Asymmetric depths, multiple fan-ins
//     converging at the same root, mixed lens kinds composed
//     together — all collapse to "N slots, this many contributions
//     this cascade, fold them."
//
// What's still unbuilt:
//
//   - The chain-operator `.merge(fn)` from §2 (this primitive is
//     root-attached only — the merge lives on a specific Signal
//     instance, not as a node mid-chain).
//   - The lazy trigger from §7 — commits are still eager per
//     arrival. Idempotent folds remain free; non-commutative folds
//     remain dependent on arrival order (which is structural, not
//     semantic).
//   - Per-slot bookkeeping ACROSS cascades. Each fresh cascade
//     clears the slot map and starts over. The "remember a slot's
//     last contribution from a prior cascade and update only on
//     change" mode is not implemented and probably isn't wanted by
//     default — it would amount to memoising the bwd, which is a
//     bigger semantic commitment.

import { _activeBwdWriter, _bwdCascadeId, Signal, type Writable } from "./signal";

/** Order-independent merge policy. `combine` should be associative
 *  and commutative; `identity` is the fold seed. Non-commutative
 *  combines will appear to work for one-slot cascades but the
 *  cross-slot fold order is unspecified — the engine does not
 *  promise an arrival order. */
export interface MergePolicy<T> {
  readonly identity: T;
  combine(acc: T, x: T): T;
}

// ─── Common policies ────────────────────────────────────────────────

export const maxPolicy: MergePolicy<number> = {
  identity: Number.NEGATIVE_INFINITY,
  combine: (a, b) => (a > b ? a : b),
};

export const minPolicy: MergePolicy<number> = {
  identity: Number.POSITIVE_INFINITY,
  combine: (a, b) => (a < b ? a : b),
};

export const sumPolicy: MergePolicy<number> = {
  identity: 0,
  combine: (a, b) => a + b,
};

/** Arithmetic mean over the contributions in one cascade. Implemented
 *  as sum/count on each fold, so the per-arrival committed value is
 *  the running mean (not the running sum). */
export const meanPolicy: MergePolicy<{ sum: number; count: number; value: number }> = {
  identity: { sum: 0, count: 0, value: 0 },
  combine(_acc, x) {
    // For mean, the `combine` here folds (sum, count, value) tuples;
    // typically called with `_acc = identity` once per cascade
    // because the merge re-folds from identity over all slots on
    // each arrival. The tuple form lets `value` carry the human-
    // facing scalar that's actually committed.
    return {
      sum: x.sum,
      count: x.count,
      value: x.count === 0 ? 0 : x.sum / x.count,
    };
  },
};

/** Convenience: like `sumPolicy` but committing the mean of the
 *  contributions instead of their sum. Internally folds over scalar
 *  contributions; uses a closure-managed running (sum, count). */
export function meanScalarPolicy(): MergePolicy<number> {
  // The state is naturally per-merge-instance; closure factory
  // pattern enforces that.
  let sum = 0;
  let count = 0;
  return {
    identity: 0,
    combine(acc, x) {
      if (acc === 0) {
        // The merge layer always folds from `identity` over the
        // current slot map on each arrival (see `recomputeAndCommit`
        // below), so `acc === identity` is a reliable per-fold
        // reset signal here. We use it to clear (sum, count) and
        // accumulate fresh over the slots being folded right now.
        sum = 0;
        count = 0;
      }
      sum += x;
      count += 1;
      return sum / count;
    },
  };
}

// ─── Internal: per-instance merge state ─────────────────────────────

/** Side-table holding merge state per signal. WeakMap-keyed so a
 *  disposed signal's state gets reclaimed without us touching the
 *  Signal class. Prototype-only — production would put these slots
 *  on the Signal class itself. */
const mergeStates = new WeakMap<
  Signal<unknown>,
  {
    policy: MergePolicy<unknown>;
    /** Slot identity → latest contribution from that slot. Cleared
     *  on fresh-cascade boundary. */
    slots: Map<unknown, unknown>;
    /** `_bwdCascadeId()` value at the last intercept. Mismatch
     *  triggers a fresh-cascade reset of `slots`. */
    lastCascadeId: number;
  }
>();

/** Sentinel slot for arrivals that lack an `activeBwdWriter`. A
 *  direct user write of the merged signal at the top level (no lens
 *  intermediary) lands here. All such writes share this slot, so
 *  sequential top-level direct writes of the merged signal collapse
 *  to one contribution-per-cascade — which is correct, because they
 *  are conceptually the same "channel" (untyped direct override). */
const DIRECT_WRITE_SLOT = Symbol("merge:direct-write-slot");

// ─── Public API ─────────────────────────────────────────────────────

/** Attach a merge policy to a signal. Returns the same reference
 *  (mutated in place). Future backward writes that arrive at this
 *  signal are dedupe'd by upstream-lens identity, folded under
 *  `policy.combine`, and the combined result is committed via the
 *  original setter.
 *
 *  Re-attachment replaces the policy and clears the slot map.
 *
 *  Restriction (current prototype): the receiver must be in
 *  signal-mode (no getter installed). Attaching to a lens itself is
 *  meaningful in principle (the §2 chain-operator form) but is not
 *  implemented yet. */
export function withMerge<T>(sig: Writable<Signal<T>>, policy: MergePolicy<T>): Writable<Signal<T>> {
  if (sig.getter !== undefined) {
    throw new TypeError(
      "withMerge: current prototype attaches to signal-mode roots only. " +
        "Chain-operator placement (§2) is not yet implemented.",
    );
  }

  // Snapshot the original setter ONCE per instance, even across
  // re-attachments — otherwise wrapping twice would call our own
  // wrapped setter from inside the new wrap and recurse.
  const wrapped = sig as Signal<T> & { _mergeOriginalSet?: Signal<T>["_setWithExclusion"] };
  if (wrapped._mergeOriginalSet === undefined) {
    wrapped._mergeOriginalSet = sig._setWithExclusion.bind(sig);
  }
  const originalSet = wrapped._mergeOriginalSet!;

  mergeStates.set(sig as Signal<unknown>, {
    policy: policy as MergePolicy<unknown>,
    slots: new Map<unknown, unknown>(),
    // `-1` never matches `_bwdCascadeId()`'s non-negative range so
    // the first arrival always trips the fresh-cascade branch.
    lastCascadeId: -1,
  });

  sig._setWithExclusion = function (next: T, excluding): void {
    const state = mergeStates.get(this as Signal<unknown>)!;
    const cascadeId = _bwdCascadeId();
    // Fresh cascade iff the cascade-id has advanced since our last
    // intercept. This is the SAME id for every arrival inside one
    // user-initiated lens cascade (incl. fan-in's batch, nested
    // lens-of-lens, user-authored multi-write setters) and STRICTLY
    // GREATER for the first arrival of the next cascade. Direct
    // (non-lens) writes don't bump the id; they all share the
    // current cascade's slot map, which is fine because they all
    // map to `DIRECT_WRITE_SLOT` and dedupe-by-slot collapses them
    // to one contribution anyway.
    if (cascadeId !== state.lastCascadeId) {
      state.slots.clear();
      state.lastCascadeId = cascadeId;
    }
    const slot = _activeBwdWriter() ?? DIRECT_WRITE_SLOT;
    // Per-slot dedupe: a repeat from the same slot REPLACES, never
    // accumulates. This is the core invariant that makes sum work
    // correctly even when a user-authored lens writes its parent
    // multiple times per logical operation.
    state.slots.set(slot, next);
    // Fold across the current slot map, commit the result.
    const policy = state.policy as MergePolicy<T>;
    let acc = policy.identity;
    for (const v of state.slots.values()) acc = policy.combine(acc, v as T);
    originalSet(acc, excluding);
  };

  return sig;
}

/** Snapshot the current slot map for a merged signal — test/debug
 *  hook. Returns `undefined` if no merge is attached. Keys are
 *  upstream-lens identities (or the `DIRECT_WRITE_SLOT` symbol). */
export function peekMergeSlots<T>(sig: Signal<T>): ReadonlyMap<unknown, T> | undefined {
  return mergeStates.get(sig as Signal<unknown>)?.slots as ReadonlyMap<unknown, T> | undefined;
}

/** Snapshot the current folded accumulator — same value the merge
 *  most recently committed. */
export function peekMergeAcc<T>(sig: Signal<T>): T | undefined {
  const state = mergeStates.get(sig as Signal<unknown>);
  if (state === undefined) return undefined;
  const policy = state.policy as MergePolicy<T>;
  let acc = policy.identity;
  for (const v of state.slots.values()) acc = policy.combine(acc, v as T);
  return acc;
}

/** The sentinel slot used for direct (non-lens) writes. Exposed for
 *  tests that need to assert on it. */
export const DIRECT_SLOT = DIRECT_WRITE_SLOT;
