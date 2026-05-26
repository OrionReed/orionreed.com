// Signal<T> — merged reactive engine: signal, computed, and lens modes
// in one class. Mode is determined by which fields are set:
//   - signal mode:   currentValue is truth, getter undefined
//   - computed mode: getter set, cachedValue is truth, no setter
//   - lens mode:     getter + setter set, cachedValue is truth on read
//
// `Vec extends Signal` is a natural prototype chain; `Vec.derive(fn)`
// and `Vec.lens(g, s)` install getter/setter on a fresh Vec instance
// to put it in computed/lens mode. `instanceof Vec` uses the native
// chain walk.
//
// Algorithm: alien-signals v2.
//
// This module is self-contained — it imports nothing from peer
// signals modules. Trait dispatch (`./traits`) and authoring helpers
// (`./writable`, etc.) are layered ON TOP of Signal; the engine has
// no knowledge of any trait, including equality. Subclasses thread
// custom equality through `super(v, { equals })` in their own
// constructor.
//
// Writability is type-tracked via `WritableBrand` and the `Writable<R>`
// / `WritableOf<T>` modifiers (declared below). The class declares
// `value` as `declare readonly value: T;` — the runtime accessor is
// installed on the prototype via `Object.defineProperty` after the
// class declaration, equivalent to compile output of `get value() { … }`
// syntax. Factory returns (`vec(…)`, `num(…)`, `signal(…)`, etc.) add
// the brand via cast; bare `Signal<T>` instances and any bare value
// class (`Vec`, `Num`, `Box`, …) are RO at the type level by default.
// `Writable<R>` re-adds a settable `value` via intersection.

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

interface Stack<T> {
  value: T;
  prev: Stack<T> | undefined;
}

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
/** Active `_NetworkNode` (only while a `network` body is running).
 *  When set, bare `signal.value =` writes self-exclude this node
 *  from the propagation walk — so a network body that reads + writes
 *  the same signal doesn't re-fire itself. Distinct from `activeSub`
 *  because regular `effect` bodies should NOT auto-self-exclude. */
let activeNetwork: _NetworkNode | undefined;
const queued: (Effect | _NetworkNode | undefined)[] = [];

/** Frozen sentinel for the common case of "nothing dirty this run".
 *  Saves a `new Set` per fire when no deps have value-changed (which
 *  is the steady-state for most networks between actual mutations). */
const EMPTY_DIRTY: ReadonlySet<Signal<unknown>> = Object.freeze(new Set<Signal<unknown>>());

// Re-entrancy guard for flush. See the comment block on `flush()` below.
let flushing = false;

// ─── Write hook (for assert/record attribution) ──────────────────────

let writeHook: ((sig: Signal<unknown>) => void) | undefined;
export function setSignalWriteHook(fn: ((sig: Signal<unknown>) => void) | undefined): () => void {
  const prev = writeHook;
  writeHook = fn;
  return () => {
    writeHook = prev;
  };
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
  const newLink: Link =
    (sub.depsTail =
    dep.subsTail =
      {
        version,
        dep,
        sub,
        prevDep,
        nextDep,
        prevSub,
        nextSub: undefined,
      });
  if (nextDep !== undefined) nextDep.prevDep = newLink;
  if (prevDep !== undefined) prevDep.nextDep = newLink;
  else sub.deps = newLink;
  if (prevSub !== undefined) prevSub.nextSub = newLink;
  else dep.subs = newLink;
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

function propagate(start: Link, innerWrite: boolean, excluding?: ReactiveNode): void {
  let l: Link | undefined = start;
  let next: Link | undefined = start.nextSub;
  let stack: Stack<Link | undefined> | undefined;
  top: do {
    const sub: ReactiveNode = l!.sub;
    // `excluding` skips a specific subscriber from notification —
    // used by `network()` so an effect that writes a signal it
    // subscribes to doesn't re-trigger itself. The advance / stack-
    // pop logic below runs unchanged, so other subs are visited
    // normally. Per-iteration cost: one identity compare.
    if (sub !== excluding) {
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
          if (nextSub !== undefined) {
            stack = { value: next, prev: stack };
            next = nextSub;
          }
          continue;
        }
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
  let l = startLink,
    sub = startSub;
  let stack: Stack<Link> | undefined;
  let checkDepth = 0,
    dirty = false;
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
      stack = { value: l, prev: stack };
      l = dep.deps!;
      sub = dep;
      ++checkDepth;
      continue;
    }
    if (!dirty) {
      const nextDep = l.nextDep;
      if (nextDep !== undefined) {
        l = nextDep;
        continue;
      }
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
        sub.flags &= ~F.Pending;
      }
      sub = l.sub;
      const nextDep = l.nextDep;
      if (nextDep !== undefined) {
        l = nextDep;
        continue top;
      }
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
  while (l !== undefined) {
    if (l === checkLink) return true;
    l = l.prevDep;
  }
  return false;
}

// Re-entrancy guard: effects that write to signals during their run
// trigger nested flush() via the `value` setter. The outer loop here
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
  while (l !== undefined) {
    const prev = l.prevDep;
    unlink(l, sub);
    l = prev;
  }
}

// ─── Public types ───────────────────────────────────────────────────

/** Plain T, thunk `() => T`, or any read-shape (Signal/Computed/…). */
export type Val<T> = T | (() => T) | Read<T>;

/** Covariant read-only surface (parameter-site for `Val<T>`). */
export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

/** Brand for writable receivers. Factories (`signal(v)`, `vec(...)`,
 *  `Vec.lens(...)`, invertible methods, etc.) return values carrying
 *  this brand. The brand is the discriminator for `field()`'s
 *  conditional return type — without it, TS can't tell RO from RW
 *  structurally. Drops to a no-op once `--enforceReadonly` ships. */
declare const WRITABLE: unique symbol;
export interface WritableBrand {
  readonly [WRITABLE]: never;
}

/** Extract the value type carried by any reactive read shape —
 *  `Signal<T>`, `Read<T>`, or any subclass thereof. */
export type Of<R> = R extends Signal<infer T> ? T : R extends Read<infer T> ? T : never;

/** "The writable form of R." Adds the writable brand and a settable
 *  `value: Of<R>` to the value class shape. */
export type Writable<R> = R & WritableBrand & { value: Of<R> };

/** T-anchored constraint for animator-style parameters:
 *
 *      function spring<T>(s: WritableOf<T>, target: T)
 *
 *  Equivalent to `Writable<Read<T>>` — a writable reactive carrying T.
 *  Satisfied by `Writable<Num>` / `Writable<Vec>` / any factory-
 *  returned writable signal. Bare RO value classes are rejected
 *  because they lack the brand. */
export type WritableOf<T> = Read<T> & WritableBrand & { value: T };

export function value<T>(v: Val<T>): T {
  if (v instanceof Signal) return v.value;
  if (typeof v === "function") return (v as () => T)();
  return v as T;
}

/** Resolve a `Val<T>` to a closure `() => T` that unwraps it on each
 *  call. Hot-path helper for animators that read reactive args every
 *  frame — set up once, invoke each tick. */
export function valFn<T>(v: Val<T>): () => T {
  if (v instanceof Signal) return () => v.value;
  if (typeof v === "function") return v as () => T;
  return () => v as T;
}

/** Self-rewriting lazy getter. First call computes `make()`, installs
 *  it as an own non-enumerable, non-configurable property under `key`,
 *  and returns it. Subsequent `self[key]` reads skip the surrounding
 *  getter entirely (own-property shadows prototype getter), so the
 *  steady-state cost is one property access.
 *
 *  Convention: `key` should match the surrounding getter's name. */
export function lazy<R>(self: object, key: string | symbol, make: () => R): R {
  const v = make();
  Object.defineProperty(self, key, {
    value: v,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return v;
}

export const isSignal = (v: unknown): v is Signal<unknown> => v instanceof Signal;

/** Runtime check: is this Signal in lens mode (both getter and setter)? */
export const isLens = (v: unknown): v is Signal<unknown> =>
  v instanceof Signal && v.getter !== undefined && v.setter !== undefined;

/** Runtime check: is this Signal in computed mode (getter, no setter)? */
export const isComputed = (v: unknown): v is Signal<unknown> =>
  v instanceof Signal && v.getter !== undefined && v.setter === undefined;

export interface SignalOptions<T = unknown> {
  /** First subscriber attached. */
  watched?: () => void;
  /** Last subscriber detached. */
  unwatched?: () => void;
  /** Per-instance equality; falls back to `===` when omitted. Value
   *  classes thread their own equality through `super(v, { equals })`
   *  in their constructor — engine never reaches into class statics. */
  equals?: (a: T, b: T) => boolean;
}

// ─── Statefulness inference ─────────────────────────────────────────
//
// A bwd is "stateful" iff it reads the receiver's input-position value
// to compute the new root state — `cyclic`'s nearest-representative,
// `Cls.lens`'s spread-replace, etc. The engine detects this from the
// bwd's declared arity (`bwd.length >= 2`), so users don't pass an
// explicit law tag:
//
//   .lens(v => v + 1, v => v - 1)         // 1-arg → stateless
//   .lens(v => v, (v, s) => stateful_fn)  // 2-arg → stateful
//
// Composition rule: a chain is stateful iff any layer in it is
// stateful. The setter dispatch branches on this — stateless setters
// skip `parent.peek()` and `priorFwd(s)`, which matters at depth.
//
// Footgun considerations:
//   - Default args reduce `Function.length` (e.g., `(v, s = 0) => …`
//     reports length 1). This is the only realistic way to misdeclare;
//     surfaces as: stateful logic gets s=undefined, default kicks in,
//     observed as a static value. Tested in footgun-probe.
//   - Rest params have `length === 0` → treated stateless. Same as
//     1-arg in observable behaviour.
//
// `field()` lenses additionally tag `_fusedOf.fieldPath`. Fusion of
// consecutive field edges collapses to a path-aware spread-replace
// setter that's ~3.5× faster than the generic stateful composition.

// biome-ignore lint/suspicious/noExplicitAny: arity-only inspection; types of v/s are irrelevant here
function isBwdStateful(bwd: ((v: any, s: any) => any) | undefined): boolean {
  return bwd !== undefined && bwd.length >= 2;
}

// ─── Field-path specialisation ──────────────────────────────────────
//
// Field chains (`tr.translate.x`, `box.center.x`, …) are the regression
// site for fusion: the generic stateful composition runs three user
// closures + `parent.peek()` per write. A path-aware setter walks the
// path in a single closure with one peek and N spreads — measurably
// faster (and matches the hand-rolled nested-lens baseline).
//
// Length-specialised fns hit the common cases (1-3 deep) without a
// loop; deeper chains fall back to `pathSetN`. Hot-path inlining
// matters here — V8 has no trouble with these specific shapes.

function makeFieldGetter<T>(path: readonly (string | number | symbol)[]): (s: unknown) => T {
  if (path.length === 1) {
    const k = path[0]!;
    return s => (s as Record<string | number | symbol, unknown>)[k] as T;
  }
  if (path.length === 2) {
    const k0 = path[0]!;
    const k1 = path[1]!;
    return s => {
      const a = (s as Record<string | number | symbol, unknown>)[k0] as Record<
        string | number | symbol,
        unknown
      >;
      return a[k1] as T;
    };
  }
  if (path.length === 3) {
    const k0 = path[0]!;
    const k1 = path[1]!;
    const k2 = path[2]!;
    return s => {
      const a = (s as Record<string | number | symbol, unknown>)[k0] as Record<
        string | number | symbol,
        unknown
      >;
      const b = a[k1] as Record<string | number | symbol, unknown>;
      return b[k2] as T;
    };
  }
  return s => {
    let cur: unknown = s;
    for (let i = 0; i < path.length; i++) {
      cur = (cur as Record<string | number | symbol, unknown>)[path[i]!];
    }
    return cur as T;
  };
}

function makeFieldSetter<T>(
  parent: Signal<unknown>,
  path: readonly (string | number | symbol)[],
): (v: T) => void {
  if (path.length === 1) {
    const k = path[0]!;
    return v => {
      const s = parent.peek() as object;
      parent._setWithExclusion({ ...s, [k]: v }, activeNetwork);
    };
  }
  if (path.length === 2) {
    const k0 = path[0]!;
    const k1 = path[1]!;
    return v => {
      const s = parent.peek() as Record<string | number | symbol, unknown>;
      const a = s[k0] as object;
      parent._setWithExclusion({ ...s, [k0]: { ...a, [k1]: v } }, activeNetwork);
    };
  }
  if (path.length === 3) {
    const k0 = path[0]!;
    const k1 = path[1]!;
    const k2 = path[2]!;
    return v => {
      const s = parent.peek() as Record<string | number | symbol, unknown>;
      const a = s[k0] as Record<string | number | symbol, unknown>;
      const b = a[k1] as object;
      parent._setWithExclusion({ ...s, [k0]: { ...a, [k1]: { ...b, [k2]: v } } }, activeNetwork);
    };
  }
  return v => {
    const s = parent.peek();
    parent._setWithExclusion(pathSetN(s, path, 0, v), activeNetwork);
  };
}

function pathSetN(
  s: unknown,
  path: readonly (string | number | symbol)[],
  i: number,
  v: unknown,
): unknown {
  if (i === path.length - 1) {
    return { ...(s as object), [path[i]!]: v };
  }
  const k = path[i]!;
  const inner = (s as Record<string | number | symbol, unknown>)[k];
  return { ...(s as object), [k]: pathSetN(inner, path, i + 1, v) };
}

// ─── The Signal class ──────────────────────────────────────────────

/** Single reactive primitive. Mode is determined by which fields are set.
 *
 *  Fields:
 *    - `currentValue`/`pendingValue` — signal-mode storage
 *    - `cachedValue` — computed/lens cached evaluation
 *    - `getter` — when set, instance is in computed/lens mode
 *    - `setter` — when set with getter, instance is in lens mode
 *
 *  Construction patterns:
 *    - `new Signal(initial)` — signal mode
 *    - `signal(initial)` — same as `new Signal(initial)`
 *    - `computed(fn)` — computed mode (untyped)
 *    - `Vec.derive(fn)` — computed mode (typed as Cls instance)
 *    - `lens(get, set)` — lens mode (untyped)
 *    - `Vec.lens(get, set)` — lens mode (typed)
 *    - `new Vec(initial)` where Vec extends Signal — typed signal mode
 *
 *  Type predicates: `isSignal(x)`, `isComputed(x)`, `isLens(x)`.
 */
export class Signal<T = unknown> implements ReactiveNode {
  // Engine fields — module-level functions (link/propagate/etc) need
  // to read these, so they stay public.
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Mutable;
  currentValue: T;
  pendingValue: T;
  cachedValue: T | undefined = undefined;
  /** Set when this Signal is in computed/lens mode. Public for
   *  engine/factory access (used by `Signal.install`, internal _update
   *  flows, etc). Don't reassign from consumer code — corrupts mode
   *  state. Naming convention `_getter`/`_setter` would signal intent
   *  better but breaks back-compat with code that reads `.getter` as
   *  a predicate. Treated as `@internal`. */
  getter: (() => T) | undefined = undefined;
  setter: ((v: T) => void) | undefined = undefined;
  /** Per-instance equality override (from `opts.equals`); falls back
   *  to `===` when undefined. Hot-read on every write. */
  _equals: ((a: T, b: T) => boolean) | undefined = undefined;
  _watched?: () => void;
  _unwatchedHook?: () => void;
  /** Fusion tag. Marks this cell as a value-space pipeline (fwd, bwd?)
   *  on top of a root `parent`. Subsequent `.lens()` (endo),
   *  `Cls.lens(this, ...)`, `Cls.derive(this, ...)`, or `field()`
   *  calls on this cell collapse the chain into a single cell
   *  pointing at the same root, composing fwd/bwd in value-space.
   *  Internal.
   *
   *  `stateful` is true iff any layer's `bwd` declares `(v, s) => …`
   *  (arity ≥ 2). The setter dispatch branches on this — stateless
   *  setters skip `parent.peek()` + `priorFwd(s)`, which is the perf
   *  optimisation for iso chains.
   *
   *  `fieldPath`, when set, identifies the bwd as a chain of "set
   *  field at key" operations, which `_fuse` collapses into a single
   *  spread-replace closure. Headline optimisation for `tr.translate.x`. */
  _fusedOf?: {
    parent: Signal<unknown>;
    fwd: (s: unknown) => T;
    bwd?: (v: T, s: unknown) => unknown;
    stateful: boolean;
    fieldPath?: readonly (string | number | symbol)[];
  };

  /** @internal — symmetric-lens metadata. Present when this cell was
   *  built by `Cls.symmetricLens(...)`, or when a `.lens(F, B)` was
   *  fused on top of one. Lets `.lens()` recognise a symmetric
   *  receiver and inline F/B into the spec directly. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque to engine
  _symOf?: SymmetricMeta<T, any>;

  constructor(initial: T, opts?: SignalOptions<T>) {
    this.currentValue = initial;
    this.pendingValue = initial;
    if (opts) {
      if (opts.equals) this._equals = opts.equals;
      if (opts.watched) this._watched = opts.watched;
      if (opts.unwatched) this._unwatchedHook = opts.unwatched;
    }
  }

  /** Friend factory used by `computed` / `lens` and the per-class
   *  statics (`Vec.lens`, `Vec.derive`, …) to flip a fresh instance
   *  into computed or lens mode. Static access from Signal lets us
   *  assign the getter/setter slots on any subclass instance.
   *  `(...args: never[])` lets us pass any constructor regardless of
   *  its declared arity (incl. `Signal` itself whose ctor takes T).
   *
   *  This is the lower-level typed factory: for parent-based lenses,
   *  prefer `Cls.lens(parent, fwd, bwd)` / `Cls.derive(parent, fn)`.
   *
   *  Overload: with a setter, returns `Writable<C>` (the writable
   *  form: `C & WritableBrand & { value: Of<C> }`). Without, returns
   *  plain `C` (read-only at the type level). */
  static install<T, C extends Signal<T>>(Cls: new (...args: never[]) => C, getter: () => T): C;
  static install<T, C extends Signal<T>>(
    Cls: new (...args: never[]) => C,
    getter: () => T,
    setter: (v: T) => void,
  ): Writable<C>;
  static install<T, C extends Signal<T>>(
    Cls: new (...args: never[]) => C,
    getter: () => T,
    setter?: (v: T) => void,
  ): C | Writable<C> {
    const inst = new Cls();
    inst.getter = getter;
    if (setter !== undefined) inst.setter = setter;
    inst.flags = 0;
    return inst;
  }

  /** @internal — flag query for `isLens` / `isComputed` from outside.
   *  Has private-field access from inside Signal's static context. */
  static _mode(v: Signal<unknown>): "signal" | "computed" | "lens" {
    if (v.getter === undefined) return "signal";
    return v.setter === undefined ? "computed" : "lens";
  }

  /** Type predicate against this class. `Vec.is(x)` narrows `x` to
   *  `Vec`. Inherited static; works for any subclass via the
   *  polymorphic `this` constructor type. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors derive
  static is<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    v: unknown,
  ): v is InstanceType<C> {
    return v instanceof this;
  }

  /** Read-only typed view. Three call shapes:
   *
   *    Cls.derive(parent, fn)    — 1-input. Goes through `_fuse`,
   *                                inherits fusion + field-path fast paths.
   *    Cls.derive(parents, fn)   — N-input. Aggregates over an array.
   *    Cls.derive(fn)            — closure-style; deps captured inside `fn`.
   *
   *  Polymorphic-`this` static: `Vec.derive(...)` → `Vec`, etc. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Signal<any>, P>(
    this: C,
    parent: Read<P>,
    fn: (v: P) => Of<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<
    C extends new (
      ...args: never[]
    ) => Signal<any>,
    P extends readonly Read<unknown>[],
  >(
    this: C,
    parents: P,
    fn: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => Of<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static derive<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    fn: () => Of<InstanceType<C>>,
  ): InstanceType<C>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static derive(this: any, ...args: any[]): any {
    if (args.length === 1) {
      // Closure-style: deps captured by reading inside `fn`.
      return Signal.install(this, args[0]);
    }
    const [parent, fn] = args;
    if (Array.isArray(parent)) return _fanin(this, parent, fn);
    return Signal._fuse(parent, this, fn);
  }

  /** Read-write typed lens. Three call shapes:
   *
   *    Cls.lens(parent, fwd, bwd)    — 1-input. Goes through `_fuse`.
   *    Cls.lens(parents, fwd, bwd)   — N-input.
   *    Cls.lens(g, s)                — closure-style getter/setter.
   *
   *  `bwd` is typed `(target, v) => P`; engine arity-detects statefulness
   *  via `bwd.length`. Polymorphic-`this`: `Vec.lens(...)` → `Writable<Vec>`. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Signal<any>, P>(
    this: C,
    parent: Read<P>,
    fwd: (v: P) => Of<InstanceType<C>>,
    bwd: (target: Of<InstanceType<C>>, v: P) => P,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Signal<any>, P extends readonly Read<unknown>[]>(
    this: C,
    parents: P,
    fwd: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => Of<InstanceType<C>>,
    bwd: (
      target: Of<InstanceType<C>>,
      vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
    ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static lens<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    g: () => Of<InstanceType<C>>,
    s: (v: Of<InstanceType<C>>) => void,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static lens(this: any, ...args: any[]): any {
    if (args.length === 2) {
      // Closure-style: getter + setter.
      return Signal.install(this, args[0], args[1]);
    }
    const [parent, fwd, bwd] = args;
    if (Array.isArray(parent)) return _fanin(this, parent, fwd, bwd);
    return Signal._fuse(parent, this, fwd, bwd);
  }

  /** Symmetric lens with a private complement. The complement is
   *  engine-managed state that the spec's `putr` (read) and `putl`
   *  (write) mutate. It preserves information the view alone discards,
   *  eliminating the "trap" behaviour of multiplicative/sign-ambiguous
   *  lenses (spread-to-zero, axis sign-flip, etc.).
   *
   *    Cls.symmetricLens(parent,   spec)   — 1-input.
   *    Cls.symmetricLens([parents], spec)  — N-input.
   *
   *  `spec.putr` returns the view value directly; `spec.putl` returns
   *  per-parent updates. Both mutate `complement` in place through
   *  field writes. For "primitive complement" wrap in `{ value: T }`.
   *
   *  Fusion: a subsequent `.lens(F, B)` on the resulting cell collapses
   *  into a single cell that shares the same complement (no extra
   *  cell layer, no extra getter dispatch). Chained `.lens()` continues
   *  to fuse. The internal multi-parent fanin is NOT collapsed (the
   *  fan-out shape can't be expressed as a single-parent chain). */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static symmetricLens<C extends new (...args: never[]) => Signal<any>, P, COMP>(
    this: C,
    parent: Read<P>,
    spec: SymmetricLensSpec1<P, Of<InstanceType<C>>, COMP>,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static symmetricLens<
    C extends new (
      ...args: never[]
    ) => Signal<any>,
    P extends readonly Read<unknown>[],
    COMP,
  >(
    this: C,
    parents: P,
    spec: SymmetricLensSpecN<
      { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
      Of<InstanceType<C>>,
      COMP
    >,
  ): Writable<InstanceType<C>>;
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  static symmetricLens(this: any, parent: any, spec: any): any {
    if (Array.isArray(parent)) return _symmetric(this, parent, spec);
    return _symmetric(this, [parent], _liftSpec1(spec));
  }

  /** Constant-projection lens — a `Writable<this>` whose reads always
   *  return `v` and whose writes are absorbed (projected back to `v`).
   *  The "writable-shaped constant": fills `Writable<Cls>` slots in APIs
   *  that demand bidirectionality, while structurally locking the value.
   *
   *  Same family as `.clamp(c, c)` — an idempotent projection collapsed
   *  to a single point. Composes through fusion as a normal lens.
   *
   *      const lockedY = Num.pin(100);          // y locked at 100
   *      vec(slider, Num.pin(100))              // writable Vec, y absorbed
   *      Vec.pin({ x: 0, y: 0 })                // origin anchor
   *
   *  Encapsulated: the underlying constant has no external reference,
   *  so writes can't accidentally bypass the projection. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  static pin<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    v: Of<InstanceType<C>>,
  ): Writable<InstanceType<C>> {
    return Signal.install(
      this,
      () => v,
      () => {},
    ) as unknown as Writable<InstanceType<C>>;
  }

  /** Endo-lens: same-class lens via `(fwd, bwd)` in value-space.
   *  Auto-fuses: `.lens(F, B)` after `.lens(f, b)` collapses to one
   *  cell with composed fns.
   *
   *  Statefulness inferred from `bwd.length`:
   *    - `bwd: v => …`       — stateless. Iso/projection chains fuse
   *                            to a fast setter that skips `parent.peek()`.
   *    - `bwd: (v, s) => …`  — stateful. Engine threads the receiver
   *                            value through `s`. See `cyclic`.
   *
   *  TS inference: declaring the param as `(v: T, s: T) => T` lets
   *  unary lambdas (`v => …`) infer `v: T` cleanly via contextual
   *  typing while still accepting binary `(v, s) => …` forms. JS's
   *  parameter-arity tolerance handles the rest at runtime.
   *
   *  Smart-dispatch on RO receivers: if `this` is a fused-RO chain,
   *  the bwd has no place to land — drop it and build a computed
   *  via `fwd` only. */
  lens(this: Signal<T>, fwd: (v: T) => T, bwd: (v: T, s: T) => T): this {
    const Cls = this.constructor as new (...args: never[]) => Signal<T>;
    // Symmetric-lens receiver: collapse F/B into one fused cell that
    // shares the inner spec's complement (skips the .lens cell layer).
    const symOf = this._symOf;
    if (symOf !== undefined) {
      return _fuseOnSymmetric(
        Cls as new (
          ...args: never[]
        ) => Signal<unknown>,
        symOf as unknown as SymmetricMeta<unknown, unknown>,
        fwd as (v: unknown) => unknown,
        bwd as (v: unknown, s: unknown) => unknown,
      ) as unknown as this;
    }
    if (this._fusedOf !== undefined && this._fusedOf.bwd === undefined) {
      return Signal._fuse(
        this as Signal<unknown>,
        Cls as new (
          ...args: never[]
        ) => Signal<unknown>,
        fwd as (s: unknown) => unknown,
      ) as unknown as this;
    }
    return Signal._fuse(
      this as Signal<unknown>,
      Cls as new (
        ...args: never[]
      ) => Signal<unknown>,
      fwd as (s: unknown) => unknown,
      bwd as (v: unknown, s: unknown) => unknown,
    ) as unknown as this;
  }

  /** Internal fusion helper used by the instance `.lens()` (endo),
   *  `Cls.lens(parent, ...)`, `Cls.derive(parent, ...)`, and `field()`.
   *  Collapses receiver-anchored chains in value-space.
   *
   *  Statefulness is inferred from `bwdLocal.length` (≥ 2 → stateful).
   *  The composite chain is stateful iff any layer is. The setter
   *  branches on this — stateless setters skip `parent.peek()` and
   *  `priorFwd(s)`, which matters at depth.
   *
   *  Field-path specialisation: if `fieldKey` is set AND the prior
   *  chain is also field-tagged (or empty), we collapse to a path-
   *  walking spread-replace setter that skips priorFwd/bwdLocal/priorBwd
   *  dispatch entirely. ~3.5× faster than the generic stateful setter.
   *
   *  Error: a writable view on top of a fused-RO receiver (e.g.
   *  `Cls.lens(<RO chain>, ...)`) has no bwd path. We throw a
   *  `TypeError` at construction. */
  static _fuse<U>(
    receiver: Signal<unknown>,
    Cls: new (...args: never[]) => Signal<U>,
    fwdLocal: (s: unknown) => U,
    bwdLocal?: (v: U, s: unknown) => unknown,
    /** Optional: the `key` if `bwdLocal` is a field-set pattern. */
    fieldKey?: string | number | symbol,
  ): Signal<U> {
    const prior = receiver._fusedOf as
      | {
          parent: Signal<unknown>;
          fwd: (s: unknown) => unknown;
          bwd?: (v: unknown, s: unknown) => unknown;
          stateful: boolean;
          fieldPath?: readonly (string | number | symbol)[];
        }
      | undefined;

    if (bwdLocal !== undefined && prior !== undefined && prior.bwd === undefined) {
      throw new TypeError(
        "Signal: cannot install a writable view on top of a read-only fused chain. " +
          "The receiver is a computed (no bwd path); Cls.lens / .lens require a writable parent.",
      );
    }

    const parent = prior !== undefined ? prior.parent : receiver;
    const priorFwd = prior?.fwd;
    const priorBwd = prior?.bwd;
    const priorStateful = prior?.stateful ?? false;
    const localStateful = isBwdStateful(bwdLocal);
    // Composite chain is stateful iff any layer is. RO cells (no
    // bwd at this layer) inherit prior's flag — they don't add bwd
    // statefulness, but downstream fusion has to know whether the
    // chain *can* compose to a stateful bwd.
    const stateful = bwdLocal === undefined ? priorStateful : priorStateful || localStateful;
    const stateless = !stateful;

    const composedFwd: (s: unknown) => U = priorFwd ? s => fwdLocal(priorFwd(s)) : fwdLocal;

    // ── Field-path specialisation ──
    //
    // When fusing `field(K)` and the entire chain so far is field-
    // tagged (or empty), collapse to a path-walking spread-replace
    // setter that skips priorFwd/bwdLocal/priorBwd dispatch.
    //
    // Critical correctness condition: the fast path can only run when
    // every layer in the chain is a field edge. If prior has a non-
    // field stateful bwd (e.g., a custom `Cls.lens` cross-class lens
    // or an endo `.lens` iso layer), we MUST fall back to the generic
    // composition — the fast path's setter writes directly to root
    // with the path, bypassing any non-field bwd in between.
    let composedPath: readonly (string | number | symbol)[] | undefined;
    if (fieldKey !== undefined) {
      if (prior === undefined) {
        composedPath = [fieldKey];
      } else if (prior.fieldPath !== undefined) {
        composedPath = [...prior.fieldPath, fieldKey];
      }
      // Otherwise: prior has a non-field bwd. composedPath stays
      // undefined → generic stateful composition runs.
    }

    let inst: Signal<U>;

    if (composedPath !== undefined && bwdLocal !== undefined) {
      // ── Field-path fast path ──
      // Build a path-walking getter/setter without the user-closure
      // composition. ~2x faster than the generic stateful setter on
      // 2-deep field chains.
      const path = composedPath;
      const getter = makeFieldGetter<U>(path);
      const setter = makeFieldSetter<U>(parent, path);
      inst = Signal.install(Cls, () => getter(parent.value), setter);
    } else if (bwdLocal === undefined) {
      // RO cell (Cls.derive). No setter.
      inst = Signal.install(Cls, () => composedFwd(parent.value));
    } else if (priorBwd === undefined) {
      // 1-level writable.
      inst = stateless
        ? Signal.install(
            Cls,
            () => composedFwd(parent.value),
            v => {
              parent._setWithExclusion(bwdLocal(v, undefined as never), activeNetwork);
            },
          )
        : Signal.install(
            Cls,
            () => composedFwd(parent.value),
            v => {
              parent._setWithExclusion(bwdLocal(v, parent.peek()), activeNetwork);
            },
          );
    } else {
      // 2+-level writable: inline the composition into the setter.
      inst = stateless
        ? Signal.install(
            Cls,
            () => composedFwd(parent.value),
            v => {
              parent._setWithExclusion(
                priorBwd(bwdLocal(v, undefined as never), undefined as never),
                activeNetwork,
              );
            },
          )
        : Signal.install(
            Cls,
            () => composedFwd(parent.value),
            v => {
              const s = parent.peek();
              parent._setWithExclusion(priorBwd(bwdLocal(v, priorFwd!(s)), s), activeNetwork);
            },
          );
    }

    // composedBwd: stored on `_fusedOf` for downstream fusion to
    // compose against (when subsequent .lens()/Cls.lens lands on
    // this cell).
    const composedBwd: ((v: U, s: unknown) => unknown) | undefined =
      bwdLocal === undefined
        ? undefined
        : priorBwd === undefined
          ? bwdLocal
          : stateless
            ? (v, s) => priorBwd(bwdLocal(v, s), s)
            : (v, s) => priorBwd(bwdLocal(v, priorFwd!(s)), s);

    (inst as Signal<U>)._fusedOf = {
      parent,
      fwd: composedFwd,
      bwd: composedBwd,
      stateful,
      fieldPath: composedPath,
    };
    return inst as Signal<U>;
  }

  /** Field lens onto `parent.value[key]`. Optimised path: when chained
   *  on top of another `fieldOf` lens, the fused setter walks the full
   *  path in a single closure instead of composing per-layer spread-
   *  replace user closures.
   *
   *  Use via `field(parent, "key", Cls)` from `./writable.ts`; this
   *  static is the engine entry point. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors Cls.lens
  static fieldOf<C extends new (...args: never[]) => Signal<any>>(
    // biome-ignore lint/suspicious/noExplicitAny: variance escape — concrete Signal<T> contravariant on setter
    parent: Signal<any>,
    key: string | number | symbol,
    Cls: C,
  ): InstanceType<C> {
    return Signal._fuse(
      parent as Signal<unknown>,
      Cls as unknown as new (
        ...args: never[]
      ) => Signal<Of<InstanceType<C>>>,
      s => (s as Record<string | number | symbol, unknown>)[key] as Of<InstanceType<C>>,
      // 2-arg bwd → arity-detected as stateful.
      (v, s) => ({ ...(s as object), [key]: v }) as unknown,
      key,
    ) as InstanceType<C>;
  }

  /** Reactive value. Read tracks dependencies; write triggers
   *  propagation. Type level: RO; widen via `Writable<R>` to gain a
   *  settable `.value`. Runtime: accessor installed on `Signal.prototype`
   *  via `Object.defineProperty` after class declaration. (Class
   *  `get value()`/`set value()` syntax also compiles to a prototype
   *  defineProperty under the hood — no V8 perf delta.) */
  declare readonly value: T;

  /** @internal — write `next`, propagating to all subs except `excluding`.
   *  Used by the `value` setter (excludes activeNetwork) and
   *  engine-internal lens/field setters. */
  _setWithExclusion(next: T, excluding: ReactiveNode | undefined): void {
    // Computed/lens slow path — same as before, no exclusion concept
    // (writes go through a setter callback the user installed).
    if (this.getter !== undefined) {
      const set = this.setter;
      if (set === undefined) throw new TypeError("Cannot write to a Computed");
      set(next);
      return;
    }
    const prev = this.pendingValue;
    this.pendingValue = next;
    const equals = this._equals;
    const same = equals ? equals(prev, next) : prev === next;
    if (!same) {
      this.flags = F.Mutable | F.Dirty;
      if (writeHook !== undefined) writeHook(this as Signal<unknown>);
      const subs = this.subs;
      if (subs !== undefined) propagate(subs, runDepth > 0, excluding);
      if (batchDepth === 0 && subs !== undefined) {
        flush();
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
      try {
        return this.value;
      } finally {
        activeSub = prev;
      }
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
    throw new TypeError(`Signal cannot be coerced to ${hint} — use \`.value\``);
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

  _update(): boolean {
    this.flags = F.Mutable;
    return true;
  }

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
    let idx = insertIndex,
      firstIdx = firstInsertedIndex;
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
      if (this.cleanup) {
        this._runCleanup();
        if (!this.flags) return;
      }
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
    try {
      c();
    } finally {
      activeSub = prev;
    }
  }
}

// Install `Signal.prototype.value` accessor. Pulled out of the class
// body so the type-level declaration (`declare readonly value: T`)
// can mark `value` as RO without TS stripping the runtime setter.
// Subclasses inherit the accessor; bare `Signal<T>` and `Vec`/`Num`/…
// are RO at the type level by default. `Writable<R>` re-adds a
// settable `.value` via intersection.
//
// V8: prototype-level Object.defineProperty done once at module load
// is the same shape class-syntax accessors compile to. No deopt.
Object.defineProperty(Signal.prototype, "value", {
  get(this: Signal<unknown>): unknown {
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
          this.flags = threw ? F.Mutable | F.Dirty : this.flags & ~F.RecursedCheck;
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
  },
  set(this: Signal<unknown>, next: unknown): void {
    // Inside a `network` body, bare `value =` writes self-exclude the
    // running network node so its body doesn't re-fire from its own writes.
    // Outside a network (regular effect, no reactive context), this is
    // `undefined` and behaviour matches the pre-network engine.
    this._setWithExclusion(next, activeNetwork);
  },
  enumerable: false,
  configurable: false,
});

// ─── Network: reactive sub-DAG with self-excluded writes ────────────
//
// `network()` is the building block for constraint networks,
// propagators, bidirectional relations — any "many signals tied
// together with feedback" abstraction that doesn't fit the dep-DAG
// pipeline shape. Four guarantees the framework provides:
//
//   1. Body re-runs when any subscribed dep changes.
//   2. Bare `signal.value =` writes inside the body self-exclude
//      this network — so termination is structural, not convergence-
//      based.
//   3. The body runs inside `batch()`, so all writes commit atomically
//      to downstream observers (glitch-free).
//   4. `body` receives `dirty` — the set of subscribed signals
//      whose value changed since last run. Empty sentinel on the
//      first run.
//
// Two subscription shapes:
//
//   network(body, opts?)        — IMPLICIT deps. Body's `.value`
//                                 reads auto-subscribe (effect-like).
//                                 Subs purge between runs to match
//                                 the body's current read pattern.
//                                 Convenient for casual use; matches
//                                 effect/computed mental model.
//
//   network(deps, body, opts?)  — EXPLICIT deps. The deps array IS
//                                 the topology. Body's `.value`
//                                 reads do NOT subscribe; only the
//                                 declared deps do. The handle has
//                                 `subscribe(...sigs)` and
//                                 `unsubscribe(...sigs)` to grow or
//                                 shrink the topology dynamically.
//                                 Predictable, no auto-track surprises.
//
// `manual: true` defers auto-firing: dep changes mark the network
// dirty but the body only runs on `flush()`. The initial run still
// happens on construction. Use case: per-frame physics where you
// want to coalesce all sub-frame mutations into a single tick.

/** Handle to a `network` invocation. */
export interface Network {
  /** Tear down: unsubscribe from every signal, drop internal state. */
  dispose(): void;
  /** Run the body now. In auto mode, equivalent to a no-op when
   *  nothing has changed. In manual mode, this is the only way to
   *  advance after construction. */
  flush(): void;
  /** Add signals to the network's topology (explicit-deps mode only).
   *  Idempotent. Does NOT fire the body — call `flush()` if you want
   *  the body to re-run with the new topology. No-op on
   *  implicit-deps networks. */
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  subscribe(...sigs: Signal<any>[]): void;
  /** Remove signals from the network's topology (explicit-deps mode
   *  only). Idempotent. Body is NOT re-run by unsubscribe. */
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  unsubscribe(...sigs: Signal<any>[]): void;
}

type NetworkBody = (dirty: ReadonlySet<Signal<unknown>>, handle: Network) => void;

class _NetworkNode implements ReactiveNode {
  subs: Link | undefined = undefined;
  subsTail: Link | undefined = undefined;
  deps: Link | undefined = undefined;
  depsTail: Link | undefined = undefined;
  flags: number = F.Watching | F.RecursedCheck;
  body: NetworkBody;
  manual: boolean;
  /** Per-instance last-seen values for current deps. Used to compute
   *  `dirty` at the start of each run. */
  lastValues: Map<Signal<unknown>, unknown> = new Map();
  /** Set by `_notify` in manual mode. Read by `flush()`. */
  pending: boolean = false;
  /** Once disposed, every subsequent `flush()` and `_run()` is a no-op. */
  disposed: boolean = false;
  /** True while `_runBody` is on the call stack. Guards against
   *  re-entrant `flush()` calls from inside the body (which would
   *  stack-overflow without this guard). */
  private _running: boolean = false;
  /** Cycle counter used by our own `link()` calls. Doesn't need to
   *  align with the engine's `cycle` global — it's only used by
   *  `link()`'s same-cycle skip-rule. */
  private _ownCycle: number = 0;
  /** Set mirror of the deps linked list. O(1) membership test for
   *  `subscribe`/`unsubscribe`. */
  private _depsSet: Set<Signal<unknown>> = new Set();
  /** Handle passed to the body. Set by `_initWithHandle()` after
   *  factory wraps the node in a Network handle, before initial fire. */
  private _handle!: Network;

  constructor(body: NetworkBody, manual: boolean) {
    this.body = body;
    this.manual = manual;
  }

  /** Two-phase init: factory constructs the node, builds the handle
   *  (which closes over `this`), then calls `_initWithHandle(handle)`
   *  to link initial deps and run the first body. This way the body
   *  sees its own handle on the very first fire. */
  _initWithHandle(handle: Network, initialDeps: readonly Signal<unknown>[]): void {
    this._handle = handle;
    this._linkBatch(initialDeps);
    this._runBody(EMPTY_DIRTY);
  }

  _update(): boolean {
    this.flags = F.Mutable;
    return true;
  }

  _notify(): void {
    if (this.manual) {
      this.pending = true;
      this.flags |= F.Watching;
      return;
    }
    queued[queuedLength++] = this;
    this.flags &= ~F.Watching;
  }

  _unwatched(): void {
    this.disposed = true;
    this.flags = F.None;
    disposeAllDepsInReverse(this);
    const sub = this.subs;
    if (sub !== undefined) unlink(sub);
    this.lastValues.clear();
  }

  _run(): void {
    if (this.disposed) return;
    const flags = this.flags;
    if (flags & F.Dirty || (flags & F.Pending && checkDirty(this.deps!, this))) {
      this._runBody(this._computeDirty());
    } else if (this.deps !== undefined) {
      this.flags = F.Watching;
    }
  }

  private _computeDirty(): ReadonlySet<Signal<unknown>> {
    let dirty: Set<Signal<unknown>> | undefined;
    for (const [sig, lastVal] of this.lastValues) {
      if (sig.peek() !== lastVal) {
        if (dirty === undefined) dirty = new Set();
        dirty.add(sig);
      }
    }
    return dirty ?? EMPTY_DIRTY;
  }

  private _runBody(dirty: ReadonlySet<Signal<unknown>>): void {
    this.flags = F.Watching | F.RecursedCheck;
    this._running = true;
    const prevSettler = activeNetwork;
    activeNetwork = this;
    try {
      ++cycle;
      ++runDepth;
      ++batchDepth;
      try {
        this.body(dirty, this._handle);
      } finally {
        if (!--batchDepth) flush();
      }
    } finally {
      --runDepth;
      activeNetwork = prevSettler;
      this.flags &= ~F.RecursedCheck;
      this._running = false;
      // Snapshot deps' values for next run's dirty computation.
      this.lastValues.clear();
      let l = this.deps;
      while (l !== undefined) {
        const sig = l.dep as Signal<unknown>;
        this.lastValues.set(sig, sig.peek());
        l = l.nextDep;
      }
    }
    this.pending = false;
  }

  flush(): void {
    if (this.disposed) return;
    if (this._running) {
      throw new Error(
        "network: flush() called from inside body — would recurse infinitely. " +
          "If you need to re-run after a topology change, return from the body and " +
          "let the next dep change (or the caller) drive the next fire.",
      );
    }
    this._runBody(this._computeDirty());
  }

  /** Add signals to the topology. Idempotent — already-subscribed
   *  signals are skipped. Does NOT fire the body; call `flush()` if
   *  you want the body to re-run with the new topology. (Splitting
   *  these lets callers add many deps cheaply and fire once at the
   *  end.) */
  subscribe(sigs: readonly Signal<unknown>[]): void {
    if (this.disposed) return;
    this._linkBatch(sigs);
  }

  /** Remove signals from the topology. Idempotent. Doesn't fire the
   *  body. */
  unsubscribe(sigs: readonly Signal<unknown>[]): void {
    if (this.disposed) return;
    const set = this._depsSet;
    for (const s of sigs) {
      if (!set.has(s)) continue;
      set.delete(s);
      let l = this.deps;
      while (l !== undefined) {
        if (l.dep === s) {
          unlink(l, this);
          break;
        }
        l = l.nextDep;
      }
    }
  }

  /** Batch-link N signals into the deps chain. depsTail is
   *  positioned once at the current tail; each successful `link()`
   *  call sets `depsTail = newLink`, so subsequent appends are O(1).
   *  This avoids O(N²) re-walks on large initial-dep arrays. */
  private _linkBatch(sigs: readonly Signal<unknown>[]): void {
    const set = this._depsSet;
    // Walk to current tail once.
    let tail = this.deps;
    if (tail !== undefined) {
      while (tail.nextDep !== undefined) tail = tail.nextDep;
    }
    this.depsTail = tail;
    for (const s of sigs) {
      if (set.has(s)) continue;
      set.add(s);
      link(s as ReactiveNode, this, ++this._ownCycle);
    }
  }
}

/** Build a reactive sub-DAG node.
 *
 *  ```ts
 *  const n = network([a, b], (dirty, n) => {
 *    // body fires when a or b changes; reads of c, d, ... here
 *    // do NOT add subscriptions.
 *    // dirty: subset of {a, b} that changed since last fire.
 *    // n: the network's own handle (subscribe / unsubscribe / dispose).
 *  });
 *  // grow/shrink topology dynamically:
 *  n.subscribe(c);
 *  n.unsubscribe(a);
 *  ```
 *
 *  Promises:
 *  - Body fires when any subscribed dep changes.
 *  - `signal.value =` writes inside the body self-exclude THIS
 *    network so it doesn't re-trigger itself.
 *  - Body runs inside `batch()`; writes commit atomically.
 *  - Topology is exactly the deps array + later subscribe/unsubscribe.
 *    Reads inside the body DO NOT add to the topology.
 *  - `flush()` from inside the body throws (would recurse infinitely).
 *  - `manual: true` defers auto-firing; only `flush()` advances. */
export function network(
  // biome-ignore lint/suspicious/noExplicitAny: deps come in many flavours
  deps: readonly Signal<any>[],
  body: (dirty: ReadonlySet<Signal<unknown>>, handle: Network) => void,
  opts?: { manual?: boolean },
): Network {
  const node = new _NetworkNode(body, opts?.manual ?? false);
  const handle: Network = {
    dispose: () => node._unwatched(),
    flush: () => node.flush(),
    subscribe: (...sigs) => node.subscribe(sigs),
    unsubscribe: (...sigs) => node.unsubscribe(sigs),
  };
  node._initWithHandle(handle, deps as readonly Signal<unknown>[]);
  return handle;
}

// ─── Public factories ────────────────────────────────────────────────

/** Writable source. Returns a branded `Signal<T>` so `.value =` is
 *  callable on it. Use `new Vec(...)` for typed value-class signals
 *  (and `vec(x, y)` / `num(v)` / etc. for the factory form). For
 *  reactive driving see the free `bind(target, source)` helper. */
export function signal<T>(initial: T, opts?: SignalOptions<T>): Writable<Signal<T>> {
  return new Signal(initial, opts) as Writable<Signal<T>>;
}

/** Untyped read-only derived view. Closure-captured deps. For typed
 *  views, prefer `Cls.derive(parent, fn)` or `Cls.derive(parents, fn)`.
 *  Same shape as the closure form of `Cls.derive(fn)`. */
export function computed<T>(getter: () => T): Signal<T> {
  return Signal.install(Signal as new (...args: never[]) => Signal<T>, getter);
}

/** Untyped read-only derived view from explicit parents.
 *
 *    derive(parent, fn)        — 1-input. Fuses with parent's chain.
 *    derive(parents, fn)       — N-input. Aggregates over the array.
 *
 *  For typed returns prefer `Cls.derive(...)`. */
export function derive<P, R>(parent: Read<P>, fn: (v: P) => R): Signal<R>;
export function derive<P extends readonly Read<unknown>[], R>(
  parents: P,
  fn: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => R,
): Signal<R>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function derive(parent: any, fn: any): any {
  if (Array.isArray(parent)) {
    return _fanin(Signal as new (...args: never[]) => Signal<unknown>, parent, fn);
  }
  return Signal._fuse(parent, Signal as new (...args: never[]) => Signal<unknown>, fn);
}

/** Read-write lens (untyped, free function). Two shapes:
 *
 *    lens(parent, fwd, bwd)    — 1-input. Fuses with parent's chain.
 *    lens(parents, fwd, bwd)   — N-input. Aggregates over the array.
 *
 *  For typed returns prefer `Cls.lens(...)`. For closure-style
 *  getter/setter, use `Cls.lens(g, s)` (typed) — the closure overload
 *  has no untyped equivalent. */
export function lens<P, R>(
  parent: Read<P>,
  fwd: (v: P) => R,
  bwd: (target: R, v: P) => P,
): Writable<Signal<R>>;
export function lens<P extends readonly Read<unknown>[], R>(
  parents: P,
  fwd: (vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never }) => R,
  bwd: (
    target: R,
    vals: { [K in keyof P]: P[K] extends Read<infer V> ? V : never },
  ) => { [K in keyof P]?: P[K] extends Read<infer V> ? V : never },
): Writable<Signal<R>>;
// biome-ignore lint/suspicious/noExplicitAny: dispatch
export function lens(parent: any, fwd: any, bwd: any): any {
  if (Array.isArray(parent)) {
    return _fanin(Signal as new (...args: never[]) => Signal<unknown>, parent, fwd, bwd);
  }
  return Signal._fuse(parent, Signal as new (...args: never[]) => Signal<unknown>, fwd, bwd);
}

// ─── symmetric lens: complement-carrying lens ───────────────────────
//
// A symmetric lens carries a private `complement` — an opaque,
// engine-managed cell that the lens's putr/putl mutate. The complement
// preserves information the view alone discards, which is what makes
// "trap" classes (multiplicative-zero, sign ambiguity, polar
// singularity) recoverable across collapse round-trips.
//
// API design notes:
//   - putr returns the view value; putl returns per-parent updates.
//   - Both receive `complement: C` and mutate it through field writes
//     (e.g. `c.θ = newθ`, `c.units[i].x = …`). This avoids the per-
//     call result-object allocation and matches every shipping spec.
//   - For "primitive complement" (no wrapper object), wrap in a
//     `{ value: T }` cell and mutate that.
//   - `putl` returns `ReadonlyArray<S | undefined>` — `undefined` to
//     leave a parent untouched.
//   - The lens does NOT participate in `_fuse` directly; instead, the
//     instance `.lens(F, B)` method DOES recognize symmetric lens
//     receivers and inlines F/B into a single composed cell. See
//     `_fuseOnSymmetric` for the composition rule.

/** Spec for a multi-input symmetric lens. The complement is owned by
 *  the engine and passed into every call; spec mutates it in place. */
export interface SymmetricLensSpecN<S extends readonly unknown[], V, C> {
  missing: C;
  putr: (sources: S, complement: C) => V;
  putl: (target: V, sources: S, complement: C) => ReadonlyArray<S[number] | undefined>;
}

/** Spec for a single-input symmetric lens (sugar over N-input). */
export interface SymmetricLensSpec1<S, V, C> {
  missing: C;
  putr: (source: S, complement: C) => V;
  putl: (target: V, source: S, complement: C) => S | undefined;
}

/** Lift a 1-input spec into the canonical N-input form. */
function _liftSpec1<S, V, C>(
  spec: SymmetricLensSpec1<S, V, C>,
): SymmetricLensSpecN<readonly S[], V, C> {
  return {
    missing: spec.missing,
    putr: (sources, c) => spec.putr(sources[0]!, c),
    putl: (target, sources, c) => [spec.putl(target, sources[0]!, c)],
  };
}

/** Metadata installed on the resulting cell so the instance `.lens()`
 *  fast path can recognize a symmetric-lens receiver and fuse against
 *  its spec without indirection. */
interface SymmetricMeta<V, C> {
  parents: readonly Signal<unknown>[];
  spec: SymmetricLensSpecN<readonly unknown[], V, C>;
  complement: C;
  vals: unknown[];
}

/** N-input symmetric lens. Allocates closure-captured `complement`
 *  plus one scratch `vals` array. */
function _symmetric<S extends readonly unknown[], V, C>(
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  Cls: new (...args: never[]) => Signal<any>,
  parents: readonly Signal<unknown>[],
  spec: SymmetricLensSpecN<S, V, C>,
): Signal<V> {
  const n = parents.length;
  const meta: SymmetricMeta<V, C> = {
    parents,
    spec: spec as unknown as SymmetricLensSpecN<readonly unknown[], V, C>,
    complement: spec.missing,
    vals: new Array(n) as unknown[],
  };

  const getter = (): V => {
    const vals = meta.vals;
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    return spec.putr(vals as unknown as S, meta.complement);
  };

  const setter = (v: V): void => {
    const vals = meta.vals;
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
    const updates = spec.putl(v, vals as unknown as S, meta.complement);
    batch(() => {
      for (let i = 0; i < n; i++) {
        const u = updates[i];
        if (u === undefined) continue;
        parents[i]!._setWithExclusion(u, activeNetwork);
      }
    });
  };

  const inst = Signal.install(Cls, getter, setter) as unknown as Signal<V>;
  (inst as Signal<V> & { _symOf?: SymmetricMeta<V, C> })._symOf = meta;
  return inst;
}

/** Build a fused cell where a plain endo `.lens(F, B)` sits on top of
 *  a symmetric lens. The composed cell skips the `.lens` cell entirely:
 *
 *    view  = F(spec.putr(sources, c))
 *    write = spec.putl(B(target, F(spec.putr(sources, c))), sources, c)
 *
 *  The composed cell stays symmetric (carries `_symOf`) so further
 *  `.lens()` calls keep fusing.
 *
 *  Stateless B (arity ≤ 1): the inner `F(putr(...))` recomputation is
 *  skipped on write — `putl(B(target), …)` is enough.
 *
 *  Returns the new cell. */
function _fuseOnSymmetric<V, U, C>(
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  Cls: new (...args: never[]) => Signal<any>,
  inner: SymmetricMeta<V, C>,
  fwd: (v: V) => U,
  bwd: (v: U, s: V) => V,
): Signal<U> {
  const { parents, spec, vals } = inner;
  const n = parents.length;
  const stateless = bwd.length < 2;

  const getter = (): U => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    return fwd(spec.putr(vals, inner.complement));
  };

  const setter: (v: U) => void = stateless
    ? (v: U): void => {
        for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
        const innerTarget = bwd(v, undefined as never);
        const updates = spec.putl(innerTarget, vals, inner.complement);
        batch(() => {
          for (let i = 0; i < n; i++) {
            const u = updates[i];
            if (u === undefined) continue;
            parents[i]!._setWithExclusion(u, activeNetwork);
          }
        });
      }
    : (v: U): void => {
        for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
        // Stateful bwd needs current inner view value (= F⁻¹ of view).
        // We can reconstruct it via putr (same `vals`, same complement).
        const innerCur = spec.putr(vals, inner.complement);
        const innerTarget = bwd(v, innerCur);
        const updates = spec.putl(innerTarget, vals, inner.complement);
        batch(() => {
          for (let i = 0; i < n; i++) {
            const u = updates[i];
            if (u === undefined) continue;
            parents[i]!._setWithExclusion(u, activeNetwork);
          }
        });
      };

  const inst = Signal.install(Cls, getter, setter) as unknown as Signal<U>;
  // Tag the fused cell with a NEW SymmetricMeta whose spec wraps the
  // composed F/B inline. Sharing parents + complement with inner ensures
  // chained fusion sees the same complement state.
  const composedSpec: SymmetricLensSpecN<readonly unknown[], U, C> = {
    missing: inner.complement,
    putr: (sources, c) => fwd(spec.putr(sources, c)),
    putl: stateless
      ? (target, sources, c) => spec.putl(bwd(target, undefined as never), sources, c)
      : (target, sources, c) => {
          const innerCur = spec.putr(sources, c);
          return spec.putl(bwd(target, innerCur), sources, c);
        },
  };
  (inst as Signal<U> & { _symOf?: SymmetricMeta<U, C> })._symOf = {
    parents,
    spec: composedSpec,
    complement: inner.complement,
    vals,
  };
  return inst;
}

// ─── _fanin: N-input lens helper ────────────────────────────────────
//
// Used by `Cls.lens([...], ...)` / `Cls.derive([...], ...)` and the
// top-level `lens([...], ...)` / `derive([...], ...)`. Pre-allocated
// scratch buffer + arity-based bwd dispatch. Engine-internal.

/** N-input lens: read aggregate via `fwd(vals)`, write distributes
 *  via `bwd(target, vals?)`. Allocation: one scratch `vals` array
 *  mutated in place. Subscribers downstream of multiple parents
 *  fire once per write (batched). */
function _fanin(
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  Cls: new (...args: never[]) => Signal<any>,
  parents: readonly Signal<unknown>[],
  fwd: (vals: unknown[]) => unknown,
  // biome-ignore lint/suspicious/noExplicitAny: dispatch
  bwd?: (...args: any[]) => unknown,
): Signal<unknown> {
  const n = parents.length;
  const vals = new Array(n) as unknown[];

  const getter = (): unknown => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.value;
    return fwd(vals);
  };

  if (bwd === undefined) {
    return Signal.install(Cls, getter);
  }

  const stateful = bwd.length >= 2;

  if (!stateful) {
    const sBwd = bwd as (target: unknown) => readonly unknown[];
    const setter = (v: unknown): void => {
      const updates = sBwd(v);
      batch(() => {
        for (let i = 0; i < n; i++) {
          const u = updates[i];
          if (u === undefined) continue;
          parents[i]!._setWithExclusion(u, activeNetwork);
        }
      });
    };
    return Signal.install(Cls, getter, setter);
  }

  const sBwd = bwd as (target: unknown, vals: unknown[]) => readonly unknown[];
  const setter = (v: unknown): void => {
    for (let i = 0; i < n; i++) vals[i] = parents[i]!.peek();
    const updates = sBwd(v, vals);
    batch(() => {
      for (let i = 0; i < n; i++) {
        const u = updates[i];
        if (u === undefined) continue;
        parents[i]!._setWithExclusion(u, activeNetwork);
      }
    });
  };
  return Signal.install(Cls, getter, setter);
}

export function effect(fn: () => void | (() => void)): () => void {
  const e = new Effect(fn);
  return () => e._unwatched();
}

export function batch<R>(fn: () => R): R {
  ++batchDepth;
  try {
    return fn();
  } finally {
    if (!--batchDepth) flush();
  }
}

export function untracked<R>(fn: () => R): R {
  const prev = activeSub;
  activeSub = undefined;
  try {
    return fn();
  } finally {
    activeSub = prev;
  }
}
