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
// machinery (propagate + equality-pruned checkDirty) refreshes every
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
//   * Short-circuit is free and equality-checked: if the source delta
//     is a no-op, the forward write no-ops, nothing fires. The "furthest
//     upward changed node" (the pivot) is the source for chains, or a
//     merge where contributions cancel.
//   * Backward cost ≤ forward cost: the walk is N puts; the refresh is
//     the same lazy, equality-checked pull forward already pays. Reads
//     that don't observe a node never recompute it.
//
// MERGE — backward dual of computed
// ─────────────────────────────────
// Computed = N→1 forward derivation. Merge = N→1 backward aggregation.
// Contributions land in a slot map keyed by contributor identity and
// fold via a user policy. Within one settle a merge re-aggregates only
// the contributions it received (slots reset per settle); batching
// (one settle) coalesces multiple writes, last-write-wins per slot.
//
// MULTI-PARENT LENS — backward dual of a multi-dep getter
// ───────────────────────────────────────────────────────
// A getter reading N parents is a forward multi-dep node. Its backward
// dual is a write that SPLITS across N parents: `_put(target)` returns a
// per-parent update array and `propagateBwd` splits into each parent
// (`propagateSplit`). This one primitive covers coupled writables (N→M,
// e.g. mean/diff, procrustes). When a lossy write must recover info the
// source can't hold (a collapsed cluster's directions), the memory lives
// in a `statefulLens` complement (threaded by `init`/`step`) that `bwd`
// reads — NOT in a bespoke engine kind. An eager split coalesces its N
// commits under one flush (shared-ancestor merges still accumulate all
// contributions first).
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
//     (`_bwdParent`, single or array, or a merge's parent). There is no
//     `activeBwdWrite` global precisely because backward is structural,
//     not ambient.
//
// MODE TABLE — a cell's role is fully determined by which fields are set
// (exactly like the forward signal/computed/lens distinction):
//
//   source      getter undefined                 (truth in currentValue)
//   computed    getter,  no _put, no _mergeNode
//   lens 1→1    getter + _put + _bwdParent (Signal)
//   multi-out   getter + _put + _bwdParent (Signal[])  (1→N / N→M bwd)
//   merge       getter + _mergeNode               (N→1 backward fold)
//
// `pendingValue` has a dual role keyed off this table: for a source it
// is the staged forward write; for a getter cell it is the deferred
// backward target awaiting the backward pass (the two never coexist on
// a node).
//
// BATCHING
//   * Outside batch: a write propagates backward eagerly and flushes —
//     matching alien's synchronous per-write semantics.
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
/** The `_NetworkNode` currently running its body, if any. Source writes
 *  self-exclude it so a network that reads+writes a signal doesn't
 *  re-trigger itself. `undefined` outside a network body — then writes
 *  behave exactly as the pre-network engine. */
let activeNetwork: _NetworkNode | undefined;
const queued: (Effect | _NetworkNode | undefined)[] = [];

const EMPTY_DIRTY: ReadonlySet<Signal<unknown>> = new Set();

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

// ─── Write hook (for assert/record attribution) ───────────────────
//
// Fires when a SOURCE commits a value-change (the one place truth
// mutates). Backward writes reach it via `_writeSource`, so lens edits
// attribute to the source they resolve to.

let writeHook: ((sig: Signal<unknown>) => void) | undefined;

/** Install a hook fired on every source value-change. Returns a restore
 *  function. Used by assert/record to attribute mutations. */
export function setSignalWriteHook(
  fn: ((sig: Signal<unknown>) => void) | undefined,
): () => void {
  const prev = writeHook;
  writeHook = fn;
  return () => {
    writeHook = prev;
  };
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
  const isFirstSub = dep.subs === undefined;
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
  // First-subscriber lifecycle hook (dual: last-sub in `_unwatched`).
  if (isFirstSub && dep instanceof Signal) {
    const hook = dep._watched;
    if (hook !== undefined) hook.call(dep);
  }
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

function propagate(start: Link, innerWrite: boolean, excluding?: ReactiveNode): void {
  let l: Link | undefined = start;
  let next: Link | undefined = start.nextSub;
  let stack: Stack<Link | undefined> | undefined;
  top: do {
    const sub: ReactiveNode = l!.sub;
    // `excluding` skips one subscriber from notification — used by
    // `network()` so a body that writes a signal it subscribes to
    // doesn't re-trigger itself. The advance/stack-pop logic below runs
    // unchanged, so other subs are visited normally.
    if (sub !== excluding) {
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

// ─── MergeNode — backward aggregation (N→1) ───────────────────────

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

// ─── Public types (writability layer) ─────────────────────────────

/** Plain T or any read-shape. Permissive consumer input — `readNow(v)`
 *  for a snapshot, `reader(v)` for a per-call closure. */
export type Val<T> = T | Read<T>;

/** Covariant read-only surface. */
export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

/** Brand for writable receivers; the discriminator for conditional
 *  writability-propagating return types. */
declare const WRITABLE: unique symbol;
export interface WritableBrand {
  readonly [WRITABLE]: never;
}

/** Value type carried by a reactive read shape. */
export type Inner<R> = R extends Signal<infer T> ? T : R extends Read<infer T> ? T : never;

/** The writable form of R: adds the brand + a settable `value`. */
export type Writable<R> = R & WritableBrand & { value: Inner<R> };

/** Strict factory input: a literal, or an existing `Writable<Cls>`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors `Inner`
export type Init<C extends Signal<any>> = Inner<C> | Writable<C>;

/** Snapshot a `Val<T>` to plain `T` (one-shot, no tracking). */
export function readNow<T>(v: Val<T>): T {
  if (v instanceof Signal) return v.value as T;
  return v as T;
}

/** Resolve a `Val<T>` to a `() => T` closure that unwraps on each call. */
export function reader<T>(v: Val<T>): () => T {
  if (v instanceof Signal) return () => v.value as T;
  return () => v as T;
}

/** Self-rewriting lazy getter: first call computes + installs an own
 *  non-enumerable property under `key`; later reads shadow this getter. */
export function lazy<R>(self: object, key: string | symbol, make: () => R): R {
  const v = make();
  Object.defineProperty(self, key, {
    value: v,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return v;
}

export const isSignal = (v: unknown): v is Signal<unknown> => v instanceof Signal;

/** Lens mode: a derived cell that can be written back (has a `put` or
 *  is a merge). The dual-direction analog of the main engine's
 *  getter+setter check. */
export const isLens = (v: unknown): v is Signal<unknown> =>
  v instanceof Signal &&
  v.getter !== undefined &&
  (v._put !== undefined || v._mergeNode !== undefined);

/** Computed mode: derived + read-only (no backward path). */
export const isComputed = (v: unknown): v is Signal<unknown> =>
  v instanceof Signal && v.getter !== undefined && v._put === undefined && v._mergeNode === undefined;

// ─── Signal class ─────────────────────────────────────────────────

export interface SignalOptions<T = unknown> {
  /** First subscriber attached (lifecycle: start a spring, attach a
   *  resource). Fired from `link` when a node gains its first sub. */
  watched?: () => void;
  /** Last subscriber detached. Fired from `_unwatched`. */
  unwatched?: () => void;
  /** Per-instance value equality; defaults to `Object.is` when omitted.
   *  Value classes thread their own through `super(v, { equals })`.
   *  Hot-read on every write/recompute — the engine stays trait-blind. */
  equals?: (a: T, b: T) => boolean;
}

export class Signal<T = unknown> implements ReactiveNode {
  flags: number = F.Mutable;
  subs: Link | undefined;
  subsTail: Link | undefined;
  deps: Link | undefined;
  depsTail: Link | undefined;

  /** Forward derivation (computed/lens/merge). `undefined` ⇒ source. */
  getter: (() => T) | undefined;

  /** Per-instance equality; `Object.is` unless `opts.equals` overrides.
   *  Always defined (the default is baked in at construction) so the hot
   *  paths call it unconditionally — no `undefined` branch. */
  _equals: (a: T, b: T) => boolean;
  /** First-subscriber / last-subscriber lifecycle hooks. */
  _watched: (() => void) | undefined;
  _unwatchedHook: (() => void) | undefined;

  /** The node's current value. A node is EITHER a source (uses
   *  `currentValue` = committed, `pendingValue` = staged write) OR a
   *  getter cell (uses `currentValue` = last derived cache, and reuses
   *  `pendingValue` for its deferred backward target — see `set value`).
   *  The two roles never coexist on one node, so two fields suffice for
   *  what would naively be four. This reuse is the fwd/bwd duality made
   *  concrete: "value pending commit" means staged-forward for a source
   *  and target-pending-backward-pass for a lens. */
  currentValue: T;
  pendingValue: T;

  /** Backward target: the upstream this cell's `put` writes through. One
   *  field, two shapes:
   *    • a single `Signal` — a 1→1 lens or a merge's parent.
   *    • a `Signal[]` — a multi-parent lens whose `_put(target)` returns
   *      a per-parent update array (the dual of a getter reading N
   *      parents); the backward pass splits into each parent.
   *  Any private state a multi-parent `_put` needs is closure-captured
   *  (params it reads, or a `statefulLens` complement for degeneracy
   *  memory) — no node, no subs, no bookkeeping. */
  _bwdParent: Signal<unknown> | Signal<unknown>[] | undefined;

  /** Lens `put` — the backward derivation (dual of `getter`). For multi-
   *  output cells, `_put(target)` returns a per-parent update array (the
   *  peek is baked into the fn). */
  // biome-ignore lint/suspicious/noExplicitAny: put fn is opaque shape
  _put: ((target: any, current?: any) => any) | undefined;

  /** Put arity, set by the factory (NOT inferred from the `bwd` function):
   *  `1` for `iso` (source-independent put `(view)=>src`), `2` for `lens`
   *  (source-reading put `(view, src)=>src`, engine peeks the parent). A
   *  cached SMI field — branching on it in the backward pass is far cheaper
   *  than a `_put.length` load. Irrelevant for multi-output cells (the peek
   *  is baked into `_put`). */
  _putArity: 1 | 2;

  /** Raw forward projection, kept separate from `getter` (which closes
   *  over `parent.value`) so the backward equality check can evaluate
   *  this cell's view against CANDIDATE parent value(s) — `_fwd(push)` —
   *  without committing. Set for plain (1→1) lenses and multi-parent
   *  lenses (N-ary, over a candidate vals array); undefined for sources /
   *  computeds / merges. */
  // biome-ignore lint/suspicious/noExplicitAny: fwd fn is opaque shape
  _fwd: ((parentValue: any) => any) | undefined;

  /** Backward aggregation (dual of a multi-dep computed). When set, this
   *  cell folds contributions via a policy instead of applying a `put`.
   *  Presence of `_mergeNode` IS the "merge mode" discriminant. */
  _mergeNode: MergeNode<T> | undefined;

  /** Stateful-lens complement: the hidden memory the view discards (a
   *  case mask under `lowercase`, the unwrapped angle under a principal
   *  axis). Engine-owned; advanced only by `_step` (forward / on commit).
   *  `undefined` for every non-stateful cell. */
  _complement: unknown;

  /** Stateful-lens complement advance. Presence IS the "stateful mode"
   *  discriminant. For a stateful cell `_fwd(vals, c)` and `_put(target,
   *  vals, c)` take the complement; `_step(vals, c, external)` returns the
   *  next complement (`external` ⇒ the source change came from outside,
   *  not this lens's own back-write). */
  // biome-ignore lint/suspicious/noExplicitAny: opaque step shape
  _step: ((vals: any, complement: any, external: boolean) => any) | undefined;

  /** The source values a stateful cell last wrote back. The next forward
   *  recompute reports `external === false` while the live sources still
   *  equal these (the change is the lens's OWN back-write, not an outside
   *  edit) — robust regardless of when/if the getter re-runs. `undefined`
   *  until the first back-write. */
  _lastBwd: unknown[] | undefined;

  /** Index in `bwdQueue` of this cell's LATEST push. The drain skips
   *  entries whose `_queueIdx` ≠ their position, so each cell propagates
   *  backward once per flush in last-write order. */
  _queueIdx: number;

  constructor(initial: T, opts?: SignalOptions<T>) {
    this.currentValue = initial;
    this.pendingValue = initial;
    // Pre-init every optional slot so the V8 hidden class is stable
    // across signal / computed / lens / merge variants.
    this.subs = undefined;
    this.subsTail = undefined;
    this.deps = undefined;
    this.depsTail = undefined;
    this.getter = undefined;
    this._equals = Object.is;
    this._watched = undefined;
    this._unwatchedHook = undefined;
    this._bwdParent = undefined;
    this._put = undefined;
    this._putArity = 1;
    this._fwd = undefined;
    this._mergeNode = undefined;
    this._complement = undefined;
    this._step = undefined;
    this._lastBwd = undefined;
    this._queueIdx = -1;
    if (opts !== undefined) {
      if (opts.equals !== undefined) this._equals = opts.equals;
      if (opts.watched !== undefined) this._watched = opts.watched;
      if (opts.unwatched !== undefined) this._unwatchedHook = opts.unwatched;
    }
  }

  // ── Forward read / write ──
  //
  // The `value` accessor is installed on the prototype via
  // `Object.defineProperty` after the class body (see below), matching
  // alien-signals. V8 optimizes the prototype accessor better than a
  // class `get/set` here — ~5 ns/node on a computed chain.
  //
  // Declared `readonly` so a bare cell is read-only at the TYPE level;
  // writability is added back only through `Writable<R>` (brand +
  // settable `value`). The runtime accessor is settable regardless.
  declare readonly value: T;

  _enqueueBwd(): void {
    this.flags |= F.BwdQueued;
    this._queueIdx = bwdQueue.length;
    bwdQueue.push(this as Signal<unknown>);
  }

  /** Source write — alien-signals' signal setter. Self-excludes the
   *  active network (if any) so a network body writing its own dep
   *  doesn't re-trigger itself; `activeNetwork` is `undefined` outside a
   *  network body, so the exclusion is a no-op in the common case. */
  _writeSource(next: T): void {
    const prev = this.pendingValue;
    this.pendingValue = next;
    if (!this._equals(prev, next)) {
      this.flags = F.Mutable | F.Dirty;
      if (writeHook !== undefined) writeHook(this as Signal<unknown>);
      const subs = this.subs;
      if (subs !== undefined) propagate(subs, runDepth > 0, activeNetwork);
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
        return !this._equals(old, next);
      } finally {
        activeSub = prev;
        this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
        purgeDeps(this);
      }
    }
    this.flags = F.Mutable;
    const prevV = this.currentValue;
    this.currentValue = this.pendingValue;
    return !this._equals(prevV, this.currentValue);
  }

  _notify(): void {}

  _unwatched(): void {
    if (this.getter !== undefined && this.depsTail !== undefined) {
      this.flags = F.Mutable | F.Dirty;
      disposeAllDepsInReverse(this);
      return;
    }
    if (this._unwatchedHook !== undefined) this._unwatchedHook();
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

  /** Footgun guard: silent coercion to string/number is almost always a bug. */
  [Symbol.toPrimitive](hint: string): never {
    throw new TypeError(`Signal cannot be coerced to ${hint} — use \`.value\``);
  }

  // ── Construction helpers ──
  //
  // All build via `new this()` so a subclass static (`Vec.lens(...)`)
  // yields a `Vec`, inheriting its constructor-set equality. No `_fuse`,
  // no closure-setter form — every lens has a structural backward target
  // (`_bwdParent` single/array/merge parent), which is what makes the
  // backward pass well-defined.

  /** Endomorphic source-independent lens (`iso`): `put` reconstructs the
   *  source from the view alone. The bread-and-butter chaining primitive
   *  (`num.add(1).scale(2)`). Cross-type uses static `OtherCls.iso(this, …)`. */
  iso(this: Signal<T>, fwd: (v: T) => T, bwd: (target: T) => T): this {
    return buildLens1(
      this.constructor as SignalCtor<Signal<T>>,
      this as Signal<unknown>,
      fwd as (v: unknown) => unknown,
      bwd as (t: unknown) => unknown,
      false,
    ) as this;
  }

  /** Endomorphic source-reading lens: `put(view, current)` consults the
   *  current source (to preserve a complement-in-source, e.g. nearest
   *  representative). Cross-type uses static `OtherCls.lens(this, …)`. */
  lens(this: Signal<T>, fwd: (v: T) => T, bwd: (target: T, current: T) => T): this {
    return buildLens1(
      this.constructor as SignalCtor<Signal<T>>,
      this as Signal<unknown>,
      fwd as (v: unknown) => unknown,
      bwd as (t: unknown, s?: unknown) => unknown,
      true,
    ) as this;
  }

  /** Backward-aggregating node — bwd dual of computed. Forward, the
   *  identity view of its parent; backward, folds contributions from
   *  upstream lenses (slot-keyed) and direct writes (DIRECT_SLOT). */
  merge(this: Signal<T>, policy: MergePolicy<T>): Signal<T> {
    if (this.getter !== undefined && this._put === undefined && this._mergeNode === undefined) {
      throw new TypeError("merge: receiver is read-only");
    }
    const parent = this as Signal<T>;
    const cell = new (this.constructor as SignalCtor<Signal<T>>)();
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): T => parent.value;
    cell._bwdParent = parent as Signal<unknown>;
    cell._mergeNode = new MergeNode<T>(parent, policy);
    return cell as Signal<T>;
  }

  /** Read-only typed view. `Cls.derive(parent, fn)` (1-input),
   *  `Cls.derive(parents, fn)` (N-input), or `Cls.derive(fn)` (closure).
   *  Polymorphic-`this`: `Vec.derive(...)` → `Vec`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Signal<any>, P>(
    this: C,
    parent: Read<P>,
    fn: (v: P) => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Signal<any>, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fn: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    fn: () => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static derive(this: any, ...args: any[]): any {
    if (args.length === 1) return buildComputed(this, args[0]);
    const [parent, fn] = args;
    if (Array.isArray(parent)) return buildLensN(this, parent, fn, undefined, false);
    return buildComputed(this, () => fn((parent as Signal<unknown>).value));
  }

  /** Source-reading lens: `put` consults the current source(s). Runtime-
   *  dispatched on arity:
   *    Cls.lens(parent,  fwd, bwd)  — 1-input;  bwd `(view, src) => src`.
   *    Cls.lens(parents, fwd, bwd)  — N-input;  bwd `(view, srcs) => srcs[]`.
   *  Polymorphic-`this`: `Vec.lens(...)` → `Writable<Vec>`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Signal<any>, P>(
    this: C,
    parent: Read<P>,
    fwd: (v: P) => Inner<InstanceType<C>>,
    bwd: (target: Inner<InstanceType<C>>, v: P) => P,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Signal<any>, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fwd: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => Inner<InstanceType<C>>,
    bwd: (
      target: Inner<InstanceType<C>>,
      vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
    ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static lens(this: any, ...args: any[]): any {
    const [parent, fwd, bwd] = args;
    if (Array.isArray(parent)) return buildLensN(this, parent, fwd, bwd, true);
    return buildLens1(this, parent, fwd, bwd, true);
  }

  /** Type predicate against this class: `Vec.is(x)` narrows `x` to `Vec`.
   *  Inherited static; works for any subclass via polymorphic `this`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static is<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    v: unknown,
  ): v is InstanceType<C> {
    return v instanceof this;
  }

  /** Source-independent lens (`iso`): `put` reconstructs the source from
   *  the view alone — no peek. Runtime-dispatched on arity:
   *    Cls.iso(parent,  fwd, bwd)  — 1-input;  bwd `(view) => src`.
   *    Cls.iso(parents, fwd, bwd)  — N-input;  bwd `(view) => srcs[]`.
   *  Polymorphic-`this`: `Vec.iso(...)` → `Writable<Vec>`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static iso<C extends new (...args: never[]) => Signal<any>, P>(
    this: C,
    parent: Read<P>,
    fwd: (v: P) => Inner<InstanceType<C>>,
    bwd: (target: Inner<InstanceType<C>>) => P,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static iso<C extends new (...args: never[]) => Signal<any>, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fwd: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => Inner<InstanceType<C>>,
    bwd: (target: Inner<InstanceType<C>>) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static iso(this: any, ...args: any[]): any {
    const [parent, fwd, bwd] = args;
    if (Array.isArray(parent)) return buildLensN(this, parent, fwd, bwd, false);
    return buildLens1(this, parent, fwd, bwd, false);
  }

  /** Complement-carrying lens (`statefulLens`): `put` reads memory the view
   *  discards. `Cls.statefulLens(parent, spec)` (1-input) or
   *  `Cls.statefulLens(parents, spec)` (N-input). Polymorphic-`this`:
   *  `Num.statefulLens(...)` → `Writable<Num>`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static statefulLens<C extends new (...args: never[]) => Signal<any>, P, Cm>(
    this: C,
    parent: Read<P>,
    spec: StatefulLensSpec<readonly [P], Inner<InstanceType<C>>, Cm>,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static statefulLens<
    C extends new (...args: never[]) => Signal<any>,
    P extends readonly Read<unknown>[],
    Cm,
  >(
    this: C,
    parents: P,
    spec: StatefulLensSpec<
      { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
      Inner<InstanceType<C>>,
      Cm
    >,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static statefulLens(this: any, parent: any, spec: any): any {
    return buildStateful(this, Array.isArray(parent) ? parent : [parent], spec);
  }

  /** Permissive consumer-layer lift — `Val<Inner<Cls>>` → `Cls`.
   *  Instance → identity; RO signal → tracked `derive`; literal → fresh
   *  seed. Return type is `Cls` (writability not assumed). */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static from<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    v: Val<Inner<InstanceType<C>>>,
  ): InstanceType<C> {
    if (v instanceof this) return v as InstanceType<C>;
    if (v instanceof Signal) {
      // biome-ignore lint/suspicious/noExplicitAny: dispatch
      return (this as any).derive(() => readNow(v)) as InstanceType<C>;
    }
    return new (this as unknown as new (init?: Inner<InstanceType<C>>) => InstanceType<C>)(
      v as Inner<InstanceType<C>>,
    ) as InstanceType<C>;
  }

  /** Constant-projection: a `Writable<this>` that always reads `v` and
   *  absorbs writes (parentless sink lens). The writable-shaped constant
   *  for APIs demanding bidirectionality. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static pin<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    v: Inner<InstanceType<C>>,
  ): Writable<InstanceType<C>> {
    const cell = new (this as unknown as SignalCtor<Signal<unknown>>)();
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): unknown => v;
    cell._put = (): unknown => undefined; // absorb (no parent → sink)
    cell._putArity = 1;
    return cell as unknown as Writable<InstanceType<C>>;
  }

  /** Typed field lens onto `parent.value[key]`. Dispatches on the
   *  parent's mode: a read-only computed parent yields a RO derive
   *  view; any writable parent (source / lens / merge / multi-parent) yields
   *  a bidirectional field lens with spread-replace `put`. Mirrors the
   *  writability-propagating conditional in `field()`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static fieldOf<C extends new (...args: never[]) => Signal<any>>(
    // biome-ignore lint/suspicious/noExplicitAny: parent is contravariant on put
    parent: Signal<any>,
    key: string | number | symbol,
    Cls: C,
  ): InstanceType<C> {
    const ctor = Cls as unknown as SignalCtor<Signal<unknown>>;
    const get = (s: unknown): unknown => (s as Record<string | number | symbol, unknown>)[key];
    // Read-only ⇔ a computed/derive (getter, no put, no merge). A multi-
    // parent lens always has `_put`, so the `_put === undefined` clause
    // already excludes the multi-output case — no need to check `_bwdParent`.
    const ro =
      parent.getter !== undefined && parent._put === undefined && parent._mergeNode === undefined;
    if (ro) {
      return buildComputed(ctor, () => get(parent.value)) as InstanceType<C>;
    }
    // Spread-replace reads the current source ⇒ source-reading (lens) form.
    return buildLens1(
      ctor,
      parent as Signal<unknown>,
      get,
      (v, s) => ({ ...(s as object), [key]: v }),
      true,
    ) as InstanceType<C>;
  }
}

// ─── Cell builders ────────────────────────────────────────────────
//
// Each `new Cls()` instantiates the right subclass (so `Vec.lens(...)`
// returns a `Vec` with Vec equality from its constructor), then sets
// the mode fields. Module-level so the class statics can call them.

// biome-ignore lint/suspicious/noExplicitAny: variance escape for subclass ctors (contravariant _equals)
type SignalCtor<C extends Signal<any>> = new (...args: never[]) => C;

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildComputed<C extends Signal<any>>(Cls: SignalCtor<C>, getter: () => unknown): C {
  const cell = new Cls();
  cell.getter = getter as () => never;
  cell.flags = F.Mutable | F.Dirty;
  return cell;
}

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildLens1<C extends Signal<any>>(
  Cls: SignalCtor<C>,
  parent: Signal<unknown>,
  fwd: (v: unknown) => unknown,
  bwd: (t: unknown, s?: unknown) => unknown,
  readsSource: boolean,
): C {
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = (() => fwd(parent.value)) as () => never;
  cell._fwd = fwd;
  cell._put = bwd;
  cell._putArity = readsSource ? 2 : 1;
  cell._bwdParent = parent;
  return cell;
}

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildLensN<C extends Signal<any>>(
  Cls: SignalCtor<C>,
  parents: Signal<unknown>[],
  fwd: (vals: readonly unknown[]) => unknown,
  bwd: ((target: unknown, vals?: readonly unknown[]) => ReadonlyArray<unknown>) | undefined,
  readsSource: boolean,
): C {
  const n = parents.length;
  const vals = new Array<unknown>(n);
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = (() => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    return fwd(vals);
  }) as () => never;
  if (bwd === undefined) return cell; // read-only derive-N
  cell._fwd = fwd as (v: unknown) => unknown; // N-ary projection for the equality check
  cell._bwdParent = parents;
  cell._put = readsSource
    ? (target: unknown): unknown => {
        for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
        return bwd(target, vals);
      }
    : (target: unknown): unknown => bwd(target);
  return cell;
}

// ─── Stateful lens (complement-carrying) ──────────────────────────────
//
// The third writable kind, alongside `iso` (view determines source) and
// `lens` (put reads the source). A stateful lens carries a COMPLEMENT —
// memory the source can't hold: the original casing a `lowercase` view
// discards, the continuous winding a principal-axis angle accumulates.
//
//   init(srcs)              → seed the complement from the initial sources
//   fwd(srcs, c)            → the view (pure)
//   step(srcs, c, external) → advance the complement (forward / on commit);
//                             `external` distinguishes an outside source
//                             change from this lens's own back-write
//   bwd(target, srcs, c)    → { updates, complement }: per-parent source
//                             updates (`undefined` ⇒ leave that parent) and
//                             the post-write complement
//
// All four are pure and side-effect-free (no in-place complement mutation
// — the equality check evaluates them speculatively); `bwd`/`step` read no
// signals (the backward pass runs untracked). The engine owns `c`,
// advancing it only on a real (non-speculative) forward recompute or
// commit — never during the equality-check short-circuit.
//
// GUARANTEE: before `bwd` runs the engine steps `c` to the current sources
// (a forward recompute), so `bwd` always sees an up-to-date complement and
// never needs to re-derive it from `srcs`.

export interface StatefulBwd<S extends readonly unknown[], C> {
  updates: { readonly [K in keyof S]: S[K] | undefined };
  complement: C;
}

export interface StatefulLensSpec<S extends readonly unknown[], V, C> {
  init: (sources: S) => C;
  step: (sources: S, complement: C, external: boolean) => C;
  fwd: (sources: S, complement: C) => V;
  bwd: (target: V, sources: S, complement: C) => StatefulBwd<S, C>;
}

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildStateful<C extends Signal<any>>(
  Cls: SignalCtor<C>,
  parents: Signal<unknown>[],
  // biome-ignore lint/suspicious/noExplicitAny: opaque spec
  spec: StatefulLensSpec<any, any, any>,
): C {
  const n = parents.length;
  const vals = new Array<unknown>(n);
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  const seed = new Array<unknown>(n);
  for (let i = 0; i < n; i++) seed[i] = parents[i]!.peek();
  cell._complement = spec.init(seed);
  cell._step = spec.step;
  // For a stateful cell `_fwd`/`_put` take the complement (see field docs).
  cell._fwd = spec.fwd as (v: unknown) => unknown;
  cell._put = spec.bwd as (t: unknown, c?: unknown) => unknown;
  cell._bwdParent = parents;
  cell.getter = (() => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    // External unless the live sources still equal this lens's own last
    // back-write (then the complement is kept, not re-recorded).
    let external = true;
    const lb = cell._lastBwd;
    if (lb !== undefined) {
      external = false;
      for (let i = 0; i < n; i++) {
        if (vals[i] !== lb[i]) {
          external = true;
          break;
        }
      }
    }
    cell._complement = cell._step!(vals, cell._complement, external);
    return (cell._fwd as (s: unknown, c: unknown) => unknown)(vals, cell._complement);
  }) as () => never;
  return cell;
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
      const prevV = this.currentValue;
      this.currentValue = this.pendingValue;
      if (!this._equals(prevV, this.currentValue)) {
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
    //
    // Exception: inside a network body (`activeNetwork` set) writes are
    // eager so a propagator's synchronous fixpoint loop observes its own
    // edits via `peek()` between steps — matching the old engine's
    // synchronous in-network writes. (Coalescing still applies to plain
    // batches and effects, where `activeNetwork` is undefined.)
    const deferred = (batchDepth > 0 || flushing) && activeNetwork === undefined;
    if (this._mergeNode !== undefined) {
      this._mergeNode.receive(DIRECT_SLOT, next);
      if (deferred) this._enqueueBwd();
      else bwdUntracked(this, undefined, false);
      return;
    }
    if (this._put === undefined) {
      throw new TypeError("Cannot write to a computed");
    }
    // The backward equality check lives in `propagateBwd` (per step),
    // where it can compare this lens's PROJECTED view against a candidate
    // parent value. That subsumes the old entry-level `next ===
    // currentView` check: a no-op write is caught there once the
    // backward pass runs.
    if (deferred) {
      // Reuse `pendingValue` (unused by a getter cell's forward path)
      // as the deferred backward target. Drained by flush.
      this.pendingValue = next;
      this._enqueueBwd();
    } else {
      bwdUntracked(this, next, false);
    }
  },
  enumerable: false,
  configurable: false,
});

// ─── Backward pass (propagateBwd) ─────────────────────────────────
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

// Backward evaluation runs UNTRACKED: `bwd`/`step`/`fwd` reads (params via
// `reader`, complement memory) must not establish forward dependencies on
// whatever `activeSub` happens to be writing (e.g. an effect that writes a
// lens). All four backward entry points route through here. Recursive
// re-entry (forkInto → propagateBwd) is already inside the cleared frame.
function bwdUntracked(cell: Signal<unknown>, target: unknown, deferred: boolean): void {
  const prev = activeSub;
  activeSub = undefined;
  try {
    propagateBwd(cell, target, deferred);
  } finally {
    activeSub = prev;
  }
}

function propagateBwd(start: Signal<unknown>, target: unknown, deferred: boolean): void {
  let cell = start;
  let v = target;
  while (true) {
    // Multi-output (multi-parent lens): compute the per-parent update
    // array and SPLIT the write into each parent. This is the dual of a
    // getter reading N parents — instead of one upstream value, the
    // `put` yields N. The recursion handles each branch (source, lens,
    // merge, or nested multi-parent) uniformly.
    const target = cell._bwdParent;
    if (Array.isArray(target)) {
      propagateSplit(cell, v, deferred);
      return;
    }
    const parent = target;
    let push: unknown;
    if (cell._mergeNode !== undefined) {
      const node = cell._mergeNode;
      push = node.fold();
      node.reset();
    } else if (cell._putArity === 1 || parent === undefined) {
      push = cell._put!(v);
    } else {
      push = cell._put!(v, parent.peek());
    }

    // Parentless lens (e.g. `pin`): the `put` ran for its effect, but
    // there is no upstream — the write is absorbed. Terminal sink.
    if (parent === undefined) return;

    // BACKWARD EQUALITY-CHECK SHORT-CIRCUIT — the dual of the forward one
    // ("a node notifies only when its value changes"). If committing
    // `push` upstream would NOT change this lens's own projected view, the
    // write stops here: the source (and any information the lens hides,
    // e.g. an off-grid remainder under quantize) is left untouched. Reuses
    // the same equality the forward path uses, evaluated on the candidate
    // `_fwd(push)`. Plain lenses with a trustworthy (clean) cache only;
    // merges / multi-parent lenses (no `_fwd`) and dirty caches fall
    // through and propagate as before.
    const fwd = cell._fwd;
    if (fwd !== undefined) {
      const cf = cell.flags;
      if (!(cf & (F.Dirty | F.Pending)) && cf !== F.None) {
        const newView = fwd(push);
        if (cell._equals(cell.currentValue, newView)) return;
      }
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

/** Split a multi-parent cell's write across its N parents. `_put(target)`
 *  returns the per-parent update array (`undefined` ⇒ leave parent
 *  untouched); each defined update recurses via `propagateBwd`.
 *
 *  Eager (unbatched) splits coalesce under a single flush: the N source
 *  commits batch into one effect pass, and shared-ancestor merges
 *  accumulate all contributions before folding — same guarantee
 *  `batch()` gives. (A multi-parent cell may be reached eagerly as the
 *  start of a write OR mid-chain from an outer single lens, so the
 *  coalescing must live here, not at the write entry point.) */
function propagateSplit(cell: Signal<unknown>, target: unknown, deferred: boolean): void {
  const parents = cell._bwdParent as Signal<unknown>[];
  const n = parents.length;

  // The candidate-substitution short-circuit below replaces the written
  // parents and PEEKS the rest. That is sound only when the parents are
  // independent roots: if an unwritten parent is DERIVED from a written
  // one (e.g. a shape's `localFrame` computed from `translate`, while the
  // lens writes `translate`), its peeked value is stale and `fwd(cand)`
  // mispredicts the post-commit view — wrongly absorbing a real change.
  // With a derived parent in the mix we can't cheaply predict the view, so
  // skip the short-circuit and let the write propagate.
  let allSources = true;
  for (let i = 0; i < n; i++) {
    if (parents[i]!.getter !== undefined) {
      allSources = false;
      break;
    }
  }

  // STATEFUL lens: `bwd` reads the complement and returns the per-parent
  // updates plus the post-write complement. The equality-check short-
  // circuit is complement-aware — it predicts the resulting view with the
  // stepped complement `c'` (so a write that lands back on the current
  // view stops here, leaving sources and complement untouched). Only on a
  // real view change do we commit `c'` and the source updates.
  if (cell._step !== undefined) {
    // Bring the complement (and cached view) current with the sources
    // before the back-write: a source may have changed without the view
    // being read, leaving `step` un-run. Reading `.value` here runs the
    // getter (advancing the complement); the backward frame is untracked,
    // so this establishes no dependency.
    void cell.value;
    const vals = new Array<unknown>(n);
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
    const res = (cell._put as (t: unknown, s: unknown, c: unknown) => StatefulBwd<unknown[], unknown>)(
      target,
      vals,
      cell._complement,
    );
    const updates = res.updates as ReadonlyArray<unknown>;
    const cand = new Array<unknown>(n);
    let anyWrite = false;
    for (let i = 0; i < n; i++) {
      const u = updates[i];
      if (u === undefined) {
        cand[i] = vals[i];
      } else {
        cand[i] = u;
        anyWrite = true;
      }
    }
    const cStep = cell._step(cand, res.complement, false);
    const cf = cell.flags;
    if (allSources && !(cf & (F.Dirty | F.Pending)) && cf !== F.None) {
      const newView = (cell._fwd as (s: unknown, c: unknown) => unknown)(cand, cStep);
      if (cell._equals(cell.currentValue, newView)) return;
    }
    cell._complement = cStep;
    if (!anyWrite) {
      // Complement-only change (e.g. writing a direction onto a collapsed
      // cluster): no source moves, so mark dirty for a correct next read.
      cell.flags = F.Mutable | F.Dirty;
      return;
    }
    cell._lastBwd = cand;
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
    return;
  }

  const updates = cell._put!(target) as ReadonlyArray<unknown>;

  // BACKWARD EQUALITY-CHECK SHORT-CIRCUIT (multi-parent form) — the dual
  // of the forward one, generalized over N parents: if applying these
  // updates would leave this cell's own projected view unchanged, the
  // write stops here. Keeps any per-parent information the projection
  // hides (the off-grid story, spread across parents) intact. Same
  // trustworthy-cache precondition as the 1→1 form. Effective only when
  // the view's equality can see "unchanged" — scalar views via
  // `Object.is`, structured views (Vec, …) via the cell's `_equals`.
  const fwd = cell._fwd;
  if (fwd !== undefined && allSources) {
    const cf = cell.flags;
    if (!(cf & (F.Dirty | F.Pending)) && cf !== F.None) {
      const cand = new Array<unknown>(n);
      for (let i = 0; i < n; i++) {
        const u = updates[i];
        cand[i] = u === undefined ? parents[i]!.peek() : u;
      }
      const newView = fwd(cand);
      if (cell._equals(cell.currentValue, newView)) return;
    }
  }

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
 *  directly (it has no backward chain to walk); a lens / multi-parent /
 *  merge parent re-enters the backward pass. Always called under a
 *  bumped `batchDepth`, so commits coalesce into one flush. */
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
    else propagateBwd(parent, u, true);
  }
}

// ─── factories ────────────────────────────────────────────────────

/** Writable source. Passes an existing `Writable` through unchanged so
 *  `signal(maybeSignal)` is idempotent. */
export function signal<T>(
  initial: T | Writable<Signal<T>>,
  opts?: SignalOptions<T>,
): Writable<Signal<T>> {
  if (initial instanceof Signal) return initial as Writable<Signal<T>>;
  return new Signal(initial as T, opts) as Writable<Signal<T>>;
}

export function computed<T>(fn: () => T): Signal<T> {
  const cell = new Signal<T>(undefined as never);
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = fn;
  return cell;
}

// Bare (untyped) factories — the dual of `computed`. These construct a
// plain `Signal`, so `R` is inferred from the closures (the polymorphic-
// `this` `Signal.lens` statics return `Signal<unknown>` on the base
// class, and are meant for typed subclasses like `Vec.lens`).

const SIGNAL_CTOR = Signal as unknown as SignalCtor<Signal<unknown>>;

/** Untyped read-only view: `derive(parent, fn)`, `derive(parents, fn)`,
 *  or `derive(fn)` (closure). */
export function derive<P, R>(parent: Read<P>, fn: (v: P) => R): Signal<R>;
export function derive<P extends readonly Read<unknown>[], R>(
  parents: P,
  fn: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => R,
): Signal<R>;
export function derive<R>(fn: () => R): Signal<R>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function derive(...args: any[]): any {
  if (args.length === 1) return buildComputed(SIGNAL_CTOR, args[0]);
  const [parent, fn] = args;
  if (Array.isArray(parent)) return buildLensN(SIGNAL_CTOR, parent, fn, undefined, false);
  return buildComputed(SIGNAL_CTOR, () => fn((parent as Signal<unknown>).value));
}

/** Untyped source-reading lens (`put` consults the source). Dispatches
 *  like `Signal.lens` but infers `R` from the closures. */
export function lens<P, R>(
  parent: Read<P>,
  fwd: (v: P) => R,
  bwd: (target: R, v: P) => P,
): Writable<Signal<R>>;
export function lens<P extends readonly Read<unknown>[], R>(
  parents: P,
  fwd: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => R,
  bwd: (
    target: R,
    vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
  ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
): Writable<Signal<R>>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function lens(...args: any[]): any {
  const [parent, fwd, bwd] = args;
  if (Array.isArray(parent)) return buildLensN(SIGNAL_CTOR, parent, fwd, bwd, true);
  return buildLens1(SIGNAL_CTOR, parent, fwd, bwd, true);
}

/** Untyped source-independent lens (`iso`): `put` reconstructs the source
 *  from the view alone. Infers `R` from the closures. */
export function iso<P, R>(
  parent: Read<P>,
  fwd: (v: P) => R,
  bwd: (target: R) => P,
): Writable<Signal<R>>;
export function iso<R>(
  parents: readonly Read<unknown>[],
  fwd: (vals: readonly unknown[]) => R,
  bwd: (target: R) => ReadonlyArray<unknown>,
): Writable<Signal<R>>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function iso(...args: any[]): any {
  const [parent, fwd, bwd] = args;
  if (Array.isArray(parent)) return buildLensN(SIGNAL_CTOR, parent, fwd, bwd, false);
  return buildLens1(SIGNAL_CTOR, parent, fwd, bwd, false);
}

/** Untyped complement-carrying lens (`statefulLens`): `put` reads memory
 *  the view discards. Infers from the spec closures. */
export function statefulLens<P, R, C>(
  parent: Read<P>,
  spec: StatefulLensSpec<readonly [P], R, C>,
): Writable<Signal<R>>;
export function statefulLens<P extends readonly Read<unknown>[], R, C>(
  parents: P,
  spec: StatefulLensSpec<{ [K in keyof P]: P[K] extends Read<infer V> ? V : never }, R, C>,
): Writable<Signal<R>>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function statefulLens(parent: any, spec: any): any {
  return buildStateful(SIGNAL_CTOR, Array.isArray(parent) ? parent : [parent], spec);
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
          bwdUntracked(cell, undefined, true);
        } else {
          bwdUntracked(cell, cell.pendingValue, true);
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

// ─── network() — reactive sub-DAG with self-excluded writes ───────
//
// A `_NetworkNode` is a watching node (like an Effect) whose body fires
// when any SUBSCRIBED dep changes, but whose own writes self-exclude the
// node (via `activeNetwork` threaded into `propagate`) so it doesn't
// re-trigger itself. Topology is explicit: the deps array plus later
// subscribe/unsubscribe — reads inside the body do NOT add deps. This is
// the building block for constraint networks (fixed topology, structural
// termination) as opposed to effects (implicit, auto-tracked deps).

/** Handle to a `network` invocation. */
export interface Network {
  /** Tear down: unsubscribe from every signal, drop internal state. */
  dispose(): void;
  /** Run the body now (manual mode's only advance mechanism; a no-op in
   *  auto mode when nothing changed). */
  flush(): void;
  /** Add signals to the topology (idempotent; does NOT fire the body). */
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  subscribe(...sigs: Signal<any>[]): void;
  /** Remove signals from the topology (idempotent; does NOT fire). */
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  unsubscribe(...sigs: Signal<any>[]): void;
}

type NetworkBody = (dirty: ReadonlySet<Signal<unknown>>, handle: Network) => void;

class _NetworkNode implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Watching | F.RecursedCheck;
  body: NetworkBody;
  manual: boolean;
  /** Per-instance last-seen dep values; used to compute `dirty`. */
  lastValues: Map<Signal<unknown>, unknown> = new Map();
  pending = false;
  disposed = false;
  private _ownCycle = 0;
  private _depsSet: Set<Signal<unknown>> = new Set();
  private _handle!: Network;

  constructor(body: NetworkBody, manual: boolean) {
    this.body = body;
    this.manual = manual;
  }

  /** Two-phase init so the body sees its own handle on the first fire. */
  _initWithHandle(handle: Network, initialDeps: readonly Signal<unknown>[]): void {
    this._handle = handle;
    this._linkBatch(initialDeps);
    this._runBody(EMPTY_DIRTY);
  }

  _update(): boolean {
    this.flags = F.Mutable;
    return true;
  }

  _notify(): void {
    if (this.manual) {
      this.pending = true;
      this.flags |= F.Watching;
      return;
    }
    queued[queuedLength++] = this;
    this.flags &= ~F.Watching;
  }

  _unwatched(): void {
    this.disposed = true;
    this.flags = F.None;
    disposeAllDepsInReverse(this);
    const sub = this.subs;
    if (sub !== undefined) unlink(sub);
    this.lastValues.clear();
  }

  _run(): void {
    if (this.disposed) return;
    const flags = this.flags;
    if (flags & F.Dirty || (flags & F.Pending && checkDirty(this.deps!, this))) {
      this._runBody(this._computeDirty());
    } else if (this.deps !== undefined) {
      this.flags = F.Watching;
    }
  }

  private _computeDirty(): ReadonlySet<Signal<unknown>> {
    let dirty: Set<Signal<unknown>> | undefined;
    for (const [sig, lastVal] of this.lastValues) {
      if (sig.peek() !== lastVal) {
        if (dirty === undefined) dirty = new Set();
        dirty.add(sig);
      }
    }
    return dirty ?? EMPTY_DIRTY;
  }

  private _runBody(dirty: ReadonlySet<Signal<unknown>>): void {
    // RecursedCheck doubles as the "body is running" guard (see flush()).
    this.flags = F.Watching | F.RecursedCheck;
    const prevSettler = activeNetwork;
    activeNetwork = this;
    try {
      ++cycle;
      ++runDepth;
      ++batchDepth;
      try {
        this.body(dirty, this._handle);
      } finally {
        if (!--batchDepth) flush();
      }
    } finally {
      --runDepth;
      activeNetwork = prevSettler;
      this.flags &= ~F.RecursedCheck;
      this.lastValues.clear();
      let l = this.deps;
      while (l !== undefined) {
        const sig = l.dep as Signal<unknown>;
        this.lastValues.set(sig, sig.peek());
        l = l.nextDep;
      }
    }
    this.pending = false;
  }

  flush(): void {
    if (this.disposed) return;
    if (this.flags & F.RecursedCheck) {
      throw new Error(
        "network: flush() called from inside body — would recurse infinitely. " +
          "Return from the body and let the next dep change drive the next fire.",
      );
    }
    this._runBody(this._computeDirty());
  }

  subscribe(sigs: readonly Signal<unknown>[]): void {
    if (this.disposed) return;
    this._linkBatch(sigs);
  }

  unsubscribe(sigs: readonly Signal<unknown>[]): void {
    if (this.disposed) return;
    const set = this._depsSet;
    for (const s of sigs) {
      if (!set.has(s)) continue;
      set.delete(s);
      let l = this.deps;
      while (l !== undefined) {
        if (l.dep === s) {
          unlink(l, this);
          break;
        }
        l = l.nextDep;
      }
    }
  }

  private _linkBatch(sigs: readonly Signal<unknown>[]): void {
    const set = this._depsSet;
    let tail = this.deps;
    if (tail !== undefined) {
      while (tail.nextDep !== undefined) tail = tail.nextDep;
    }
    this.depsTail = tail;
    for (const s of sigs) {
      if (set.has(s)) continue;
      set.add(s);
      link(s as ReactiveNode, this, ++this._ownCycle);
    }
  }
}

/** Build a reactive sub-DAG node with explicit topology.
 *
 *  Promises:
 *  - Body fires when any subscribed dep changes; `dirty` is the subset
 *    that changed since the last fire.
 *  - `signal.value =` writes inside the body self-exclude THIS network
 *    so it doesn't re-trigger itself.
 *  - Body runs inside `batch()`; writes commit atomically.
 *  - Topology is exactly the deps array + later subscribe/unsubscribe —
 *    reads inside the body do NOT add deps.
 *  - `flush()` from inside the body throws (would recurse infinitely).
 *  - `manual: true` defers auto-firing; only `flush()` advances. */
export function network(
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  deps: readonly Signal<any>[],
  body: (dirty: ReadonlySet<Signal<unknown>>, handle: Network) => void,
  opts?: { manual?: boolean },
): Network {
  const node = new _NetworkNode(body, opts?.manual ?? false);
  const handle: Network = {
    dispose: () => node._unwatched(),
    flush: () => node.flush(),
    subscribe: (...sigs) => node.subscribe(sigs),
    unsubscribe: (...sigs) => node.unsubscribe(sigs),
  };
  node._initWithHandle(handle, deps as readonly Signal<unknown>[]);
  return handle;
}
