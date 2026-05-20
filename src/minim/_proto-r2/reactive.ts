// Reactive<T> — merged engine: signal, computed, and lens in one class.
//
// Mode is determined by which fields are set:
//   - signal mode:   currentValue is truth, getter undefined
//   - computed mode: getter set, cachedValue is truth, no setter
//   - lens mode:     getter set, setter set, cachedValue is truth (read), setter handles writes
//
// This eliminates `viewClassFor` and `setPrototypeOf` from the engine:
// `Vec extends Reactive` is a natural prototype chain, `derived(Vec, fn)`
// is `new Vec(); set getter; return`, and `instanceof Vec` uses the
// native chain walk.
//
// Algorithm is alien-signals; trait dispatch via `./traits`.
//
// Bug-fixes incorporated from production minim's signal.ts:
//   - peek(): shallowPropagate on Dirty-clear (subscribers were marked
//     Pending by the upstream write; without this they stay stranded)
//   - flush(): re-entrancy guard (cascading bind-effects on field
//     lenses can otherwise blow the call stack)

import { EQUALS, type Equals } from "./traits";

// ─── Internal types ──────────────────────────────────────────────────

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

// Flags match alien-signals v2.
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
const queued: (Effect | undefined)[] = [];

// Re-entrancy guard for flush. See the comment block on `flush()` below.
let flushing = false;

// ─── Write hook (for assert/record attribution) ──────────────────────

let writeHook: ((sig: Reactive<unknown>) => void) | undefined;
export function setSignalWriteHook(
  fn: ((sig: Reactive<unknown>) => void) | undefined,
): () => void {
  const prev = writeHook;
  writeHook = fn;
  return () => { writeHook = prev; };
}

// ─── alien-signals algorithm — link / unlink / propagate / etc. ──────

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

// Re-entrancy guard: effects that write to signals during their run
// trigger nested flush() via `Reactive.set value`. The outer loop here
// is designed to drain the queue including entries appended mid-run,
// so the recursive call is redundant — and at scale (hundreds of
// cascading bind-effects on field lenses) it blows V8's stack.
// Guarding turns O(N) stack growth into O(1).
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

// ─── Public types ───────────────────────────────────────────────────

/** Plain T, thunk `() => T`, or any read-shape (Reactive/Computed/…). */
export type Val<T> = T | (() => T) | Read<T>;

/** Covariant read-only surface (parameter-site for `Val<T>`). */
export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

/** Type alias for a read-only Reactive (computed). Both runtime-checked
 *  (writes throw) and TS-narrowed (Read interface). */
export type Computed<T = unknown> = Omit<Reactive<T>, "value"> & { readonly value: T };

/** Type alias for a writable derived view (lens). Structurally a Reactive
 *  with both getter AND setter set. Treated as writable in TS. */
export type Lens<T = unknown> = Reactive<T>;

export function value<T>(v: Val<T>): T {
  if (v instanceof Reactive) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}

export const isSignal = (v: unknown): v is Reactive<unknown> => v instanceof Reactive;

/** Runtime check: is this Reactive in lens mode (both getter and setter)? */
export const isLens = (v: unknown): v is Reactive<unknown> =>
  v instanceof Reactive && v.getter !== undefined && v.setter !== undefined;

/** Runtime check: is this Reactive in computed mode (getter, no setter)? */
export const isComputed = (v: unknown): v is Reactive<unknown> =>
  v instanceof Reactive && v.getter !== undefined && v.setter === undefined;

export interface ReactiveOptions<T = unknown> {
  /** First subscriber attached. */
  watched?: () => void;
  /** Last subscriber detached. */
  unwatched?: () => void;
  /** Per-instance equality; shadows class `[EQUALS]`. */
  equals?: Equals<T>;
}

// ─── The Reactive class ──────────────────────────────────────────────

/** Single reactive primitive. Mode is determined by which fields are set.
 *
 *  Fields:
 *    - `currentValue`/`pendingValue` — signal-mode storage
 *    - `cachedValue` — computed/lens cached evaluation
 *    - `getter` — when set, instance is in computed/lens mode
 *    - `setter` — when set with getter, instance is in lens mode
 *
 *  Construction patterns:
 *    - `new Reactive(initial)` — signal mode
 *    - `signal(initial)` — same as `new Reactive(initial)`
 *    - `computed(fn)` — computed mode (untyped)
 *    - `computed(Cls, fn)` — computed mode (typed as Cls instance)
 *    - `lens(get, set)` — lens mode (untyped)
 *    - `lens(Cls, get, set)` — lens mode (typed)
 *    - `new Vec(initial)` where Vec extends Reactive — typed signal mode
 *    - `computed(Vec, fn)` — typed computed view of Vec
 *    - `lens(Vec, get, set)` — typed writable view of Vec
 *
 *  Type predicates: `isSignal(x)`, `isComputed(x)`, `isLens(x)`.
 */
export class Reactive<T = unknown> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Mutable;
  currentValue: T;
  pendingValue: T;
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

  /** Read with tracking. Branches on signal vs computed mode. */
  get value(): T {
    const flags = this.flags;
    if (this.getter !== undefined) {
      // ── Computed path ──
      if (flags & F.RecursedCheck) {
        throw new RangeError(
          `Cyclic computed: ${(this.constructor as { name?: string }).name ?? "?"} read its own value`,
        );
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
        // First read: lazy init
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
    // Single branch on the "is this a derived view?" predicate. Signal
    // writes (the common case) take the fall-through. Computed/lens
    // writes take the slow path with a second branch.
    if (this.getter !== undefined) {
      const set = this.setter;
      if (set === undefined) throw new TypeError("Cannot write to a Computed");
      set(next);
      return;
    }
    const prev = this.pendingValue;
    this.pendingValue = next;
    const equals = (this as unknown as { [EQUALS]?: Equals<T> })[EQUALS];
    const same = equals ? equals(prev, next) : prev === next;
    if (!same) {
      this.flags = F.Mutable | F.Dirty;
      if (writeHook !== undefined) writeHook(this as Reactive<unknown>);
      const subs = this.subs;
      if (subs !== undefined) {
        propagate(subs, runDepth > 0);
        if (batchDepth === 0) flush();
      }
    }
  }

  /** Untracked read; honors Dirty + propagates to subs (fix for stranded
   *  subscribers when peek follows a write). */
  peek(): T {
    if (this.getter !== undefined) {
      // Computed-mode peek: untracked .value
      const prev = activeSub;
      activeSub = undefined;
      try { return this.value; }
      finally { activeSub = prev; }
    }
    // Signal-mode peek
    if (this.flags & F.Dirty) {
      this.flags = F.Mutable;
      if (this.currentValue !== (this.currentValue = this.pendingValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    return this.currentValue;
  }

  /** One-shot write of `value(v)`. Severs any prior `.bind(...)`. Chainable. */
  set(v: Val<T>): this {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined; }
    this.value = value(v);
    return this;
  }

  /** Bind to a `Val<T>`; replaces any prior binding. Returns disposer
   *  (no-op for plain T). */
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

  /** Footgun guard: silently coercing to string/number is almost always a bug. */
  [Symbol.toPrimitive](hint: string): never {
    throw new TypeError(`Reactive cannot be coerced to ${hint} — use \`.value\``);
  }
}

// ─── Effect class ───────────────────────────────────────────────────

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

// ─── Public factories ────────────────────────────────────────────────

export function signal<T>(initial: T, opts?: ReactiveOptions<T>): Reactive<T> {
  return new Reactive(initial, opts);
}

// `computed` overloads:
//   computed(fn)              → Reactive<T>  (untyped)
//   computed(Cls, fn)         → Cls instance (typed read-only view)
export function computed<T>(getter: () => T): Reactive<T>;
export function computed<T, C extends Reactive<T>>(
  Cls: new (...args: never[]) => C,
  getter: () => T,
): C;
export function computed<T, C extends Reactive<T>>(
  ClsOrFn: (new (...args: never[]) => C) | (() => T),
  maybeGetter?: () => T,
): C | Reactive<T> {
  if (maybeGetter === undefined) {
    // computed(fn) — untyped
    const fn = ClsOrFn as () => T;
    const r = new Reactive<T>(undefined as T);
    r.getter = fn;
    r.flags = 0;
    return r;
  }
  // computed(Cls, fn) — typed
  const Cls = ClsOrFn as new (...args: never[]) => C;
  const inst = new Cls();
  inst.getter = maybeGetter;
  inst.flags = 0;
  return inst;
}

// `lens` overloads:
//   lens(get, set)            → Reactive<T>  (untyped writable derived)
//   lens(Cls, get, set)       → Cls instance (typed writable derived)
export function lens<T>(getter: () => T, setter: (v: T) => void): Reactive<T>;
export function lens<T, C extends Reactive<T>>(
  Cls: new (...args: never[]) => C,
  getter: () => T,
  setter: (v: T) => void,
): C;
export function lens<T, C extends Reactive<T>>(
  ClsOrGetter: (new (...args: never[]) => C) | (() => T),
  getterOrSetter: (() => T) | ((v: T) => void),
  maybeSetter?: (v: T) => void,
): C | Reactive<T> {
  if (maybeSetter === undefined) {
    // lens(get, set) — untyped
    const r = new Reactive<T>(undefined as T);
    r.getter = ClsOrGetter as () => T;
    r.setter = getterOrSetter as (v: T) => void;
    r.flags = 0;
    return r;
  }
  // lens(Cls, get, set) — typed
  const Cls = ClsOrGetter as new (...args: never[]) => C;
  const inst = new Cls();
  inst.getter = getterOrSetter as () => T;
  inst.setter = maybeSetter;
  inst.flags = 0;
  return inst;
}

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
