// claims.ts — writer claims as a primitive for the drag-vs-spring conflict.
//
// Different angle: instead of orchestrating WHICH PROCESS RUNS each
// frame (interleave/stack), let multiple processes try to write the
// same signal — but with a CLAIM disciplining who actually gets to.
//
// Two flavors:
//   A. Claim<T>      — exclusive single writer; later claimants get nothing.
//   B. PriorityClaim<T> — highest-priority active claim wins; preempted
//                          claimants are NOTIFIED they were displaced.
//
// This makes "drag preempts spring" expressible as data, not control flow.
// Drag holds a priority-10 claim while dragging; spring holds a priority-0
// claim continuously. Spring's writes silently no-op while drag is active.

import { type Read, Signal } from "../signal";

// ── A. Exclusive Claim ───────────────────────────────────────────

export interface Claim<T> {
  /** Attempt to acquire; returns a writer handle, or null if already held. */
  acquire(): ClaimWriter<T> | null;
  /** Is this claim currently held? */
  held: Read<boolean>;
}

export interface ClaimWriter<T> {
  write(v: T): void;
  release(): void;
}

export function claim<T>(sig: Signal<T>): Claim<T> {
  const held = new Signal(false);
  let active: symbol | null = null;

  return {
    held,
    acquire(): ClaimWriter<T> | null {
      if (active) return null;
      const id = Symbol();
      active = id;
      held.value = true;
      return {
        write(v: T): void {
          if (active === id) sig.value = v;
        },
        release(): void {
          if (active === id) {
            active = null;
            held.value = false;
          }
        },
      };
    },
  };
}

// ── B. Priority Claim ────────────────────────────────────────────
//
// Multiple holders coexist; the one with highest active priority gets
// its writes through. Lower-priority writers SILENTLY no-op (their
// `write` does nothing). When a holder is preempted (higher one
// arrives), it's notified via `onPreempt`. When the preempter
// releases, the next-highest holder is notified via `onResume`.

export interface PriorityClaim<T> {
  acquire(priority: number, opts?: PriorityClaimOpts): PriorityWriter<T>;
  /** The current highest-priority active claim's priority, or null. */
  activePriority: Read<number | null>;
}

export interface PriorityClaimOpts {
  /** Called when a higher-priority claimant takes over. */
  onPreempt?: () => void;
  /** Called when the holder becomes active (initial acquire OR resume after preempter release). */
  onResume?: () => void;
}

export interface PriorityWriter<T> {
  write(v: T): void;
  release(): void;
}

interface Holder {
  id: symbol;
  priority: number;
  opts: PriorityClaimOpts;
  wasActive: boolean;
}

export function priorityClaim<T>(sig: Signal<T>): PriorityClaim<T> {
  const holders: Holder[] = [];
  const activePriority = new Signal<number | null>(null);

  const recompute = (): void => {
    if (holders.length === 0) {
      activePriority.value = null;
      return;
    }
    let topIdx = 0;
    for (let i = 1; i < holders.length; i++) {
      if (holders[i].priority > holders[topIdx].priority) topIdx = i;
    }
    const topPri = holders[topIdx].priority;
    activePriority.value = topPri;
    // Fire transitions.
    for (let i = 0; i < holders.length; i++) {
      const h = holders[i];
      const nowActive = i === topIdx;
      if (h.wasActive !== nowActive) {
        h.wasActive = nowActive;
        if (nowActive) h.opts.onResume?.();
        else h.opts.onPreempt?.();
      }
    }
  };

  const isActive = (id: symbol): boolean => {
    if (holders.length === 0) return false;
    let topIdx = 0;
    for (let i = 1; i < holders.length; i++) {
      if (holders[i].priority > holders[topIdx].priority) topIdx = i;
    }
    return holders[topIdx].id === id;
  };

  return {
    activePriority,
    acquire(priority: number, opts: PriorityClaimOpts = {}): PriorityWriter<T> {
      const id = Symbol();
      const h: Holder = { id, priority, opts, wasActive: false };
      holders.push(h);
      recompute();
      return {
        write(v: T): void {
          if (isActive(id)) sig.value = v;
        },
        release(): void {
          const i = holders.indexOf(h);
          if (i >= 0) holders.splice(i, 1);
          recompute();
        },
      };
    },
  };
}
