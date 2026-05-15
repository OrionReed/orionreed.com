// core3.ts — class-based engine + struct factory.
//
// Inspired by alien-signals-starter (the author's class-based reference
// impl) and the TC39 signals proposal polyfill. Same propagation
// algorithm as alien-signals; just exposed as classes with `.value`
// getter/setter instead of bound callable functions.
//
// Expected wins vs the bound-function approach (core.ts):
//   • Construction: ~10ns vs ~190ns (~19x faster — no bind cost).
//   • Memory: ~150B/cell vs ~480B/cell (~3x less — no bound-fn overhead).
// Expected tradeoff:
//   • Reads: `.value` getter ~4ns vs callable `()` ~1.4ns (3ns slower).
//   • Writes: `.value =` setter ~4ns vs callable ~9ns (faster!).
//
// This is the API shape used by preact-signals, TC39 Signal.State,
// MobX, Vue ref, and alien-signals-starter. We're the outlier with
// callable signals.
//
// Struct factory: adapts the class shape to typed cells with
// methods/getters/fields/traits/chain. Cell instances are objects
// (not functions), so they need explicit `.read()` / `.write(v)` or
// `.value` to access the underlying value.

// ════════════════════════════════════════════════════════════════════
// ENGINE — alien-signals algorithm, class-based shell
// ════════════════════════════════════════════════════════════════════

interface ReactiveNode {
  deps?: Link;
  depsTail?: Link;
  subs?: Link;
  subsTail?: Link;
  flags: number;
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

interface Stack<T> { value: T; prev: Stack<T> | undefined; }

const ReactiveFlags = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
} as const;

const HasChildEffect = 64;

// Use the same makeSystem closure pattern as core.ts. It allows the
// algorithm to be configured for different node-type dispatches via the
// 3 callbacks (update / notify / unwatched). Kept here for parity.
function makeSystem(
  update: (sub: ReactiveNode) => boolean,
  notify: (sub: ReactiveNode) => void,
  unwatched: (sub: ReactiveNode) => void,
) {
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
    const newLink: Link = (sub.depsTail = dep.subsTail = {
      version, dep, sub, prevDep, nextDep, prevSub, nextSub: undefined,
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
    else if ((dep.subs = nextSub) === undefined) unwatched(dep);
    return nextDep;
  }

  function propagate(start: Link, innerWrite: boolean): void {
    let l: Link | undefined = start;
    let next: Link | undefined = start.nextSub;
    let stack: Stack<Link | undefined> | undefined;
    top: do {
      const sub: ReactiveNode = l!.sub;
      let flags = sub.flags;
      if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending))) {
        sub.flags = flags | ReactiveFlags.Pending;
        if (innerWrite) sub.flags |= ReactiveFlags.Recursed;
      } else if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))) {
        flags = ReactiveFlags.None;
      } else if (!(flags & ReactiveFlags.RecursedCheck)) {
        sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending;
      } else if (!(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) && isValidLink(l!, sub)) {
        sub.flags = flags | (ReactiveFlags.Recursed | ReactiveFlags.Pending);
        flags &= ReactiveFlags.Mutable;
      } else {
        flags = ReactiveFlags.None;
      }
      if (flags & ReactiveFlags.Watching) notify(sub);
      if (flags & ReactiveFlags.Mutable) {
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
    let l = startLink;
    let sub = startSub;
    let stack: Stack<Link> | undefined;
    let checkDepth = 0;
    let dirty = false;
    top: do {
      const dep = l.dep;
      const flags = dep.flags;
      if (sub.flags & ReactiveFlags.Dirty) dirty = true;
      else if ((flags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) === (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) {
        const subs = dep.subs!;
        if (update(dep)) {
          if (subs.nextSub !== undefined) shallowPropagate(subs);
          dirty = true;
        }
      } else if ((flags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) === (ReactiveFlags.Mutable | ReactiveFlags.Pending)) {
        stack = { value: l, prev: stack };
        l = dep.deps!;
        sub = dep;
        ++checkDepth;
        continue;
      }
      if (!dirty) {
        const nextDep = l.nextDep;
        if (nextDep !== undefined) { l = nextDep; continue; }
      }
      while (checkDepth--) {
        l = stack!.value;
        stack = stack!.prev;
        if (dirty) {
          const subs = sub.subs!;
          if (update(sub)) {
            if (subs.nextSub !== undefined) shallowPropagate(subs);
            sub = l.sub;
            continue;
          }
          dirty = false;
        } else {
          sub.flags &= ~ReactiveFlags.Pending;
        }
        sub = l.sub;
        const nextDep = l.nextDep;
        if (nextDep !== undefined) { l = nextDep; continue top; }
      }
      return dirty && !!sub.flags;
    } while (true);
  }

  function shallowPropagate(l: Link): void {
    do {
      const sub = l.sub;
      const flags = sub.flags;
      if ((flags & (ReactiveFlags.Pending | ReactiveFlags.Dirty)) === ReactiveFlags.Pending) {
        sub.flags = flags | ReactiveFlags.Dirty;
        if ((flags & (ReactiveFlags.Watching | ReactiveFlags.RecursedCheck)) === ReactiveFlags.Watching) notify(sub);
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

  return { link, unlink, propagate, checkDirty, shallowPropagate };
}

// ── Engine state ───────────────────────────────────────────────────

interface EffectNode extends ReactiveNode {
  fn(): (() => void) | void;
  cleanup: (() => void) | void;
}

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
const queued: (EffectNode | undefined)[] = [];

const { link, unlink, propagate, checkDirty, shallowPropagate } = makeSystem(
  (node) => {
    if (node instanceof Signal) return node._update();
    if (node instanceof Computed) return node._update();
    if (node instanceof Lens) return node._update();
    node.flags = ReactiveFlags.Mutable;
    return true;
  },
  (effect) => {
    let e = effect as EffectNode;
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queued[insertIndex++] = e;
      e.flags &= ~ReactiveFlags.Watching;
      const next = e.subs?.sub as EffectNode | undefined;
      if (next === undefined || !(next.flags & ReactiveFlags.Watching)) break;
      e = next;
    } while (true);
    queuedLength = insertIndex;
    let idx = insertIndex;
    let firstIdx = firstInsertedIndex;
    while (firstIdx < --idx) {
      const left = queued[firstIdx];
      queued[firstIdx++] = queued[idx];
      queued[idx] = left;
    }
  },
  (node) => {
    if (node instanceof Computed || node instanceof Lens) {
      if (node.depsTail !== undefined) {
        node.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
        disposeAllDepsInReverse(node);
      }
    } else if (node instanceof Signal) {
      // no cleanup
    } else if ("fn" in node) {
      // effect cleanup
      const e = node as EffectNode;
      e.flags = ReactiveFlags.None;
      disposeAllDepsInReverse(e);
      const sub = e.subs;
      if (sub !== undefined) unlink(sub);
      if (e.cleanup) runCleanup(e);
    }
  },
);

function flush(): void {
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]!;
      queued[notifyIndex++] = undefined;
      runEffect(e);
    }
  } finally {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]!;
      queued[notifyIndex++] = undefined;
      e.flags |= ReactiveFlags.Watching | ReactiveFlags.Recursed;
    }
    notifyIndex = 0;
    queuedLength = 0;
  }
}

function runEffect(e: EffectNode): void {
  const flags = e.flags;
  if (flags & ReactiveFlags.Dirty || (flags & ReactiveFlags.Pending && checkDirty(e.deps!, e))) {
    if (flags & HasChildEffect) {
      let l = e.depsTail;
      while (l !== undefined) {
        const prev = l.prevDep;
        const dep = l.dep;
        if (!(dep instanceof Computed) && !(dep instanceof Lens) && !(dep instanceof Signal)) unlink(l, e);
        l = prev;
      }
    }
    if (e.cleanup) {
      runCleanup(e);
      if (!e.flags) return;
    }
    e.depsTail = undefined;
    e.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
    const prev = activeSub;
    activeSub = e;
    try {
      ++cycle;
      ++runDepth;
      e.cleanup = e.fn();
    } finally {
      --runDepth;
      activeSub = prev;
      e.flags &= ~ReactiveFlags.RecursedCheck;
      purgeDeps(e);
    }
  } else if (e.deps !== undefined) {
    e.flags = ReactiveFlags.Watching | (flags & HasChildEffect);
  }
}

function runCleanup(e: EffectNode): void {
  const cleanup = e.cleanup!;
  e.cleanup = undefined;
  const prev = activeSub;
  activeSub = undefined;
  try { cleanup(); } finally { activeSub = prev; }
}

function disposeAllDepsInReverse(sub: ReactiveNode): void {
  let l = sub.depsTail;
  while (l !== undefined) {
    const prev = l.prevDep;
    unlink(l, sub);
    l = prev;
  }
}

function purgeDeps(sub: ReactiveNode): void {
  const depsTail = sub.depsTail;
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
  while (dep !== undefined) dep = unlink(dep, sub);
}

// ── Public API: classes ─────────────────────────────────────────────

/** Untracked read — read a signal without subscribing the current effect. */
export function peek<T>(s: { peek(): T }): T { return s.peek(); }

/** Writable signal. Construct with `new Signal(v)` or `signal(v)`. */
export class Signal<T = any> implements ReactiveNode {
  // Reactive node fields
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = ReactiveFlags.Mutable;
  // Value storage
  currentValue: T;
  pendingValue: T;

  constructor(initial: T) {
    this.currentValue = initial;
    this.pendingValue = initial;
  }

  /** Read with tracking. */
  get value(): T {
    if (this.flags & ReactiveFlags.Dirty) {
      this.flags = ReactiveFlags.Mutable;
      if (this.currentValue !== (this.currentValue = this.pendingValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.currentValue;
  }

  /** Write — triggers propagation if value changed. */
  set value(next: T) {
    if (this.pendingValue !== (this.pendingValue = next)) {
      this.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
      const subs = this.subs;
      if (subs !== undefined) {
        propagate(subs, !!runDepth);
        if (!batchDepth) flush();
      }
    }
  }

  /** Untracked read. */
  peek(): T { return this.currentValue; }

  /** Internal: equality-check update. */
  _update(): boolean {
    this.flags = ReactiveFlags.Mutable;
    return this.currentValue !== (this.currentValue = this.pendingValue);
  }
}

/** Read-only computed signal. */
export class Computed<T = any> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = 0;
  cachedValue: T | undefined = undefined;
  getter: () => T;

  constructor(getter: () => T) {
    this.getter = getter;
  }

  get value(): T {
    const flags = this.flags;
    if (
      flags & ReactiveFlags.Dirty ||
      (flags & ReactiveFlags.Pending &&
        (checkDirty(this.deps!, this) || ((this.flags = flags & ~ReactiveFlags.Pending), false)))
    ) {
      if (this._update()) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    } else if (!flags) {
      this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      try { this.cachedValue = this.getter(); }
      finally { activeSub = prev; this.flags &= ~ReactiveFlags.RecursedCheck; }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }

  peek(): T {
    const prev = activeSub;
    activeSub = undefined;
    try { return this.value; }
    finally { activeSub = prev; }
  }

  _update(): boolean {
    if (this.flags & HasChildEffect) {
      let l = this.depsTail;
      while (l !== undefined) {
        const prev = l.prevDep;
        const dep = l.dep;
        if (!(dep instanceof Computed) && !(dep instanceof Lens) && !(dep instanceof Signal)) unlink(l, this);
        l = prev;
      }
    }
    this.depsTail = undefined;
    this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
    const prev = activeSub;
    activeSub = this;
    try {
      ++cycle;
      const old = this.cachedValue;
      return old !== (this.cachedValue = this.getter());
    } finally {
      activeSub = prev;
      this.flags &= ~ReactiveFlags.RecursedCheck;
      purgeDeps(this);
    }
  }
}

/** Writable computed: get via getter (tracks deps), set via setter. */
export class Lens<T = any> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = 0;
  cachedValue: T | undefined = undefined;
  getter: () => T;
  setter: (v: T) => void;

  constructor(getter: () => T, setter: (v: T) => void) {
    this.getter = getter;
    this.setter = setter;
  }

  get value(): T {
    const flags = this.flags;
    if (
      flags & ReactiveFlags.Dirty ||
      (flags & ReactiveFlags.Pending &&
        (checkDirty(this.deps!, this) || ((this.flags = flags & ~ReactiveFlags.Pending), false)))
    ) {
      if (this._update()) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    } else if (!flags) {
      this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      try { this.cachedValue = this.getter(); }
      finally { activeSub = prev; this.flags &= ~ReactiveFlags.RecursedCheck; }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }

  set value(next: T) { this.setter(next); }

  peek(): T {
    const prev = activeSub;
    activeSub = undefined;
    try { return this.value; }
    finally { activeSub = prev; }
  }

  _update(): boolean {
    if (this.flags & HasChildEffect) {
      let l = this.depsTail;
      while (l !== undefined) {
        const prev = l.prevDep;
        const dep = l.dep;
        if (!(dep instanceof Computed) && !(dep instanceof Lens) && !(dep instanceof Signal)) unlink(l, this);
        l = prev;
      }
    }
    this.depsTail = undefined;
    this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
    const prev = activeSub;
    activeSub = this;
    try {
      ++cycle;
      const old = this.cachedValue;
      return old !== (this.cachedValue = this.getter());
    } finally {
      activeSub = prev;
      this.flags &= ~ReactiveFlags.RecursedCheck;
      purgeDeps(this);
    }
  }
}

// ── Factory helpers (parallel API surface) ────────────────────────

export function signal<T>(initial: T): Signal<T> { return new Signal(initial); }
export function computed<T>(getter: () => T): Computed<T> { return new Computed(getter); }
export function lens<T>(getter: () => T, setter: (v: T) => void): Lens<T> {
  return new Lens(getter, setter);
}

export function effect(fn: () => void | (() => void)): () => void {
  const e: EffectNode = {
    fn: fn as () => (() => void) | void,
    cleanup: undefined,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: ReactiveFlags.Watching | ReactiveFlags.RecursedCheck,
  };
  const prev = activeSub;
  activeSub = e;
  if (prev !== undefined) {
    link(e, prev, 0);
    prev.flags |= HasChildEffect;
  }
  try {
    ++runDepth;
    e.cleanup = e.fn();
  } finally {
    --runDepth;
    activeSub = prev;
    e.flags &= ~ReactiveFlags.RecursedCheck;
  }
  return function dispose() {
    e.flags = ReactiveFlags.None;
    disposeAllDepsInReverse(e);
    const sub = e.subs;
    if (sub !== undefined) unlink(sub);
    if (e.cleanup) runCleanup(e);
  };
}

export function batch<R>(fn: () => R): R {
  ++batchDepth;
  try { return fn(); }
  finally { if (!--batchDepth) flush(); }
}

// ── follow / mirror as class-friendly helpers ─────────────────────

/** One-way binding: target ← src. Returns dispose. */
export function follow<T>(target: Signal<T> | Lens<T>, src: Signal<T> | Computed<T> | Lens<T>): () => void {
  return effect(() => { target.value = src.value; });
}

/** Two-way binding. `a` wins at setup. Returns dispose. */
export function mirror<T>(a: Signal<T> | Lens<T>, b: Signal<T> | Lens<T>): () => void {
  let busy = false;
  const dA = effect(() => {
    const v = a.value;
    if (busy) return;
    busy = true; try { b.value = v; } finally { busy = false; }
  });
  const dB = effect(() => {
    const v = b.value;
    if (busy) return;
    busy = true; try { a.value = v; } finally { busy = false; }
  });
  return () => { dA(); dB(); };
}
