// _proto-cell/cell.ts — Signal-is-Lens sketch.
//
// Every cell has `_getter: () => T` (always defined). Sources install
// an intrinsic getter/setter that touch a backing slot; derived cells
// install user-supplied closures. The `get value` / `set value` paths
// have no mode branch — they call the getter/setter unconditionally.
//
// The point of this sketch: measure whether V8 can inline the
// intrinsic source closures well enough to match the current
// branched 3-mode `Signal` on the hot read/write path.
//
// Algorithm: same alien-signals v2 as `signal.ts` — we reuse the
// link/unlink/propagate machinery verbatim. Only the per-instance
// dispatch changes.

import { type Equals, type TraitDict } from "../traits";

// ─── Internal types (identical to signal.ts) ──────────────────────

interface ReactiveNode {
  deps?: Link;
  depsTail?: Link;
  subs?: Link;
  subsTail?: Link;
  flags: number;
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

const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
} as const;

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
const queued: (CellEffect | undefined)[] = [];
let flushing = false;

// ─── alien-signals algorithm (verbatim) ───────────────────────────

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
  const newLink: Link = (sub.depsTail = dep.subsTail =
    { version, dep, sub, prevDep, nextDep, prevSub, nextSub: undefined });
  if (nextDep !== undefined) nextDep.prevDep = newLink;
  if (prevDep !== undefined) prevDep.nextDep = newLink;
  else sub.deps = newLink;
  if (prevSub !== undefined) prevSub.nextSub = newLink;
  else dep.subs = newLink;
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
  let l = startLink, sub = startSub;
  let stack: Stack<Link> | undefined;
  let checkDepth = 0, dirty = false;
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

function flush(): void {
  if (flushing) return;
  flushing = true;
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]!;
      queued[notifyIndex++] = undefined;
      e._run();
    }
  } finally {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]!;
      queued[notifyIndex++] = undefined;
      e.flags |= F.Watching | F.Recursed;
    }
    notifyIndex = 0;
    queuedLength = 0;
    flushing = false;
  }
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

// ─── The unified Cell class ───────────────────────────────────────

/** Every Cell is a lens. Sources are lenses onto an intrinsic slot
 *  (`_value` + `_pending`); derived cells (computed/lens) are lenses
 *  with a user-supplied getter and optional setter.
 *
 *  No mode branching in `get value` / `set value` — dispatch is via
 *  the always-defined `_getter` / optional `_setter`. The cost we
 *  bench: one closure call per read vs the current branched code.
 *
 *  Fields:
 *    - `_value` — cached/current value (sources: current truth; derived: last cached read)
 *    - `_pending` — pending write (sources only; derived ignore it)
 *    - `_getter` — always defined; sources have an intrinsic closure that does the dirty/propagate dance
 *    - `_setter` — undefined ⇒ RO; sources have intrinsic write closure; lenses have user fn
 *    - `_isSource` — fusion/identity tag; helps `Cell.through` know whether the parent is a source
 */
export class Cell<T = unknown> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Mutable;

  _value: T;
  _pending: T;

  /** Public-facing read closure. Sources: intrinsic dirty-honoring slot
   *  read. Derived: cache+lazy wrapper around `_userFn`. Always defined. */
  _getter: () => T;
  /** Public-facing write closure. Undefined = read-only. Sources:
   *  intrinsic slot write + propagate. Lenses: user setter wrapped if
   *  needed. */
  _setter: ((v: T) => void) | undefined;
  /** Raw user fn for derived cells; consulted by `_update()` to skip
   *  the cache wrapper and avoid the cycle-check re-entry. Undefined
   *  for sources. */
  _userFn: (() => T) | undefined;

  _equals: Equals<T> | undefined = undefined;
  _watched?: () => void;
  _unwatchedHook?: () => void;
  /** True when this cell owns its `_value`/`_pending` slot (source);
   *  false when it's a view computed by `_userFn` (derived). */
  _isSource: boolean;

  constructor(initial: T, opts?: { equals?: Equals<T>; watched?: () => void; unwatched?: () => void }) {
    this._value = initial;
    this._pending = initial;
    this._isSource = true;
    this._userFn = undefined;
    const self = this;
    this._getter = () => sourceRead<T>(self);
    this._setter = (v: T) => { sourceWrite<T>(self, v) };

    if (opts?.equals) this._equals = opts.equals;
    else {
      const cls = this.constructor as { traits?: TraitDict<T> };
      if (cls.traits?.equals) this._equals = cls.traits.equals;
    }
    if (opts) {
      if (opts.watched) this._watched = opts.watched;
      if (opts.unwatched) this._unwatchedHook = opts.unwatched;
    }
  }

  /** Flip a fresh instance into derived (computed/lens) mode. */
  static install<T, C extends Cell<T>>(
    Cls: new (...args: never[]) => C,
    getter: () => T,
    setter?: (v: T) => void,
  ): C {
    const inst = new Cls();
    inst._isSource = false;
    inst._userFn = getter;
    inst._getter = computedGetter(inst as Cell<T>, getter) as () => T;
    inst._setter = setter;
    inst.flags = 0;
    return inst;
  }

  /** Read with tracking. NO mode branch — call the getter, that's it. */
  get value(): T {
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this._getter();
  }

  set value(next: T) {
    const set = this._setter;
    if (set === undefined) throw new TypeError("Cannot write to a Computed");
    set(next);
  }

  /** Untracked read. */
  peek(): T {
    const prev = activeSub;
    activeSub = undefined;
    try {
      return this._getter();
    } finally {
      activeSub = prev;
    }
  }

  _update(): boolean {
    if (this._isSource) {
      this.flags = F.Mutable;
      return this._value !== (this._value = this._pending);
    }
    // Derived: re-run the RAW user fn under tracking. Calling
    // `_getter()` here would re-enter the cache wrapper and trip the
    // cycle-check we just set.
    this.depsTail = undefined;
    this.flags = F.Mutable | F.RecursedCheck;
    const prev = activeSub;
    activeSub = this;
    let threw = true;
    try {
      ++cycle;
      const old = this._value;
      const next = (this._value = this._userFn!());
      threw = false;
      const eq = this._equals;
      return eq ? !eq(old, next) : old !== next;
    } finally {
      activeSub = prev;
      this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
      purgeDeps(this);
    }
  }

  _notify(): void {}

  _unwatched(): void {
    if (!this._isSource && this.depsTail !== undefined) {
      this.flags = F.Mutable | F.Dirty;
      disposeAllDepsInReverse(this);
      return;
    }
    if (this._unwatchedHook !== undefined) this._unwatchedHook();
  }
}

// ─── Source closures (used by intrinsic getter/setter) ────────────

/** Source-cell read: honor Dirty + propagate to subs (commits pending). */
function sourceRead<T>(c: Cell<T>): T {
  const flags = c.flags;
  if (flags & F.Dirty) {
    c.flags = F.Mutable;
    if (c._value !== (c._value = c._pending)) {
      const subs = c.subs;
      if (subs !== undefined) shallowPropagate(subs);
    }
  }
  return c._value;
}

/** Source-cell write: equality-skip + propagate. */
function sourceWrite<T>(c: Cell<T>, v: T): void {
  const prev = c._pending;
  c._pending = v;
  const equals = c._equals;
  const same = equals ? equals(prev, v) : prev === v;
  if (!same) {
    c.flags = F.Mutable | F.Dirty;
    const subs = c.subs;
    if (subs !== undefined) {
      propagate(subs, runDepth > 0);
      if (batchDepth === 0) flush();
    }
  }
}

// ─── Derived-getter wrappers (computed-mode lazy/check behavior) ──

/** Build a "computed-style" getter wrapper for `install`. Adds the
 *  cache-hit / lazy-init / dirty-check logic that today's `get value`
 *  signal-path inlines. We do it via a closure so we can keep the
 *  `get value` body fully unified. */
function computedGetter<T>(c: Cell<T>, userFn: () => T): () => T {
  return () => {
    const flags = c.flags;
    if (flags & F.RecursedCheck) {
      throw new RangeError(`Cyclic computed: ${(c.constructor as { name?: string }).name ?? "?"} read its own value`);
    }
    if (
      flags & F.Dirty ||
      (flags & F.Pending && (checkDirty(c.deps!, c) || ((c.flags = flags & ~F.Pending), false)))
    ) {
      if (c._update()) {
        const subs = c.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    } else if (!flags) {
      // First read: lazy init.
      c.flags = F.Mutable | F.RecursedCheck;
      const prev = activeSub;
      activeSub = c;
      let threw = true;
      try {
        c._value = userFn();
        threw = false;
      } finally {
        activeSub = prev;
        c.flags = threw ? F.Mutable | F.Dirty : c.flags & ~F.RecursedCheck;
      }
    }
    return c._value;
  };
}

// ─── Public factories ────────────────────────────────────────────

export function cell<T>(initial: T): Cell<T> {
  return new Cell(initial);
}

export function computed<T>(getter: () => T): Cell<T> {
  const c = new Cell<T>(undefined as T);
  c._isSource = false;
  c._userFn = getter;
  c._getter = computedGetter(c, getter);
  c._setter = undefined;
  c.flags = 0;
  return c;
}

export function lens<T>(getter: () => T, setter: (v: T) => void): Cell<T> {
  const c = new Cell<T>(undefined as T);
  c._isSource = false;
  c._userFn = getter;
  c._getter = computedGetter(c, getter);
  c._setter = setter;
  c.flags = 0;
  return c;
}

// ─── Effect class (unchanged from signal.ts) ─────────────────────

class CellEffect implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Watching | F.RecursedCheck;
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
    let e: CellEffect = this;
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queued[insertIndex++] = e;
      e.flags &= ~F.Watching;
      const next = e.subs?.sub as CellEffect | undefined;
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
    if (
      flags & F.Dirty ||
      (flags & F.Pending && checkDirty(this.deps!, this))
    ) {
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

export function effect(fn: () => void | (() => void)): () => void {
  const e = new CellEffect(fn);
  return () => e._unwatched();
}

export function batch<R>(fn: () => R): R {
  ++batchDepth;
  try {
    return fn();
  } finally {
    if (!--batchDepth) flush();
  }
}
