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
// Algorithm: alien-signals v2. Trait dispatch via `./traits`.
//
// Writability is type-tracked via `WritableBrand` (declared below)
// and the `Writable<R>` modifier in `./writable`. Factory returns
// add the brand via cast; bare `Signal<T>` instances (created via
// `new Signal(...)`) are RO at the type level.

import { type Equals, type TraitDict } from "./traits";
import { type Writable } from "./writable";

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
const queued: (Effect | undefined)[] = [];

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
// trigger nested flush() via `Signal.set value`. The outer loop here
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
 *  this brand. The brand gates calls to `Signal.set` / `Signal.bind`
 *  and is used by `Writable<R>` / `WritableOf<T>` to surface the
 *  writable API. */
declare const WRITABLE: unique symbol;
export interface WritableBrand {
  readonly [WRITABLE]: never;
}

/** Extract the value type carried by a Signal (signal/computed/lens). */
export type Of<R> = R extends Signal<infer T> ? T : never;

/** Per-field reactive init: each axis accepts plain T, signal, or thunk.
 *  Used by composite-value factories like `transform({...})`. */
export type SignalInit<T> = { [K in keyof T]?: Val<T[K]> };

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
  /** Per-instance equality; shadows class `[EQUALS]`. */
  equals?: Equals<T>;
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
  /** Per-instance equality override (from `opts.equals`); falls back to
   *  class-level `traits.equals` then `===`. Hot-read on every write. */
  _equals: Equals<T> | undefined = undefined;
  _watched?: () => void;
  _unwatchedHook?: () => void;
  /** Fusion tag. Marks this cell as a value-space pipeline (fwd, bwd?)
   *  on top of a root `parent`. Subsequent `.through()`, `.lensTo()`,
   *  or `.deriveTo()` calls on this cell collapse the chain into a
   *  single cell pointing at the same root, composing fwd/bwd
   *  in value-space. Internal.
   *
   *  Generalised from the original endo-only `_throughOf`: `fwd`/`bwd`
   *  may now bridge cross-type chains (`lensTo`/`deriveTo`). `bwd` is
   *  `undefined` for fused-RO cells (deriveTo chains); `.lensTo()` on
   *  a fused-RO cell throws at construction time.
   *
   *  `bwdStateless: true` is a hint from the caller that this chain's
   *  bwd doesn't read its `s` parameter. `.through()` sets it (endo
   *  bwds are stateless `(v) => v`); `.lensTo()` does not. When set on
   *  every layer of a chain, fusion skips both `parent.peek()` and
   *  `priorFwd(s)` in the setter — recovers the cost of threading
   *  receiver-state that nobody reads. */
  _fusedOf?: {
    parent: Signal<unknown>;
    fwd: (s: unknown) => T;
    bwd?: (v: T, s: unknown) => unknown;
    bwdStateless?: boolean;
  };

  constructor(initial: T, opts?: SignalOptions<T>) {
    this.currentValue = initial;
    this.pendingValue = initial;
    // Resolve equality once at construction: opts.equals wins; else
    // class-level static `traits.equals` (if the subclass declared one).
    // This collapses the hot-path equality lookup into a single `_equals`
    // read per write.
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

  /** Friend factory used by `computed` / `lens` and the per-class
   *  statics (`Vec.lens`, `Vec.derive`, …) to flip a fresh instance
   *  into computed or lens mode. Static access from Signal lets us
   *  assign the getter/setter slots on any subclass instance.
   *  `(...args: never[])` lets us pass any constructor regardless of
   *  its declared arity (incl. `Signal` itself whose ctor takes T).
   *
   *  This is the lower-level typed factory: for parent-based lenses,
   *  prefer `parent.lensTo(Cls, fwd, bwd)` / `parent.deriveTo(Cls, fwd)`.
   *
   *  Overload: with a setter, returns `Writable<C>` (registry-resolved
   *  to the per-class writable form, e.g. `Wr<Vec>` for Vec). Without,
   *  returns plain `C` (read-only at the type level). */
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

  /** Read-only derived view of the same class. Polymorphic-`this`
   *  static: `Vec.derive(fn)` → `Vec`, `Box.derive(fn)` → `Box`, etc.
   *  Inherited by every `Signal` subclass — user value classes get it
   *  for free without redeclaring it.
   *
   *  Signature follows the `lensTo`/`deriveTo` shape (`Signal<any>`
   *  upper bound, `InstanceType<C>` for the value type) — same
   *  variance-escape pattern. The inner cast bridges the gap between
   *  `Signal.install`'s `Signal<T>`-anchored return and the recovered
   *  instance type; runtime is correct because `this` is a Signal
   *  subclass constructor. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors lensTo
  static derive<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    fn: () => Of<InstanceType<C>>,
  ): InstanceType<C> {
    return Signal.install(this, fn) as InstanceType<C>;
  }

  /** Writable lens of the same class. Polymorphic-`this` static:
   *  `Vec.lens(g, s)` → `Writable<Vec>`. Inherited by every subclass. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors lensTo
  static lens<C extends new (...args: never[]) => Signal<any>>(
    this: C,
    g: () => Of<InstanceType<C>>,
    s: (v: Of<InstanceType<C>>) => void,
  ): Writable<InstanceType<C>> {
    return Signal.install(this, g, s) as Writable<InstanceType<C>>;
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

  /** Cross-type lens: produce a typed `Cls`-instance lens that reads
   *  `fwd(this.value)` and writes via `this.value = bwd(u, this.peek())`.
   *
   *  Field-lens getters (`vec.x`, `box.w`, …) compose this with `lazy`:
   *  `lazy(this, "x", () => this.lensTo(Num, s => s.x, (v, s) => ({...s, x: v})))`.
   *  For arbitrary-shape typed lenses without a parent, use
   *  `Signal.install(Cls, g, s)` directly.
   *
   *  Fuses with the receiver's prior fusion tag: chained `lensTo`s on
   *  fused parents collapse to one cell pointing at the chain's root.
   *  In particular, nested `field()` access (`transform.translate.x`)
   *  is a single fused lens onto `transform`.
   *
   *  Signature note: `Cls` is typed as a constructor returning
   *  `Signal<any>` (so subclasses with invariant setters fit) and `U`
   *  is recovered from `InstanceType<C>` via `ValueOf<>`. The fwd/bwd
   *  closures are typed against the recovered U — this dodges the
   *  contravariant-setter incompatibility you'd hit with the naive
   *  `C extends Signal<U>` formulation. */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape hatch
  lensTo<C extends new (...args: never[]) => Signal<any>>(
    this: Signal<T>,
    Cls: C,
    fwd: (s: T) => Of<InstanceType<C>>,
    bwd: (u: Of<InstanceType<C>>, s: T) => T,
  ): InstanceType<C> {
    return Signal._fuse(
      this as Signal<unknown>,
      Cls as unknown as new (...args: never[]) => Signal<Of<InstanceType<C>>>,
      fwd as (s: unknown) => Of<InstanceType<C>>,
      (u, s) => bwd(u, s as T),
      false,
    ) as InstanceType<C>;
  }

  /** Cross-type computed: read-only `Cls`-instance derived from
   *  `fwd(this.value)`. The one-way analog of `lensTo`. Fuses with
   *  the receiver's prior fusion tag (any chain of derive/lens/through
   *  collapses to a single computed pointing at the root). */
  // biome-ignore lint/suspicious/noExplicitAny: variance escape hatch
  deriveTo<C extends new (...args: never[]) => Signal<any>>(
    this: Signal<T>,
    Cls: C,
    fwd: (s: T) => Of<InstanceType<C>>,
  ): InstanceType<C> {
    return Signal._fuse(
      this as Signal<unknown>,
      Cls as unknown as new (...args: never[]) => Signal<Of<InstanceType<C>>>,
      fwd as (s: unknown) => Of<InstanceType<C>>,
    ) as InstanceType<C>;
  }

  /** Endo-lens: wrap this cell with a `(fwd, bwd)` pair in value-space.
   *  Returns a lens of the same class. Auto-fuses: `.through(F, B)`
   *  after `.through(f, b)` collapses to one cell with composed fns,
   *  avoiding per-chain allocation and dep-graph nodes.
   *
   *  Smart-dispatch on RO receivers: if `this` is a fused-RO chain
   *  (e.g., from `.deriveTo()`), the bwd has no place to land —
   *  drop it and build a computed via `fwd` only. This matches the
   *  receiver's writability at runtime and aligns with the `: this`
   *  return type (RO receiver → RO result). `.scale(2)` on
   *  `box.center` reads correctly; writes would throw "Cannot write
   *  to a Computed" at the result cell. */
  through(this: Signal<T>, fwd: (v: T) => T, bwd: (v: T) => T): this {
    const Cls = this.constructor as new (...args: never[]) => Signal<T>;
    if (this._fusedOf !== undefined && this._fusedOf.bwd === undefined) {
      return Signal._fuse(
        this as Signal<unknown>,
        Cls,
        fwd as (s: unknown) => T,
      ) as unknown as this;
    }
    // Through's bwd is stateless `(v) => v`; adapt to the unified
    // `(v, s) => s'` shape by ignoring the parent-state argument.
    // `bwdStateless: true` lets fusion skip `parent.peek()` and
    // `priorFwd(s)` in the setter when the whole chain is stateless.
    return Signal._fuse(
      this as Signal<unknown>,
      Cls,
      fwd as (s: unknown) => T,
      (v, _s) => bwd(v),
      true,
    ) as unknown as this;
  }

  /** Internal fusion helper used by `.through()` / `.lensTo()` /
   *  `.deriveTo()`. Collapses receiver-anchored chains in value-space.
   *
   *  Semantics:
   *    - parent = receiver's root (chases `_fusedOf.parent`).
   *    - composedFwd : root_value → own_value (= fwdLocal ∘ priorFwd).
   *    - composedBwd : (own, root) → root' (= priorBwd ∘ bwdLocal),
   *                    threading priorFwd(root) when bwdLocal needs
   *                    the receiver's current state. Skipped when the
   *                    chain is `bwdStateless`-throughout.
   *    - tags result with `_fusedOf` so further fusion sees it.
   *
   *  `newStateless` (caller-supplied): does `bwdLocal` ignore its `s`
   *  argument? `.through()` passes `true`, `.lensTo()` `false`. The
   *  resulting chain is stateless iff this layer and every prior
   *  layer is — then the setter inlines without `parent.peek()` /
   *  `priorFwd(s)`. Any stateful layer poisons the flag upward.
   *
   *  Performance: the getter/setter closures installed on the cell
   *  call the composed fns directly, eliminating a wrapper-closure
   *  layer (V8 inlines two-level user closures fine but bails on
   *  three). The `_fusedOf` tag stores the composed fns by reference
   *  so downstream fusion can compose against them without rebuilding.
   *
   *  Error: a writable view on top of a fused-RO receiver (e.g.
   *  `.deriveTo(...).lensTo(...)`) has no bwd path. We throw a
   *  `TypeError` at construction. TS already prevents this at the
   *  type level (deriveTo returns bare RO `Cls`); the runtime check
   *  is defensive against escape-hatch casts. */
  static _fuse<U>(
    receiver: Signal<unknown>,
    Cls: new (...args: never[]) => Signal<U>,
    fwdLocal: (s: unknown) => U,
    bwdLocal?: (v: U, s: unknown) => unknown,
    newStateless: boolean = false,
  ): Signal<U> {
    const prior = receiver._fusedOf as
      | {
          parent: Signal<unknown>;
          fwd: (s: unknown) => unknown;
          bwd?: (v: unknown, s: unknown) => unknown;
          bwdStateless?: boolean;
        }
      | undefined;

    // Eager error: writable view on a read-only chain has no
    // composable bwd path. Throw at construction so the stack trace
    // points to the `.lensTo`/`.through` site, not a much-later
    // write. TS rejects this at the type level for normal callers.
    if (bwdLocal !== undefined && prior !== undefined && prior.bwd === undefined) {
      throw new TypeError(
        "Signal: cannot install a writable view on top of a read-only fused chain. " +
          "The receiver is a computed (no bwd path); .lensTo()/.through() require a writable parent.",
      );
    }

    const parent = prior !== undefined ? prior.parent : receiver;
    const priorFwd = prior?.fwd;
    const priorBwd = prior?.bwd;
    // Fused chain is stateless iff this layer AND every prior layer
    // is. No prior == trivially stateless above. RO cells (no bwd at
    // this layer) propagate the prior flag unchanged — the flag is
    // about the chain's *bwd potential*, and an RO layer contributes
    // nothing stateful since it contributes no bwd at all.
    const priorStateless = prior?.bwdStateless ?? true;
    const fusedStateless = bwdLocal === undefined ? priorStateless : newStateless && priorStateless;

    const composedFwd: (s: unknown) => U = priorFwd
      ? s => fwdLocal(priorFwd(s))
      : fwdLocal;

    // composedBwd is stored on `_fusedOf` for downstream fusion to
    // compose against. The stateless variant skips `priorFwd(s)`
    // (which would be passed to bwds that ignore it).
    const composedBwd: ((v: U, s: unknown) => unknown) | undefined =
      bwdLocal === undefined
        ? undefined
        : priorBwd === undefined
          ? bwdLocal
          : fusedStateless
            ? (v, s) => priorBwd(bwdLocal(v, s), s)
            : (v, s) => priorBwd(bwdLocal(v, priorFwd!(s)), s);

    // Setter is installed with the composition inlined directly into
    // the setter body — calling `composedBwd(v, parent.peek())` would
    // add a closure-call layer that V8 can't always inline (the bwd
    // composition captures 3 fns from lexical scope). For the common
    // field-chain case this matters: micro-benchmarks show the
    // wrapping layer doubles write latency vs the hand-rolled
    // nested-lens baseline.
    //
    // Four cases (by `bwdLocal` presence × `priorBwd` presence ×
    // statelessness): RO install, 1-level stateless, 1-level stateful,
    // 2+-level stateless, 2+-level stateful. We collapse the four
    // writable cases by stateless-first dispatch; in the stateless
    // arms, both `parent.peek()` and `priorFwd(s)` are skipped
    // because nothing downstream reads them.
    let inst: Signal<U>;
    if (bwdLocal === undefined) {
      inst = Signal.install(Cls, () => composedFwd(parent.value));
    } else if (priorBwd === undefined) {
      // 1-level case (no prior to compose with).
      inst = fusedStateless
        ? Signal.install(
            Cls,
            () => composedFwd(parent.value),
            v => {
              parent.value = bwdLocal(v, undefined as never);
            },
          )
        : Signal.install(
            Cls,
            () => composedFwd(parent.value),
            v => {
              parent.value = bwdLocal(v, parent.peek());
            },
          );
    } else {
      // 2+-level case: inline the composition into the setter.
      inst = fusedStateless
        ? Signal.install(
            Cls,
            () => composedFwd(parent.value),
            v => {
              parent.value = priorBwd(bwdLocal(v, undefined as never), undefined as never);
            },
          )
        : Signal.install(
            Cls,
            () => composedFwd(parent.value),
            v => {
              const s = parent.peek();
              parent.value = priorBwd(bwdLocal(v, priorFwd!(s)), s);
            },
          );
    }
    (inst as Signal<U>)._fusedOf = {
      parent,
      fwd: composedFwd,
      bwd: composedBwd,
      bwdStateless: fusedStateless,
    };
    return inst as Signal<U>;
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
    const equals = this._equals;
    const same = equals ? equals(prev, next) : prev === next;
    if (!same) {
      this.flags = F.Mutable | F.Dirty;
      if (writeHook !== undefined) writeHook(this as Signal<unknown>);
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

// ─── Public factories ────────────────────────────────────────────────

/** Writable source. Returns a branded `Signal<T>` so `.value =` is
 *  callable on it. Use `new Vec(...)` for typed value-class signals
 *  (and `vec(x, y)` / `num(v)` / etc. for the factory form). For
 *  reactive driving see the free `bind(target, source)` helper. */
export function signal<T>(initial: T, opts?: SignalOptions<T>): Signal<T> & WritableBrand {
  return new Signal(initial, opts) as Signal<T> & WritableBrand;
}

/** Untyped read-only derived view. For typed views, prefer the
 *  per-class static `Cls.derive(fn)` (e.g. `Vec.derive(...)`). */
export function computed<T>(getter: () => T): Signal<T> {
  return Signal.install(Signal as new (...args: never[]) => Signal<T>, getter);
}

/** Untyped read-write derived view. For typed lenses, prefer the
 *  per-class static `Cls.lens(get, set)` (e.g. `Vec.lens(...)`). */
export function lens<T>(getter: () => T, setter: (v: T) => void): Writable<Signal<T>> {
  return Signal.install(Signal as new (...args: never[]) => Signal<T>, getter, setter);
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
