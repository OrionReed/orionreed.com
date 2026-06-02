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
// FAN-OUT — backward dual of fan-in
// ─────────────────────────────────
// A getter reading N parents is forward fan-in. Its backward dual is a
// write that distributes to N parents: `_put(target)` returns a
// per-parent update array and `cascadeBwd` FORKS into each parent
// (`cascadeFanout`). This single primitive subsumes both `_fanin`
// (N→M coupled writables, e.g. mean/diff, procrustes) and symmetric /
// complement lenses. The "complement" — private lens memory that lets
// lossy writes recover discarded info — is NOT a node: it is closure-
// captured state in the getter/`_put`, with no subs, no dirty bits,
// no propagation. Eager fan-out coalesces its N commits under one flush
// (shared-ancestor merges still accumulate all contributions first).
//
// GET / PUT, TRACKED / DECLARED — the core asymmetry
// ──────────────────────────────────────────────────
// Forward and backward are duals but NOT mirror images. A cell `get`s
// its value forward (the `getter`) and `put`s edits backward (`_put`).
// The asymmetry that matters:
//
//   * Forward dependencies are IMPLICIT — auto-tracked by reading
//     `.value` under an `activeSub` (link/propagate/`deps`). You never
//     declare what a getter reads; the engine discovers it each run.
//   * Backward targets are EXPLICIT — declared at construction
//     (`_bwdParent` / `_bwdParents` / a merge's parent). There is no
//     `activeBwdWrite` global precisely because backward is structural,
//     not ambient.
//
// MODE TABLE — a cell's role is fully determined by which fields are set
// (exactly like the forward signal/computed/lens distinction):
//
//   source      getter undefined                 (truth in currentValue)
//   computed    getter,  no _put, no _mergeNode
//   lens 1→1    getter + _put + _bwdParent
//   fan-out     getter + _put + _bwdParents       (1→N / N→M backward)
//   merge       getter + _mergeNode               (N→1 backward fold)
//
// `pendingValue` has a dual role keyed off this table: for a source it
// is the staged forward write; for a getter cell it is the deferred
// backward target awaiting cascade (the two never coexist on a node).
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

/** Spec for a complement-carrying symmetric lens over N parents.
 *
 *  The `complement` is private lens memory: information the view alone
 *  discards (a collapsed cluster's shape, a multiplied-away sign), kept
 *  so lossy writes can be recovered. It is NOT a graph node — it never
 *  fans out, is never observed, and needs no subscriptions or dirty
 *  bookkeeping. The engine stores it as nothing at all; `putr`/`putl`
 *  close over it and mutate it in place. `putr` may refresh it on each
 *  read (forward reads are NOT pure for symmetric lenses — that is the
 *  defining property), and `putl` consults it to undo information loss.
 *
 *  `putr` returns the view; `putl` returns per-parent updates
 *  (`undefined` ⇒ leave that parent untouched). */
export interface SymmetricLensSpecN<S extends readonly unknown[], V, C> {
  missing: C;
  putr: (sources: S, complement: C) => V;
  putl: (target: V, sources: S, complement: C) => ReadonlyArray<S[number] | undefined>;
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

  /** Backward chain: the cell whose `put` produces this cell's upstream.
   *  Single-parent lenses and merges use this. */
  _bwdParent: Signal<unknown> | undefined;

  /** Multi-output backward: the N direct parents a fan-in / symmetric
   *  lens distributes writes to. When set, `_bwdParent` is unused and
   *  `_put(target)` returns a per-parent update array (the dual of a
   *  getter reading N parents). The cascade FORKS into each parent.
   *  Any private lens state (a "complement") is closure-captured by the
   *  getter/`_put` — it needs no node, no subs, no bookkeeping. */
  _bwdParents: Signal<unknown>[] | undefined;

  /** Lens `put` — the backward derivation (dual of `getter`). Arity
   *  distinguishes `(t)=>p` from `(t,current)=>p`. For multi-output
   *  cells, `_put(target)` returns a per-parent update array and
   *  `_putArity` is irrelevant (the peek is baked into the fn). */
  // biome-ignore lint/suspicious/noExplicitAny: put fn is opaque shape
  _put: ((target: any, current?: any) => any) | undefined;
  _putArity: 1 | 2;

  /** Backward fan-in (dual of a multi-dep computed). When set, this
   *  cell folds contributions via a policy instead of applying a `put`.
   *  Presence of `_mergeNode` IS the "merge mode" discriminant. */
  _mergeNode: MergeNode<T> | undefined;

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
    this._bwdParents = undefined;
    this._put = undefined;
    this._putArity = 1;
    this._mergeNode = undefined;
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
    cell._put = bwd as (target: unknown, current?: unknown) => unknown;
    cell._putArity = bwd.length >= 2 ? 2 : 1;
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
    if (this.getter !== undefined && this._put === undefined && this._mergeNode === undefined) {
      throw new TypeError("merge: receiver is read-only");
    }
    const parent = this as Signal<T>;
    const cell = new Signal<T>(undefined as never);
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): T => parent.value;
    cell._bwdParent = parent as Signal<unknown>;
    cell._mergeNode = new MergeNode<T>(parent, policy);
    return cell;
  }

  /** N-input lens (fan-in). Forward: `fwd(vals)` over the N parents'
   *  values (auto-linked as deps — forward fan-in is just a getter
   *  reading N cells). Backward: `bwd(target, vals?)` returns a
   *  per-parent update array; the cascade forks into each parent.
   *  Arity-dispatched — stateless `(t)=>updates` skips the parent peek;
   *  stateful `(t, vals)=>updates` gets the current parent values.
   *  Omit `bwd` for a read-only N-input derive. One scratch `vals`
   *  array allocated, reused for read and write. */
  static fanin<R>(
    parents: readonly Signal<unknown>[],
    fwd: (vals: readonly unknown[]) => R,
    bwd?: (target: R, vals?: readonly unknown[]) => ReadonlyArray<unknown>,
  ): Signal<R> {
    const n = parents.length;
    const vals = new Array<unknown>(n);
    const cell = new Signal<R>(undefined as never);
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): R => {
      for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
      return fwd(vals);
    };
    if (bwd === undefined) return cell; // read-only derive-N
    cell._bwdParents = parents as Signal<unknown>[];
    cell._put =
      bwd.length >= 2
        ? (target: unknown): unknown => {
            for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
            return (bwd as (t: R, v: readonly unknown[]) => ReadonlyArray<unknown>)(
              target as R,
              vals,
            );
          }
        : (target: unknown): unknown => (bwd as (t: R) => ReadonlyArray<unknown>)(target as R);
    return cell;
  }

  /** N-input symmetric lens carrying a private complement. Sugar over
   *  `fanin` where `putr`/`putl` share closure-captured complement
   *  state (`spec.missing`, mutated in place). The complement is NOT a
   *  cell — see `SymmetricLensSpecN`. */
  static symmetric<R, C>(
    parents: readonly Signal<unknown>[],
    spec: SymmetricLensSpecN<readonly unknown[], R, C>,
  ): Signal<R> {
    const n = parents.length;
    const vals = new Array<unknown>(n);
    const complement = spec.missing;
    const cell = new Signal<R>(undefined as never);
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): R => {
      for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
      return spec.putr(vals, complement);
    };
    cell._bwdParents = parents as Signal<unknown>[];
    cell._put = (target: unknown): unknown => {
      for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
      return spec.putl(target as R, vals, complement);
    };
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
    if (this._mergeNode !== undefined) {
      this._mergeNode.receive(DIRECT_SLOT, next);
      if (deferred) this._enqueueBwd();
      else cascadeBwd(this, undefined, false);
    } else if (this._put === undefined) {
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
//
// This is NOT a second propagation engine: every path terminates in
// `_writeSource` (the forward write). Backward "compiles" a view-edit
// into source-edits; the forward machinery does the rest.

function cascadeBwd(start: Signal<unknown>, target: unknown, deferred: boolean): void {
  let cell = start;
  let v = target;
  while (true) {
    // Multi-output (fan-in / symmetric): compute the per-parent update
    // array and FORK the cascade into each parent. This is the dual of
    // a getter reading N parents — instead of one upstream value, the
    // `put` yields N. The recursion handles each branch (source, lens,
    // merge, or nested fan-in) uniformly.
    if (cell._bwdParents !== undefined) {
      cascadeFanout(cell, v, deferred);
      return;
    }
    const parent = cell._bwdParent!;
    let push: unknown;
    if (cell._mergeNode !== undefined) {
      const node = cell._mergeNode;
      push = node.fold();
      node.reset();
    } else {
      push = cell._putArity === 1 ? cell._put!(v) : cell._put!(v, parent.peek());
    }

    if (parent._mergeNode !== undefined) {
      parent._mergeNode.receive(cell, push);
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

/** Fork a multi-output cell's write into its N parents. `_put(target)`
 *  returns the per-parent update array (`undefined` ⇒ leave parent
 *  untouched); each defined update recurses via `cascadeBwd`.
 *
 *  Eager (unbatched) forks coalesce under a single flush: the N source
 *  commits batch into one effect pass, and shared-ancestor merges
 *  accumulate all contributions before folding — same guarantee
 *  `batch()` gives. (A multi-output cell may be reached eagerly as the
 *  start of a write OR mid-chain from an outer single lens, so the
 *  coalescing must live here, not at the write entry point.) */
function cascadeFanout(cell: Signal<unknown>, target: unknown, deferred: boolean): void {
  const parents = cell._bwdParents!;
  const updates = cell._put!(target) as ReadonlyArray<unknown>;
  const n = parents.length;
  if (deferred) {
    forkInto(parents, updates, n);
    return;
  }
  ++batchDepth;
  try {
    forkInto(parents, updates, n);
  } finally {
    if (!--batchDepth) flush();
  }
}

/** Route each defined update to its parent. A source parent commits
 *  directly (it has no backward chain to walk); a lens / fan-in / merge
 *  parent re-enters the cascade. Always called under a bumped
 *  `batchDepth`, so commits coalesce into one flush. */
function forkInto(
  parents: Signal<unknown>[],
  updates: ReadonlyArray<unknown>,
  n: number,
): void {
  for (let i = 0; i < n; i++) {
    const u = updates[i];
    if (u === undefined) continue;
    const parent = parents[i]!;
    if (parent.getter === undefined) parent._writeSource(u);
    else cascadeBwd(parent, u, true);
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
        if (cell._mergeNode !== undefined) {
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
