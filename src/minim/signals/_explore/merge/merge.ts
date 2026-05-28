// merge.ts — backward-merge prototype (companion to
// ../../backwards-merge.md).
//
// This is the FIRST prototype, targeting §10 step 2 of the doc:
// fold-on-arrival for an order-independent merge policy on a root
// signal. It does NOT yet implement the in-chain `.merge()` operator
// from §2's example, the slot-tracking required for non-idempotent
// folds (sum/mean across propagations), or the lazy/end-of-turn
// trigger discussion in §7. Those come next, once this works.
//
// Approach (intentionally minimal):
//
//   - Monkey-patch the merged signal's `_setWithExclusion` on the
//     instance. The engine is otherwise untouched. (One tiny
//     concession: `_batchDepth()` is exposed from `signal.ts` so we
//     can detect "fresh propagation" vs "in-flight cascade" without
//     reimplementing batch tracking.)
//   - Each backward write arriving at the merged signal folds into a
//     per-instance accumulator using the policy's `combine`. The
//     folded accumulator is then committed via the original setter,
//     so all downstream propagation/equality short-circuiting works
//     exactly as before.
//   - "Fresh propagation" = entered at `batchDepth === 0`. Inside a
//     batch (including the implicit batch wrapping `_fanin`'s sub-
//     writes), all arrivals fold into the same `acc`. Sequential
//     top-level writes get fresh accs — which intentionally degrades
//     to today's last-write-wins for the no-batch case. Users opt in
//     to combining sequential writes by wrapping in `batch(...)`.
//
// What this DOES test:
//   - Idempotent folds (max/min/union) — should converge correctly.
//   - Non-idempotent folds within one batch (sum, mean) — should
//     combine the deposits arriving in that batch; correct iff the
//     "deposits per slot per propagation" invariant holds (which it
//     does for fan-in lenses today: each backward edge fires once).
//
// What this DOESN'T test:
//   - Multi-propagation slot tracking (the case where a single
//     logical "merge value" must survive across propagations and
//     decompose by source). That's the next layer.
//   - The `.merge()` chain-operator placement question from §2.
//   - The lazy trigger from §7(a). The current intercept commits
//     eagerly per-arrival, which means downstream subscribers fire
//     once per arrival, not once per resolved merge. Eager-resolve
//     is the cheap path; lazy is the harder option.

import { _batchDepth, _batchSession, Signal, type Writable } from "./signal";

/** Order-independent merge policy. `combine` should be associative
 *  and commutative; `identity` is the fold seed (`max` → -∞, `min`
 *  → +∞, `+` → 0, set-union → ∅).
 *
 *  Non-associative or non-commutative combines will appear to "work"
 *  here but the result will depend on backward-traversal order,
 *  which the engine does not promise. Use a different mechanism
 *  (when one exists) for those. */
export interface MergePolicy<T> {
  readonly identity: T;
  combine(acc: T, x: T): T;
}

// ─── Common policies ────────────────────────────────────────────────

/** Lattice join via `Math.max`. Identity = -∞. */
export const maxPolicy: MergePolicy<number> = {
  identity: Number.NEGATIVE_INFINITY,
  combine: (a, b) => (a > b ? a : b),
};

/** Lattice meet via `Math.min`. Identity = +∞. */
export const minPolicy: MergePolicy<number> = {
  identity: Number.POSITIVE_INFINITY,
  combine: (a, b) => (a < b ? a : b),
};

/** Additive monoid. Identity = 0. Note: only "correct" within a
 *  single propagation — across propagations, see the slot-tracking
 *  TODO. */
export const sumPolicy: MergePolicy<number> = {
  identity: 0,
  combine: (a, b) => a + b,
};

/** Arithmetic mean. Implemented as a (sum, count) pair folded into
 *  a divided result on each commit — the intermediate state is
 *  exposed by the per-write equality check, but the steady-state
 *  read is the mean. */
export function meanPolicy(): MergePolicy<number> {
  let sum = 0;
  let count = 0;
  return {
    identity: 0,
    combine(acc, x) {
      // `acc === identity` indicates a fresh propagation reset.
      // We piggy-back on that to clear (sum, count) — works only
      // because the intercept calls `combine(identity, x)` on each
      // first arrival of a fresh propagation. Brittle and a clear
      // sign that "policy" should carry richer hooks; see TODO.
      if (acc === 0 && count === 0) {
        sum = 0;
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
 *  Signal class. Prototype-only — production would put `acc` on the
 *  Signal class itself, alongside `pendingValue`. */
const mergeStates = new WeakMap<
  Signal<unknown>,
  {
    policy: MergePolicy<unknown>;
    acc: unknown;
    /** Last `_batchSession()` seen at intercept. Detects the fresh-
     *  cascade boundary: when this differs from the current session
     *  the accumulator is reset before folding the new contribution. */
    lastSession: number;
  }
>();

// ─── Public API ─────────────────────────────────────────────────────

/** Attach a merge policy to a writable signal. Returns the same
 *  reference (mutated in place).
 *
 *  After attachment, backward writes arriving at `sig` are folded
 *  into a per-propagation accumulator via `policy.combine` before
 *  being committed downstream. "Per-propagation" is detected by
 *  `_batchDepth() === 0` at intercept entry: a fresh top-level write
 *  resets the accumulator to `policy.identity` first; in-batch
 *  writes (including those from `_fanin`'s implicit batch) fold
 *  into the existing accumulator.
 *
 *  Calling `withMerge` twice on the same signal replaces the policy
 *  and resets the accumulator. */
export function withMerge<T>(sig: Writable<Signal<T>>, policy: MergePolicy<T>): Writable<Signal<T>> {
  // Snapshot the original setter ONCE per instance, even across
  // re-attachments — otherwise wrapping twice would call our own
  // wrapped setter from inside the new wrap and double-fold.
  const wrapped = sig as Signal<T> & { _mergeOriginalSet?: Signal<T>["_setWithExclusion"] };
  if (wrapped._mergeOriginalSet === undefined) {
    wrapped._mergeOriginalSet = sig._setWithExclusion.bind(sig);
  }
  const originalSet = wrapped._mergeOriginalSet!;

  mergeStates.set(sig as Signal<unknown>, {
    policy: policy as MergePolicy<unknown>,
    acc: policy.identity,
    // `-1` is a sentinel that never matches `_batchSession()`'s
    // non-negative range, so the first write of the merge's life
    // always resets-then-folds, picking up `policy.identity` cleanly.
    lastSession: -1,
  });

  sig._setWithExclusion = function (next: T, excluding): void {
    const state = mergeStates.get(this as Signal<unknown>)!;
    const session = _batchSession();
    // Fresh cascade iff: (a) we're outside any batch (top-level
    // direct write), or (b) the batch-exit session counter has
    // advanced since we last folded into `acc`. Inside an ongoing
    // cascade (fan-in's implicit batch, or a user-opened batch),
    // session is stable and depth > 0 → keep folding.
    if (_batchDepth() === 0 || session !== state.lastSession) {
      state.acc = (state.policy as MergePolicy<T>).identity;
      state.lastSession = session;
    }
    state.acc = (state.policy as MergePolicy<T>).combine(state.acc as T, next);
    originalSet(state.acc as T, excluding);
  };

  return sig;
}

/** Snapshot the current accumulator value for a merged signal.
 *  Returns `undefined` if no merge is attached. Test-only — exposes
 *  internal state for assertion. */
export function peekMergeAcc<T>(sig: Signal<T>): T | undefined {
  return mergeStates.get(sig as Signal<unknown>)?.acc as T | undefined;
}
