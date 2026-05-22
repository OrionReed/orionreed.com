// _proto-cell2/cell2.ts — 2-class split sketch (Source + Derived).
//
// Instead of a single Signal class with mode-branching, split into:
//   Source<T>  — owns an intrinsic slot, source semantics inline
//   Derived<T> — wraps user (g, s?), derived semantics inline
//
// Both implement ReactiveNode. The mode "dispatch" is encoded in the
// JS class: V8 sees a polymorphic site (2 hidden classes) and uses an
// IC stub that's faster than the closure dispatch from `_proto-cell/`.
//
// Hypothesis: this gives the conceptual simplification (no mode branch
// inside hot paths) AND keeps perf parity / wins over the current
// branched 3-mode Signal.
//
// Same alien-signals v2 graph machinery as `signal.ts`.

import { type Equals } from "../traits";

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
const queued: (Cell2Effect | undefined)[] = [];
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
  const newLink: Link = (sub.depsTail = dep.subsTail =
    { version, dep, sub, prevDep, nextDep, prevSub, nextSub: undefined });
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

// ─── Source<T> — slot-backed cell with NO mode branching ──────────

export class Source<T = unknown> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Mutable;

  _value: T;
  _pending: T;
  _equals: Equals<T> | undefined = undefined;

  constructor(initial: T) {
    this._value = initial;
    this._pending = initial;
  }

  get value(): T {
    if (activeSub !== undefined) link(this, activeSub, cycle);
    // Inline source dirty-honor.
    if (this.flags & F.Dirty) {
      this.flags = F.Mutable;
      if (this._value !== (this._value = this._pending)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    return this._value;
  }

  set value(v: T) {
    const prev = this._pending;
    this._pending = v;
    const equals = this._equals;
    const same = equals ? equals(prev, v) : prev === v;
    if (!same) {
      this.flags = F.Mutable | F.Dirty;
      const subs = this.subs;
      if (subs !== undefined) {
        propagate(subs, runDepth > 0);
        if (batchDepth === 0) flush();
      }
    }
  }

  peek(): T {
    if (this.flags & F.Dirty) {
      this.flags = F.Mutable;
      if (this._value !== (this._value = this._pending)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    return this._value;
  }

  _update(): boolean {
    this.flags = F.Mutable;
    return this._value !== (this._value = this._pending);
  }

  _notify(): void {}

  _unwatched(): void {}
}

// ─── Derived<T> — user (getter, setter?) wrapper ──────────────────

export class Derived<T = unknown> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = 0;

  _value: T;  // cached
  _userFn: () => T;
  _userSetter: ((v: T) => void) | undefined;
  _equals: Equals<T> | undefined = undefined;

  constructor(userFn: () => T, userSetter?: (v: T) => void) {
    this._value = undefined as T;
    this._userFn = userFn;
    this._userSetter = userSetter;
  }

  get value(): T {
    const flags = this.flags;
    if (flags & F.RecursedCheck) {
      throw new RangeError(`Cyclic derived: read its own value`);
    }
    if (
      flags & F.Dirty ||
      (flags & F.Pending && (checkDirty(this.deps!, this) || ((this.flags = flags & ~F.Pending), false)))
    ) {
      if (this._update()) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    } else if (!flags) {
      // First read: lazy init
      this.flags = F.Mutable | F.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      let threw = true;
      try {
        this._value = this._userFn();
        threw = false;
      } finally {
        activeSub = prev;
        this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this._value;
  }

  set value(v: T) {
    if (this._userSetter === undefined) throw new TypeError("Cannot write to a Computed");
    this._userSetter(v);
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

  _update(): boolean {
    this.depsTail = undefined;
    this.flags = F.Mutable | F.RecursedCheck;
    const prev = activeSub;
    activeSub = this;
    let threw = true;
    try {
      ++cycle;
      const old = this._value;
      const next = (this._value = this._userFn());
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
    if (this.depsTail !== undefined) {
      this.flags = F.Mutable | F.Dirty;
      disposeAllDepsInReverse(this);
    }
  }
}

// ─── Public factories ────────────────────────────────────────────

export function source<T>(initial: T): Source<T> {
  return new Source(initial);
}

export function computed<T>(getter: () => T): Derived<T> {
  return new Derived(getter);
}

export function lens<T>(getter: () => T, setter: (v: T) => void): Derived<T> {
  return new Derived(getter, setter);
}

// ─── Effect (uses ReactiveNode interface, doesn't care about class) ─

class Cell2Effect implements ReactiveNode {
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
    let e: Cell2Effect = this;
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queued[insertIndex++] = e;
      e.flags &= ~F.Watching;
      const next = e.subs?.sub as Cell2Effect | undefined;
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
  const e = new Cell2Effect(fn);
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
