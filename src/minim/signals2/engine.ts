// engine.ts — minim's reactive engine.
//
// One file. Signal/Computed/Lens — a single class hierarchy where
// Computed extends Signal and Lens extends Computed. Effect is the
// fourth primitive (internal-ish). Polymorphic dispatch via _update /
// _notify / _unwatched. Algorithm is alien-signals, unchanged.
//
// Surface design
//   • Val<T> = T | (() => T) | Signal<T>           universal "yields T"
//   • value(v: Val<T>): T                          unwrap (auto-tracks)
//   • new Signal(v: Val<T>)                        construct, optionally bind
//   • signal.value get/set                         plain read/write
//   • signal.bind(source: Val<T>): () => void      explicit re-bind
//   • signal.peek(): T                             untracked read
//   • computed(fn) / lens(get, set) / effect(fn)
//   • batch(fn) / untracked(fn) / follow(target, source)
//   • SignalOptions { watched, unwatched }         lifecycle hooks
//   • Linear/Lerp/Metric/Equals + CommonTraits<T>  trait shapes
//   • classOf(s) / traitsOf(s) / requireTraits(s, ...keys)

// ════════════════════════════════════════════════════════════════════
// Internal types — alien-signals shape, kept verbatim
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
// Val<T> — universal rule
// ════════════════════════════════════════════════════════════════════

/** "Anything that yields a T":
 *  - plain T
 *  - thunk () => T
 *  - reactive Signal (any Signal subclass — Computed/Lens/Vec/Num/etc.)
 *
 *  Branded NOMINALLY via `instanceof Signal` — plain `{ value: 5 }`
 *  objects are NOT mistakenly treated as cells. */
export type Val<T> = T | (() => T) | Signal<T>;

/** Unwrap a Val<T> to T. Inside a tracking context (effect/computed
 *  body) reactive forms auto-subscribe. */
export function value<T>(v: Val<T>): T {
  if (v instanceof Signal) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}

/** Predicate: is `v` a reactive signal of any flavor? */
export const isSignal = (v: unknown): v is Signal<unknown> => v instanceof Signal;

// ════════════════════════════════════════════════════════════════════
// Lifecycle hooks
// ════════════════════════════════════════════════════════════════════

export interface SignalOptions {
  /** First subscriber attached. */
  watched?: () => void;
  /** Last subscriber detached. */
  unwatched?: () => void;
}

// ════════════════════════════════════════════════════════════════════
// Signal — writable reactive value, the base class
// ════════════════════════════════════════════════════════════════════

export class Signal<T = unknown> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Mutable;
  currentValue: T;
  pendingValue: T;
  /** Set when the signal is bound to a reactive Val<T>. */
  protected _binding: (() => void) | undefined = undefined;
  /** Optional lifecycle hooks. */
  _watched?: () => void;
  _unwatchedHook?: () => void;

  constructor(initial: Val<T>, opts?: SignalOptions) {
    if (opts) {
      this._watched = opts.watched;
      this._unwatchedHook = opts.unwatched;
    }
    if (initial instanceof Signal || typeof initial === "function") {
      const v = value(initial);
      this.currentValue = v;
      this.pendingValue = v;
      this._binding = effect(() => {
        const next = value(initial);
        if (this.peek() !== next) this._setPlain(next);
      });
    } else {
      this.currentValue = initial as T;
      this.pendingValue = initial as T;
    }
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

  /** Plain write. Does NOT rebind — use `.bind(source)` for that. */
  set value(next: T) { this._setPlain(next); }

  protected _setPlain(next: T): void {
    const prev = this.pendingValue;
    this.pendingValue = next;
    const equals = (this.constructor as ValueClass<T>).traits?.equals;
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

  /** Bind this signal to a reactive source. Severs any previous binding.
   *  Plain T sources do a one-shot write. Returns a dispose fn. */
  bind(source: Val<T>): () => void {
    if (this._binding) { this._binding(); this._binding = undefined; }
    if (source instanceof Signal || typeof source === "function") {
      this._binding = effect(() => {
        const next = value(source);
        if (this.peek() !== next) this._setPlain(next);
      });
      return this._binding;
    }
    this._setPlain(source as T);
    return () => {};
  }

  /** Sever any active binding. */
  unbind(): void {
    if (this._binding) { this._binding(); this._binding = undefined; }
  }

  /** Whether this signal is bound to an external reactive source. */
  get isBound(): boolean { return this._binding !== undefined; }

  // Polymorphic engine dispatch:
  _update(): boolean {
    this.flags = F.Mutable;
    return this.currentValue !== (this.currentValue = this.pendingValue);
  }
  _notify(): void {}
  _unwatched(): void {
    if (this._unwatchedHook !== undefined) this._unwatchedHook();
  }
}

// ════════════════════════════════════════════════════════════════════
// Computed — read-only derived signal
// ════════════════════════════════════════════════════════════════════

/** Read-only derived signal. Re-evaluates when deps change.
 *  Extends Signal so `instanceof Signal` covers all reactive types. */
export class Computed<T = unknown> extends Signal<T> {
  cachedValue: T | undefined = undefined;
  getter: () => T;

  constructor(getter: () => T) {
    super(undefined as T);  // Signal's slots inherited; value semantics overridden below
    this.getter = getter;
    this.flags = 0;
  }

  // Override value getter for lazy-eval caching.
  override get value(): T {
    const flags = this.flags;
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
      try { this.cachedValue = this.getter(); }
      finally { activeSub = prev; this.flags &= ~F.RecursedCheck; }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }

  // Computed is read-only by default. Subclasses (Lens) override.
  override set value(_next: T) {
    throw new TypeError("Cannot write to a Computed");
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
    try {
      ++cycle;
      const old = this.cachedValue;
      return old !== (this.cachedValue = this.getter());
    } finally {
      activeSub = prev;
      this.flags &= ~F.RecursedCheck;
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

// ════════════════════════════════════════════════════════════════════
// Lens — writable view (custom get/set)
// ════════════════════════════════════════════════════════════════════

export class Lens<T = unknown> extends Computed<T> {
  setter: (v: T) => void;
  constructor(getter: () => T, setter: (v: T) => void) {
    super(getter);
    this.setter = setter;
  }
  // Inherits Computed's value getter; override only the setter.
  override set value(next: T) { this.setter(next); }
  // TS class-getter+setter requires both on the class; re-declare get
  // as super.value (no perf change measured for simple value-types).
  override get value(): T { return super.value; }
}

// ════════════════════════════════════════════════════════════════════
// Effect — internal-ish; users call effect()
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

export function signal<T>(initial: Val<T>): Signal<T> { return new Signal(initial); }
export function computed<T>(getter: () => T): Computed<T> { return new Computed(getter); }
export function lens<T>(getter: () => T, setter: (v: T) => void): Lens<T> { return new Lens(getter, setter); }
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

/** One-way binding: target follows source (Val<T>). Returns dispose. */
export function follow<T>(target: Signal<T>, source: Val<T>): () => void {
  return effect(() => { target.value = value(source); });
}

// ════════════════════════════════════════════════════════════════════
// Traits — generic dispatch via static slot
// ════════════════════════════════════════════════════════════════════

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T> = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;

/** Open registry of common traits — extend via declaration merging. */
export interface CommonTraits<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
}

/** Internal: a value-type class that may declare static `traits`. */
interface ValueClass<T = unknown> {
  new (v: Val<T>): Signal<T>;
  readonly traits?: CommonTraits<T>;
}

/** Get the value-type class of a signal. */
export function classOf<T>(s: Signal<T>): ValueClass<T> & { readonly name: string } {
  return s.constructor as ValueClass<T> & { readonly name: string };
}

/** Read all traits from a signal's class. Returns the traits object
 *  (with optional members) — the user handles missing keys explicitly.
 *  For a throwing version that requires specific keys, see `requireTraits`. */
export function traitsOf<T>(s: Signal<T>): CommonTraits<T> {
  return ((s.constructor as ValueClass<T>).traits ?? {}) as CommonTraits<T>;
}

/** Pluck N traits from a signal's class. Throws if any are missing.
 *
 *      const { linear, lerp } = requireTraits(v, "linear", "lerp");
 *      lerp(a, b, 0.5);
 */
export function requireTraits<T, K extends keyof CommonTraits<T>>(
  s: Signal<T>,
  ...keys: readonly K[]
): { [Key in K]: NonNullable<CommonTraits<T>[Key]> } {
  const tag = (s.constructor as { name?: string }).name ?? "?";
  const traits = (s.constructor as ValueClass<T>).traits;
  if (!traits) throw new Error(`requireTraits(${tag}): no traits declared`);
  const out = {} as { [Key in K]: NonNullable<CommonTraits<T>[Key]> };
  for (const k of keys) {
    const v = traits[k];
    if (v == null) throw new Error(`requireTraits(${tag}): missing trait \`${String(k)}\``);
    out[k] = v as NonNullable<CommonTraits<T>[K]>;
  }
  return out;
}
