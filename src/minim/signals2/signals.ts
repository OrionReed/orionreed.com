// signals.ts — minim's reactive primitives + struct factory in one file.
//
// Two sections:
//
//   1. ENGINE — class-based reactivity (Signal/Computed/Lens/Effect) using
//      the alien-signals algorithm. Polymorphic dispatch via `_update` /
//      `_notify` / `_unwatched` on each class. Algorithm at module level
//      (no closure factory). Construction ~7ns, reads ~4ns, writes ~9ns.
//
//   2. STRUCT — typed cells via `struct({...})`:
//        cell.value          read/write
//        cell.peek()         untracked read
//        cell.x              Lens<T> for field x (lazy, cached)
//        cell.add(b)         reactive method → Computed<R>
//        cell.raw()          fluent plain-math chain
//        Vec.chain(v)        same, on Type
//        Vec.add(a, b)       static plain math
//        Vec.traits          typed trait bag (CommonTraits<T>)
//        Vec.is(v)           type guard via instanceof
//        Vec.with(init)      FieldSpec for nested defaults
//
// Algorithm is unchanged from alien-signals. Glitch-freeness preserved.

// ════════════════════════════════════════════════════════════════════
// ENGINE — alien-signals algorithm, polymorphic class shell
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

// ── Engine state ────────────────────────────────────────────────────

let cycle = 0;
let runDepth = 0;
let batchDepth = 0;
let notifyIndex = 0;
let queuedLength = 0;
let activeSub: ReactiveNode | undefined;
const queued: (Effect | undefined)[] = [];

// ── Algorithm (was alien's createReactiveSystem, inlined) ──────────

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
    if (flags & ReactiveFlags.Watching) sub._notify();
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
      if (dep._update()) {
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
        if (sub._update()) {
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
      if ((flags & (ReactiveFlags.Watching | ReactiveFlags.RecursedCheck)) === ReactiveFlags.Watching) sub._notify();
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
      e.flags |= ReactiveFlags.Watching | ReactiveFlags.Recursed;
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
  while (l !== undefined) {
    const prev = l.prevDep;
    unlink(l, sub);
    l = prev;
  }
}

// Strip child-effect deps from a computed/effect's dep chain before re-eval.
function unlinkChildEffects(node: ReactiveNode): void {
  let l = node.depsTail;
  while (l !== undefined) {
    const prev = l.prevDep;
    if (l.dep instanceof Effect) unlink(l, node);
    l = prev;
  }
}

// ── Public API: classes ─────────────────────────────────────────────

/** Writable signal. Construct with `new Signal(v)` or `signal(v)`. */
export class Signal<T = any> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = ReactiveFlags.Mutable;
  currentValue: T;
  pendingValue: T;

  constructor(initial: T) {
    this.currentValue = initial;
    this.pendingValue = initial;
  }

  /** Read with tracking. */
  get value(): T {
    if (this.flags & ReactiveFlags.Dirty) {
      this.flags = ReactiveFlags.Mutable;
      if (this.currentValue !== (this.currentValue = this.pendingValue)) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.currentValue;
  }

  /** Write — triggers propagation if value changed. */
  set value(next: T) {
    if (this.pendingValue !== (this.pendingValue = next)) {
      this.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
      const subs = this.subs;
      if (subs !== undefined) {
        propagate(subs, !!runDepth);
        if (!batchDepth) flush();
      }
    }
  }

  /** Untracked read. */
  peek(): T { return this.currentValue; }

  _update(): boolean {
    this.flags = ReactiveFlags.Mutable;
    return this.currentValue !== (this.currentValue = this.pendingValue);
  }
  _notify(): void {}  // signals don't get notified (no Watching flag)
  _unwatched(): void {}  // no deps to dispose
}

/** Read-only computed signal. */
export class Computed<T = any> implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = 0;
  cachedValue: T | undefined = undefined;
  getter: () => T;

  constructor(getter: () => T) { this.getter = getter; }

  get value(): T {
    const flags = this.flags;
    if (
      flags & ReactiveFlags.Dirty ||
      (flags & ReactiveFlags.Pending &&
        (checkDirty(this.deps!, this) || ((this.flags = flags & ~ReactiveFlags.Pending), false)))
    ) {
      if (this._update()) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    } else if (!flags) {
      this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      try { this.cachedValue = this.getter(); }
      finally { activeSub = prev; this.flags &= ~ReactiveFlags.RecursedCheck; }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }

  peek(): T {
    const prev = activeSub;
    activeSub = undefined;
    try { return this.value; }
    finally { activeSub = prev; }
  }

  _update(): boolean {
    if (this.flags & HasChildEffect) unlinkChildEffects(this);
    this.depsTail = undefined;
    this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
    const prev = activeSub;
    activeSub = this;
    try {
      ++cycle;
      const old = this.cachedValue;
      return old !== (this.cachedValue = this.getter());
    } finally {
      activeSub = prev;
      this.flags &= ~ReactiveFlags.RecursedCheck;
      purgeDeps(this);
    }
  }
  _notify(): void {}
  _unwatched(): void {
    if (this.depsTail !== undefined) {
      this.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
      disposeAllDepsInReverse(this);
    }
  }
}

/** Writable computed: get via getter (tracks deps), set via setter.
 *  Extends Computed for `_update`/`_unwatched`/`peek`. The `value`
 *  accessor pair is inlined (not `super.value`) — ~5% faster reads. */
export class Lens<T = any> extends Computed<T> {
  setter: (v: T) => void;
  constructor(getter: () => T, setter: (v: T) => void) {
    super(getter);
    this.setter = setter;
  }
  get value(): T {
    const flags = this.flags;
    if (
      flags & ReactiveFlags.Dirty ||
      (flags & ReactiveFlags.Pending &&
        (checkDirty(this.deps!, this) || ((this.flags = flags & ~ReactiveFlags.Pending), false)))
    ) {
      if (this._update()) {
        const subs = this.subs;
        if (subs !== undefined) shallowPropagate(subs);
      }
    } else if (!flags) {
      this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
      const prev = activeSub;
      activeSub = this;
      try { this.cachedValue = this.getter(); }
      finally { activeSub = prev; this.flags &= ~ReactiveFlags.RecursedCheck; }
    }
    if (activeSub !== undefined) link(this, activeSub, cycle);
    return this.cachedValue!;
  }
  set value(next: T) { this.setter(next); }
}

/** Side-effect — runs `fn` whenever its deps change. */
export class Effect implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
  fn: () => (() => void) | void;
  cleanup: (() => void) | undefined = undefined;

  constructor(fn: () => (() => void) | void) {
    this.fn = fn;
    const prev = activeSub;
    activeSub = this;
    if (prev !== undefined) {
      link(this, prev, 0);
      prev.flags |= HasChildEffect;
    }
    try {
      ++runDepth;
      const ret = fn();
      this.cleanup = typeof ret === "function" ? ret : undefined;
    } finally {
      --runDepth;
      activeSub = prev;
      this.flags &= ~ReactiveFlags.RecursedCheck;
    }
  }

  _update(): boolean {
    this.flags = ReactiveFlags.Mutable;
    return true;
  }

  _notify(): void {
    let e: Effect = this;
    let insertIndex = queuedLength;
    const firstInsertedIndex = insertIndex;
    do {
      queued[insertIndex++] = e;
      e.flags &= ~ReactiveFlags.Watching;
      const next = e.subs?.sub as Effect | undefined;
      if (next === undefined || !(next.flags & ReactiveFlags.Watching)) break;
      e = next;
    } while (true);
    queuedLength = insertIndex;
    // Reverse the just-inserted run so parents run after children.
    let idx = insertIndex;
    let firstIdx = firstInsertedIndex;
    while (firstIdx < --idx) {
      const left = queued[firstIdx];
      queued[firstIdx++] = queued[idx];
      queued[idx] = left;
    }
  }

  _unwatched(): void {
    this.flags = ReactiveFlags.None;
    disposeAllDepsInReverse(this);
    const sub = this.subs;
    if (sub !== undefined) unlink(sub);
    if (this.cleanup) this._runCleanup();
  }

  _run(): void {
    const flags = this.flags;
    if (flags & ReactiveFlags.Dirty || (flags & ReactiveFlags.Pending && checkDirty(this.deps!, this))) {
      if (flags & HasChildEffect) unlinkChildEffects(this);
      if (this.cleanup) {
        this._runCleanup();
        if (!this.flags) return;
      }
      this.depsTail = undefined;
      this.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
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
        this.flags &= ~ReactiveFlags.RecursedCheck;
        purgeDeps(this);
      }
    } else if (this.deps !== undefined) {
      this.flags = ReactiveFlags.Watching | (flags & HasChildEffect);
    }
  }

  _runCleanup(): void {
    const c = this.cleanup!;
    this.cleanup = undefined;
    const prev = activeSub;
    activeSub = undefined;
    try { c(); } finally { activeSub = prev; }
  }

  /** Dispose this effect. */
  stop(): void { this._unwatched(); }
}

// ── Factory helpers (parallel API surface) ────────────────────────

export function signal<T>(initial: T): Signal<T> { return new Signal(initial); }
export function computed<T>(getter: () => T): Computed<T> { return new Computed(getter); }
export function lens<T>(getter: () => T, setter: (v: T) => void): Lens<T> {
  return new Lens(getter, setter);
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

// ── follow / mirror as class-friendly helpers ─────────────────────

/** One-way binding: target ← src. Returns dispose. */
export function follow<T>(target: Signal<T> | Lens<T>, src: Signal<T> | Computed<T> | Lens<T>): () => void {
  return effect(() => { target.value = src.value; });
}

/** Two-way binding. `a` wins at setup. Returns dispose. */
export function mirror<T>(a: Signal<T> | Lens<T>, b: Signal<T> | Lens<T>): () => void {
  let busy = false;
  const dA = effect(() => {
    const v = a.value;
    if (busy) return;
    busy = true; try { b.value = v; } finally { busy = false; }
  });
  const dB = effect(() => {
    const v = b.value;
    if (busy) return;
    busy = true; try { a.value = v; } finally { busy = false; }
  });
  return () => { dA(); dB(); };
}

// ════════════════════════════════════════════════════════════════════
// STRUCT — typed cells, methods, getters, fields, traits, chain
// ════════════════════════════════════════════════════════════════════

// ── Trait interfaces (open registry, declaration-merge extensible) ──

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T> = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;
export interface CommonTraits<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
}

// ── Type system ──────────────────────────────────────────────────

export type Val<T> = T | (() => T);
export type RO<T> = Computed<T> | Signal<T> | Lens<T>;

type Of<X> =
  X extends Type<infer U, any> ? U : X extends FieldSpec<infer U> ? U : X;
type ShapeOf<V> =
  V extends Record<string, any>
    ? V extends Function
      ? V
      : { [K in keyof V]: Of<V[K]> }
    : V;
type FieldOf<X> =
  X extends Type<infer U, infer C>
    ? Cell<U, C>
    : X extends FieldSpec<infer U>
      ? Cell<U>
      : Cell<X>;
type Fields<V> =
  V extends Record<string, any>
    ? V extends Function
      ? {}
      : { readonly [K in keyof V]: FieldOf<V[K]> }
    : {};
type Methods<M, T> = {
  readonly [K in keyof M]: M[K] extends (self: T, ...a: infer A) => infer R
    ? (...a: A) => Computed<R>
    : never;
};
type Getters<G> = {
  readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never;
};

export type Cell<T, Cfg = unknown> = Signal<T> & {
  raw(): Chain<T, Cfg>;
} & (Cfg extends { value: infer V } ? Fields<V> : {}) &
  (Cfg extends { methods: infer M } ? Methods<M, T> : {}) &
  (Cfg extends { getters: infer G } ? Getters<G> : {});

export type Type<T = any, Cfg = unknown> = (Cfg extends { methods: infer M }
  ? M
  : {}) & {
  readonly tag: string;
  readonly value: any;
  readonly traits: Cfg extends { traits: infer Tr } ? Tr : {};
  readonly prototype: any;
  (init?: Partial<T>): Cell<T, Cfg>;
  is(v: unknown): v is Cell<T, Cfg>;
  with(init: T): FieldSpec<T>;
  chain(v: T): Chain<T, Cfg>;
};

export type Chain<T, Cfg> = { value: T } & (Cfg extends { methods: infer M }
  ? {
      [K in keyof M]: M[K] extends (self: T, ...a: infer A) => infer R
        ? R extends T
          ? (...a: A) => Chain<T, Cfg>
          : (...a: A) => R
        : never;
    }
  : {});

export interface FieldSpec<T = any> {
  readonly [BRAND]: "field";
  readonly type: Type<T, any>;
  readonly init: T;
}

export interface StructDef<T = any> {
  tag: string;
  value: any;
  methods?: Record<string, (self: T, ...args: any[]) => any>;
  getters?: Record<string, (this: any) => any>;
  traits?: CommonTraits<T> & Record<string, unknown>;
}

// ── Detection & utils ───────────────────────────────────────────

const BRAND = Symbol.for("minim.struct");
const isType = (v: any): boolean =>
  typeof v === "function" && v[BRAND] === "type";
const isFieldSpec = (v: any): v is FieldSpec =>
  v != null && typeof v === "object" && v[BRAND] === "field";

export const typeOf = <T>(c: any): Type<T> | undefined => c?.constructor;
export const unwrap = <T>(v: Val<T>): T =>
  typeof v === "function" ? (v as () => T)() : v;

/** Resolve `value:` entry → (initial value, type's prototype for sub-lens methods). */
function resolve(entry: any, override: any): { init: any; proto: any } {
  if (isType(entry))
    return { init: override ?? entry.value, proto: entry.prototype };
  if (isFieldSpec(entry))
    return { init: override ?? entry.init, proto: entry.type.prototype };
  return { init: override ?? entry, proto: null };
}

// ── struct() ────────────────────────────────────────────────────

// Names defined on cell prototypes — methods/getters/fields can't clash.
const RESERVED = new Set(["value", "peek", "constructor", "raw"]);

export function struct<const Cfg extends StructDef>(
  cfg: Cfg,
): Type<ShapeOf<Cfg["value"]>, Cfg> {
  const methods = cfg.methods ?? {};
  const getters = cfg.getters ?? {};
  const fields =
    cfg.value != null &&
    typeof cfg.value === "object" &&
    typeof cfg.value !== "function"
      ? Object.keys(cfg.value)
      : [];
  const seen = new Set<string>();
  for (const n of [
    ...Object.keys(methods),
    ...Object.keys(getters),
    ...fields,
  ]) {
    if (RESERVED.has(n))
      throw new Error(`struct(${cfg.tag}): "${n}" is reserved`);
    if (seen.has(n))
      throw new Error(
        `struct(${cfg.tag}): "${n}" collides across method/getter/field`,
      );
    seen.add(n);
  }

  // Cell class — extends Signal for reactive machinery; methods,
  // getters, and field-lenses live on its prototype.
  class CellCls extends Signal<any> {
    constructor(init: any) {
      const v = cfg.value;
      if (v != null && typeof v === "object" && typeof v !== "function") {
        const out: any = {};
        for (const k of Object.keys(v)) out[k] = resolve(v[k], init?.[k]).init;
        super(out);
      } else {
        super(init !== undefined ? init : v);
      }
    }
  }
  Object.defineProperty(CellCls, "name", { value: cfg.tag });
  const proto = CellCls.prototype as any;

  // Chain ctor (built early so the method loop can install both shapes).
  const Chain: any = function (this: any, v: any) { this.value = v; };

  // Methods get three lifts: reactive (cell), mutating (chain), static (Type).
  // One pass over `methods` installs all three.
  for (const [k, fn] of Object.entries(methods)) {
    proto[k] = function (this: CellCls, ...args: any[]) {
      const self = this;
      return computed(() => fn(self.value, ...args.map(unwrap)));
    };
    Chain.prototype[k] = function (this: any, ...a: any[]) {
      this.value = (fn as any)(this.value, ...a);
      return this;
    };
  }

  // Lazy getters — first access caches as own-prop.
  for (const [k, g] of Object.entries(getters)) {
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: any) {
        const v = g.call(this);
        Object.defineProperty(this, k, { value: v });
        return v;
      },
    });
  }

  // Lazy field lenses. For typed-entry fields, we need both Lens's
  // value get/set (delegating to parent) AND the typed methods/sub-
  // fields. Build a per-Type Lens subclass ONCE at struct() time
  // ("ViewLens") that extends Lens and carries the typed methods.
  // Each field-access just `new TypedLens(getter, setter)` — fast.
  //
  // Why not setPrototypeOf? Lens.prototype's `value` getter/setter
  // gets shadowed when the proto is swapped to the typed proto
  // (which inherits from Signal.prototype with a different value).
  // ViewLens keeps Lens's `value` on the chain via class inheritance.
  const viewCache = new Map<object, any>();
  function makeViewClass(typedProto: any): any {
    let cached = viewCache.get(typedProto);
    if (cached) return cached;
    class ViewLens extends Lens {}
    for (const pk of Object.getOwnPropertyNames(typedProto)) {
      if (pk === "constructor" || pk === "value") continue;
      const desc = Object.getOwnPropertyDescriptor(typedProto, pk);
      if (desc) Object.defineProperty(ViewLens.prototype, pk, desc);
    }
    viewCache.set(typedProto, ViewLens);
    return ViewLens;
  }
  for (const k of fields) {
    const subProto = resolve((cfg.value as any)[k], undefined).proto;
    const LensCls = subProto ? makeViewClass(subProto) : Lens;
    Object.defineProperty(proto, k, {
      configurable: true,
      enumerable: true,
      get(this: CellCls) {
        const self = this;
        const fl: any = new LensCls(
          () => (self.value as any)[k],
          (v: any) => { self.value = { ...(self.value as any), [k]: v }; },
        );
        // own-prop, non-configurable, non-writable, non-enumerable (all defaults)
        Object.defineProperty(this, k, { value: fl });
        return fl;
      },
    });
  }

  proto.raw = function (this: CellCls) {
    return new Chain(this.peek());
  };

  // Type function — `Vec({x,y})` constructs a CellCls; also carries
  // static methods, traits, helpers. Static methods come from the same
  // bag and are installed alongside reactive/chain methods (unified loop above).
  const Vec: any = function (init?: any) {
    return new CellCls(init);
  };
  Object.assign(Vec, methods);
  Vec.tag = cfg.tag;
  Vec.value = cfg.value;
  Vec.traits = cfg.traits ?? {};
  Vec[BRAND] = "type";
  Vec.prototype = proto;
  Vec.is = (v: any): boolean => v instanceof CellCls;
  Vec.with = (init: any): FieldSpec =>
    ({ [BRAND]: "field", type: Vec, init }) as FieldSpec;
  Vec.chain = (v: any) => new Chain(v);

  // Make `instance.constructor === Vec` (the Type) so `typeOf(cell)`
  // returns the type with `.traits`/`.tag`/`.is`/`.with`/`.chain`.
  Object.defineProperty(proto, "constructor", { value: Vec, configurable: true, writable: true });

  return Vec as Type<ShapeOf<Cfg["value"]>, Cfg>;
}
