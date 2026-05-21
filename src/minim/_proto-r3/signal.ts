// signal.ts — three concrete primitives + Effect + factories.
//
// `Signal<T>` (writable source), `Computed<T>` (read-only derived),
// `Lens<T>` (writable derived). All three extend `Node<T>` from
// `./node` and share the engine plumbing imported from there.
//
// No mode flags, no `if (this.getter !== undefined)` branches in hot
// accessors. Each class has monomorphic value/peek/_update.
//
// Construction patterns:
//   - `signal(initial, opts?)`       → Signal<T>
//   - `computed(getter, opts?)`      → Computed<T>
//   - `lens(get, set, opts?)`        → Lens<T>
//   - `new Vec(initial, opts?)`      → typed VecSignal (signal-mode)
//   - `Vec.lens(get, set, opts?)`    → typed VecLens (writable derived)
//   - `Vec.derive(fn, opts?)`        → typed VecComputed (read-only derived)

import {
  Node, F, type Link, type EffectLike, type Val, type NodeOptions,
  type Read, type Of,
  link, propagate, checkDirty, shallowPropagate, flush, purgeDeps,
  disposeAllDepsInReverse, enqueueEffect, startFlushIfNeeded,
  activeSub, setActiveSub, cycle, incCycle, incRunDepth, decRunDepth,
  incBatchDepth, decBatchDepth, fireWriteHook, batchDepth,
  valueOf,
} from "./node";

export {
  Node, type Read, type Of, type Val, type NodeOptions,
};

// ─── Signal — writable source ───────────────────────────────────────

export class Signal<T = unknown> extends Node<T> {
  currentValue: T;
  pendingValue: T;

  constructor(initial: T, opts?: NodeOptions<T>) {
    super();
    this.currentValue = initial;
    this.pendingValue = initial;
    this._initEquals(opts);
    this._initHooks(opts);
  }

  get value(): T {
    if (this.flags & F.Dirty) {
      this.flags = F.Mutable;
      if (this.currentValue !== (this.currentValue = this.pendingValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.currentValue;
  }

  set value(next: T) {
    const prev = this.pendingValue;
    this.pendingValue = next;
    const equals = this._equals;
    const same = equals ? equals(prev, next) : prev === next;
    if (!same) {
      this.flags = F.Mutable | F.Dirty;
      fireWriteHook(this as Node<unknown>);
      const subs = this.subs;
      if (subs !== undefined) {
        propagate(subs, /* innerWrite */ false);
        startFlushIfNeeded();
      }
    }
  }

  peek(): T {
    if (this.flags & F.Dirty) {
      this.flags = F.Mutable;
      if (this.currentValue !== (this.currentValue = this.pendingValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    return this.currentValue;
  }

  /** One-shot write of `valueOf(v)`. Severs any prior `.bind(...)`. */
  set(v: Val<T>): this {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined }
    this.value = valueOf(v);
    return this;
  }

  bind(source: Val<T>): () => void {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined }
    if (source instanceof Node || typeof source === "function") {
      const stop = effect(() => { this.value = valueOf(source) });
      this._stopBinding = stop;
      return stop;
    }
    this.value = source as T;
    return () => {};
  }

  _update(): boolean {
    this.flags = F.Mutable;
    return this.currentValue !== (this.currentValue = this.pendingValue);
  }
}

// ─── Computed — read-only derived ───────────────────────────────────

export class Computed<T = unknown> extends Node<T> {
  cachedValue: T | undefined = undefined;
  getter: () => T;

  constructor(getter: () => T, opts?: NodeOptions<T>) {
    super();
    this.getter = getter;
    this.flags = 0;  // lazy-init: first read computes
    this._initEquals(opts);
    this._initHooks(opts);
  }

  get value(): T {
    const flags = this.flags;
    if (flags & F.RecursedCheck) {
      throw new RangeError(
        `Cyclic computed: ${(this.constructor as { name?: string }).name ?? "?"} read its own value`,
      );
    }
    if (
      flags & F.Dirty ||
      (flags & F.Pending &&
        (checkDirty(this.deps!, this) ||
          ((this.flags = flags & ~F.Pending), false)))
    ) {
      if (this._update()) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    } else if (!flags) {
      this.flags = F.Mutable | F.RecursedCheck;
      const prev = activeSub;
      setActiveSub(this);
      let threw = true;
      try {
        this.cachedValue = this.getter();
        threw = false;
      } finally {
        setActiveSub(prev);
        this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }

  // Writable surface intentionally absent — set value inherits the
  // throwing setter from Node.

  peek(): T {
    const prev = activeSub;
    setActiveSub(undefined);
    try { return this.value } finally { setActiveSub(prev) }
  }

  _update(): boolean {
    this.depsTail = undefined;
    this.flags = F.Mutable | F.RecursedCheck;
    const prev = activeSub;
    setActiveSub(this);
    let threw = true;
    try {
      incCycle();
      const old = this.cachedValue;
      const next = (this.cachedValue = this.getter());
      threw = false;
      const eq = this._equals;
      return eq ? !eq(old as T, next) : old !== next;
    } finally {
      setActiveSub(prev);
      this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
      purgeDeps(this);
    }
  }

  _unwatched(): void {
    if (this.depsTail !== undefined) {
      this.flags = F.Mutable | F.Dirty;
      disposeAllDepsInReverse(this);
      return;
    }
    super._unwatched();
  }
}

// ─── Lens — writable derived ────────────────────────────────────────

export class Lens<T = unknown> extends Node<T> {
  cachedValue: T | undefined = undefined;
  getter: () => T;
  setter: (v: T) => void;

  constructor(getter: () => T, setter: (v: T) => void, opts?: NodeOptions<T>) {
    super();
    this.getter = getter;
    this.setter = setter;
    this.flags = 0;
    this._initEquals(opts);
    this._initHooks(opts);
  }

  get value(): T {
    const flags = this.flags;
    if (flags & F.RecursedCheck) {
      throw new RangeError(
        `Cyclic lens: ${(this.constructor as { name?: string }).name ?? "?"} read its own value`,
      );
    }
    if (
      flags & F.Dirty ||
      (flags & F.Pending &&
        (checkDirty(this.deps!, this) ||
          ((this.flags = flags & ~F.Pending), false)))
    ) {
      if (this._update()) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    } else if (!flags) {
      this.flags = F.Mutable | F.RecursedCheck;
      const prev = activeSub;
      setActiveSub(this);
      let threw = true;
      try {
        this.cachedValue = this.getter();
        threw = false;
      } finally {
        setActiveSub(prev);
        this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }

  set value(next: T) { this.setter(next) }

  peek(): T {
    const prev = activeSub;
    setActiveSub(undefined);
    try { return this.value } finally { setActiveSub(prev) }
  }

  set(v: Val<T>): this {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined }
    this.value = valueOf(v);
    return this;
  }

  bind(source: Val<T>): () => void {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined }
    if (source instanceof Node || typeof source === "function") {
      const stop = effect(() => { this.value = valueOf(source) });
      this._stopBinding = stop;
      return stop;
    }
    this.value = source as T;
    return () => {};
  }

  _update(): boolean {
    this.depsTail = undefined;
    this.flags = F.Mutable | F.RecursedCheck;
    const prev = activeSub;
    setActiveSub(this);
    let threw = true;
    try {
      incCycle();
      const old = this.cachedValue;
      const next = (this.cachedValue = this.getter());
      threw = false;
      const eq = this._equals;
      return eq ? !eq(old as T, next) : old !== next;
    } finally {
      setActiveSub(prev);
      this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
      purgeDeps(this);
    }
  }

  _unwatched(): void {
    if (this.depsTail !== undefined) {
      this.flags = F.Mutable | F.Dirty;
      disposeAllDepsInReverse(this);
      return;
    }
    super._unwatched();
  }
}

// ─── Effect ─────────────────────────────────────────────────────────

class Effect implements EffectLike {
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
    setActiveSub(this);
    try {
      incRunDepth();
      const ret = fn();
      this.cleanup = typeof ret === "function" ? ret : undefined;
    } finally {
      decRunDepth();
      setActiveSub(prev);
      this.flags &= ~F.RecursedCheck;
    }
  }

  _update(): boolean { this.flags = F.Mutable; return true }

  _notify(): void {
    let e: Effect = this;
    let insertIndex = enqueueEffect(e) - 1;
    const firstInsertedIndex = insertIndex;
    e.flags &= ~F.Watching;
    while (true) {
      const next = e.subs?.sub as Effect | undefined;
      if (next === undefined || !(next.flags & F.Watching)) break;
      e = next;
      insertIndex = enqueueEffect(e) - 1;
      e.flags &= ~F.Watching;
    }
    // reverse the inserted range so outer effects run before inner
    let idx = insertIndex + 1, firstIdx = firstInsertedIndex;
    while (firstIdx < --idx) {
      const leftIdx = firstIdx;
      // swap via getters/setters on the queue
      // (we don't import queued directly; use a tiny helper)
      _swapQueued(leftIdx, idx);
      firstIdx++;
    }
  }

  _unwatched(): void {
    this.flags = F.None;
    disposeAllDepsInReverse(this);
    const sub = this.subs;
    if (sub !== undefined) {
      // unlink from node module
      // (we don't currently use this path for effects subscribed to)
    }
    if (this.cleanup) this._runCleanup();
  }

  _run(): void {
    const flags = this.flags;
    if (flags & F.Dirty || (flags & F.Pending && checkDirty(this.deps!, this))) {
      if (this.cleanup) { this._runCleanup(); if (!this.flags) return }
      this.depsTail = undefined;
      this.flags = F.Watching | F.RecursedCheck;
      const prev = activeSub;
      setActiveSub(this);
      try {
        incCycle();
        incRunDepth();
        const ret = this.fn();
        this.cleanup = typeof ret === "function" ? ret : undefined;
      } finally {
        decRunDepth();
        setActiveSub(prev);
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
    setActiveSub(undefined);
    try { c() } finally { setActiveSub(prev) }
  }
}

import { queued } from "./node";
function _swapQueued(i: number, j: number): void {
  const a = queued[i];
  queued[i] = queued[j];
  queued[j] = a;
}

// ─── Type predicates ────────────────────────────────────────────────

export const isNode     = (v: unknown): v is Node<unknown>     => v instanceof Node;
export const isSignal   = (v: unknown): v is Signal<unknown>   => v instanceof Signal;
export const isComputed = (v: unknown): v is Computed<unknown> => v instanceof Computed;
export const isLens     = (v: unknown): v is Lens<unknown>     => v instanceof Lens;

// ─── Factories ──────────────────────────────────────────────────────

/** Writable source. */
export function signal<T>(initial: T, opts?: NodeOptions<T>): Signal<T> {
  return new Signal(initial, opts);
}

/** Read-only derived. */
export function computed<T>(getter: () => T, opts?: NodeOptions<T>): Computed<T> {
  return new Computed(getter, opts);
}

/** Writable derived (custom getter + setter). */
export function lens<T>(
  getter: () => T,
  setter: (v: T) => void,
  opts?: NodeOptions<T>,
): Lens<T> {
  return new Lens(getter, setter, opts);
}

export function effect(fn: () => void | (() => void)): () => void {
  const e = new Effect(fn);
  return () => e._unwatched();
}

export function batch<R>(fn: () => R): R {
  incBatchDepth();
  try { return fn() } finally { if (batchDepth - 1 === 0) flush(); decBatchDepth() }
}

export function untracked<R>(fn: () => R): R {
  const prev = activeSub;
  setActiveSub(undefined);
  try { return fn() } finally { setActiveSub(prev) }
}

export { valueOf as value };
