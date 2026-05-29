// signal.ts — symmetric bidirectional engine prototype (v2).
//
// DESIGN PILLARS
// ──────────────
// 1. Forward and backward use the SAME primitive: flag-mediated
//    propagation + lazy resolution + worklist drain at boundary.
//    Both paths look symmetric in structure: write → mark → queue
//    → flush.
//
// 2. Backward dispatch cost per cell ≤ forward dispatch cost per
//    cell. Both are: flag check + queue push. No closure cascade
//    at write time, no try/finally on hot path, no globals to
//    push/pop.
//
// 3. Setters DO NOT run at write time. They run during flush, at
//    most ONCE per cascade per lens. Multiple writes to the same
//    lens within one cascade naturally coalesce — the latest
//    pendingBwdValue wins, the setter sees only that.
//
// 4. No fusion. Each lens cell is a real, observable, addressable
//    node. Fusion was a workaround for expensive eager dispatch;
//    cheap dispatch makes it unnecessary complexity.
//
// 5. Merge is the natural dual of Computed. Computed = N→1 forward
//    derivation. Merge = N→1 backward aggregation. Both use the
//    same machinery: dispatch fires once at flush, reads
//    accumulated state, computes single value, deposits forward.
//
// WORKLIST ALGORITHM
// ──────────────────
// At write time:
//   - Deposit pending value at the cell.
//   - Mark BwdPending + queue self.
//   - That's it. NO ancestor walk.
//
// At flush:
//   - Drain bwd queue in FIFO order (leaves first because written
//     first). Each cell's setter (or merge fold) deposits at
//     parent, which queues parent if not yet queued. Queue grows
//     until quiescent.
//   - Then drain fwd queue (effects).
//
// This naturally handles:
//   - Multi-write coalescing (each cell drained once).
//   - Topological correctness (parents drain after children).
//   - Merges (contributions accumulate before parent fires).
//   - Cascades from lens→merge→merge→signal of any shape.

// ─── Flags ────────────────────────────────────────────────────────

const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  Pending: 4,
  Dirty: 8,
  BwdPending: 16,
  InBwdQueue: 32,
  InFwdQueue: 64,
} as const;

// ─── Engine globals ──────────────────────────────────────────────

let activeSub: ReactiveNode | undefined;
let writeDepth = 0;
const bwdQueue: Signal<unknown>[] = [];
const fwdQueue: ReactiveNode[] = [];
let flushing = false;

// ─── Types ────────────────────────────────────────────────────────

interface ReactiveNode {
  flags: number;
  deps: Link | undefined;
  depsTail: Link | undefined;
  subs: Link | undefined;
  subsTail: Link | undefined;
  _update(): boolean;
  _notify(): void;
}

interface Link {
  dep: ReactiveNode;
  sub: ReactiveNode;
  prevDep: Link | undefined;
  nextDep: Link | undefined;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
}

// ─── Linking / propagate / shallowDirty ──────────────────────────

function link(dep: ReactiveNode, sub: ReactiveNode): void {
  const prevDep = sub.depsTail;
  if (prevDep !== undefined && prevDep.dep === dep) return;
  // Slower de-dup: scan deps. For prototype OK.
  let scan = sub.deps;
  while (scan !== undefined) {
    if (scan.dep === dep) return;
    scan = scan.nextDep;
  }
  const l: Link = {
    dep,
    sub,
    prevDep,
    nextDep: undefined,
    prevSub: dep.subsTail,
    nextSub: undefined,
  };
  if (prevDep !== undefined) prevDep.nextDep = l;
  else sub.deps = l;
  sub.depsTail = l;
  if (dep.subsTail !== undefined) dep.subsTail.nextSub = l;
  else dep.subs = l;
  dep.subsTail = l;
}

function propagate(start: Link): void {
  let l: Link | undefined = start;
  while (l !== undefined) {
    const sub = l.sub;
    const flags = sub.flags;
    if (!(flags & (F.Pending | F.Dirty))) {
      sub.flags = flags | F.Pending;
      if (flags & F.Watching && !(flags & F.InFwdQueue)) {
        sub.flags |= F.InFwdQueue;
        fwdQueue.push(sub);
      }
      if (sub.subs !== undefined) propagate(sub.subs);
    }
    l = l.nextSub;
  }
}

function shallowDirty(start: Link): void {
  let l: Link | undefined = start;
  while (l !== undefined) {
    const sub = l.sub;
    if ((sub.flags & (F.Pending | F.Dirty)) === F.Pending) {
      sub.flags = (sub.flags & ~F.Pending) | F.Dirty;
    }
    l = l.nextSub;
  }
}

// ─── MergeNode ───────────────────────────────────────────────────

export interface MergePolicy<T> {
  readonly identity: T;
  combine(acc: T, x: T): T;
  /** Optional inverse for incremental fold. */
  remove?(acc: T, x: T): T;
}

export const DIRECT_SLOT: unique symbol = Symbol("merge:direct-slot");

class MergeNode<T> {
  readonly cell: Signal<T>;
  readonly parent: Signal<T>;
  readonly policy: MergePolicy<T>;
  readonly slots: Map<unknown, T> = new Map();
  readonly hasIncrementalAcc: boolean;
  acc: T;

  constructor(cell: Signal<T>, parent: Signal<T>, policy: MergePolicy<T>) {
    this.cell = cell;
    this.parent = parent;
    this.policy = policy;
    this.hasIncrementalAcc = policy.remove !== undefined;
    this.acc = policy.identity;
  }

  receive(slot: unknown, next: T): void {
    if (this.hasIncrementalAcc) {
      // biome-ignore lint/style/noNonNullAssertion: gated by hasIncrementalAcc
      const remove = this.policy.remove!;
      const prior = this.slots.get(slot);
      if (prior === undefined) this.acc = this.policy.combine(this.acc, next);
      else this.acc = this.policy.combine(remove(this.acc, prior), next);
    }
    this.slots.set(slot, next);
  }

  fold(): T {
    if (this.hasIncrementalAcc) return this.acc;
    let acc = this.policy.identity;
    for (const v of this.slots.values()) acc = this.policy.combine(acc, v);
    return acc;
  }

  reset(): void {
    this.slots.clear();
    this.acc = this.policy.identity;
  }
}

// ─── Helper: deposit + queue ─────────────────────────────────────

function bwdDeposit(cell: Signal<unknown>, value: unknown): void {
  if (cell.getter === undefined) {
    cell.pendingValue = value;
  } else {
    cell._pendingBwdValue = value;
  }
  if (!(cell.flags & F.InBwdQueue)) {
    cell.flags |= F.BwdPending | F.InBwdQueue;
    bwdQueue.push(cell);
  }
}

function bwdContribute(merge: Signal<unknown>, slot: unknown, value: unknown): void {
  // biome-ignore lint/style/noNonNullAssertion: caller checks _mergeNode
  merge._mergeNode!.receive(slot, value);
  if (!(merge.flags & F.InBwdQueue)) {
    merge.flags |= F.BwdPending | F.InBwdQueue;
    bwdQueue.push(merge);
  }
}


// ─── Signal class ────────────────────────────────────────────────

export class Signal<T = unknown> implements ReactiveNode {
  flags: number = F.Mutable;
  subs: Link | undefined;
  subsTail: Link | undefined;
  deps: Link | undefined;
  depsTail: Link | undefined;

  getter: (() => T) | undefined;
  setter: ((v: T) => void) | undefined;

  currentValue!: T;
  pendingValue!: T;
  cachedValue!: T;

  _bwdParent?: Signal<unknown>;
  _bwdParents?: readonly Signal<unknown>[];
  _pendingBwdValue?: T;

  /** Engine-only queue-mode setter. Lens cells set this alongside
   *  `setter` (eager). Separating eliminates a runtime branch on
   *  every call: `setter` is invoked only in eager mode, `_qSetter`
   *  only from inside flush. */
  _qSetter?: (target: T) => void;

  _mergeNode?: MergeNode<T>;
  _isMerge?: boolean;

  constructor(initial: T) {
    this.currentValue = initial;
    this.pendingValue = initial;
    this.cachedValue = initial;
  }

  // ── Forward read ──

  get value(): T {
    if (activeSub !== undefined) link(this, activeSub);
    // Lazy bwd: if any cell in the system has a pending bwd write
    // (cheap to check via a global counter alternative — for now,
    // just check own BwdPending and rely on dependents being marked
    // transitively). Flush drains the bwd queue first.
    if (bwdQueue.length > 0 && !flushing) flush();
    if (this.getter !== undefined) {
      if (this.flags & (F.Pending | F.Dirty)) this._update();
      return this.cachedValue;
    }
    return this.currentValue;
  }

  // ── Backward write entry ──
  //
  // HYBRID DISPATCH MODEL
  //
  //   Outside any batch/flush, single writes take an EAGER fast
  //   path that matches canonical's shape: signals commit + propagate
  //   inline; lenses synchronously cascade their setters; merges
  //   receive + fold + cascade. Per-cell cost matches canonical.
  //
  //   Inside a batch or during a flush, writes take the QUEUE
  //   slow path: deposit + mark + enqueue. The outer flush drains
  //   in worklist order, coalescing multi-writes (each cell's setter
  //   runs at most once per cascade).
  //
  //   This preserves canonical's per-write semantics outside batches
  //   while delivering the coalescing payoff inside batches.

  // ── Backward write entry — FULLY LAZY ──
  //
  // True dual of fwd: writes JUST deposit + queue. The setter
  // cascade is deferred and runs at most once per cell per
  // cascade (regardless of how many writes hit it).
  //
  // FLUSH TRIGGERS (cascade actually runs at one of these):
  //   1. A subsequent READ of any BwdPending cell.
  //   2. End of an explicit `batch()` block.
  //   3. Subscriber Watching (effect) re-fire — only if writes
  //      propagated Pending into subs requiring an immediate
  //      effect run (auto-flushed at writeDepth → 0).
  //
  // Per-write cost (no subs): ~10ns — just deposit + queue.
  // Symmetric to fwd write cost. Cascade amortizes across reads.

  set value(next: T) {
    if (this._isMerge === true) {
      bwdContribute(this as Signal<unknown>, DIRECT_SLOT, next);
    } else if (this.getter === undefined) {
      if (this._equalsCheck(this.pendingValue, next)) return;
      this.pendingValue = next;
      if (!(this.flags & F.InBwdQueue)) {
        this.flags |= F.BwdPending | F.InBwdQueue;
        bwdQueue.push(this as Signal<unknown>);
      }
    } else if (this.setter === undefined) {
      throw new TypeError("Cannot write to a computed");
    } else {
      this._pendingBwdValue = next;
      if (!(this.flags & F.InBwdQueue)) {
        this.flags |= F.BwdPending | F.InBwdQueue;
        bwdQueue.push(this as Signal<unknown>);
      }
    }
    // Notify downstream readers that the value here will change.
    // Effects get queued in fwdQueue; computeds/lenses get marked
    // Dirty so their next read re-derives. The bwd commit itself
    // is deferred until a read or the auto-flush below.
    if (this.subs !== undefined) {
      propagate(this.subs);
      shallowDirty(this.subs);
    }
    // Auto-flush effects at top-level write boundary (so effects
    // fire predictably, alien-style). Effects re-run, read deps;
    // reads trigger bwd cascade on demand.
    if (writeDepth === 0 && !flushing && fwdQueue.length > 0) flush();
  }

  _setWithExclusion(next: T): void {
    // Identical to set value's deposit logic, but without the
    // boundary-flush. Used internally during flush by setters
    // depositing at their parents.
    if (this._isMerge === true) {
      bwdContribute(this as Signal<unknown>, DIRECT_SLOT, next);
      return;
    }
    if (this.getter === undefined) {
      if (this._equalsCheck(this.pendingValue, next)) return;
      this.pendingValue = next;
      if (!(this.flags & F.InBwdQueue)) {
        this.flags |= F.BwdPending | F.InBwdQueue;
        bwdQueue.push(this as Signal<unknown>);
      }
      return;
    }
    if (this.setter === undefined) throw new TypeError("Cannot write to a computed");
    this._pendingBwdValue = next;
    if (!(this.flags & F.InBwdQueue)) {
      this.flags |= F.BwdPending | F.InBwdQueue;
      bwdQueue.push(this as Signal<unknown>);
    }
  }

  _equalsCheck(a: T, b: T): boolean {
    return a === b;
  }

  _update(): boolean {
    const prev = activeSub;
    activeSub = this;
    try {
      // biome-ignore lint/style/noNonNullAssertion: getter set in computed/lens mode
      const next = this.getter!();
      this.flags = (this.flags & ~(F.Pending | F.Dirty)) | F.Mutable;
      if (this._equalsCheck(this.cachedValue, next)) return false;
      this.cachedValue = next;
      return true;
    } finally {
      activeSub = prev;
    }
  }

  _notify(): void {}

  // ── Construction helpers ──

  static lens<P, R>(
    parent: Signal<P>,
    fwd: (v: P) => R,
    bwd: (target: R, current: P) => P,
  ): Signal<R> {
    const cell = new Signal<R>(fwd(parent.peek()));
    cell.flags |= F.Dirty; // force first read to run getter and establish fwd links
    cell.getter = (): R => fwd(parent.value as P);
    // Eager setter: synchronous cascade. Branchless for the common
    // case (no merge): peek + bwd + cascade. Merge-rare path is
    // inline for monomorphic JIT.
    cell.setter = (target: R): void => {
      const upstream = bwd(target, parent.peek());
      const p = parent as Signal<unknown>;
      const m = p._mergeNode;
      if (m === undefined) p._commitEager(upstream as never);
      else {
        m.receive(cell, upstream);
        const acc = m.fold();
        m.reset();
        (m.parent as Signal<unknown>)._commitEager(acc);
      }
    };
    // Queue setter: deferred, reads parent's pending if mid-flush.
    cell._qSetter = (target: R): void => {
      const p = parent as Signal<unknown>;
      const current =
        p._pendingBwdValue !== undefined ? (p._pendingBwdValue as P) : (parent.peek() as P);
      const upstream = bwd(target, current);
      if (p._mergeNode !== undefined) bwdContribute(p, cell, upstream);
      else bwdDeposit(p, upstream);
    };
    cell._bwdParent = parent as Signal<unknown>;
    return cell;
  }

  static derive<P, R>(parent: Signal<P>, fn: (v: P) => R): Signal<R> {
    const cell = new Signal<R>(fn(parent.peek()));
    cell.flags |= F.Dirty;
    cell.getter = (): R => fn(parent.value as P);
    return cell;
  }

  /** Backward-aggregating node. Bwd dual of Computed.
   *  Receives contributions from upstream lenses (via slot map)
   *  and from direct writes (under DIRECT_SLOT). Folds at flush. */
  merge(this: Signal<T>, policy: MergePolicy<T>): Signal<T> {
    // Receiver must be writable: either a Signal source, a Lens
    // (getter+setter), or another Merge (writes via _isMerge path).
    if (this.getter !== undefined && this.setter === undefined && this._isMerge !== true) {
      throw new TypeError("merge: receiver is RO");
    }
    const parent = this as Signal<T>;
    const cell = new Signal<T>(parent.peek());
    cell.flags |= F.Dirty;
    cell.getter = (): T => parent.value;
    cell.setter = undefined; // direct writes go via _setWithExclusion → bwdContribute
    cell._bwdParent = parent as Signal<unknown>;
    cell._mergeNode = new MergeNode<T>(cell, parent, policy);
    cell._isMerge = true;
    return cell;
  }

  peek(): T {
    if (this.getter !== undefined) {
      if (this.flags & (F.Pending | F.Dirty)) this._update();
      return this.cachedValue;
    }
    return this.currentValue;
  }
}

// ─── factories ───────────────────────────────────────────────────

export function signal<T>(initial: T): Signal<T> {
  return new Signal(initial);
}

export function computed<T>(fn: () => T): Signal<T> {
  const cell = new Signal<T>(undefined as never);
  cell.getter = fn;
  cell.flags |= F.Dirty;
  return cell;
}

// ─── Effect ───────────────────────────────────────────────────────

class Effect implements ReactiveNode {
  flags: number = F.Watching;
  subs: Link | undefined;
  subsTail: Link | undefined;
  deps: Link | undefined;
  depsTail: Link | undefined;
  fn: () => void;

  constructor(fn: () => void) {
    this.fn = fn;
    this._run();
  }

  _run(): void {
    const prev = activeSub;
    activeSub = this;
    try {
      this.fn();
    } finally {
      activeSub = prev;
      this.flags &= ~(F.Pending | F.Dirty);
    }
  }

  _update(): boolean {
    this._run();
    return false;
  }

  _notify(): void {
    if (!(this.flags & F.InFwdQueue)) {
      this.flags |= F.InFwdQueue;
      fwdQueue.push(this);
    }
  }
}

export function effect(fn: () => void): () => void {
  const e = new Effect(fn);
  return () => {
    e.flags = F.None;
  };
}

// ─── Flush ────────────────────────────────────────────────────────

/** Drain ONLY the fwd queue. Used by the signal-write fast path
 *  when there's nothing in bwd queue. Sets `flushing = true` so
 *  nested writes from effects take the slow path. */
function drainFwdOnly(): void {
  if (flushing) return;
  flushing = true;
  try {
    let j = 0;
    // Outer loop: effects may write signals, which adds to bwdQueue;
    // those need draining too. Loop until quiescent.
    while (j < fwdQueue.length || bwdQueue.length > 0) {
      while (j < fwdQueue.length) {
        const sub = fwdQueue[j++]!;
        sub.flags &= ~F.InFwdQueue;
        if (sub.flags & (F.Pending | F.Dirty)) sub._update();
      }
      if (bwdQueue.length > 0) {
        // Demote to full flush.
        flushing = false;
        flush();
        return;
      }
    }
    fwdQueue.length = 0;
  } finally {
    flushing = false;
  }
}

function flush(): void {
  if (flushing) return;
  flushing = true;
  let bwdI = 0;
  let fwdI = 0;
  try {
    // Drain both queues until quiescent. Effects writing signals
    // grow bwdQueue; bwd commits grow fwdQueue. Loop until both
    // are stable.
    while (true) {
      const startedBwd = bwdI;
      const startedFwd = fwdI;

      while (bwdI < bwdQueue.length) {
        const cell = bwdQueue[bwdI++]!;
        cell.flags &= ~(F.BwdPending | F.InBwdQueue);

        if (cell._isMerge === true) {
          // biome-ignore lint/style/noNonNullAssertion: _isMerge implies _mergeNode
          const node = cell._mergeNode!;
          const acc = node.fold();
          // Reset slot map for the NEXT cascade. Current cascade
          // contributions have all arrived (we're being drained).
          node.reset();
          cell.flags |= F.Dirty;
          if (cell.subs !== undefined) {
            propagate(cell.subs);
            shallowDirty(cell.subs);
          }
          const parent = node.parent as Signal<unknown>;
          if (parent._mergeNode !== undefined) {
            bwdContribute(parent, cell, acc as never);
          } else {
            bwdDeposit(parent, acc as never);
          }
        } else if (cell._qSetter !== undefined) {
          // biome-ignore lint/style/noNonNullAssertion: deposited at write time
          const v = cell._pendingBwdValue!;
          cell._pendingBwdValue = undefined;
          cell._qSetter(v);
          cell.flags |= F.Dirty;
          if (cell.subs !== undefined) {
            propagate(cell.subs);
            shallowDirty(cell.subs);
          }
        } else {
          const next = cell.pendingValue;
          if (cell.currentValue !== next) {
            cell.currentValue = next;
            if (cell.subs !== undefined) {
              propagate(cell.subs);
              shallowDirty(cell.subs);
            }
          }
        }
      }

      while (fwdI < fwdQueue.length) {
        const sub = fwdQueue[fwdI++]!;
        sub.flags &= ~F.InFwdQueue;
        if (sub.flags & (F.Pending | F.Dirty)) sub._update();
      }

      if (bwdI === startedBwd && fwdI === startedFwd) break;
    }
    bwdQueue.length = 0;
    fwdQueue.length = 0;
  } finally {
    flushing = false;
  }
}

export function batch<R>(fn: () => R): R {
  ++writeDepth;
  try {
    return fn();
  } finally {
    if (--writeDepth === 0 && !flushing) flush();
  }
}
