// node.ts — abstract reactive base + engine plumbing.
//
// Engine state (link/propagate/cycle/etc) lives as module-level
// statics and free functions; instance state is minimal. All three
// concrete primitives (Signal/Computed/Lens) extend `Node<T>`.
//
// Algorithm: alien-signals v2 (same as the merged r2 engine).

import { type Equals, type TraitDict } from "./traits";

// ─── Internal types ──────────────────────────────────────────────────

export interface ReactiveNode {
  deps?: Link;
  depsTail?: Link;
  subs?: Link;
  subsTail?: Link;
  flags: number;
  _update(): boolean;
  _notify(): void;
  _unwatched(): void;
}

export interface Link {
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
export const F = {
  None: 0,
  Mutable: 1,
  Watching: 2,
  RecursedCheck: 4,
  Recursed: 8,
  Dirty: 16,
  Pending: 32,
} as const;

// ─── Engine globals ─────────────────────────────────────────────────

export let cycle = 0;
export let runDepth = 0;
export let batchDepth = 0;
export let activeSub: ReactiveNode | undefined;
export let notifyIndex = 0;
export let queuedLength = 0;
export const queued: (EffectLike | undefined)[] = [];

// Re-entrancy guard: effects writing to signals during their run would
// otherwise blow V8's stack via nested flush() calls. See engine
// notes in /signals/signal.ts for the full story.
let flushing = false;

/** Effect interface — implemented by the Effect class in signal.ts.
 *  We use a structural interface here to avoid a circular import. */
export interface EffectLike extends ReactiveNode { _run(): void }

export const setActiveSub = (s: ReactiveNode | undefined): void => { activeSub = s };
export const incCycle = (): void => { ++cycle };
export const incRunDepth = (): void => { ++runDepth };
export const decRunDepth = (): void => { --runDepth };
export const incBatchDepth = (): void => { ++batchDepth };
export const decBatchDepth = (): void => { --batchDepth };

// ─── Write hook (for assert/record attribution) ──────────────────────

let writeHook: ((node: Node<unknown>) => void) | undefined;
export function setNodeWriteHook(
  fn: ((n: Node<unknown>) => void) | undefined,
): () => void {
  const prev = writeHook;
  writeHook = fn;
  return () => { writeHook = prev };
}
export const fireWriteHook = (n: Node<unknown>): void => {
  if (writeHook !== undefined) writeHook(n);
};

// ─── Engine functions ───────────────────────────────────────────────

export function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
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

export function unlink(l: Link, sub: ReactiveNode = l.sub): Link | undefined {
  const { dep, prevDep, nextDep, nextSub, prevSub } = l;
  if (nextDep !== undefined) nextDep.prevDep = prevDep; else sub.depsTail = prevDep;
  if (prevDep !== undefined) prevDep.nextDep = nextDep; else sub.deps = nextDep;
  if (nextSub !== undefined) nextSub.prevSub = prevSub; else dep.subsTail = prevSub;
  if (prevSub !== undefined) prevSub.nextSub = nextSub;
  else if ((dep.subs = nextSub) === undefined) dep._unwatched();
  return nextDep;
}

export function propagate(start: Link, innerWrite: boolean): void {
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

export function checkDirty(startLink: Link, startSub: ReactiveNode): boolean {
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

export function shallowPropagate(l: Link): void {
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

export function flush(): void {
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

export function purgeDeps(sub: ReactiveNode): void {
  const depsTail = sub.depsTail;
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
  while (dep !== undefined) dep = unlink(dep, sub);
}

export function disposeAllDepsInReverse(sub: ReactiveNode): void {
  let l = sub.depsTail;
  while (l !== undefined) {
    const prev = l.prevDep;
    unlink(l, sub);
    l = prev;
  }
}

export function enqueueEffect(e: EffectLike): number {
  return (queued[queuedLength++] = e, queuedLength);
}

export function startFlushIfNeeded(): void {
  if (batchDepth === 0) flush();
}

// ─── Public types ───────────────────────────────────────────────────

/** Plain T, thunk `() => T`, or any read-shape (Node/Signal/Computed/Lens). */
export type Val<T> = T | (() => T) | Read<T>;

/** Covariant read-only surface (parameter-site for `Val<T>`). */
export interface Read<out T> {
  readonly value: T;
  peek(): T;
}

/** Extract the value type carried by a Node. */
export type Of<R> = R extends Node<infer T> ? T : never;

export interface NodeOptions<T = unknown> {
  watched?: () => void;
  unwatched?: () => void;
  equals?: Equals<T>;
}

export function valueOf<T>(v: Val<T>): T {
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

  /** Resolve equality from opts → static traits → `===`. Called once
   *  from each concrete subclass's constructor. */
  protected _initEquals(opts: NodeOptions<T> | undefined): void {
    if (opts?.equals) { this._equals = opts.equals; return }
    const cls = this.constructor as { traits?: TraitDict<T> };
    if (cls.traits?.equals) this._equals = cls.traits.equals;
  }

  protected _initHooks(opts: NodeOptions<T> | undefined): void {
    if (opts?.watched) this._watched = opts.watched;
    if (opts?.unwatched) this._unwatchedHook = opts.unwatched;
  }

  /** Per-instance lazy derived cache. Key unique within class. */
  memo<R>(key: string | symbol, make: () => R): R {
    const c = (this._memoCache ??= {});
    const k = key as string;
    return (c[k] ?? (c[k] = make())) as R;
  }

  /** Cached field lens. `Cls` constructs the lens; signature kept
   *  flexible because the construction call goes via the lens factory
   *  in signal.ts. */
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
        // Runtime: only Signal/Lens has a usable setter — Computed throws.
        // The writable field-lens factory in value classes only invokes
        // this setter callback on writable receivers, so the cast is
        // safe in practice.
        (v) => { (this as unknown as { value: T }).value = { ...(this.peek() as object), [key]: v } as T },
      );
      c[k as string] = cached;
    }
    return cached as R;
  }

  /** Read-only by default at the type level. Each concrete primitive
   *  supplies its own getter; Signal/Lens additionally declare a
   *  setter, widening to writable in those subclasses. Computed
   *  inherits getter-only. */
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
