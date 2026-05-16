// _alien_starter.ts — verbatim port of johnsoncodehk/alien-signals-starter
// (https://github.com/johnsoncodehk/alien-signals-starter/blob/master/index.ts)
// using OUR engine.ts's createReactiveSystem so the underlying algorithm is
// identical to bare alien (engine.ts) and to our class-based signals.ts.
//
// Lets us A/B test: with the algorithm fixed, what does the canonical
// class-based wrapper look like, vs. our `signals.ts`?

import { createReactiveSystem, ReactiveFlags, type ReactiveNode, type Link } from "./engine";

const { link, unlink, propagate, checkDirty, shallowPropagate } = createReactiveSystem(
  (n) => (n as any).update(),
  (e) => { queue.push(e as Effect); },
  () => {},
);

let cycle = 0;
let batchDepth = 0;
let activeSub: ReactiveNode | undefined;
const queue: Effect[] = [];

export function startBatch(): void { ++batchDepth; }
export function endBatch(): void { if (--batchDepth === 0) flush(); }
export function batch<R>(fn: () => R): R {
  startBatch();
  try { return fn(); } finally { endBatch(); }
}

function flush() {
  while (queue.length > 0) queue.shift()!.run();
}

function shouldUpdate(sub: ReactiveNode): boolean {
  const flags = sub.flags;
  if (flags & ReactiveFlags.Dirty) return true;
  if (flags & ReactiveFlags.Pending) {
    if (checkDirty(sub.deps!, sub)) return true;
    sub.flags = flags & ~ReactiveFlags.Pending;
  }
  return false;
}

export class Signal<T = any> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  flags: number = ReactiveFlags.Mutable;
  value: T;
  pendingValue: T;
  constructor(value: T) { this.pendingValue = this.value = value; }

  get(): T {
    if (shouldUpdate(this) && this.update()) {
      const subs = this.subs;
      if (subs !== undefined) shallowPropagate(subs);
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.value;
  }

  set(value: T): void {
    this.pendingValue = value;
    this.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
    const subs = this.subs;
    if (subs !== undefined) {
      propagate(subs, false);
      if (batchDepth === 0) flush();
    }
  }

  update(): boolean {
    this.flags = ReactiveFlags.Mutable;
    return this.value !== (this.value = this.pendingValue);
  }
}

export class Computed<T = any> implements ReactiveNode {
  value: T | undefined = undefined;
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
  constructor(public getter: () => T) {}

  get(): T {
    if (shouldUpdate(this) && this.update()) {
      const subs = this.subs;
      if (subs !== undefined) shallowPropagate(subs);
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.value!;
  }

  update(): boolean {
    ++cycle;
    this.depsTail = undefined;
    this.flags = ReactiveFlags.Mutable | (32 /* RecursedCheck */);
    const prev = activeSub;
    activeSub = this;
    try {
      return this.value !== (this.value = this.getter());
    } finally {
      activeSub = prev;
      this.flags &= ~32;
      let toRemove = this.depsTail !== undefined ? (this.depsTail as Link).nextDep : this.deps;
      while (toRemove !== undefined) toRemove = unlink(toRemove, this);
    }
  }
}

export class Effect<T = any> implements ReactiveNode {
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = ReactiveFlags.Watching;
  constructor(public fn: () => T) {}

  run(): T {
    ++cycle;
    this.depsTail = undefined;
    this.flags = ReactiveFlags.Watching | 32;
    const prev = activeSub;
    activeSub = this;
    try { return this.fn(); }
    finally {
      activeSub = prev;
      this.flags &= ~32;
      let toRemove = this.depsTail !== undefined ? (this.depsTail as Link).nextDep : this.deps;
      while (toRemove !== undefined) toRemove = unlink(toRemove, this);
    }
  }

  stop(): void {
    let dep = this.deps;
    while (dep !== undefined) dep = unlink(dep, this);
  }
}

export function signal<T>(v: T): Signal<T> { return new Signal(v); }
export function computed<T>(fn: () => T): Computed<T> { return new Computed(fn); }
export function effect<T>(fn: () => T): Effect<T> {
  const e = new Effect(fn);
  e.run();
  return e;
}
