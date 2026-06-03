// alien-canonical.ts — alien-signals 3.2.1 (the v2 algorithm), ported
// MECHANICALLY from the published functional API (`.bind({...})` +
// `signalOper`/`computedOper`) to a class-based shape, so it is
// apples-to-apples with our class-based engine for benchmarks and the
// conformance suite. The algorithm (link/unlink/propagate/checkDirty/
// shallowPropagate + the signal/computed/effect operators) is verbatim;
// only the node representation changed (bound function → class instance
// with a prototype `value` accessor).
//
// Source: node_modules/alien-signals/esm/{system,index}.mjs @ 3.2.1.
// This file is the gold-standard reference, NOT part of the engine.

// ─── Flags (verbatim) ─────────────────────────────────────────────
const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
} as const;

interface Link {
  version: number;
  dep: Node;
  sub: Node;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
  prevDep: Link | undefined;
  nextDep: Link | undefined;
}
interface Stack<T> {
  value: T;
  prev: Stack<T> | undefined;
}
interface Node {
  flags: number;
  deps?: Link | undefined;
  depsTail?: Link | undefined;
  subs: Link | undefined;
  subsTail: Link | undefined;
}

// ─── Engine globals (verbatim) ────────────────────────────────────
let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: AlienEffect | AlienComputed<unknown> | undefined;
const queued: (AlienEffect | undefined)[] = [];

// ─── Reactive system (verbatim from system.mjs) ───────────────────
function update(node: Node): boolean {
  if (node instanceof AlienComputed) return updateComputed(node);
  if (node instanceof AlienSignal) return updateSignal(node);
  node.flags = F.Mutable;
  return true;
}
function notify(effect: AlienEffect): void {
  let e: AlienEffect | undefined = effect;
  let insertIndex = queuedLength;
  let firstInsertedIndex = insertIndex;
  do {
    queued[insertIndex++] = e;
    e.flags &= ~F.Watching;
    e = e.subs?.sub as AlienEffect | undefined;
    if (e === undefined || !(e.flags & F.Watching)) break;
  } while (true);
  queuedLength = insertIndex;
  while (firstInsertedIndex < --insertIndex) {
    const left = queued[firstInsertedIndex];
    queued[firstInsertedIndex++] = queued[insertIndex];
    queued[insertIndex] = left;
  }
}
function unwatched(node: Node): void {
  if (node instanceof AlienComputed) {
    if (node.depsTail !== undefined) {
      node.flags = F.Mutable | F.Dirty;
      disposeAllDepsInReverse(node);
    }
  } else if (node instanceof AlienSignal) {
    // nothing
  } else if (node instanceof AlienEffect) {
    effectOper(node);
  }
}

function link(dep: Node, sub: Node, version: number): void {
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
      { version, dep, sub, prevDep, nextDep, prevSub, nextSub: undefined });
  if (nextDep !== undefined) nextDep.prevDep = newLink;
  if (prevDep !== undefined) prevDep.nextDep = newLink;
  else sub.deps = newLink;
  if (prevSub !== undefined) prevSub.nextSub = newLink;
  else dep.subs = newLink;
}
function unlink(l: Link, sub: Node = l.sub): Link | undefined {
  const { dep, prevDep, nextDep, nextSub, prevSub } = l;
  if (nextDep !== undefined) nextDep.prevDep = prevDep;
  else sub.depsTail = prevDep;
  if (prevDep !== undefined) prevDep.nextDep = nextDep;
  else sub.deps = nextDep;
  if (nextSub !== undefined) nextSub.prevSub = prevSub;
  else dep.subsTail = prevSub;
  if (prevSub !== undefined) prevSub.nextSub = nextSub;
  else if ((dep.subs = nextSub) === undefined) unwatched(dep);
  return nextDep;
}
function propagate(start: Link, innerWrite: boolean): void {
  let link: Link | undefined = start;
  let next = start.nextSub;
  let stack: Stack<Link | undefined> | undefined;
  top: do {
    const sub = link!.sub;
    let flags = sub.flags;
    if (!(flags & (F.RecursedCheck | F.Recursed | F.Dirty | F.Pending))) {
      sub.flags = flags | F.Pending;
      if (innerWrite) sub.flags |= F.Recursed;
    } else if (!(flags & (F.RecursedCheck | F.Recursed))) {
      flags = F.None;
    } else if (!(flags & F.RecursedCheck)) {
      sub.flags = (flags & ~F.Recursed) | F.Pending;
    } else if (!(flags & (F.Dirty | F.Pending)) && isValidLink(link!, sub)) {
      sub.flags = flags | (F.Recursed | F.Pending);
      flags &= F.Mutable;
    } else {
      flags = F.None;
    }
    if (flags & F.Watching) notify(sub as AlienEffect);
    if (flags & F.Mutable) {
      const subSubs = sub.subs;
      if (subSubs !== undefined) {
        const nextSub = (link = subSubs).nextSub;
        if (nextSub !== undefined) {
          stack = { value: next, prev: stack };
          next = nextSub;
        }
        continue;
      }
    }
    if ((link = next!) !== undefined) {
      next = link.nextSub;
      continue;
    }
    while (stack !== undefined) {
      link = stack.value;
      stack = stack.prev;
      if (link !== undefined) {
        next = link.nextSub;
        continue top;
      }
    }
    break;
  } while (true);
}
function checkDirty(startLink: Link, startSub: Node): boolean {
  let link = startLink;
  let sub = startSub;
  let stack: Stack<Link> | undefined;
  let checkDepth = 0;
  let dirty = false;
  top: do {
    const dep = link.dep;
    const flags = dep.flags;
    if (sub.flags & F.Dirty) {
      dirty = true;
    } else if ((flags & (F.Mutable | F.Dirty)) === (F.Mutable | F.Dirty)) {
      const subs = dep.subs!;
      if (update(dep)) {
        if (subs.nextSub !== undefined) shallowPropagate(subs);
        dirty = true;
      }
    } else if ((flags & (F.Mutable | F.Pending)) === (F.Mutable | F.Pending)) {
      stack = { value: link, prev: stack };
      link = dep.deps!;
      sub = dep;
      ++checkDepth;
      continue;
    }
    if (!dirty) {
      const nextDep = link.nextDep;
      if (nextDep !== undefined) {
        link = nextDep;
        continue;
      }
    }
    while (checkDepth--) {
      link = stack!.value;
      stack = stack!.prev;
      if (dirty) {
        const subs = sub.subs!;
        if (update(sub)) {
          if (subs.nextSub !== undefined) shallowPropagate(subs);
          sub = link.sub;
          continue;
        }
        dirty = false;
      } else {
        sub.flags &= ~F.Pending;
      }
      sub = link.sub;
      const nextDep = link.nextDep;
      if (nextDep !== undefined) {
        link = nextDep;
        continue top;
      }
    }
    return dirty && !!sub.flags;
  } while (true);
}
function shallowPropagate(start: Link): void {
  let link: Link | undefined = start;
  do {
    const sub = link.sub;
    const flags = sub.flags;
    if ((flags & (F.Pending | F.Dirty)) === F.Pending) {
      sub.flags = flags | F.Dirty;
      if ((flags & (F.Watching | F.RecursedCheck)) === F.Watching) notify(sub as AlienEffect);
    }
  } while ((link = link.nextSub) !== undefined);
}
function isValidLink(checkLink: Link, sub: Node): boolean {
  let link = sub.depsTail;
  while (link !== undefined) {
    if (link === checkLink) return true;
    link = link.prevDep;
  }
  return false;
}

// ─── update / run / flush (verbatim) ──────────────────────────────
function updateComputed(c: AlienComputed<unknown>): boolean {
  c.depsTail = undefined;
  c.flags = F.Mutable | F.RecursedCheck;
  const prevSub = activeSub;
  activeSub = c;
  try {
    ++cycle;
    const oldValue = c._v;
    return oldValue !== (c._v = c.getter(oldValue));
  } finally {
    activeSub = prevSub;
    c.flags &= ~F.RecursedCheck;
    purgeDeps(c);
  }
}
function updateSignal(s: AlienSignal<unknown>): boolean {
  s.flags = F.Mutable;
  return s.currentValue !== (s.currentValue = s.pendingValue);
}
function run(e: AlienEffect): void {
  const flags = e.flags;
  if (flags & F.Dirty || (flags & F.Pending && checkDirty(e.deps!, e))) {
    if (e.cleanup) {
      runCleanup(e);
      if (!e.flags) return;
    }
    e.depsTail = undefined;
    e.flags = F.Watching | F.RecursedCheck;
    const prevSub = activeSub;
    activeSub = e;
    try {
      ++cycle;
      ++runDepth;
      e.cleanup = e.fn() as (() => void) | undefined;
    } finally {
      --runDepth;
      activeSub = prevSub;
      e.flags &= ~F.RecursedCheck;
      purgeDeps(e);
    }
  } else if (e.deps !== undefined) {
    e.flags = F.Watching;
  }
}
function flush(): void {
  while (notifyIndex < queuedLength) {
    const effect = queued[notifyIndex]!;
    queued[notifyIndex++] = undefined;
    run(effect);
  }
  notifyIndex = 0;
  queuedLength = 0;
}
function runCleanup(e: AlienEffect): void {
  const cleanup = e.cleanup!;
  e.cleanup = undefined;
  const prevSub = activeSub;
  activeSub = undefined;
  try {
    cleanup();
  } finally {
    activeSub = prevSub;
  }
}
function effectOper(e: AlienEffect): void {
  e.flags = F.None;
  disposeAllDepsInReverse(e);
  const sub = e.subs;
  if (sub !== undefined) unlink(sub);
  if (e.cleanup) runCleanup(e);
}
function disposeAllDepsInReverse(sub: Node): void {
  let link = sub.depsTail;
  while (link !== undefined) {
    const prev = link.prevDep;
    unlink(link, sub);
    link = prev;
  }
}
function purgeDeps(sub: Node): void {
  const depsTail = sub.depsTail;
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
  while (dep !== undefined) dep = unlink(dep, sub);
}

// ─── Node classes (the mechanical reshape) ────────────────────────
export class AlienSignal<T> implements Node {
  currentValue: T;
  pendingValue: T;
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  flags = F.Mutable;
  constructor(v: T) {
    this.currentValue = v;
    this.pendingValue = v;
  }
  declare value: T;
}
Object.defineProperty(AlienSignal.prototype, "value", {
  get(this: AlienSignal<unknown>): unknown {
    if (this.flags & F.Dirty) {
      if (updateSignal(this)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.currentValue;
  },
  set(this: AlienSignal<unknown>, next: unknown): void {
    if (this.pendingValue !== (this.pendingValue = next)) {
      this.flags = F.Mutable | F.Dirty;
      const subs = this.subs;
      if (subs !== undefined) {
        propagate(subs, runDepth > 0);
        if (!batchDepth) flush();
      }
    }
  },
});

export class AlienComputed<T> implements Node {
  _v: T | undefined = undefined;
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags = F.None;
  getter: (prev?: T) => T;
  constructor(getter: (prev?: T) => T) {
    this.getter = getter;
  }
  declare value: T;
}
Object.defineProperty(AlienComputed.prototype, "value", {
  get(this: AlienComputed<unknown>): unknown {
    const flags = this.flags;
    if (
      flags & F.Dirty ||
      (flags & F.Pending &&
        (checkDirty(this.deps!, this) || ((this.flags = flags & ~F.Pending), false)))
    ) {
      if (updateComputed(this)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    } else if (!flags) {
      this.flags = F.Mutable | F.RecursedCheck;
      const prevSub = activeSub;
      activeSub = this;
      try {
        this._v = this.getter();
      } finally {
        activeSub = prevSub;
        this.flags &= ~F.RecursedCheck;
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this._v;
  },
});

export class AlienEffect implements Node {
  fn: () => (() => void) | void;
  cleanup: (() => void) | undefined = undefined;
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags = F.Watching | F.RecursedCheck;
  constructor(fn: () => (() => void) | void) {
    this.fn = fn;
  }
}

// ─── Public API ───────────────────────────────────────────────────
export function signal<T>(initial: T): AlienSignal<T> {
  return new AlienSignal(initial);
}
export function computed<T>(getter: (prev?: T) => T): AlienComputed<T> {
  return new AlienComputed(getter);
}
export function effect(fn: () => (() => void) | void): () => void {
  const e = new AlienEffect(fn);
  const prevSub = activeSub;
  activeSub = e;
  try {
    ++runDepth;
    e.cleanup = fn() as (() => void) | undefined;
  } finally {
    --runDepth;
    activeSub = prevSub;
    e.flags &= ~F.RecursedCheck;
  }
  return () => effectOper(e);
}
export function startBatch(): void {
  ++batchDepth;
}
export function endBatch(): void {
  if (!--batchDepth) flush();
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
