// Vendored from alien-signals v3.2.1 — MIT licensed.
// https://github.com/stackblitz/alien-signals
//
// Verbatim algorithm. Two upstream files merged into one, typed for
// minim. Nothing about the reactive-graph semantics is changed —
// glitch-freeness in diamond / triangle / nested-effect topologies
// is preserved. The only edits vs upstream:
//
//   1. The two upstream files (`system.ts`, `index.ts`) merged into
//      one for grep-ability.
//   2. TypeScript types added (vendored `.mjs` is plain JS).
//   3. `const enum ReactiveFlags` → `const ReactiveFlags = { ... } as const`
//      (const-enums aren't allowed under isolatedModules).
//   4. Inline-flag numeric literals where upstream used the same
//      literals (V8 const-folds either way; identical bytecode after
//      JIT). Named ReactiveFlags constants used at use-sites for
//      grep-ability and type safety.
//
// Public API preserved 1:1 with upstream:
//   signal, computed, effect, effectScope, trigger,
//   startBatch, endBatch, getActiveSub, setActiveSub, getBatchDepth,
//   isSignal, isComputed, isEffect, isEffectScope

// ── Reactive system ─────────────────────────────────────────────────

export interface ReactiveNode {
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

/** Flags on every ReactiveNode. Match upstream alien values exactly.
 *  Compared via bitwise ops; V8 inlines the field access. */
export const ReactiveFlags = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
} as const;

/** Flag for effect/effectScope nodes that own child effects — drives
 *  cleanup of child subscriptions on re-run. Internal to alien. */
const HasChildEffect = 64;

// Public algorithm — same signatures as upstream `createReactiveSystem`,
// inlined here to avoid the extra module hop.
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

// ── Engine state ────────────────────────────────────────────────────

interface EffectScopeNode extends ReactiveNode {}

interface EffectNode extends ReactiveNode {
  fn(): (() => void) | void;
  cleanup: (() => void) | void;
}

interface ComputedNode<T = unknown> extends ReactiveNode {
  value: T | undefined;
  getter: (previousValue?: T) => T;
}

interface SignalNode<T = unknown> extends ReactiveNode {
  currentValue: T;
  pendingValue: T;
}

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
const queued: (EffectNode | undefined)[] = [];

const { link, unlink, propagate, checkDirty, shallowPropagate } = makeSystem(
  // update
  (node) => {
    if ("getter" in node) return updateComputed(node as ComputedNode);
    if ("currentValue" in node) {
      const s = node as SignalNode;
      s.flags = ReactiveFlags.Mutable;
      return s.currentValue !== (s.currentValue = s.pendingValue);
    }
    node.flags = ReactiveFlags.Mutable;
    return true;
  },
  // notify — schedule effect in queue, hoisting parent effect-scope subs
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
  // unwatched — drop a node when its last subscriber leaves
  (node) => {
    if ("getter" in node) {
      if (node.depsTail !== undefined) {
        node.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
        disposeAllDepsInReverse(node);
      }
    } else if ("currentValue" in node) {
      // signal — keep as-is, no children to dispose
    } else if ("fn" in node) {
      effectOper.call(node as EffectNode);
    } else {
      effectScopeOper.call(node as EffectScopeNode);
    }
  },
);

// ── Public API ──────────────────────────────────────────────────────

/** Public signal handle. Overloaded so `s()` is typed `T` (read) and
 *  `s(v)` is typed `void` (write) — TypeScript dispatches on argc. */
export interface SignalFn<T> {
  (): T;
  (value: T): void;
  readonly __t?: T;
}

export function getActiveSub(): ReactiveNode | undefined {
  return activeSub;
}

export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
  const prev = activeSub;
  activeSub = sub;
  return prev;
}

export function getBatchDepth(): number { return batchDepth; }

export function startBatch(): void { ++batchDepth; }

export function endBatch(): void { if (!--batchDepth) flush(); }

export function isSignal(fn: () => void): boolean {
  return fn.name === "bound " + signalOper.name;
}

export function isComputed(fn: () => void): boolean {
  return fn.name === "bound " + computedOper.name;
}

export function isEffect(fn: () => void): boolean {
  return fn.name === "bound " + effectOper.name;
}

export function isEffectScope(fn: () => void): boolean {
  return fn.name === "bound " + effectScopeOper.name;
}

export function signal<T>(initialValue: T): SignalFn<T> {
  return signalOper.bind({
    currentValue: initialValue,
    pendingValue: initialValue,
    subs: undefined,
    subsTail: undefined,
    flags: ReactiveFlags.Mutable,
  } as SignalNode<T>) as unknown as SignalFn<T>;
}

export function computed<T>(getter: (previousValue?: T) => T): SignalFn<T> {
  const node = {
    value: undefined,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: 0,
    getter: getter as (previousValue?: unknown) => unknown,
  } as ComputedNode<T>;
  return computedOper.bind(node as ComputedNode<unknown>) as unknown as SignalFn<T>;
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
  const prev = setActiveSub(e);
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
  return effectOper.bind(e);
}

export function effectScope(fn: () => void): () => void {
  const e: EffectScopeNode = {
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    flags: ReactiveFlags.Mutable,
  };
  const prev = setActiveSub(e);
  if (prev !== undefined) {
    link(e, prev, 0);
    prev.flags |= HasChildEffect;
  }
  try { fn(); } finally { activeSub = prev; }
  return effectScopeOper.bind(e);
}

export function trigger(fn: () => void): void {
  const sub: ReactiveNode = {
    deps: undefined, depsTail: undefined, flags: ReactiveFlags.Watching,
  };
  const prev = setActiveSub(sub);
  try { fn(); }
  finally {
    activeSub = prev;
    sub.flags = ReactiveFlags.None;
    let l = sub.deps;
    while (l !== undefined) {
      const dep = l.dep;
      l = unlink(l, sub);
      const subs = dep.subs;
      if (subs !== undefined) {
        propagate(subs, !!runDepth);
        shallowPropagate(subs);
      }
    }
    if (!batchDepth) flush();
  }
}

// ── Internals ───────────────────────────────────────────────────────

function updateComputed<T>(c: ComputedNode<T>): boolean {
  if (c.flags & HasChildEffect) {
    let l = c.depsTail;
    while (l !== undefined) {
      const prev = l.prevDep;
      const dep = l.dep;
      if (!("getter" in dep) && !("currentValue" in dep)) unlink(l, c);
      l = prev;
    }
  }
  c.depsTail = undefined;
  c.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
  const prev = setActiveSub(c);
  try {
    ++cycle;
    const oldValue = c.value;
    return oldValue !== (c.value = c.getter(oldValue));
  } finally {
    activeSub = prev;
    c.flags &= ~ReactiveFlags.RecursedCheck;
    purgeDeps(c);
  }
}

function run(e: EffectNode): void {
  const flags = e.flags;
  if (flags & ReactiveFlags.Dirty || (flags & ReactiveFlags.Pending && checkDirty(e.deps!, e))) {
    if (flags & HasChildEffect) {
      let l = e.depsTail;
      while (l !== undefined) {
        const prev = l.prevDep;
        const dep = l.dep;
        if (!("getter" in dep) && !("currentValue" in dep)) unlink(l, e);
        l = prev;
      }
    }
    if (e.cleanup) {
      runCleanup(e);
      if (!e.flags) return;
    }
    e.depsTail = undefined;
    e.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
    const prev = setActiveSub(e);
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

function flush(): void {
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]!;
      queued[notifyIndex++] = undefined;
      run(e);
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

function computedOper<T>(this: ComputedNode<T>): T {
  const flags = this.flags;
  if (
    flags & ReactiveFlags.Dirty ||
    (flags & ReactiveFlags.Pending &&
      (checkDirty(this.deps!, this) || ((this.flags = flags & ~ReactiveFlags.Pending), false)))
  ) {
    if (updateComputed(this)) {
      const subs = this.subs;
      if (subs !== undefined) shallowPropagate(subs);
    }
  } else if (!flags) {
    this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
    const prev = setActiveSub(this);
    try { this.value = this.getter(); }
    finally { activeSub = prev; this.flags &= ~ReactiveFlags.RecursedCheck; }
  }
  const sub = activeSub;
  if (sub !== undefined) link(this, sub, cycle);
  return this.value!;
}

function signalOper<T>(this: SignalNode<T>, ...value: T[]): T | void {
  if (value.length) {
    if (this.pendingValue !== (this.pendingValue = value[0])) {
      this.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
      const subs = this.subs;
      if (subs !== undefined) {
        propagate(subs, !!runDepth);
        if (!batchDepth) flush();
      }
    }
  } else {
    if (this.flags & ReactiveFlags.Dirty) {
      this.flags = ReactiveFlags.Mutable;
      if (this.currentValue !== (this.currentValue = this.pendingValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    const sub = activeSub;
    if (sub !== undefined) link(this, sub, cycle);
    return this.currentValue;
  }
}

function runCleanup(e: EffectNode): void {
  const cleanup = e.cleanup!;
  e.cleanup = undefined;
  const prev = activeSub;
  activeSub = undefined;
  try { cleanup(); } finally { activeSub = prev; }
}

function effectOper(this: EffectNode): void {
  effectScopeOper.call(this);
  if (this.cleanup) runCleanup(this);
}

function effectScopeOper(this: EffectScopeNode): void {
  this.flags = ReactiveFlags.None;
  disposeAllDepsInReverse(this);
  const sub = this.subs;
  if (sub !== undefined) unlink(sub);
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
