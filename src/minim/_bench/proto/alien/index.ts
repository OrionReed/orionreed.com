// Vendored from alien-signals v3.2.1 — MIT licensed.
// https://github.com/stackblitz/alien-signals
//
// The public surface: `signal`, `computed`, `effect`, `effectScope`,
// `startBatch`/`endBatch`, `trigger`, plus `setActiveSub` for opting
// out of dependency tracking.
//
// The user-facing primitive is a callable function. `s()` reads, `s(v)`
// writes (no return). The dependency-graph node lives in the bound
// `this` of the closure — no allocation per call.

import { createReactiveSystem, type ReactiveNode } from "./system";

const HasChildEffect = 64;

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

const { link, unlink, propagate, checkDirty, shallowPropagate } =
  createReactiveSystem({
    update(node: ReactiveNode): boolean {
      if ("getter" in node) return updateComputed(node as ComputedNode);
      if ("currentValue" in node) return updateSignal(node as SignalNode);
      node.flags = 1;
      return true;
    },
    notify(effect: ReactiveNode) {
      let e = effect as EffectNode;
      let insertIndex = queuedLength;
      const firstInsertedIndex = insertIndex;
      do {
        queued[insertIndex++] = e;
        e.flags &= ~2;
        const next = (e.subs?.sub as EffectNode | undefined);
        if (next === undefined || !(next.flags & 2)) break;
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
    unwatched(node: ReactiveNode) {
      if ("getter" in node) {
        if (node.depsTail !== undefined) {
          node.flags = 1 | 16;
          disposeAllDepsInReverse(node);
        }
      } else if ("currentValue" in node) {
        // signal — keep as-is
      } else if ("fn" in node) {
        effectOper.call(node as EffectNode);
      } else {
        effectScopeOper.call(node as EffectScopeNode);
      }
    },
  });

export function getActiveSub(): ReactiveNode | undefined {
  return activeSub;
}

export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
  const prev = activeSub;
  activeSub = sub;
  return prev;
}

export function getBatchDepth(): number {
  return batchDepth;
}

export function startBatch(): void {
  ++batchDepth;
}

export function endBatch(): void {
  if (!--batchDepth) flush();
}

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

export interface SignalFn<T> {
  (): T;
  (value: T): void;
}

export function signal<T>(): SignalFn<T | undefined>;
export function signal<T>(initialValue: T): SignalFn<T>;
export function signal<T>(initialValue?: T): SignalFn<T> {
  return signalOper.bind({
    currentValue: initialValue,
    pendingValue: initialValue,
    subs: undefined,
    subsTail: undefined,
    flags: 1,
  } as SignalNode<T | undefined>) as unknown as SignalFn<T>;
}

export function computed<T>(getter: (previousValue?: T) => T): () => T {
  const node = {
    value: undefined,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: 0,
    getter: getter as (previousValue?: unknown) => unknown,
  } as ComputedNode<T>;
  return computedOper.bind(node as ComputedNode<unknown>) as unknown as () => T;
}

export function effect(fn: () => void | (() => void)): () => void {
  const e: EffectNode = {
    fn: fn as () => (() => void) | void,
    cleanup: undefined,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: 2 | 4,
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
    e.flags &= ~4;
  }
  return effectOper.bind(e);
}

export function effectScope(fn: () => void): () => void {
  const e: EffectScopeNode = {
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    flags: 1,
  };
  const prev = setActiveSub(e);
  if (prev !== undefined) {
    link(e, prev, 0);
    prev.flags |= HasChildEffect;
  }
  try {
    fn();
  } finally {
    activeSub = prev;
  }
  return effectScopeOper.bind(e);
}

export function trigger(fn: () => void): void {
  const sub: ReactiveNode = {
    deps: undefined, depsTail: undefined, flags: 2,
  };
  const prev = setActiveSub(sub);
  try {
    fn();
  } finally {
    activeSub = prev;
    sub.flags = 0;
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
  c.flags = 1 | 4;
  const prev = setActiveSub(c);
  try {
    ++cycle;
    const oldValue = c.value;
    return oldValue !== (c.value = c.getter(oldValue));
  } finally {
    activeSub = prev;
    c.flags &= ~4;
    purgeDeps(c);
  }
}

function updateSignal<T>(s: SignalNode<T>): boolean {
  s.flags = 1;
  return s.currentValue !== (s.currentValue = s.pendingValue);
}

function run(e: EffectNode): void {
  const flags = e.flags;
  if (flags & 16 || (flags & 32 && checkDirty(e.deps!, e))) {
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
    e.flags = 2 | 4;
    const prev = setActiveSub(e);
    try {
      ++cycle;
      ++runDepth;
      e.cleanup = e.fn();
    } finally {
      --runDepth;
      activeSub = prev;
      e.flags &= ~4;
      purgeDeps(e);
    }
  } else if (e.deps !== undefined) {
    e.flags = 2 | (flags & HasChildEffect);
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
      e.flags |= 2 | 8;
    }
    notifyIndex = 0;
    queuedLength = 0;
  }
}

function computedOper<T>(this: ComputedNode<T>): T {
  const flags = this.flags;
  if (
    flags & 16 ||
    (flags & 32 &&
      (checkDirty(this.deps!, this) || ((this.flags = flags & ~32), false)))
  ) {
    if (updateComputed(this)) {
      const subs = this.subs;
      if (subs !== undefined) shallowPropagate(subs);
    }
  } else if (!flags) {
    this.flags = 1 | 4;
    const prev = setActiveSub(this);
    try {
      this.value = this.getter();
    } finally {
      activeSub = prev;
      this.flags &= ~4;
    }
  }
  const sub = activeSub;
  if (sub !== undefined) link(this, sub, cycle);
  return this.value!;
}

function signalOper<T>(this: SignalNode<T>, ...value: T[]): T | void {
  if (value.length) {
    if (this.pendingValue !== (this.pendingValue = value[0])) {
      this.flags = 1 | 16;
      const subs = this.subs;
      if (subs !== undefined) {
        propagate(subs, !!runDepth);
        if (!batchDepth) flush();
      }
    }
  } else {
    if (this.flags & 16) {
      if (updateSignal(this)) {
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
  try {
    cleanup();
  } finally {
    activeSub = prev;
  }
}

function effectOper(this: EffectNode): void {
  effectScopeOper.call(this);
  if (this.cleanup) runCleanup(this);
}

function effectScopeOper(this: EffectScopeNode): void {
  this.flags = 0;
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

/** Used to access the SignalNode/ComputedNode behind a bound signal/computed —
 *  needed for "Cell IS the callable" experiments where we want to bypass
 *  the normal call dispatch and read currentValue directly. */
export function nodeOf<T>(fn: () => T): ReactiveNode {
  // The bound `this` of a signal/computed is the node. JS doesn't expose
  // it directly; we cheat via the function's prototype-free closure
  // lookup. NOT public alien API — only used by minim's internals.
  return (fn as { __node?: ReactiveNode }).__node ?? (fn as never);
}
