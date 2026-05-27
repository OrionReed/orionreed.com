// wp-merge.ts — runtime intention merging.
//
// An alternative to construction-time diamond detection: at write time,
// accumulate intentions into a temporary buffer per cell, then apply a
// MERGE function to resolve multiple intentions before committing.
//
// Three merge strategies:
//   - lastWins  (default; matches today's batch semantics)
//   - sum       (gradient-style; intentions add)
//   - mean      (average of intentions)
//   - max/min   (lattice-style merges)
//   - throw     (panic on conflict — the strict-consistency mode)

import { batch, type Signal, type Writable } from "../../index";

export type MergeFn<T> = (a: T, b: T) => T;

export interface MergeSession {
  /** Record an intention for a cell. */
  intend<T>(cell: Writable<Signal<T>>, value: T, merge?: MergeFn<T>): void;
  /** Apply all merged intentions atomically. */
  commit(): void;
}

/** Start a session: intentions are queued and merged; `commit()` flushes
 *  them as one batched write. Default merge is last-write-wins.
 *
 *  Useful as an inner-loop substrate for wp lens factories that want to
 *  expose deterministic conflict resolution. */
export function mergeSession(): MergeSession {
  const queue = new Map<
    Signal<unknown>,
    { value: unknown; merge: MergeFn<unknown> | undefined }
  >();
  return {
    intend<T>(cell: Writable<Signal<T>>, value: T, merge?: MergeFn<T>): void {
      const existing = queue.get(cell as Signal<unknown>);
      if (existing === undefined) {
        queue.set(cell as Signal<unknown>, {
          value,
          merge: merge as MergeFn<unknown> | undefined,
        });
        return;
      }
      const fn = (merge ?? existing.merge) as MergeFn<unknown> | undefined;
      const next = fn ? fn(existing.value, value) : value;
      queue.set(cell as Signal<unknown>, { value: next, merge: fn });
    },
    commit(): void {
      batch(() => {
        for (const [cell, { value }] of queue) {
          (cell as Writable<Signal<unknown>>).value = value;
        }
      });
      queue.clear();
    },
  };
}

// ─── Common merges ───────────────────────────────────────────────────

/** Last write wins (default semantics). */
export const lastWins = <T,>(_a: T, b: T): T => b;

/** Numeric sum — gradient-style accumulation. */
export const sumNum = (a: number, b: number): number => a + b;

/** Numeric mean of accumulated intentions. NOTE: a true mean needs a
 *  counter; this binary form computes ½(a+b) per merge. */
export const meanNum = (a: number, b: number): number => (a + b) / 2;

/** Max — lattice merge for join-semilattice with `max`. */
export const maxNum = (a: number, b: number): number => Math.max(a, b);

/** Min — lattice merge with `min`. */
export const minNum = (a: number, b: number): number => Math.min(a, b);

/** Panic on conflict: refuses to merge unequal values. */
export function strict<T>(eq: (a: T, b: T) => boolean = (a, b) => a === b): MergeFn<T> {
  return (a, b) => {
    if (!eq(a, b)) {
      throw new Error(`wp: conflicting intentions: ${String(a)} vs ${String(b)}`);
    }
    return a;
  };
}

// ─── DELTA-style merge: intentions are deltas, not absolutes ────────

/** A lens factory that delivers DELTA intentions to writable parents
 *  and accumulates them via sum before committing. This is the
 *  gradient-accumulation semantics from backprop.
 *
 *  The bwd here returns `delta_i` per parent (signed). Engine writes
 *  `parent.value += sum(deltas_for_this_parent)`.
 *
 *  Resolves the asymmetric diamond ONLY IF parents are intentional
 *  about emitting deltas instead of absolute targets. */
export type DeltaLensSpec<P extends readonly Writable<Signal<unknown>>[], T> = {
  fwd: (vals: { [K in keyof P]: P[K] extends Signal<infer V> ? V : never }) => T;
  bwd: (
    target: T,
    vals: { [K in keyof P]: P[K] extends Signal<infer V> ? V : never },
  ) => { [K in keyof P]?: P[K] extends Signal<infer V> ? V : never };
};

// (Implementation deferred — would need richer engine cooperation. The
// MergeSession primitive above is the more practical first step.)
