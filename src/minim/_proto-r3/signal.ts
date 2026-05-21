// signal.ts — three concrete primitives + engine + Effect + factories.
//
// Engine state and the four classes (Node abstract base, Signal,
// Computed, Lens) live in one file so V8 can resolve all module-local
// state as fast `let`s rather than cross-module-binding loads.
//
// `Signal<T>` (writable source), `Computed<T>` (read-only derived),
// `Lens<T>` (writable derived). All three extend `Node<T>` which
// declares the engine fields and shared cache helpers.
//
// Construction patterns:
//   - `signal(initial, opts?)`       → Signal<T>
//   - `computed(getter, opts?)`      → Computed<T>
//   - `lens(get, set, opts?)`        → Lens<T>
//   - `new Vec(initial, opts?)`      → typed VecSignal (signal-mode)
//   - `Vec.lens(get, set, opts?)`    → typed VecLens (writable derived)
//   - `Vec.derive(fn, opts?)`        → typed VecComputed (read-only derived)

import { type Equals, type TraitDict } from "./traits";

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

const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
} as const;

// ─── Engine globals (file-local for V8 friendliness) ────────────────

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let activeSub: ReactiveNode | undefined;
let notifyIndex = 0;
let queuedLength = 0;
const queued: (Effect | undefined)[] = [];
let flushing = false;
let writeHook: ((n: Node<unknown>) => void) | undefined;

export function setNodeWriteHook(fn: ((n: Node<unknown>) => void) | undefined): () => void {
  const prev = writeHook;
  writeHook = fn;
  return () => { writeHook = prev };
}

// ─── Engine functions (file-local) ──────────────────────────────────

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
  if (prevDep !== undefined) prevDep.nextDep = newLink; else sub.deps = newLink;
  if (prevSub !== undefined) prevSub.nextSub = newLink; else dep.subs = newLink;
  if (isFirstSub && dep instanceof Node) {
    const hook = dep._watched;
    if (hook !== undefined) hook.call(dep);
  }
}

function unlink(l: Link, sub: ReactiveNode = l.sub): Link | undefined {
  const { dep, prevDep, nextDep, nextSub, prevSub } = l;
  if (nextDep !== undefined) nextDep.prevDep = prevDep; else sub.depsTail = prevDep;
  if (prevDep !== undefined) prevDep.nextDep = nextDep; else sub.deps = nextDep;
  if (nextSub !== undefined) nextSub.prevSub = prevSub; else dep.subsTail = prevSub;
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
        if (nextSub !== undefined) { stack = { value: next, prev: stack }; next = nextSub }
        continue;
      }
    }
    if ((l = next!) !== undefined) { next = l.nextSub; continue }
    while (stack !== undefined) {
      l = stack.value; stack = stack.prev;
      if (l !== undefined) { next = l.nextSub; continue top }
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
      if (dep._update()) { if (subs.nextSub !== undefined) shallowPropagate(subs); dirty = true }
    } else if ((flags & (F.Mutable | F.Pending)) === (F.Mutable | F.Pending)) {
      stack = { value: l, prev: stack }; l = dep.deps!; sub = dep; ++checkDepth; continue;
    }
    if (!dirty) {
      const nextDep = l.nextDep;
      if (nextDep !== undefined) { l = nextDep; continue }
    }
    while (checkDepth--) {
      l = stack!.value; stack = stack!.prev;
      if (dirty) {
        const subs = sub.subs!;
        if (sub._update()) { if (subs.nextSub !== undefined) shallowPropagate(subs); sub = l.sub; continue }
        dirty = false;
      } else {
        sub.flags &= ~F.Pending;
      }
      sub = l.sub;
      const nextDep = l.nextDep;
      if (nextDep !== undefined) { l = nextDep; continue top }
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
  while (l !== undefined) { if (l === checkLink) return true; l = l.prevDep }
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

// ─── Public types ───────────────────────────────────────────────────

/** Plain T, thunk `() => T`, or any read-shape (Node/Signal/Computed/Lens). */
export type Val<T> = T | (() => T) | Read<T>;

/** Covariant read-only surface (parameter-site for `Val<T>`). */
export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

export type Of<R> = R extends Node<infer T> ? T : never;

export interface NodeOptions<T = unknown> {
  watched?: () => void;
  unwatched?: () => void;
  equals?: Equals<T>;
}

export function value<T>(v: Val<T>): T {
  if (v instanceof Node) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}

// ─── Node — abstract reactive base ──────────────────────────────────

/** Abstract base for all reactive primitives. Carries engine state
 *  (deps/subs/flags) and shared cache facilities (memo/field). Each
 *  concrete primitive supplies its own `value`/`_update` semantics. */
export abstract class Node<T = unknown> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Mutable;
  _equals: Equals<T> | undefined = undefined;
  _watched?: () => void;
  _unwatchedHook?: () => void;
  protected _stopBinding?: () => void;
  protected _memoCache?: Record<string | symbol, unknown>;
  protected _fields?: Record<string | symbol, unknown>;

  /** Per-instance lazy derived cache. */
  memo<R>(key: string | symbol, make: () => R): R {
    const c = (this._memoCache ??= {});
    const k = key as string;
    return (c[k] ?? (c[k] = make())) as R;
  }

  /** Cached field-lens factory. The `make` callback constructs a
   *  primitive (NumLens/NumComputed/…) over the get/set pair. */
  field<K extends keyof T, R>(
    key: K,
    make: (get: () => T[K], set: (v: T[K]) => void) => R,
  ): R {
    const c = (this._fields ??= {});
    const k = key as string | symbol;
    let cached = c[k as string];
    if (cached === undefined) {
      cached = make(
        () => (this.value as T)[key],
        (v) => { (this as unknown as { value: T }).value = { ...(this.peek() as object), [key]: v } as T },
      );
      c[k as string] = cached;
    }
    return cached as R;
  }

  /** Read-only at the type level; Signal/Lens add a setter, widening
   *  to writable in those subclasses. */
  get value(): T {
    throw new TypeError(`${(this.constructor as { name?: string }).name ?? "Node"} has no value accessor`);
  }
  peek(): T { return this.value }

  abstract _update(): boolean;
  _notify(): void {}
  _unwatched(): void { if (this._unwatchedHook !== undefined) this._unwatchedHook() }

  /** Footgun guard: silently coercing to string/number is almost always a bug. */
  [Symbol.toPrimitive](hint: string): never {
    throw new TypeError(`${this.constructor.name} cannot be coerced to ${hint} — use \`.value\``);
  }
}

// ─── Signal — writable source ───────────────────────────────────────

export class Signal<T = unknown> extends Node<T> {
  /** @internal */ private currentValue: T;
  /** @internal */ private pendingValue: T;

  constructor(initial: T, opts?: NodeOptions<T>) {
    super();
    this.currentValue = initial;
    this.pendingValue = initial;
    if (opts?.equals) {
      this._equals = opts.equals;
    } else {
      const cls = this.constructor as { traits?: TraitDict<T> };
      if (cls.traits?.equals) this._equals = cls.traits.equals;
    }
    if (opts) {
      if (opts.watched) this._watched = opts.watched;
      if (opts.unwatched) this._unwatchedHook = opts.unwatched;
    }
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
      if (writeHook !== undefined) writeHook(this as Node<unknown>);
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
      if (this.currentValue !== (this.currentValue = this.pendingValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    return this.currentValue;
  }

  /** One-shot write; severs prior `.bind(...)`. */
  set(v: Val<T>): this {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined }
    this.value = value(v);
    return this;
  }

  bind(source: Val<T>): () => void {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined }
    if (source instanceof Node || typeof source === "function") {
      const stop = effect(() => { this.value = value(source) });
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
  /** @internal */ private cachedValue: T | undefined = undefined;
  /** @internal */ private getter: () => T;

  constructor(getter: () => T, opts?: NodeOptions<T>) {
    super();
    this.getter = getter;
    this.flags = 0;
    if (opts?.equals) this._equals = opts.equals;
    if (opts?.watched) this._watched = opts.watched;
    if (opts?.unwatched) this._unwatchedHook = opts.unwatched;
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
      activeSub = this;
      let threw = true;
      try {
        this.cachedValue = this.getter();
        threw = false;
      } finally {
        activeSub = prev;
        this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }

  peek(): T {
    const prev = activeSub;
    activeSub = undefined;
    try { return this.value } finally { activeSub = prev }
  }

  _update(): boolean {
    this.depsTail = undefined;
    this.flags = F.Mutable | F.RecursedCheck;
    const prev = activeSub;
    activeSub = this;
    let threw = true;
    try {
      ++cycle;
      const old = this.cachedValue;
      const next = (this.cachedValue = this.getter());
      threw = false;
      const eq = this._equals;
      return eq ? !eq(old as T, next) : old !== next;
    } finally {
      activeSub = prev;
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
  /** @internal */ private cachedValue: T | undefined = undefined;
  /** @internal */ private getter: () => T;
  /** @internal */ private setter: (v: T) => void;

  constructor(getter: () => T, setter: (v: T) => void, opts?: NodeOptions<T>) {
    super();
    this.getter = getter;
    this.setter = setter;
    this.flags = 0;
    if (opts?.equals) this._equals = opts.equals;
    if (opts?.watched) this._watched = opts.watched;
    if (opts?.unwatched) this._unwatchedHook = opts.unwatched;
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
      activeSub = this;
      let threw = true;
      try {
        this.cachedValue = this.getter();
        threw = false;
      } finally {
        activeSub = prev;
        this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }

  set value(next: T) { this.setter(next) }

  peek(): T {
    const prev = activeSub;
    activeSub = undefined;
    try { return this.value } finally { activeSub = prev }
  }

  set(v: Val<T>): this {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined }
    this.value = value(v);
    return this;
  }

  bind(source: Val<T>): () => void {
    if (this._stopBinding) { this._stopBinding(); this._stopBinding = undefined }
    if (source instanceof Node || typeof source === "function") {
      const stop = effect(() => { this.value = value(source) });
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
    activeSub = this;
    let threw = true;
    try {
      ++cycle;
      const old = this.cachedValue;
      const next = (this.cachedValue = this.getter());
      threw = false;
      const eq = this._equals;
      return eq ? !eq(old as T, next) : old !== next;
    } finally {
      activeSub = prev;
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

  _update(): boolean { this.flags = F.Mutable; return true }

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
      if (this.cleanup) { this._runCleanup(); if (!this.flags) return }
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
    try { c() } finally { activeSub = prev }
  }
}

// ─── Type predicates ────────────────────────────────────────────────

export const isNode     = (v: unknown): v is Node<unknown>     => v instanceof Node;
export const isSignal   = (v: unknown): v is Signal<unknown>   => v instanceof Signal;
export const isComputed = (v: unknown): v is Computed<unknown> => v instanceof Computed;
export const isLens     = (v: unknown): v is Lens<unknown>     => v instanceof Lens;

// ─── Factories ──────────────────────────────────────────────────────

export function signal<T>(initial: T, opts?: NodeOptions<T>): Signal<T> {
  return new Signal(initial, opts);
}
export function computed<T>(getter: () => T, opts?: NodeOptions<T>): Computed<T> {
  return new Computed(getter, opts);
}
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
  ++batchDepth;
  try { return fn() } finally { if (!--batchDepth) flush() }
}

export function untracked<R>(fn: () => R): R {
  const prev = activeSub;
  activeSub = undefined;
  try { return fn() } finally { activeSub = prev }
}
