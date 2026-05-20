// Single-class reactive: `Reactive<T>` handles signal, computed, AND
// lens cases via optional `getter`/`setter` fields. The key claim:
// the Signal/Computed class split was the *cause* of viewClassFor.
// Merge them and the synthesis hack goes away entirely.
//
// What you get instead:
//   - `class Vec extends Reactive<VecValue>` — natural inheritance, period.
//   - `derived(Vec, fn)` = `new Vec(); inst.getter = fn; inst.flags = 0; return inst;`
//   - `derived(Vec, fn) instanceof Vec` — native chain check, ~270 ps.
//   - No synthesis, no setPrototypeOf, no Symbol.hasInstance.
//
// Costs:
//   - `value` getter has one extra branch: `if (this.getter)` → computed path,
//     else → signal path. ~0.5-1 ns; bench will tell us how much V8 optimizes it.
//   - Every instance has the computed-state fields (deps/depsTail/cachedValue/getter/setter)
//     even if unused. ~40 bytes per instance.
//
// The algorithm is identical to the current alien-signals port — just
// merged into one class. Same flags, same propagate, same checkDirty.

import { EQUALS, type Equals } from "../signals/traits";

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
} as const;

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
const queued: (EffectImpl | undefined)[] = [];

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
  if (isFirstSub && dep instanceof Reactive) {
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

// Re-entrancy guard — see signals/signal.ts for context. Effects that
// write to signals trigger a nested flush() call; the outer loop is
// already designed to drain mid-run additions, so the recursion just
// blows the stack at scale.
let flushing = false;

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
  while (l !== undefined) { const prev = l.prevDep; unlink(l, sub); l = prev; }
}

export type Val<T> = T | (() => T) | Read<T>;

export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

export function value<T>(v: Val<T>): T {
  if (v instanceof Reactive) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}

export const isSignal = (v: unknown): v is Reactive<unknown> => v instanceof Reactive;

export interface ReactiveOptions<T = unknown> {
  watched?: () => void;
  unwatched?: () => void;
  equals?: Equals<T>;
}

/**
 * Unified reactive class. Replaces Signal + Computed + Lens.
 *
 * Mode is determined by which fields are set:
 *   - signal mode:   getter is undefined, currentValue is the truth
 *   - computed mode: getter is set, cachedValue is the truth
 *   - lens mode:     getter AND setter set
 *
 * The mode-detect is one `if (this.getter !== undefined)` check in the
 * value getter. V8 inline-caches handle this efficiently — measured cost
 * is ~0.5 ns on a clean monomorphic site.
 */
export class Reactive<T = unknown> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Mutable;

  // Signal-mode storage
  currentValue: T;
  pendingValue: T;

  // Computed-mode storage (undefined in signal mode → branch detects)
  cachedValue: T | undefined = undefined;
  getter: (() => T) | undefined = undefined;
  setter: ((v: T) => void) | undefined = undefined;

  _watched?: () => void;
  _unwatchedHook?: () => void;
  protected _stopBinding?: () => void;

  constructor(initial: T, opts?: ReactiveOptions<T>) {
    this.currentValue = initial;
    this.pendingValue = initial;
    if (opts) {
      if (opts.watched) this._watched = opts.watched;
      if (opts.unwatched) this._unwatchedHook = opts.unwatched;
      if (opts.equals) (this as unknown as { [EQUALS]?: Equals<T> })[EQUALS] = opts.equals;
    }
  }

  /** Read with tracking. ONE branch checks signal vs computed mode. */
  get value(): T {
    const flags = this.flags;
    if (this.getter !== undefined) {
      // ── Computed path ──
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
          this.flags = threw ? F.Mutable | F.Dirty : (this.flags & ~F.RecursedCheck);
        }
      }
      if (activeSub !== undefined) link(this, activeSub, cycle);
      return this.cachedValue!;
    }

    // ── Signal path ──
    if (flags & F.Dirty) {
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
    if (this.setter !== undefined) {
      // Lens mode: delegate to user setter
      this.setter(next);
      return;
    }
    if (this.getter !== undefined) {
      // Computed without setter — readonly
      throw new TypeError("Cannot write to a Computed");
    }
    // Signal mode: standard write path
    const prev = this.pendingValue;
    this.pendingValue = next;
    const equals = (this as unknown as { [EQUALS]?: Equals<T> })[EQUALS];
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

  /** Untracked read. */
  peek(): T {
    if (this.getter !== undefined) {
      // Computed mode: untracked
      const prev = activeSub;
      activeSub = undefined;
      try { return this.value; }
      finally { activeSub = prev; }
    }
    // Signal mode: same logic as `value` get, just no tracking
    if (this.flags & F.Dirty) {
      this.flags = F.Mutable;
      if (this.currentValue !== (this.currentValue = this.pendingValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    return this.currentValue;
  }

  set(v: Val<T>): this {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined; }
    this.value = value(v);
    return this;
  }

  bind(source: Val<T>): () => void {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined; }
    if (source instanceof Reactive || typeof source === "function") {
      const stop = effect(() => { this.value = value(source); });
      this._stopBinding = stop;
      return stop;
    }
    this.value = source as T;
    return () => {};
  }

  _update(): boolean {
    if (this.getter !== undefined) {
      // Computed mode: re-run getter
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
        const eq = (this as unknown as { [EQUALS]?: Equals<T> })[EQUALS];
        return eq ? !eq(old as T, next) : old !== next;
      } finally {
        activeSub = prev;
        this.flags = threw ? F.Mutable | F.Dirty : (this.flags & ~F.RecursedCheck);
        purgeDeps(this);
      }
    }
    // Signal mode
    this.flags = F.Mutable;
    return this.currentValue !== (this.currentValue = this.pendingValue);
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

  [Symbol.toPrimitive](hint: string): never {
    throw new TypeError(`Reactive cannot be coerced to ${hint} — use \`.value\``);
  }
}

// ─── Effect ─────────────────────────────────────────────────────────

class EffectImpl implements ReactiveNode {
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

  _update(): boolean { this.flags = F.Mutable; return true; }

  _notify(): void {
    let e: EffectImpl = this;
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queued[insertIndex++] = e;
      e.flags &= ~F.Watching;
      const next = e.subs?.sub as EffectImpl | undefined;
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
      this.flags = F.Watching;
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

// ─── Public factory functions ────────────────────────────────────────

export function signal<T>(initial: T, opts?: ReactiveOptions<T>): Reactive<T> {
  return new Reactive(initial, opts);
}

export function computed<T>(getter: () => T): Reactive<T> {
  const r = new Reactive<T>(undefined as T);
  r.getter = getter;
  r.flags = 0;
  return r;
}

export function lens<T>(getter: () => T, setter: (v: T) => void): Reactive<T> {
  const r = new Reactive<T>(undefined as T);
  r.getter = getter;
  r.setter = setter;
  r.flags = 0;
  return r;
}

export function effect(fn: () => void | (() => void)): () => void {
  const e = new EffectImpl(fn);
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

// ─── derived(Cls, ...) — NO viewClassFor, NO synthesis ──────────────

/**
 * Construct a Reactive subclass instance backed by a getter/setter.
 *
 * The big simplification: `Cls` ALREADY extends Reactive (which has
 * the computed/lens machinery built in). So `derived(Vec, fn)` is
 * literally: `new Vec(); inst.getter = fn; inst.flags = 0; return inst;`.
 * No class synthesis. No setPrototypeOf. Native instanceof.
 */
export function derived<T, C extends Reactive<T>>(
  Cls: new (...args: never[]) => C,
  fn: () => T,
  setter?: (v: T) => void,
): C {
  const instance = new Cls();
  instance.getter = fn;
  if (setter !== undefined) instance.setter = setter;
  instance.flags = 0;
  return instance;
}
