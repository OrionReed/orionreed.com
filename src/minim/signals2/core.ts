// core.ts — minim signals + struct factory. Two sections:
//
//   1. ENGINE — vendored alien-signals v3.2.1 + minim patches:
//      - signal(initial, proto?) / computed(getter, proto?) accept a
//        prototype, stamped at construction (saves post-hoc
//        setPrototypeOf cost).
//      - lens(get, set, proto?) — NEW writable computed primitive
//        (read = computed semantics with equality propagation; write
//        delegates to setter). One node, not a wrapper.
//      - signalProto — shared proto carrying peek/follow/mirror.
//      - peek/follow/mirror as free functions too.
//      Algorithm unchanged. Glitch-freeness preserved.
//
//   2. STRUCT — `struct({...})` factory for typed cells:
//      - Methods are lifted to reactive cell methods + exposed as
//        static fns on the Type.
//      - Getters: lazy reactive accessors.
//      - Fields: lazy projection lenses (per-field subscription via
//        alien's computed-equality propagation).
//      - Traits: open registry (CommonTraits<T>, declaration-merge
//        extensible).
//      - Chain: fluent plain-math handle via Vec.chain(v) / cell.raw().

// ── Reactive system ─────────────────────────────────────────────────

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

interface LensNode<T = unknown> extends ComputedNode<T> {
  setter: (v: T) => void;
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
    if ("getter" in node) {
      if (node.depsTail !== undefined) {
        node.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
        disposeAllDepsInReverse(node);
      }
    } else if ("currentValue" in node) {
      // signal
    } else if ("fn" in node) {
      effectOper.call(node as EffectNode);
    } else {
      effectScopeOper.call(node as EffectScopeNode);
    }
  },
);

// ── Free utility functions ──────────────────────────────────────────
//
// `peek`, `follow`, and `mirror` are exported as standalone fns. Bare
// reactive primitives (signal/computed/lens) use them via `peek(s)`,
// `follow(target, src)`, `mirror(a, b)`. Typed cells (cell5 struct
// system) install equivalent methods on their prototype.
//
// Why standalone first? Per-signal proto-overrides cost ~70B/cell and
// ~3ns/read by transitioning V8's hidden class for the bound function.
// Bare signals shouldn't pay that — only typed cells do, and only
// because they need a proto anyway for user methods.

/** Untracked read — calls `s()` without subscribing the current effect. */
export function peek<T>(s: SignalFn<T>): T {
  const prev = setActiveSub(undefined);
  try { return s(); }
  finally { setActiveSub(prev); }
}

/** One-way binding — pushes `src`'s value into `target` on every change.
 *  Returns dispose. */
export function follow<T>(target: SignalFn<T>, src: SignalFn<T>): () => void {
  return effect(() => { target(src()); });
}

/** Two-way binding — keeps `a` and `b` in sync. `a` wins at setup.
 *  Returns dispose. */
export function mirror<T>(a: SignalFn<T>, b: SignalFn<T>): () => void {
  let busy = false;
  const dA = effect(() => {
    const v = a();
    if (busy) return;
    busy = true; try { b(v); } finally { busy = false; }
  });
  const dB = effect(() => {
    const v = b();
    if (busy) return;
    busy = true; try { a(v); } finally { busy = false; }
  });
  return () => { dA(); dB(); };
}

/** Optional shared bare-cell proto carrying `peek`/`follow`/`mirror`
 *  as methods. Pass to `signal(initial, signalProto)` to give a bare
 *  cell ergonomic methods. Costs ~70B + ~3ns/read (V8 hidden class).
 *  cell5 omits this for bare signals; cell4 (legacy) still uses it. */
export const signalProto: any = Object.create(Function.prototype);
signalProto.peek = function (this: SignalFn<unknown>) { return peek(this); };
signalProto.follow = function (this: SignalFn<any>, o: SignalFn<any>) { return follow(this, o); };
signalProto.mirror = function (this: SignalFn<any>, o: SignalFn<any>) { return mirror(this, o); };
// Legacy alias — cell4 uses `sync`:
signalProto.sync = signalProto.mirror;

// ── Public API ──────────────────────────────────────────────────────

/** The reactive primitive: callable for read / write, plus
 *  `peek`/`follow`/`mirror` methods on every cell (bare or typed). */
export interface SignalFn<T> {
  (): T;
  (value: T): void;
  peek(): T;
  follow(other: SignalFn<T>): () => void;
  mirror(other: SignalFn<T>): () => void;
  readonly __t?: T;
}

function getActiveSub(): ReactiveNode | undefined { return activeSub; }
function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
  const prev = activeSub;
  activeSub = sub;
  return prev;
}
function getBatchDepth(): number { return batchDepth; }

/** Start a write batch. Prefer `batch(fn)` over manual start/end. */
export function startBatch(): void { ++batchDepth; }
/** End a write batch. */
export function endBatch(): void { if (!--batchDepth) flush(); }

// Kind tag stamped on bound cell-functions at construction. Survives
// any minification or function-name rename — unlike the upstream
// `fn.name === "bound " + ...` string match which is bundler-fragile.
const KIND = Symbol("minim.kind");

export function isSignal(fn: any): boolean {
  return typeof fn === "function" && fn[KIND] === "signal";
}
export function isComputed(fn: any): boolean {
  return typeof fn === "function" && fn[KIND] === "computed";
}
export function isLens(fn: any): boolean {
  return typeof fn === "function" && fn[KIND] === "lens";
}
export function isEffect(fn: any): boolean {
  return typeof fn === "function" && fn[KIND] === "effect";
}
export function isEffectScope(fn: any): boolean {
  return typeof fn === "function" && fn[KIND] === "effectScope";
}

/** Construct a signal. Every signal gets `peek`/`follow`/`mirror`
 *  methods via `signalProto`. The proto is overridable for typed
 *  cells (cell5 struct system passes Vec.prototype). */
export function signal<T>(initialValue: T, proto: any = signalProto): SignalFn<T> {
  const fn = signalOper.bind({
    currentValue: initialValue,
    pendingValue: initialValue,
    subs: undefined,
    subsTail: undefined,
    flags: ReactiveFlags.Mutable,
  } as SignalNode<T>) as unknown as SignalFn<T>;
  Object.setPrototypeOf(fn, proto);
  (fn as any)[KIND] = "signal";
  return fn;
}

/** Construct a read-only computed. Same proto-stamping story as signal. */
export function computed<T>(
  getter: (previousValue?: T) => T,
  proto: any = signalProto,
): SignalFn<T> {
  const node = {
    value: undefined,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: 0,
    getter: getter as (previousValue?: unknown) => unknown,
  } as ComputedNode<T>;
  const fn = computedOper.bind(node as ComputedNode<unknown>) as unknown as SignalFn<T>;
  Object.setPrototypeOf(fn, proto);
  (fn as any)[KIND] = "computed";
  return fn;
}

/** NEW: Native writable computed. Read is computed-semantics (tracks
 *  deps, equality propagation on output). Write delegates to setter.
 *  One node, no wrapper. */
export function lens<T>(
  getter: (previousValue?: T) => T,
  setter: (v: T) => void,
  proto: any = signalProto,
): SignalFn<T> {
  const node = {
    value: undefined,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    flags: 0,
    getter: getter as (previousValue?: unknown) => unknown,
    setter: setter as (v: unknown) => void,
  } as LensNode<T>;
  const fn = lensOper.bind(node as LensNode<unknown>) as unknown as SignalFn<T>;
  Object.setPrototypeOf(fn, proto);
  (fn as any)[KIND] = "lens";
  return fn;
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
  const out = effectOper.bind(e);
  (out as any)[KIND] = "effect";
  return out;
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
  const out = effectScopeOper.bind(e);
  (out as any)[KIND] = "effectScope";
  return out;
}

function trigger(fn: () => void): void {
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

/** lensOper: read = computedOper semantics; write = delegate to setter.
 *  Mirrors the upstream signalOper rest-param shape for V8 consistency. */
function lensOper<T>(this: LensNode<T>, ...value: T[]): T | void {
  if (value.length) {
    this.setter(value[0]);
    return;
  }
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

/** Run a function in a write-batched block. */
export function batch<R>(fn: () => R): R {
  startBatch();
  try { return fn(); }
  finally { endBatch(); }
}

// ════════════════════════════════════════════════════════════════════
// STRUCT — typed cells via struct({...}) factory.
// ════════════════════════════════════════════════════════════════════

// ── Trait interfaces (open registry, declaration-merge extensible) ──

/** Additive group with a scalar action — `add/sub/scale`. */
export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}

/** Linear interpolation between two values. */
export type Lerp<T> = (a: T, b: T, t: number) => T;

/** Distance / norm between two values (metric axioms). */
export type Metric<T> = (a: T, b: T) => number;

/** Value-level equality, used for change detection on whole-value writes. */
export type Equals<T> = (a: T, b: T) => boolean;

/** Open registry of well-known trait names. Extend via declaration
 *  merging from user modules to add custom traits while keeping
 *  type-safety on struct({ traits: { ... } }) literals. */
export interface CommonTraits<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
}

// ── Public types ────────────────────────────────────────────────────

export type Val<T> = T | (() => T);
export type RO<T> = (() => T) & { peek(): T };

type Val_<X> = X extends Type<infer U, any> ? U : X extends FieldSpec<infer U> ? U : X;
type ShapeOf<V> = V extends Record<string, any> ? V extends Function ? V : { [K in keyof V]: Val_<V[K]> } : V;
type Lift<M, T> = { readonly [K in keyof M]: M[K] extends (self: T, ...a: infer A) => infer R ? (...a: A) => RO<R> : never };
type Get<G> = { readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never };
/** Resolve a single value-spec entry to a typed Cell, preserving Cfg
 *  for typed entries so methods/fields chain (e.g. `tr.translate.x`). */
type FieldCell<X> =
  X extends Type<infer U, infer C> ? Cell<U, C>
  : X extends FieldSpec<infer U> ? Cell<U>
  : Cell<X>;
type Fields<V> = V extends Record<string, any> ? V extends Function ? {} : { readonly [K in keyof V]: FieldCell<V[K]> } : {};

export type Cell<T, Cfg = unknown> = SignalFn<T>
  & { raw(): Chain<T, Cfg> }
  & (Cfg extends { value: infer V } ? Fields<V> : {})
  & (Cfg extends { methods: infer M } ? Lift<M, T> : {})
  & (Cfg extends { getters: infer G } ? Get<G> : {});

export type Type<T = any, Cfg = unknown> = (Cfg extends { methods: infer M } ? M : {}) & {
  readonly tag: string;
  readonly value: any;
  readonly traits: Cfg extends { traits: infer Tr } ? Tr : {};
  readonly prototype: any;
  (init?: Partial<T>): Cell<T, Cfg>;
  is(v: unknown): v is Cell<T, Cfg>;
  with(init: T): FieldSpec<T>;
  /** Wrap a plain value into a fluent chain handle (~5ns/step, ~40B).
   *  Each method call mutates `.value` and returns the same handle. */
  chain(v: T): Chain<T, Cfg>;
};

/** Chain handle for fluent plain math. `.value` extracts. */
export type Chain<T, Cfg> = { value: T } & (Cfg extends { methods: infer M }
  ? { [K in keyof M]: M[K] extends (self: T, ...a: infer A) => infer R
      ? R extends T ? (...a: A) => Chain<T, Cfg> : (...a: A) => R
      : never }
  : {});

export interface FieldSpec<T = any> { readonly [BRAND]: "field"; readonly type: Type<T, any>; readonly init: T }

export interface StructDef<T = any> {
  tag: string;
  value: any;
  methods?: Record<string, (self: T, ...args: any[]) => any>;
  getters?: Record<string, (this: any) => any>;
  traits?: CommonTraits<T> & Record<string, unknown>;
}

// ── Detection ──────────────────────────────────────────────────────

const BRAND = Symbol.for("minim.struct");
const isType = (v: any): boolean => typeof v === "function" && v[BRAND] === "type";
const isFieldSpec = (v: any): v is FieldSpec => v != null && typeof v === "object" && v[BRAND] === "field";
const isAnyCell = (v: any): boolean => typeof v === "function" && Object.getPrototypeOf(v)?.[BRAND] === "proto";

export const typeOf = <T>(c: SignalFn<T>): Type<T> | undefined => (c as any).constructor;
export const unwrap = <T>(v: Val<T>): T => typeof v === "function" ? (v as () => T)() : v;

/** Resolve a `value:` entry: extract its initial value and the
 *  prototype the field-lens should inherit. One walk covers both. */
function resolve(entry: any, override: any): { init: any; proto: any } {
  if (isType(entry))      return { init: override ?? entry.value,  proto: entry.prototype };
  if (isFieldSpec(entry)) return { init: override ?? entry.init,   proto: entry.type.prototype };
  if (isAnyCell(entry))   return { init: override ?? entry.peek(), proto: typeOf(entry)!.prototype };
  return                       { init: override ?? entry,         proto: signalProto };
}

// ── struct() ───────────────────────────────────────────────────────

const RESERVED = new Set(["peek", "follow", "mirror", "raw", "constructor",
  "length", "name", "caller", "arguments", "prototype", "call", "apply", "toString", "bind"]);

export function struct<const Cfg extends StructDef>(cfg: Cfg): Type<ShapeOf<Cfg["value"]>, Cfg> {
  const methods = cfg.methods ?? {};
  const getters = cfg.getters ?? {};
  const fields = (cfg.value != null && typeof cfg.value === "object" && typeof cfg.value !== "function")
    ? Object.keys(cfg.value) : [];
  const seen = new Set<string>();
  for (const n of [...Object.keys(methods), ...Object.keys(getters), ...fields]) {
    if (RESERVED.has(n)) throw new Error(`struct(${cfg.tag}): "${n}" is reserved`);
    if (seen.has(n))     throw new Error(`struct(${cfg.tag}): "${n}" collides across method/getter/field`);
    seen.add(n);
  }

  const Vec: any = function (init?: any) {
    const v = cfg.value;
    if (v != null && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v)) out[k] = resolve(v[k], init?.[k]).init;
      return signal(out, Vec.prototype);
    }
    return signal(init !== undefined ? init : v, Vec.prototype);
  };
  Vec.tag = cfg.tag;
  Vec.value = cfg.value;
  Vec.traits = cfg.traits ?? {};
  Vec[BRAND] = "type";
  Vec.with = (init: any) => ({ [BRAND]: "field", type: Vec, init }) as FieldSpec;

  for (const [k, fn] of Object.entries(methods)) Vec[k] = fn;

  // Mutating chain ctor — `Vec.chain(v).method().method().value`.
  const Chain: any = function (this: any, v: any) { this.value = v; };
  for (const [k, fn] of Object.entries(methods)) {
    Chain.prototype[k] = function (this: any, ...a: any[]) {
      this.value = (fn as any)(this.value, ...a);
      return this;
    };
  }
  Vec.chain = (v: any) => new Chain(v);

  const proto: any = Object.create(signalProto);
  proto[BRAND] = "proto";
  proto.constructor = Vec;
  proto.raw = function (this: any) { return new Chain(this.peek()); };

  for (const [k, fn] of Object.entries(methods)) {
    proto[k] = function (this: () => any, ...a: any[]) {
      const s = this;
      return computed(() => fn(s(), ...a.map(unwrap)));
    };
  }

  for (const [k, g] of Object.entries(getters)) {
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: any) { const v = g.call(this); Object.defineProperty(this, k, { value: v }); return v; },
    });
  }

  for (const k of fields) {
    const fieldProto = resolve((cfg.value as any)[k], undefined).proto;
    Object.defineProperty(proto, k, {
      configurable: true, enumerable: true,
      get(this: any) {
        const s = this;
        const f = lens(() => (s() as any)[k], (v: any) => { s({ ...s.peek(), [k]: v }); }, fieldProto);
        Object.defineProperty(this, k, { value: f, configurable: false, writable: false });
        return f;
      },
    });
  }

  Vec.prototype = proto;
  Vec.is = (v: unknown): boolean => isAnyCell(v) && Object.getPrototypeOf(v) === proto;
  return Vec as Type<ShapeOf<Cfg["value"]>, Cfg>;
}
