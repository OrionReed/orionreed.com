// signal.ts — symmetric bidirectional engine prototype.
//
// GOAL
// ────
// Compete with alien-signals (the engine canonical is built on) on
// absolute per-op cost in BOTH directions, while making backward
// propagation as architecturally first-class as forward — and 100%
// correct (passes the reactive-framework-test-suite forward).
//
// DESIGN — the central realization
// ────────────────────────────────
// A backward write is NOT a separate propagation mechanism. It is a
// *compiler* from a view-edit into source-edits. The walk up the
// `_bwdParent` chain applies each lens's `put` to compute what the
// SOURCE(s) must become; once committed, the EXACT SAME forward
// machinery (propagate + value-gated checkDirty) refreshes every
// downstream view. So:
//
//   * Forward is alien-signals, verbatim. (link/propagate/checkDirty/
//     shallowPropagate, Dirty/Pending/Recursed flags, lazy pull.)
//   * Backward = "walk up, put, commit sources, then it's a forward
//     write." No per-node propagation during the walk, no fusion,
//     no second propagation engine.
//
// CONSEQUENCES (all desirable)
//   * Views are never sticky: a view is always `get(source)`. Writing
//     `a` through a lens commits `put(a, src)` to the source, and the
//     view re-reads to `get(put(a, src))`. For well-behaved (PutGet)
//     lenses that's `a`; for lossy lenses the view "snaps" — the
//     principled behavior for state-based asymmetric lenses.
//   * Short-circuit is free and value-gated: if the source delta is a
//     no-op, the forward write no-ops, nothing fires. The "furthest
//     upward changed node" (the pivot) is the source for chains, or a
//     merge where contributions cancel.
//   * Backward cost ≤ forward cost: the walk is N puts; the refresh is
//     the same lazy, value-gated pull forward already pays. Reads that
//     don't observe a node never recompute it.
//
// MERGE — backward dual of computed
// ─────────────────────────────────
// Computed = N→1 forward derivation. Merge = N→1 backward aggregation.
// Contributions land in a slot map keyed by contributor identity and
// fold via a user policy. Within one settle a merge re-aggregates only
// the contributions it received (slots reset per settle); batching
// (one settle) coalesces multiple writes, last-write-wins per slot.
//
// BATCHING
//   * Outside batch: a write cascades eagerly and flushes — matching
//     alien's synchronous per-write semantics.
//   * Inside batch / during flush: lens writes deposit their latest
//     value and queue (last-write-wins via `_queueIdx`); merge folds
//     defer to the queue drain so all contributors land first. The
//     flush loop alternates bwd-drain / effect-drain to a fixpoint.

// ─── Flags (alien-signals v2) ─────────────────────────────────────

const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
  /** Backward-only: cell has a pending backward contribution queued. */
  BwdQueued: 64,
} as const;

// ─── Engine globals ───────────────────────────────────────────────

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
let flushing = false;
const queued: (Effect | undefined)[] = [];

/** Backward worklist. Holds lens cells with deferred writes and merge
 *  cells awaiting fold. Drained (to a fixpoint with effects) by flush. */
const bwdQueue: Signal<unknown>[] = [];

// ─── Types ────────────────────────────────────────────────────────

interface ReactiveNode {
  flags: number;
  deps: Link | undefined;
  depsTail: Link | undefined;
  subs: Link | undefined;
  subsTail: Link | undefined;
  _update(): boolean;
  _notify(): void;
  _unwatched(): void;
}

interface Link {
  version: number;
  dep: ReactiveNode;
  sub: ReactiveNode;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
  prevDep: Link | undefined;
  nextDep: Link | undefined;
}

interface Stack<T> {
  value: T;
  prev: Stack<T> | undefined;
}

// ─── alien-signals algorithm — link / unlink / propagate / etc. ───

function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
  const prevDep = sub.depsTail;
  if (prevDep !== undefined && prevDep.dep === dep) return;
  const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps;
  if (nextDep !== undefined && nextDep.dep === dep) {
    nextDep.version = version;
    sub.depsTail = nextDep;
    return;
  }
  const prevSub = dep.subsTail;
  if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub) return;
  const newLink: Link =
    (sub.depsTail =
    dep.subsTail =
      {
        version,
        dep,
        sub,
        prevDep,
        nextDep,
        prevSub,
        nextSub: undefined,
      });
  if (nextDep !== undefined) nextDep.prevDep = newLink;
  if (prevDep !== undefined) prevDep.nextDep = newLink;
  else sub.deps = newLink;
  if (prevSub !== undefined) prevSub.nextSub = newLink;
  else dep.subs = newLink;
}

function unlink(l: Link, sub: ReactiveNode = l.sub): Link | undefined {
  const { dep, prevDep, nextDep, nextSub, prevSub } = l;
  if (nextDep !== undefined) nextDep.prevDep = prevDep;
  else sub.depsTail = prevDep;
  if (prevDep !== undefined) prevDep.nextDep = nextDep;
  else sub.deps = nextDep;
  if (nextSub !== undefined) nextSub.prevSub = prevSub;
  else dep.subsTail = prevSub;
  if (prevSub !== undefined) prevSub.nextSub = nextSub;
  else if ((dep.subs = nextSub) === undefined) dep._unwatched();
  return nextDep;
}

function propagate(start: Link, innerWrite: boolean): void {
  let l: Link | undefined = start;
  let next: Link | undefined = start.nextSub;
  let stack: Stack<Link | undefined> | undefined;
  top: do {
    const sub: ReactiveNode = l!.sub;
    let flags = sub.flags;
    if (!(flags & (F.RecursedCheck | F.Recursed | F.Dirty | F.Pending))) {
      sub.flags = flags | F.Pending;
      if (innerWrite) sub.flags |= F.Recursed;
    } else if (!(flags & (F.RecursedCheck | F.Recursed))) {
      flags = F.None;
    } else if (!(flags & F.RecursedCheck)) {
      sub.flags = (flags & ~F.Recursed) | F.Pending;
    } else if (!(flags & (F.Dirty | F.Pending)) && isValidLink(l!, sub)) {
      sub.flags = flags | (F.Recursed | F.Pending);
      flags &= F.Mutable;
    } else {
      flags = F.None;
    }
    if (flags & F.Watching) sub._notify();
    if (flags & F.Mutable) {
      const subSubs: Link | undefined = sub.subs;
      if (subSubs !== undefined) {
        const nextSub = (l = subSubs).nextSub;
        if (nextSub !== undefined) {
          stack = { value: next, prev: stack };
          next = nextSub;
        }
        continue;
      }
    }
    if ((l = next!) !== undefined) {
      next = l.nextSub;
      continue;
    }
    while (stack !== undefined) {
      l = stack.value;
      stack = stack.prev;
      if (l !== undefined) {
        next = l.nextSub;
        continue top;
      }
    }
    break;
  } while (true);
}

function checkDirty(startLink: Link, startSub: ReactiveNode): boolean {
  let l = startLink,
    sub = startSub;
  let stack: Stack<Link> | undefined;
  let checkDepth = 0,
    dirty = false;
  top: do {
    const dep = l.dep;
    const flags = dep.flags;
    if (sub.flags & F.Dirty) dirty = true;
    else if ((flags & (F.Mutable | F.Dirty)) === (F.Mutable | F.Dirty)) {
      const subs = dep.subs!;
      if (dep._update()) {
        if (subs.nextSub !== undefined) shallowPropagate(subs);
        dirty = true;
      }
    } else if ((flags & (F.Mutable | F.Pending)) === (F.Mutable | F.Pending)) {
      stack = { value: l, prev: stack };
      l = dep.deps!;
      sub = dep;
      ++checkDepth;
      continue;
    }
    if (!dirty) {
      const nextDep = l.nextDep;
      if (nextDep !== undefined) {
        l = nextDep;
        continue;
      }
    }
    while (checkDepth--) {
      l = stack!.value;
      stack = stack!.prev;
      if (dirty) {
        const subs = sub.subs!;
        if (sub._update()) {
          if (subs.nextSub !== undefined) shallowPropagate(subs);
          sub = l.sub;
          continue;
        }
        dirty = false;
      } else {
        sub.flags &= ~F.Pending;
      }
      sub = l.sub;
      const nextDep = l.nextDep;
      if (nextDep !== undefined) {
        l = nextDep;
        continue top;
      }
    }
    return dirty && !!sub.flags;
  } while (true);
}

function shallowPropagate(l: Link): void {
  do {
    const sub = l.sub;
    const flags = sub.flags;
    if ((flags & (F.Pending | F.Dirty)) === F.Pending) {
      sub.flags = flags | F.Dirty;
      if ((flags & (F.Watching | F.RecursedCheck)) === F.Watching) sub._notify();
    }
  } while ((l = l.nextSub!) !== undefined);
}

function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
  let l = sub.depsTail;
  while (l !== undefined) {
    if (l === checkLink) return true;
    l = l.prevDep;
  }
  return false;
}

function purgeDeps(sub: ReactiveNode): void {
  const depsTail = sub.depsTail;
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
  while (dep !== undefined) dep = unlink(dep, sub);
}

function disposeAllDepsInReverse(sub: ReactiveNode): void {
  let l = sub.depsTail;
  while (l !== undefined) {
    const prev = l.prevDep;
    unlink(l, sub);
    l = prev;
  }
}

// ─── MergeNode — backward fan-in ──────────────────────────────────

export interface MergePolicy<T> {
  readonly identity: T;
  combine(acc: T, x: T): T;
  /** Optional inverse for incremental fold. */
  remove?(acc: T, x: T): T;
}

export const DIRECT_SLOT: unique symbol = Symbol("merge:direct-slot");

class MergeNode<T> {
  readonly parent: Signal<T>;
  readonly policy: MergePolicy<T>;
  readonly slots: Map<unknown, T> = new Map();
  readonly hasIncrementalAcc: boolean;
  acc: T;

  constructor(parent: Signal<T>, policy: MergePolicy<T>) {
    this.parent = parent;
    this.policy = policy;
    this.hasIncrementalAcc = policy.remove !== undefined;
    this.acc = policy.identity;
  }

  receive(slot: unknown, next: T): void {
    if (this.hasIncrementalAcc) {
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

// ─── Signal class ─────────────────────────────────────────────────

export class Signal<T = unknown> implements ReactiveNode {
  flags: number = F.Mutable;
  subs: Link | undefined;
  subsTail: Link | undefined;
  deps: Link | undefined;
  depsTail: Link | undefined;

  /** Forward derivation (computed/lens/merge). `undefined` ⇒ source. */
  getter: (() => T) | undefined;

  /** The node's current value. A node is EITHER a source (uses
   *  `currentValue` = committed, `pendingValue` = staged write) OR a
   *  getter cell (uses `currentValue` = last derived cache, and reuses
   *  `pendingValue` for its deferred backward target — see `set value`).
   *  The two roles never coexist on one node, so two fields suffice for
   *  what would naively be four. This reuse is the fwd/bwd duality made
   *  concrete: "value pending commit" means staged-forward for a source
   *  and target-pending-cascade for a lens. */
  currentValue: T;
  pendingValue: T;

  /** Backward chain: the cell whose `put` produces this cell's upstream. */
  _bwdParent: Signal<unknown> | undefined;

  /** Lens `put`. Arity distinguishes `(t)=>p` from `(t,current)=>p`. */
  // biome-ignore lint/suspicious/noExplicitAny: bwd fn is opaque shape
  _bwdFn: ((target: any, current?: any) => any) | undefined;
  _bwdFnArity: 1 | 2;

  _mergeNode: MergeNode<T> | undefined;
  _isMerge: boolean;

  /** Index in `bwdQueue` of this cell's LATEST push. The drain skips
   *  entries whose `_queueIdx` ≠ their position, so each cell cascades
   *  once per flush in last-write order. */
  _queueIdx: number;

  constructor(initial: T) {
    this.currentValue = initial;
    this.pendingValue = initial;
    // Pre-init every optional slot so the V8 hidden class is stable
    // across signal / computed / lens / merge variants.
    this.subs = undefined;
    this.subsTail = undefined;
    this.deps = undefined;
    this.depsTail = undefined;
    this.getter = undefined;
    this._bwdParent = undefined;
    this._bwdFn = undefined;
    this._bwdFnArity = 1;
    this._mergeNode = undefined;
    this._isMerge = false;
    this._queueIdx = -1;
  }

  // ── Forward read / write ──
  //
  // The `value` accessor is installed on the prototype via
  // `Object.defineProperty` after the class body (see below), matching
  // alien-signals. V8 optimizes the prototype accessor better than a
  // class `get/set` here — ~5 ns/node on a computed chain.
  declare value: T;

  _enqueueBwd(): void {
    this.flags |= F.BwdQueued;
    this._queueIdx = bwdQueue.length;
    bwdQueue.push(this as Signal<unknown>);
  }

  /** Source write — alien-signals' signal setter, sans exclusion. */
  _writeSource(next: T): void {
    const prev = this.pendingValue;
    this.pendingValue = next;
    if (prev !== next) {
      this.flags = F.Mutable | F.Dirty;
      const subs = this.subs;
      if (subs !== undefined) propagate(subs, runDepth > 0);
      if (batchDepth === 0 && !flushing && subs !== undefined) flush();
    }
  }

  _update(): boolean {
    if (this.getter !== undefined) {
      // Computed / lens / merge: re-run the forward derivation.
      this.depsTail = undefined;
      this.flags = F.Mutable | F.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      let threw = true;
      try {
        ++cycle;
        const old = this.currentValue;
        const next = (this.currentValue = this.getter());
        threw = false;
        return old !== next;
      } finally {
        activeSub = prev;
        this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
        purgeDeps(this);
      }
    }
    this.flags = F.Mutable;
    return this.currentValue !== (this.currentValue = this.pendingValue);
  }

  _notify(): void {}

  _unwatched(): void {
    if (this.getter !== undefined && this.depsTail !== undefined) {
      this.flags = F.Mutable | F.Dirty;
      disposeAllDepsInReverse(this);
    }
  }

  peek(): T {
    const prev = activeSub;
    activeSub = undefined;
    try {
      return this.value;
    } finally {
      activeSub = prev;
    }
  }

  // ── Construction helpers ──

  static lens<P, R>(
    parent: Signal<P>,
    fwd: (v: P) => R,
    bwd: (target: R, current: P) => P,
  ): Signal<R> {
    const cell = new Signal<R>(undefined as never);
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): R => fwd(parent.value as P);
    cell._bwdFn = bwd as (target: unknown, current?: unknown) => unknown;
    cell._bwdFnArity = bwd.length >= 2 ? 2 : 1;
    cell._bwdParent = parent as Signal<unknown>;
    return cell;
  }

  static derive<P, R>(parent: Signal<P>, fn: (v: P) => R): Signal<R> {
    const cell = new Signal<R>(undefined as never);
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): R => fn(parent.value as P);
    return cell;
  }

  /** Backward-aggregating node — bwd dual of computed. Forward, it is
   *  the identity view of its parent; backward, it folds contributions
   *  from upstream lenses (slot-keyed) and direct writes (DIRECT_SLOT). */
  merge(this: Signal<T>, policy: MergePolicy<T>): Signal<T> {
    if (this.getter !== undefined && this._bwdFn === undefined && !this._isMerge) {
      throw new TypeError("merge: receiver is read-only");
    }
    const parent = this as Signal<T>;
    const cell = new Signal<T>(undefined as never);
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): T => parent.value;
    cell._bwdParent = parent as Signal<unknown>;
    cell._mergeNode = new MergeNode<T>(parent, policy);
    cell._isMerge = true;
    return cell;
  }
}

// Install `value` on the prototype (alien-signals pattern). V8 JITs a
// prototype accessor noticeably better than a class `get/set value` for
// this hot path.
Object.defineProperty(Signal.prototype, "value", {
  get(this: Signal<unknown>): unknown {
    const flags = this.flags;
    if (this.getter !== undefined) {
      if (flags & F.RecursedCheck) {
        throw new RangeError(
          `Cyclic computed: ${(this.constructor as { name?: string }).name ?? "?"} read its own value`,
        );
      }
      if (
        flags & F.Dirty ||
        (flags & F.Pending &&
          (checkDirty(this.deps!, this) || ((this.flags = flags & ~F.Pending), false)))
      ) {
        if (this._update()) {
          const subs = this.subs;
          if (subs !== undefined) shallowPropagate(subs);
        }
      } else if (!flags) {
        // First read: lazy init.
        this.flags = F.Mutable | F.RecursedCheck;
        const prev = activeSub;
        activeSub = this;
        let threw = true;
        try {
          this.currentValue = this.getter();
          threw = false;
        } finally {
          activeSub = prev;
          this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
        }
      }
      if (activeSub !== undefined) link(this, activeSub, cycle);
      return this.currentValue;
    }
    // Signal path.
    if (flags & F.Dirty) {
      this.flags = F.Mutable;
      if (this.currentValue !== (this.currentValue = this.pendingValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.currentValue;
  },
  set(this: Signal<unknown>, next: unknown): void {
    if (this.getter === undefined) {
      this._writeSource(next);
      return;
    }
    // Backward write. Deferred while batching / flushing so repeated
    // writes coalesce (last-write-wins) and merge folds wait for all
    // contributors; eager + synchronous otherwise.
    const deferred = batchDepth > 0 || flushing;
    if (this._isMerge) {
      this._mergeNode!.receive(DIRECT_SLOT, next);
      if (deferred) this._enqueueBwd();
      else cascadeBwd(this, undefined, false);
    } else if (this._bwdFn === undefined) {
      throw new TypeError("Cannot write to a computed");
    } else if (deferred) {
      // Reuse `pendingValue` (unused by a getter cell's forward path)
      // as the deferred backward target. Drained by flush.
      this.pendingValue = next;
      this._enqueueBwd();
    } else {
      cascadeBwd(this, next, false);
    }
  },
  enumerable: false,
  configurable: false,
});

// ─── Backward cascade ─────────────────────────────────────────────
//
// Walk up `_bwdParent`, applying `put` at each lens / folding at each
// merge, until a source is committed (via the forward write path) or a
// parent merge is reached. `deferred` (inside batch / flush) stops at a
// parent merge after depositing — the merge folds later, once all
// contributors have landed. Eager folds merges inline.

function cascadeBwd(start: Signal<unknown>, target: unknown, deferred: boolean): void {
  let cell = start;
  let v = target;
  while (true) {
    const parent = cell._bwdParent!;
    let push: unknown;
    if (cell._isMerge) {
      const node = cell._mergeNode!;
      push = node.fold();
      node.reset();
    } else {
      push = cell._bwdFnArity === 1 ? cell._bwdFn!(v) : cell._bwdFn!(v, parent.peek());
    }

    if (parent._isMerge) {
      parent._mergeNode!.receive(cell, push);
      if (deferred) {
        if (!(parent.flags & F.BwdQueued)) parent._enqueueBwd();
        return;
      }
      cell = parent;
      continue;
    }
    if (parent.getter === undefined) {
      // Source: commit + forward-propagate. This IS the forward write.
      parent._writeSource(push);
      return;
    }
    // Parent is a lens: keep walking, carrying its new view value.
    cell = parent;
    v = push;
  }
}

// ─── factories ────────────────────────────────────────────────────

export function signal<T>(initial: T): Signal<T> {
  return new Signal(initial);
}

export function computed<T>(fn: () => T): Signal<T> {
  const cell = new Signal<T>(undefined as never);
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = fn;
  return cell;
}

// ─── Effect (alien-signals verbatim) ──────────────────────────────

class Effect implements ReactiveNode {
  flags: number = F.Watching | F.RecursedCheck;
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  fn: () => (() => void) | void;
  cleanup: (() => void) | undefined = undefined;

  constructor(fn: () => (() => void) | void) {
    this.fn = fn;
    const prev = activeSub;
    activeSub = this;
    try {
      ++runDepth;
      const ret = fn();
      this.cleanup = typeof ret === "function" ? ret : undefined;
    } finally {
      --runDepth;
      activeSub = prev;
      this.flags &= ~F.RecursedCheck;
    }
  }

  _update(): boolean {
    this.flags = F.Mutable;
    return true;
  }

  _notify(): void {
    let e: Effect = this;
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queued[insertIndex++] = e;
      e.flags &= ~F.Watching;
      const next = e.subs?.sub as Effect | undefined;
      if (next === undefined || !(next.flags & F.Watching)) break;
      e = next;
    } while (true);
    queuedLength = insertIndex;
    let idx = insertIndex,
      firstIdx = firstInsertedIndex;
    while (firstIdx < --idx) {
      const left = queued[firstIdx];
      queued[firstIdx++] = queued[idx];
      queued[idx] = left;
    }
  }

  _unwatched(): void {
    this.flags = F.None;
    disposeAllDepsInReverse(this);
    const sub = this.subs;
    if (sub !== undefined) unlink(sub);
    if (this.cleanup) this._runCleanup();
  }

  _run(): void {
    const flags = this.flags;
    if (flags & F.Dirty || (flags & F.Pending && checkDirty(this.deps!, this))) {
      if (this.cleanup) {
        this._runCleanup();
        if (!this.flags) return;
      }
      this.depsTail = undefined;
      this.flags = F.Watching | F.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      try {
        ++cycle;
        ++runDepth;
        const ret = this.fn();
        this.cleanup = typeof ret === "function" ? ret : undefined;
      } finally {
        --runDepth;
        activeSub = prev;
        this.flags &= ~F.RecursedCheck;
        purgeDeps(this);
      }
    } else if (this.deps !== undefined) {
      this.flags = F.Watching;
    }
  }

  _runCleanup(): void {
    const c = this.cleanup!;
    this.cleanup = undefined;
    const prev = activeSub;
    activeSub = undefined;
    try {
      c();
    } finally {
      activeSub = prev;
    }
  }
}

export function effect(fn: () => (() => void) | void): () => void {
  const e = new Effect(fn);
  return () => e._unwatched();
}

// ─── Flush / batch / untracked ────────────────────────────────────
//
// Alternates backward-drain and effect-drain to a fixpoint: backward
// commits source values (which queue effects); effects may write
// (forward → more effects, or backward → more bwd entries). Loops
// until both queues are exhausted.

function flush(): void {
  if (flushing) return;
  flushing = true;
  let bwdIndex = 0;
  try {
    // Head-checked: when both queues are already drained (the common
    // case — a source write with no watching subscribers still calls
    // flush), the loop body never runs. A `do/while` would pay the
    // empty-drain cost on every write.
    while (bwdIndex < bwdQueue.length || notifyIndex < queuedLength) {
      while (bwdIndex < bwdQueue.length) {
        const cell = bwdQueue[bwdIndex]!;
        if (cell._queueIdx !== bwdIndex || !(cell.flags & F.BwdQueued)) {
          bwdIndex++;
          continue;
        }
        bwdIndex++;
        cell.flags &= ~F.BwdQueued;
        if (cell._isMerge) {
          cascadeBwd(cell, undefined, true);
        } else {
          cascadeBwd(cell, cell.pendingValue, true);
        }
      }
      while (notifyIndex < queuedLength) {
        const e = queued[notifyIndex]!;
        queued[notifyIndex++] = undefined;
        e._run();
      }
    }
  } finally {
    bwdQueue.length = 0;
    notifyIndex = 0;
    queuedLength = 0;
    flushing = false;
  }
}

export function batch<R>(fn: () => R): R {
  ++batchDepth;
  try {
    return fn();
  } finally {
    if (!--batchDepth) flush();
  }
}

export function untracked<R>(fn: () => R): R {
  const prev = activeSub;
  activeSub = undefined;
  try {
    return fn();
  } finally {
    activeSub = prev;
  }
}
