// signal.ts — minim's reactive engine.
//
// Hierarchy: Signal → Computed (Lens = Computed with setter).
// Algorithm is alien-signals; trait dispatch via `./traits`.

import { EQUALS, type Equals } from "./traits";

// ════════════════════════════════════════════════════════════════════
// alien-signals types
// ════════════════════════════════════════════════════════════════════

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

interface Stack<T> { value: T; prev: Stack<T> | undefined }

const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
  HasChildEffect: 64,
} as const;

const noop = () => {};

// ── Engine state ────────────────────────────────────────────────────

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
const queued: (Effect | undefined)[] = [];

// ── Algorithm ──────────────────────────────────────────────────────

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
  const newLink: Link = (sub.depsTail = dep.subsTail = {
    version, dep, sub, prevDep, nextDep, prevSub, nextSub: undefined,
  });
  if (nextDep !== undefined) nextDep.prevDep = newLink;
  if (prevDep !== undefined) prevDep.nextDep = newLink;
  else sub.deps = newLink;
  if (prevSub !== undefined) prevSub.nextSub = newLink;
  else dep.subs = newLink;
  // First subscriber: fire `watched` hook if declared.
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
        if (nextSub !== undefined) { stack = { value: next, prev: stack }; next = nextSub; }
        continue;
      }
    }
    if ((l = next!) !== undefined) { next = l.nextSub; continue; }
    while (stack !== undefined) {
      l = stack.value; stack = stack.prev;
      if (l !== undefined) { next = l.nextSub; continue top; }
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
      stack = { value: l, prev: stack }; l = dep.deps!; sub = dep; ++checkDepth; continue;
    }
    if (!dirty) {
      const nextDep = l.nextDep;
      if (nextDep !== undefined) { l = nextDep; continue; }
    }
    while (checkDepth--) {
      l = stack!.value; stack = stack!.prev;
      if (dirty) {
        const subs = sub.subs!;
        if (sub._update()) {
          if (subs.nextSub !== undefined) shallowPropagate(subs);
          sub = l.sub; continue;
        }
        dirty = false;
      } else {
        sub.flags &= ~F.Pending;
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
    if ((flags & (F.Pending | F.Dirty)) === F.Pending) {
      sub.flags = flags | F.Dirty;
      if ((flags & (F.Watching | F.RecursedCheck)) === F.Watching) sub._notify();
    }
  } while ((l = l.nextSub!) !== undefined);
}

function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
  let l = sub.depsTail;
  while (l !== undefined) { if (l === checkLink) return true; l = l.prevDep; }
  return false;
}

function flush(): void {
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
  }
}

function purgeDeps(sub: ReactiveNode): void {
  const depsTail = sub.depsTail;
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
  while (dep !== undefined) dep = unlink(dep, sub);
}

function disposeAllDepsInReverse(sub: ReactiveNode): void {
  let l = sub.depsTail;
  while (l !== undefined) { const prev = l.prevDep; unlink(l, sub); l = prev; }
}

function unlinkChildEffects(node: ReactiveNode): void {
  let l = node.depsTail;
  while (l !== undefined) {
    const prev = l.prevDep;
    if (l.dep instanceof Effect) unlink(l, node);
    l = prev;
  }
}

// ════════════════════════════════════════════════════════════════════
// Val<T> — "anything that yields a T"
// ════════════════════════════════════════════════════════════════════

/** Plain T, thunk `() => T`, or any read-shape (Signal/Computed/…).
 *  Reactive forms are typed via the covariant `Read<T>` view so a
 *  concrete `Signal<number>` flows into `Val<string | number>`, etc.
 *  Branded nominally via `instanceof Signal` at runtime so plain
 *  objects with `.value` aren't mistaken for cells. */
export type Val<T> = T | (() => T) | Read<T>;

/** Covariant read-only signal surface. Anything with `value: T` +
 *  `peek(): T`. Used at *parameter* sites where Signal's invariance
 *  would block subclass-T cells; runtime checks still go through
 *  `v instanceof Signal`. */
export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

/** Unwrap to T. Reactive forms auto-track inside an effect/computed body. */
export function value<T>(v: Val<T>): T {
  if (v instanceof Signal) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}

export const isSignal = (v: unknown): v is Signal<unknown> => v instanceof Signal;

// ════════════════════════════════════════════════════════════════════
// SignalOptions
// ════════════════════════════════════════════════════════════════════

export interface SignalOptions<T = unknown> {
  /** First subscriber attached. */
  watched?: () => void;
  /** Last subscriber detached. */
  unwatched?: () => void;
  /** Per-instance equality. Stamps `[EQUALS]` shadowing the class slot.
   *  Falls back to `===` if no slot is declared. */
  equals?: Equals<T>;
}

// ════════════════════════════════════════════════════════════════════
// Signal — writable reactive value, base class
// ════════════════════════════════════════════════════════════════════

/** Writable signal. Bind reactively via `.bind(source: Val<T>)`. */
export class Signal<T = unknown> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Mutable;
  currentValue: T;
  pendingValue: T;
  _watched?: () => void;
  _unwatchedHook?: () => void;
  /** Disposer for the most recent `.bind(reactive)`. */
  protected _stopBinding?: () => void;

  constructor(initial: T, opts?: SignalOptions<T>) {
    if (opts) {
      if (opts.watched) this._watched = opts.watched;
      if (opts.unwatched) this._unwatchedHook = opts.unwatched;
      // Stamp own-property [EQUALS], shadowing any class-level slot.
      if (opts.equals) (this as unknown as { [EQUALS]?: Equals<T> })[EQUALS] = opts.equals;
    }
    this.currentValue = initial;
    this.pendingValue = initial;
  }

  /** Read with tracking. */
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

  /** Plain write. */
  set value(next: T) {
    const prev = this.pendingValue;
    this.pendingValue = next;
    const equals = this[EQUALS];
    const same = equals ? equals(prev, next) : prev === next;
    if (!same) {
      this.flags = F.Mutable | F.Dirty;
      const subs = this.subs;
      if (subs !== undefined) {
        propagate(subs, !!runDepth);
        if (!batchDepth) flush();
      }
    }
  }

  /** Untracked read; honors Dirty flag. */
  peek(): T {
    if (this.flags & F.Dirty) {
      this.flags = F.Mutable;
      this.currentValue = this.pendingValue;
    }
    return this.currentValue;
  }

  /** One-shot write of `value(v)`. Severs any prior `.bind(...)`. Chainable. */
  set(v: Val<T>): this {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined; }
    this.value = value(v);
    return this;
  }

  /** Bind to a `Val<T>`; each call REPLACES any prior binding.
   *
   *    sig.bind(5)              one-shot write of 5
   *    sig.bind(otherSig)       follows otherSig.value
   *    sig.bind(() => x.value)  follows tracked deps of the thunk
   *
   *  Returns a dispose fn (no-op for plain T). To unbind without setting
   *  a value: keep the dispose fn from a prior bind, or `sig.bind(sig.peek())`. */
  bind(source: Val<T>): () => void {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined; }
    if (source instanceof Signal || typeof source === "function") {
      const stop = effect(() => { this.value = value(source); });
      this._stopBinding = stop;
      return stop;
    }
    this.value = source as T;
    return noop;
  }

  _update(): boolean {
    this.flags = F.Mutable;
    return this.currentValue !== (this.currentValue = this.pendingValue);
  }
  _notify(): void {}
  _unwatched(): void {
    if (this._unwatchedHook !== undefined) this._unwatchedHook();
  }

  /** Footgun guard: `${sig}` / `sig + 1` / `Boolean(sig)` throw instead
   *  of silently coercing. `sig === otherSig` (identity) still works. */
  [Symbol.toPrimitive](hint: string): never {
    throw new TypeError(`Signal cannot be coerced to ${hint} — use \`.value\``);
  }
}

// ════════════════════════════════════════════════════════════════════
// Computed — derived signal (read-only, or writable view if setter set)
// ════════════════════════════════════════════════════════════════════

export class Computed<T = unknown> extends Signal<T> {
  cachedValue: T | undefined = undefined;
  getter: () => T;
  /** Lens-mode iff set; otherwise writes throw. */
  setter?: (v: T) => void;

  constructor(getter: () => T, setter?: (v: T) => void) {
    super(undefined as T);
    this.getter = getter;
    if (setter !== undefined) this.setter = setter;
    this.flags = 0;
  }

  override get value(): T {
    const flags = this.flags;
    // RecursedCheck is set only during this computed's own sync eval.
    // Hitting it on a read means the getter is reading its own value.
    if (flags & F.RecursedCheck) {
      throw new RangeError(`Cyclic computed: ${(this.constructor as { name?: string }).name ?? "?"} read its own value`);
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
      this.flags = F.Mutable | F.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      let threw = true;
      try {
        this.cachedValue = this.getter();
        threw = false;
      } finally {
        activeSub = prev;
        // On throw: leave dirty so next read retries.
        this.flags = threw ? F.Mutable | F.Dirty : (this.flags & ~F.RecursedCheck);
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }

  override set value(next: T) {
    if (this.setter !== undefined) this.setter(next);
    else throw new TypeError("Cannot write to a Computed");
  }

  override peek(): T {
    const prev = activeSub;
    activeSub = undefined;
    try { return this.value; }
    finally { activeSub = prev; }
  }

  override _update(): boolean {
    if (this.flags & F.HasChildEffect) unlinkChildEffects(this);
    this.depsTail = undefined;
    this.flags = F.Mutable | F.RecursedCheck;
    const prev = activeSub;
    activeSub = this;
    let threw = true;
    try {
      ++cycle;
      const old = this.cachedValue;
      const next = this.cachedValue = this.getter();
      threw = false;
      const eq = this[EQUALS];
      return eq ? !eq(old as T, next) : old !== next;
    } finally {
      activeSub = prev;
      this.flags = threw ? F.Mutable | F.Dirty : (this.flags & ~F.RecursedCheck);
      purgeDeps(this);
    }
  }

  override _unwatched(): void {
    if (this.depsTail !== undefined) {
      this.flags = F.Mutable | F.Dirty;
      disposeAllDepsInReverse(this);
    }
  }
}

/** Type alias — Lens is a Computed with a setter; no separate runtime class. */
export type Lens<T = unknown> = Computed<T>;

// ════════════════════════════════════════════════════════════════════
// Effect — internal; users call effect()
// ════════════════════════════════════════════════════════════════════

class Effect implements ReactiveNode {
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
    if (prev !== undefined) {
      link(this, prev, 0);
      prev.flags |= F.HasChildEffect;
    }
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

  _update(): boolean { this.flags = F.Mutable; return true; }

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
    let idx = insertIndex, firstIdx = firstInsertedIndex;
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
      if (flags & F.HasChildEffect) unlinkChildEffects(this);
      if (this.cleanup) { this._runCleanup(); if (!this.flags) return; }
      this.depsTail = undefined;
      this.flags = F.Watching | F.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      try {
        ++cycle; ++runDepth;
        const ret = this.fn();
        this.cleanup = typeof ret === "function" ? ret : undefined;
      } finally {
        --runDepth;
        activeSub = prev;
        this.flags &= ~F.RecursedCheck;
        purgeDeps(this);
      }
    } else if (this.deps !== undefined) {
      this.flags = F.Watching | (flags & F.HasChildEffect);
    }
  }

  _runCleanup(): void {
    const c = this.cleanup!;
    this.cleanup = undefined;
    const prev = activeSub;
    activeSub = undefined;
    try { c(); } finally { activeSub = prev; }
  }
}

// ════════════════════════════════════════════════════════════════════
// Factory helpers
// ════════════════════════════════════════════════════════════════════

export function signal<T>(initial: T, opts?: SignalOptions<T>): Signal<T> {
  return new Signal(initial, opts);
}
export function computed<T>(getter: () => T): Computed<T> { return new Computed(getter); }
export function lens<T>(getter: () => T, setter: (v: T) => void): Lens<T> { return new Computed(getter, setter); }
export function effect(fn: () => void | (() => void)): () => void {
  const e = new Effect(fn);
  return () => e._unwatched();
}
export function batch<R>(fn: () => R): R {
  ++batchDepth;
  try { return fn(); }
  finally { if (!--batchDepth) flush(); }
}
export function untracked<R>(fn: () => R): R {
  const prev = activeSub;
  activeSub = undefined;
  try { return fn(); }
  finally { activeSub = prev; }
}

