// signal.ts — symmetric bidirectional reactive engine.
//
// Forward propagation is alien-signals verbatim (link/propagate/
// checkDirty/shallowPropagate, Dirty/Pending/Recursed flags, lazy pull).
// Backward is not a second engine: a write "compiles" a view-edit into
// source-edits by walking up `_bwdParent`, applying each lens's `put` to
// compute what the source(s) must become, committing via the SAME
// forward write path. So views are never sticky (a view is always
// `get(source)`; lossy lenses snap), no-op deltas short-circuit for free
// via equality, and backward cost ≤ forward cost.
//
// Duals:
//   * merge — N→1 backward aggregation (dual of computed's N→1 forward).
//     Contributions land in a slot map keyed by contributor identity,
//     fold via a user policy, reset per settle.
//   * multi-parent lens — a write that SPLITS across N parents
//     (`_put(target)` → per-parent update array, `propagateSplit`); the
//     dual of a getter reading N parents. Covers coupled writables
//     (N→M, e.g. mean/diff). Info the source can't hold lives in a
//     stateful-lens complement, not a bespoke engine kind.
//
// Core asymmetry: forward deps are IMPLICIT (auto-tracked reads of
// `.value` under `activeSub`); backward targets are EXPLICIT (declared
// at construction in `_bwdParent`). Hence no `activeBwdWrite` global.
//
// Mode table — a cell's role is fully determined by which fields are set:
//   source      getter undefined                 (truth in currentValue)
//   computed    getter,  no _put, no _mergeNode
//   lens 1→1    getter + _put + _bwdParent (Signal)
//   multi-out   getter + _put + _bwdParent (Signal[])  (1→N / N→M bwd)
//   merge       getter + _mergeNode               (N→1 backward fold)
// `pendingValue` is dual-keyed off this table: a staged forward write
// for a source, a deferred backward target for a getter cell (never
// both on one node).
//
// Batching: outside a batch a write propagates backward eagerly and
// flushes (alien's synchronous per-write semantics). Inside batch/flush,
// lens writes deposit their latest value and queue (last-write-wins via
// `_queueIdx`) and merge folds defer until all contributors land; the
// flush loop alternates bwd-drain / effect-drain to a fixpoint.

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
/** Network running its body, if any. Source writes self-exclude it so a
 *  network reading+writing a signal doesn't re-trigger itself. */
let activeNetwork: _NetworkNode | undefined;
const queued: (Effect | _NetworkNode | undefined)[] = [];

const EMPTY_DIRTY: ReadonlySet<Cell<unknown>> = new Set();

/** Backward worklist: lens cells with deferred writes, merge cells
 *  awaiting fold. Drained to a fixpoint with effects by flush. */
const bwdQueue: Cell<unknown>[] = [];

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

// Fires on every SOURCE value-change (the one place truth mutates).
// Backward writes reach it via `_writeSource`, attributing lens edits to
// the source they resolve to.

let writeHook: ((sig: Cell<unknown>) => void) | undefined;

/** Install a hook fired on every source value-change; returns a restore fn. */
export function setSignalWriteHook(fn: ((sig: Cell<unknown>) => void) | undefined): () => void {
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
  if (isFirstSub && dep instanceof Cell) {
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
    // `excluding` skips one subscriber (used by `network()` so a body
    // writing a signal it subscribes to doesn't re-trigger itself).
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
  readonly parent: Cell<T>;
  readonly policy: MergePolicy<T>;
  readonly slots: Map<unknown, T> = new Map();
  readonly hasIncrementalAcc: boolean;
  acc: T;

  constructor(parent: Cell<T>, policy: MergePolicy<T>) {
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

/** Plain T or any read-shape; snapshot via `readNow`, close via `reader`. */
export type Val<T> = T | Read<T>;

/** Covariant read-only surface. */
export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

/** Brand discriminating writable receivers in conditional return types. */
declare const WRITABLE: unique symbol;
export interface WritableBrand {
  readonly [WRITABLE]: never;
}

/** Value type carried by a reactive read shape. */
export type Inner<R> = R extends Cell<infer T> ? T : R extends Read<infer T> ? T : never;

/** The writable form of R: adds the brand + a settable `value`. */
export type Writable<R> = R & WritableBrand & { value: Inner<R> };

/** Strict factory input: a literal, or an existing `Writable<Cls>`. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors `Inner`
export type Init<C extends Cell<any>> = Inner<C> | Writable<C>;

/** Snapshot a `Val<T>` to plain `T` (one-shot, no tracking). */
export function readNow<T>(v: Val<T>): T {
  if (v instanceof Cell) return v.value as T;
  return v as T;
}

/** Resolve a `Val<T>` to a `() => T` closure that unwraps on each call. */
export function reader<T>(v: Val<T>): () => T {
  if (v instanceof Cell) return () => v.value as T;
  return () => v as T;
}

/** Lazy getter: computes once, installs a non-enumerable own prop under
 *  `key` that shadows this getter on later reads. */
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

export const isSignal = (v: unknown): v is Cell<unknown> => v instanceof Cell;

/** Lens mode: a derived cell that can be written back (has `put` or is a merge). */
export const isLens = (v: unknown): v is Cell<unknown> =>
  v instanceof Cell &&
  v.getter !== undefined &&
  (v._put !== undefined || v._mergeNode !== undefined);

/** Computed mode: derived + read-only (no backward path). */
export const isComputed = (v: unknown): v is Cell<unknown> =>
  v instanceof Cell && v.getter !== undefined && v._put === undefined && v._mergeNode === undefined;

// ─── Signal class ─────────────────────────────────────────────────

export interface SignalOptions<T = unknown> {
  /** First subscriber attached; fired from `link`. */
  watched?: () => void;
  /** Last subscriber detached; fired from `_unwatched`. */
  unwatched?: () => void;
  /** Per-instance value equality; defaults to `Object.is`. */
  equals?: (a: T, b: T) => boolean;
}

export class Cell<T = unknown> implements ReactiveNode {
  flags: number = F.Mutable;
  subs: Link | undefined;
  subsTail: Link | undefined;
  deps: Link | undefined;
  depsTail: Link | undefined;

  /** Forward derivation (computed/lens/merge). `undefined` ⇒ source. */
  getter: (() => T) | undefined;

  /** Per-instance equality, always defined (defaults to `Object.is` at
   *  construction) so hot paths call it without an `undefined` branch. */
  _equals: (a: T, b: T) => boolean;
  /** First-subscriber / last-subscriber lifecycle hooks. */
  _watched: (() => void) | undefined;
  _unwatchedHook: (() => void) | undefined;

  /** Source: `currentValue` = committed, `pendingValue` = staged write.
   *  Getter cell: `currentValue` = last derived cache, `pendingValue`
   *  reused as the deferred backward target (see `set value`). The two
   *  roles never coexist, so two fields suffice for four. */
  currentValue: T;
  pendingValue: T;

  /** Backward target this cell's `put` writes through. A single `Signal`
   *  (1→1 lens or merge parent) or a `Signal[]` (multi-parent lens whose
   *  `_put` returns a per-parent update array; the backward pass splits
   *  into each). Private `_put` state is closure-captured. */
  _bwdParent: Cell<unknown> | Cell<unknown>[] | undefined;

  /** Lens `put` — backward derivation (dual of `getter`). Multi-output:
   *  `_put(target)` returns a per-parent update array. */
  // biome-ignore lint/suspicious/noExplicitAny: put fn is opaque shape
  _put: ((target: any, current?: any) => any) | undefined;

  /** Put arity, set by the factory: `1` source-independent `(view)=>src`,
   *  `2` source-reading `(view, src)=>src` (engine peeks the parent). A
   *  cached SMI — cheaper to branch on than `_put.length`. */
  _putArity: 1 | 2;

  /** Raw forward projection, separate from `getter` (which closes over
   *  `parent.value`) so the backward equality check can evaluate the view
   *  against CANDIDATE parent value(s) without committing. Set for 1→1
   *  and multi-parent lenses; undefined for sources/computeds/merges. */
  // biome-ignore lint/suspicious/noExplicitAny: fwd fn is opaque shape
  _fwd: ((parentValue: any) => any) | undefined;

  /** Backward aggregation node. Presence IS the merge-mode discriminant:
   *  the cell folds contributions via a policy instead of applying `put`. */
  _mergeNode: MergeNode<T> | undefined;

  /** Stateful-lens complement: memory the view discards (a case mask
   *  under `lowercase`, the unwrapped angle under a principal axis).
   *  Engine-owned, advanced only by `_step`. */
  _complement: unknown;

  /** Stateful-lens complement advance; presence IS the stateful-mode
   *  discriminant. `_step(vals, c, external)` returns the next complement
   *  (`external` ⇒ source change came from outside, not this lens's own
   *  back-write). When set, `_fwd`/`_put` also take the complement. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque step shape
  _step: ((vals: any, complement: any, external: boolean) => any) | undefined;

  /** Source values a stateful cell last wrote back. A later recompute
   *  reports `external === false` while the live sources still equal
   *  these (the change is the lens's own back-write). */
  _lastBwd: unknown[] | undefined;

  /** Index in `bwdQueue` of this cell's LATEST push. The drain skips
   *  entries whose `_queueIdx` ≠ their position, so each cell propagates
   *  backward once per flush in last-write order. */
  _queueIdx: number;

  constructor(initial: T, opts?: SignalOptions<T>) {
    this.currentValue = initial;
    this.pendingValue = initial;
    // Pre-init every optional slot for a stable V8 hidden class across variants.
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

  // The `value` accessor is installed on the prototype after the class
  // body (V8 JITs a prototype accessor better than a class get/set here).
  // Declared `readonly` so a bare cell is read-only at the TYPE level;
  // writability is added back via `Writable<R>`. The runtime accessor is
  // settable regardless.
  declare readonly value: T;

  _enqueueBwd(): void {
    this.flags |= F.BwdQueued;
    this._queueIdx = bwdQueue.length;
    bwdQueue.push(this as Cell<unknown>);
  }

  /** Source write (alien's signal setter). Self-excludes the active
   *  network so a body writing its own dep doesn't re-trigger itself. */
  _writeSource(next: T): void {
    const prev = this.pendingValue;
    this.pendingValue = next;
    if (!this._equals(prev, next)) {
      this.flags = F.Mutable | F.Dirty;
      if (writeHook !== undefined) writeHook(this as Cell<unknown>);
      const subs = this.subs;
      if (subs !== undefined) propagate(subs, runDepth > 0, activeNetwork);
      if (batchDepth === 0 && !flushing && subs !== undefined) flush();
    }
  }

  _update(): boolean {
    if (this.getter !== undefined) {
      // Computed/lens/merge: re-run the forward derivation.
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

  /** Guard: silent coercion to string/number is almost always a bug. */
  [Symbol.toPrimitive](hint: string): never {
    throw new TypeError(`Signal cannot be coerced to ${hint} — use \`.value\``);
  }

  // Construction helpers build via `new this()` so a subclass static
  // (`Vec.lens(...)`) yields a `Vec` with its constructor-set equality.
  // Every lens has a structural backward target (`_bwdParent`), which is
  // what makes the backward pass well-defined.

  /** Endomorphic lens. A 2-arg `bwd(view, current)` consults the current
   *  source; a 1-arg `bwd(view)` reconstructs it from the view alone. */
  lens(this: Cell<T>, fwd: (v: T) => T, bwd: (target: T, current: T) => T): this {
    return buildLens1(
      this.constructor as SignalCtor<Cell<T>>,
      this as Cell<unknown>,
      fwd as (v: unknown) => unknown,
      bwd as (t: unknown, s?: unknown) => unknown,
      bwd.length >= 2,
    ) as this;
  }

  /** Backward-aggregating node — bwd dual of computed. Forward, the
   *  identity view of its parent; backward, folds contributions from
   *  upstream lenses (slot-keyed) and direct writes (DIRECT_SLOT). */
  merge(this: Cell<T>, policy: MergePolicy<T>): Cell<T> {
    if (this.getter !== undefined && this._put === undefined && this._mergeNode === undefined) {
      throw new TypeError("merge: receiver is read-only");
    }
    const parent = this as Cell<T>;
    const cell = new (this.constructor as SignalCtor<Cell<T>>)();
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): T => parent.value;
    cell._bwdParent = parent as Cell<unknown>;
    cell._mergeNode = new MergeNode<T>(parent, policy);
    return cell as Cell<T>;
  }

  /** Read-only typed view. `Cls.derive(parent, fn)` (1-input),
   *  `Cls.derive(parents, fn)` (N-input), or `Cls.derive(fn)` (closure).
   *  Polymorphic-`this`: `Vec.derive(...)` → `Vec`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Cell<any>, P>(
    this: C,
    parent: Read<P>,
    fn: (v: P) => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Cell<any>, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fn: (
      vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
    ) => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Cell<any>>(
    this: C,
    fn: () => Inner<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static derive(this: any, ...args: any[]): any {
    if (args.length === 1) return buildComputed(this, args[0]);
    const [parent, fn] = args;
    if (Array.isArray(parent)) return buildLensN(this, parent, fn, undefined, false);
    return buildComputed(this, () => fn((parent as Cell<unknown>).value));
  }

  /** Writable lens. `Cls.lens(parent, fwd, bwd)` for one input,
   *  `Cls.lens(parents, fwd, bwd)` for N; a 2-arg `bwd` reads the source,
   *  a 1-arg `bwd` reconstructs it. `Cls.lens(parent(s), spec)` builds a
   *  complement-carrying lens from `{ init, step, fwd, bwd }`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Cell<any>, P>(
    this: C,
    parent: Read<P>,
    fwd: (v: P) => Inner<InstanceType<C>>,
    bwd: (target: Inner<InstanceType<C>>, v: P) => P,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Cell<any>, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fwd: (
      vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
    ) => Inner<InstanceType<C>>,
    bwd: (
      target: Inner<InstanceType<C>>,
      vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
    ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Cell<any>, P, Cm>(
    this: C,
    parent: Read<P>,
    spec: StatefulLensSpec<readonly [P], Inner<InstanceType<C>>, Cm>,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<
    C extends new (
      ...args: never[]
    ) => Cell<any>,
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
  static lens(this: any, ...args: any[]): any {
    const [parent, a, b] = args;
    if (args.length === 2) return buildStateful(this, Array.isArray(parent) ? parent : [parent], a);
    const readsSource = (b as (...xs: unknown[]) => unknown).length >= 2;
    if (Array.isArray(parent)) return buildLensN(this, parent, a, b, readsSource);
    return buildLens1(this, parent, a, b, readsSource);
  }

  /** Type predicate against this class: `Vec.is(x)` narrows `x` to `Vec`.
   *  Inherited static; works for any subclass via polymorphic `this`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static is<C extends new (...args: never[]) => Cell<any>>(
    this: C,
    v: unknown,
  ): v is InstanceType<C> {
    return v instanceof this;
  }

  /** Lift `Val<Inner<Cls>>` → `Cls`: instance → identity, RO signal →
   *  tracked `derive`, literal → fresh seed. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static from<C extends new (...args: never[]) => Cell<any>>(
    this: C,
    v: Val<Inner<InstanceType<C>>>,
  ): InstanceType<C> {
    if (v instanceof this) return v as InstanceType<C>;
    if (v instanceof Cell) {
      // biome-ignore lint/suspicious/noExplicitAny: dispatch
      return (this as any).derive(() => readNow(v)) as InstanceType<C>;
    }
    return new (this as unknown as new (init?: Inner<InstanceType<C>>) => InstanceType<C>)(
      v as Inner<InstanceType<C>>,
    ) as InstanceType<C>;
  }

  /** Writable-shaped constant: always reads `v`, absorbs writes
   *  (parentless sink lens), for APIs demanding bidirectionality. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static pin<C extends new (...args: never[]) => Cell<any>>(
    this: C,
    v: Inner<InstanceType<C>>,
  ): Writable<InstanceType<C>> {
    const cell = new (this as unknown as SignalCtor<Cell<unknown>>)();
    cell.flags = F.Mutable | F.Dirty;
    cell.getter = (): unknown => v;
    cell._put = (): unknown => undefined; // absorb (no parent → sink)
    cell._putArity = 1;
    return cell as unknown as Writable<InstanceType<C>>;
  }

  /** Typed field lens onto `parent.value[key]`. A read-only computed
   *  parent yields a RO derive view; any writable parent yields a
   *  bidirectional field lens with spread-replace `put`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static fieldOf<C extends new (...args: never[]) => Cell<any>>(
    // biome-ignore lint/suspicious/noExplicitAny: parent is contravariant on put
    parent: Cell<any>,
    key: string | number | symbol,
    Cls: C,
  ): InstanceType<C> {
    const ctor = Cls as unknown as SignalCtor<Cell<unknown>>;
    const get = (s: unknown): unknown => (s as Record<string | number | symbol, unknown>)[key];
    // Read-only ⇔ computed (getter, no put, no merge). `_put === undefined`
    // also excludes multi-output, so no `_bwdParent` check needed.
    const ro =
      parent.getter !== undefined && parent._put === undefined && parent._mergeNode === undefined;
    if (ro) {
      return buildComputed(ctor, () => get(parent.value)) as InstanceType<C>;
    }
    // Spread-replace reads the current source ⇒ source-reading (lens) form.
    return buildLens1(
      ctor,
      parent as Cell<unknown>,
      get,
      (v, s) => ({ ...(s as object), [key]: v }),
      true,
    ) as InstanceType<C>;
  }
}

// ─── Cell builders ────────────────────────────────────────────────
//
// Each `new Cls()` yields the right subclass (so `Vec.lens(...)` returns
// a `Vec`), then sets the mode fields. Module-level so statics can call them.

// biome-ignore lint/suspicious/noExplicitAny: variance escape for subclass ctors (contravariant _equals)
type SignalCtor<C extends Cell<any>> = new (...args: never[]) => C;

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildComputed<C extends Cell<any>>(Cls: SignalCtor<C>, getter: () => unknown): C {
  const cell = new Cls();
  cell.getter = getter as () => never;
  cell.flags = F.Mutable | F.Dirty;
  return cell;
}

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildLens1<C extends Cell<any>>(
  Cls: SignalCtor<C>,
  parent: Cell<unknown>,
  fwd: (v: unknown) => unknown,
  bwd: (t: unknown, s?: unknown) => unknown,
  readsSource: boolean,
): C {
  const cell = new Cls();
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = (() => fwd(parent.value)) as () => never;
  cell._put = bwd;
  cell._putArity = readsSource ? 2 : 1;
  cell._bwdParent = parent;
  return cell;
}

// biome-ignore lint/suspicious/noExplicitAny: variance escape
function buildLensN<C extends Cell<any>>(
  Cls: SignalCtor<C>,
  parents: Cell<unknown>[],
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
// The third writable kind (alongside source-independent `iso` and
// source-reading `lens`). Carries a COMPLEMENT — memory the source can't
// hold (the casing a `lowercase` view discards, the winding a principal-
// axis angle accumulates):
//   init(srcs)              → seed the complement
//   fwd(srcs, c)            → the view
//   step(srcs, c, external) → advance the complement (forward / on commit);
//                             `external` = outside change vs own back-write
//   bwd(target, srcs, c)    → { updates, complement }: per-parent updates
//                             (`undefined` ⇒ leave parent) + new complement
//
// All four are pure (the equality check evaluates them speculatively);
// `bwd`/`step` read no signals (backward runs untracked). The engine owns
// `c`, advancing it only on a real forward recompute or commit. Before
// `bwd` runs the engine steps `c` to the current sources, so `bwd` always
// sees an up-to-date complement.

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
function buildStateful<C extends Cell<any>>(
  Cls: SignalCtor<C>,
  parents: Cell<unknown>[],
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
  cell._fwd = spec.fwd as (v: unknown) => unknown;
  cell._put = spec.bwd as (t: unknown, c?: unknown) => unknown;
  cell._bwdParent = parents;
  cell.getter = (() => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    // External unless the live sources still equal this lens's own last
    // back-write.
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

// Install `value` on the prototype (V8 JITs it better than a class get/set).
Object.defineProperty(Cell.prototype, "value", {
  get(this: Cell<unknown>): unknown {
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
  set(this: Cell<unknown>, next: unknown): void {
    if (this.getter === undefined) {
      this._writeSource(next);
      return;
    }
    // Backward write. Deferred while batching/flushing so repeated writes
    // coalesce (last-write-wins) and merge folds wait for all
    // contributors; eager + synchronous otherwise. Exception: inside a
    // network body writes are eager so the body's fixpoint loop observes
    // its own edits via `peek()` between steps.
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
    // Entry-level no-op (GetPut): writing the current view starts no walk.
    // O(1), concrete (no speculation). Deeper no-ops are caught as the
    // walk reaches each unchanged parent; lossy lenses encode their own
    // absorption in `put`.
    if (this._equals(next, this.peek())) return;
    if (deferred) {
      // Reuse `pendingValue` (unused by a getter's forward path) as the
      // deferred backward target; drained by flush.
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
// parent merge is reached. `deferred` (inside batch/flush) stops at a
// parent merge after depositing so it folds once all contributors land;
// eager folds merges inline. Not a second engine: every path terminates
// in `_writeSource`.

// Backward evaluation runs UNTRACKED so `bwd`/`step`/`fwd` reads don't
// establish forward deps on whatever `activeSub` is writing (e.g. an
// effect that writes a lens). All backward entry points route through here.
function bwdUntracked(cell: Cell<unknown>, target: unknown, deferred: boolean): void {
  const prev = activeSub;
  activeSub = undefined;
  try {
    propagateBwd(cell, target, deferred);
  } finally {
    activeSub = prev;
  }
}

function propagateBwd(start: Cell<unknown>, target: unknown, deferred: boolean): void {
  let cell = start;
  let v = target;
  while (true) {
    // Multi-parent lens: SPLIT the write into each parent (dual of a
    // getter reading N parents — the `put` yields N upstream values).
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

    // Parentless lens (e.g. `pin`): no upstream, write absorbed. Sink.
    if (parent === undefined) return;

    // Concrete no-op stop: if the parent already holds `push`, committing
    // changes nothing upstream, so the walk stops. Sound for ANY topology
    // (no speculation). A lossy lens hides an off-grid edit by returning
    // the current source from `put`. Merge parents fold instead.
    if (parent._mergeNode === undefined && parent._equals(push, parent.peek())) return;

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
      // Source: commit + forward-propagate (the forward write).
      parent._writeSource(push);
      return;
    }
    // Parent is a lens: keep walking, carrying its new view value.
    cell = parent;
    v = push;
  }
}

/** Split a multi-parent cell's write across its N parents. `_put(target)`
 *  returns the per-parent update array (`undefined` ⇒ leave parent);
 *  each defined update recurses via `propagateBwd`. Eager splits coalesce
 *  under one flush (same guarantee as `batch()`); the coalescing lives
 *  here since such a cell may be reached as a write start or mid-chain. */
function propagateSplit(cell: Cell<unknown>, target: unknown, deferred: boolean): void {
  const parents = cell._bwdParent as Cell<unknown>[];
  const n = parents.length;

  // STATEFUL lens: `bwd` reads the complement and returns per-parent
  // updates plus the post-write complement. We commit the stepped
  // complement and fork the source updates; absorption is the lens's job
  // (its `bwd` returns `undefined` updates, forked as no-ops).
  if (cell._step !== undefined) {
    // Bring the complement current with the sources before the back-write
    // (a source may have changed without the view being read, leaving
    // `step` un-run). Untracked, so reading `.value` adds no dependency.
    void cell.value;
    const vals = new Array<unknown>(n);
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
    const res = (
      cell._put as (t: unknown, s: unknown, c: unknown) => StatefulBwd<unknown[], unknown>
    )(target, vals, cell._complement);
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
    cell._complement = cStep;
    if (!anyWrite) {
      // Complement-only change (no source moves): mark dirty for a correct next read.
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

  // No speculation: each defined update forks to its parent, where
  // `_writeSource`'s equality check prunes no-op sources and the forward
  // pass prunes unchanged views. Absorption ⇒ `undefined` updates.
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

/** Route each defined update to its parent: a source commits directly, a
 *  lens/multi-parent/merge re-enters the backward pass. Always called
 *  under a bumped `batchDepth` so commits coalesce into one flush. */
function forkInto(parents: Cell<unknown>[], updates: ReadonlyArray<unknown>, n: number): void {
  for (let i = 0; i < n; i++) {
    const u = updates[i];
    if (u === undefined) continue;
    const parent = parents[i]!;
    if (parent.getter === undefined) parent._writeSource(u);
    else propagateBwd(parent, u, true);
  }
}

// ─── factories ────────────────────────────────────────────────────

/** Writable source; passes an existing `Writable` through (idempotent). */
export function cell<T>(
  initial: T | Writable<Cell<T>>,
  opts?: SignalOptions<T>,
): Writable<Cell<T>> {
  if (initial instanceof Cell) return initial as Writable<Cell<T>>;
  return new Cell(initial as T, opts) as Writable<Cell<T>>;
}

export function computed<T>(fn: () => T): Cell<T> {
  const cell = new Cell<T>(undefined as never);
  cell.flags = F.Mutable | F.Dirty;
  cell.getter = fn;
  return cell;
}

// Bare (untyped) factories. Construct a plain `Signal`, inferring `R`
// from the closures (the polymorphic-`this` statics are for typed
// subclasses like `Vec.lens`).

const SIGNAL_CTOR = Cell as unknown as SignalCtor<Cell<unknown>>;

/** Untyped read-only view: `derive(parent, fn)`, `derive(parents, fn)`,
 *  or `derive(fn)` (closure). */
export function derive<P, R>(parent: Read<P>, fn: (v: P) => R): Cell<R>;
export function derive<P extends readonly Read<unknown>[], R>(
  parents: P,
  fn: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => R,
): Cell<R>;
export function derive<R>(fn: () => R): Cell<R>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function derive(...args: any[]): any {
  if (args.length === 1) return buildComputed(SIGNAL_CTOR, args[0]);
  const [parent, fn] = args;
  if (Array.isArray(parent)) return buildLensN(SIGNAL_CTOR, parent, fn, undefined, false);
  return buildComputed(SIGNAL_CTOR, () => fn((parent as Cell<unknown>).value));
}

/** Untyped lens, inferring `R` from the closures. A 2-arg `bwd` reads the
 *  source, a 1-arg `bwd` reconstructs it; `lens(parent(s), spec)` builds a
 *  complement-carrying lens. */
export function lens<P, R>(
  parent: Read<P>,
  fwd: (v: P) => R,
  bwd: (target: R, v: P) => P,
): Writable<Cell<R>>;
export function lens<P extends readonly Read<unknown>[], R>(
  parents: P,
  fwd: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => R,
  bwd: (
    target: R,
    vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
  ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
): Writable<Cell<R>>;
export function lens<P, R, C>(
  parent: Read<P>,
  spec: StatefulLensSpec<readonly [P], R, C>,
): Writable<Cell<R>>;
export function lens<P extends readonly Read<unknown>[], R, C>(
  parents: P,
  spec: StatefulLensSpec<{ [K in keyof P]: P[K] extends Read<infer V> ? V : never }, R, C>,
): Writable<Cell<R>>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function lens(...args: any[]): any {
  const [parent, a, b] = args;
  if (args.length === 2) {
    return buildStateful(SIGNAL_CTOR, Array.isArray(parent) ? parent : [parent], a);
  }
  const readsSource = (b as (...xs: unknown[]) => unknown).length >= 2;
  if (Array.isArray(parent)) return buildLensN(SIGNAL_CTOR, parent, a, b, readsSource);
  return buildLens1(SIGNAL_CTOR, parent, a, b, readsSource);
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
// commits sources (queuing effects); effects may write (more effects /
// more bwd entries). Loops until both queues are exhausted.

function flush(): void {
  if (flushing) return;
  flushing = true;
  let bwdIndex = 0;
  try {
    // Head-checked so the common already-drained case skips the body.
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
// A watching node (like an Effect) whose body fires when any SUBSCRIBED
// dep changes, but whose own writes self-exclude the node (via
// `activeNetwork`) so it doesn't re-trigger itself. Topology is explicit
// (deps array + later subscribe/unsubscribe; reads in the body add no
// deps) — the building block for constraint networks vs auto-tracked
// effects.

/** Handle to a `network` invocation. */
export interface Network {
  /** Tear down: unsubscribe from every signal, drop internal state. */
  dispose(): void;
  /** Run the body now (manual mode's only advance; no-op if unchanged). */
  flush(): void;
  /** Add signals to the topology (idempotent; does NOT fire the body). */
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  subscribe(...sigs: Cell<any>[]): void;
  /** Remove signals from the topology (idempotent; does NOT fire). */
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  unsubscribe(...sigs: Cell<any>[]): void;
}

type NetworkBody = (dirty: ReadonlySet<Cell<unknown>>, handle: Network) => void;

class _NetworkNode implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Watching | F.RecursedCheck;
  body: NetworkBody;
  manual: boolean;
  /** Per-instance last-seen dep values; used to compute `dirty`. */
  lastValues: Map<Cell<unknown>, unknown> = new Map();
  pending = false;
  disposed = false;
  private _ownCycle = 0;
  private _depsSet: Set<Cell<unknown>> = new Set();
  private _handle!: Network;

  constructor(body: NetworkBody, manual: boolean) {
    this.body = body;
    this.manual = manual;
  }

  /** Two-phase init so the body sees its own handle on the first fire. */
  _initWithHandle(handle: Network, initialDeps: readonly Cell<unknown>[]): void {
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

  private _computeDirty(): ReadonlySet<Cell<unknown>> {
    let dirty: Set<Cell<unknown>> | undefined;
    for (const [sig, lastVal] of this.lastValues) {
      if (sig.peek() !== lastVal) {
        if (dirty === undefined) dirty = new Set();
        dirty.add(sig);
      }
    }
    return dirty ?? EMPTY_DIRTY;
  }

  private _runBody(dirty: ReadonlySet<Cell<unknown>>): void {
    // RecursedCheck doubles as the "body running" guard (see flush()).
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
        const sig = l.dep as Cell<unknown>;
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

  subscribe(sigs: readonly Cell<unknown>[]): void {
    if (this.disposed) return;
    this._linkBatch(sigs);
  }

  unsubscribe(sigs: readonly Cell<unknown>[]): void {
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

  private _linkBatch(sigs: readonly Cell<unknown>[]): void {
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

/** Build a reactive sub-DAG node with explicit topology. The body fires
 *  when any subscribed dep changes (`dirty` = the changed subset), runs
 *  inside `batch()`, and self-excludes its own writes. Topology is the
 *  deps array + later subscribe/unsubscribe (body reads add no deps).
 *  `flush()` from inside the body throws; `manual: true` defers
 *  auto-firing so only `flush()` advances. */
export function network(
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  deps: readonly Cell<any>[],
  body: (dirty: ReadonlySet<Cell<unknown>>, handle: Network) => void,
  opts?: { manual?: boolean },
): Network {
  const node = new _NetworkNode(body, opts?.manual ?? false);
  const handle: Network = {
    dispose: () => node._unwatched(),
    flush: () => node.flush(),
    subscribe: (...sigs) => node.subscribe(sigs),
    unsubscribe: (...sigs) => node.unsubscribe(sigs),
  };
  node._initWithHandle(handle, deps as readonly Cell<unknown>[]);
  return handle;
}
