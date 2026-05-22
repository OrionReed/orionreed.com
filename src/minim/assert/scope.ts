// scope() — wrap a factory so its invocations carry identity.
//
// The wrapped factory returns an Animator-shaped wrapper around the
// inner gen. The wrapper:
//   - captures parent at *construction time* (`currentSpan` at the
//     moment the factory is called — that's the call-site span).
//   - opens the span on first `.next()` (so `start` aligns with the
//     engine clock, not with construction).
//   - pushes `currentSpan = self` for the duration of every `.next()`,
//     `.return()`, and `.throw()`. This makes attribution work through
//     `yield`, `yield*`, and arbitrary nesting because the parent's
//     wrapper is on the stack while the parent's body runs (which is
//     where any child factory call happens).
//   - closes the span on `done`, cancellation, or error.
//
// Per-factory queries (`alive`, `last`, `runs`, `duration`,
// `touched`, `touchedDeep`) hang off the wrapper as lazy signal
// getters. Allocate on first read; never if untouched.

import type { Animator, Tick, Yieldable } from "@minim/core";
import { computed, type Read, type Signal, signal } from "@minim/signals";
import { closeSpan, currentSpan, notifySpanOpen, openSpan, type Span, withSpan } from "./span";

/** Factory function shape. */
type AnyFactory = (...args: any[]) => Animator<any>;

/** Bumped by record() on each open/close so derived signals refresh. */
let traceVersion = signal(0);

/** Scope notifies record() of new spans; record() bumps the version,
 *  which causes `alive` / `last` / `runs` etc. to recompute. */
export function bumpTraceVersion(): void {
  traceVersion.value++;
}

/** Watch every recent span; subscribers wake on each open/close.
 *  Used to give scoped factories their lazy stat signals. */
export function traceVersionSignal(): Read<number> {
  return traceVersion;
}

/** Per-factory live history. `record()` populates this; `stop()`
 *  doesn't clear it (so post-stop queries still work). */
const spansByFactory = new WeakMap<Function, Span[]>();
export function recordFactorySpan(s: Span): void {
  let arr = spansByFactory.get(s.fn);
  if (!arr) {
    arr = [];
    spansByFactory.set(s.fn, arr);
  }
  arr.push(s);
}
export function spansOf(fn: Function): readonly Span[] {
  return spansByFactory.get(fn) ?? [];
}

/** Scoped factory: callable, carries name + lazy stats. */
export interface Scoped<F extends AnyFactory> {
  (...args: Parameters<F>): ReturnType<F>;
  readonly name: string;
  readonly alive: Read<boolean>;
  readonly last: Read<Span | undefined>;
  readonly runs: Read<number>;
  /** Total wall-time across all completed spans; in-flight spans
   *  contribute up to the current clock. */
  readonly duration: Read<number>;
  /** Signals written during the most recent invocation (self only). */
  readonly touched: Read<readonly Signal<unknown>[]>;
  /** Signals written during the most recent invocation, plus its
   *  descendants. */
  readonly touchedDeep: Read<readonly Signal<unknown>[]>;
}

/** Wrap `fn` so its invocations open Spans with identity = fn. */
export function scope<F extends AnyFactory>(fn: F, name?: string): Scoped<F> {
  const tagged = name ?? fn.name ?? "anon";
  const factory = ((...args: Parameters<F>): ReturnType<F> => {
    const parent = currentSpan;
    const inner = fn(...args) as Animator<any>;
    return makeWrapper(fn, args, parent, inner) as ReturnType<F>;
  }) as Scoped<F>;

  Object.defineProperty(factory, "name", {
    value: tagged,
    configurable: true,
  });

  // Lazy stat signals. Each property allocates its Computed on first
  // access and memoizes thereafter. Each query reads `traceVersion`
  // directly so it dirties on every open/close event — going through
  // an `allSpans` intermediate broke because spansOf() returns the
  // same array reference and alien-signals' equality treats that as
  // "unchanged", short-circuiting downstream propagation.
  const lazy = <T>(make: () => Read<T>): { get(): Read<T> } => {
    let cached: Read<T> | undefined;
    return {
      get() {
        if (!cached) cached = make();
        return cached;
      },
    };
  };

  const lastSpan = lazy(() =>
    computed(() => {
      traceVersion.value;
      const list = spansOf(fn);
      return list.length === 0 ? undefined : list[list.length - 1];
    }),
  );

  Object.defineProperty(factory, "alive", {
    get: lazy(() =>
      computed(() => {
        traceVersion.value;
        const list = spansOf(fn);
        for (const s of list) if (s.status === "open") return true;
        return false;
      }),
    ).get,
  });

  Object.defineProperty(factory, "last", { get: () => lastSpan.get() });

  Object.defineProperty(factory, "runs", {
    get: lazy(() =>
      computed(() => {
        traceVersion.value;
        return spansOf(fn).length;
      }),
    ).get,
  });

  Object.defineProperty(factory, "duration", {
    get: lazy(() =>
      computed(() => {
        traceVersion.value;
        const list = spansOf(fn);
        let total = 0;
        for (const s of list) {
          const end = s.end ?? s.start;
          total += Math.max(0, end - s.start);
        }
        return total;
      }),
    ).get,
  });

  Object.defineProperty(factory, "touched", {
    get: lazy(() =>
      computed(() => {
        traceVersion.value;
        const list = spansOf(fn);
        if (list.length === 0) return [];
        return Array.from(list[list.length - 1].touched);
      }),
    ).get,
  });

  Object.defineProperty(factory, "touchedDeep", {
    get: lazy(() =>
      computed(() => {
        traceVersion.value;
        const list = spansOf(fn);
        if (list.length === 0) return [];
        return collectTouchedDeep(list[list.length - 1]);
      }),
    ).get,
  });

  return factory;
}

/** Walk descendants of `root` via `parent` back-links across all
 *  recorded spans; collect the union of `touched` sets. Allocations
 *  scale with the descendant count, not with total trace size. */
function collectTouchedDeep(root: Span): Signal<unknown>[] {
  const out = new Set<Signal<unknown>>(root.touched);
  // Span.parent is a back-link; we need forward iteration. Walk every
  // recorded span and check ancestry. Trace size is small in practice.
  // A child's parent chain is finite; `descends(s, root)` is O(depth).
  for (const arr of allFactoryLists()) {
    for (const s of arr) {
      if (s === root) continue;
      if (descends(s, root)) {
        for (const sig of s.touched) out.add(sig);
      }
    }
  }
  return Array.from(out);
}

function descends(s: Span, ancestor: Span): boolean {
  let cur = s.parent;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/** Iterate every `Span[]` we've ever recorded. WeakMap can't be
 *  iterated, so the recorder stores a parallel `factories` array
 *  it appends to whenever a never-before-seen factory opens a span. */
let knownFactories: Function[] = [];
export function rememberFactory(fn: Function): void {
  if (!spansByFactory.has(fn)) knownFactories.push(fn);
}
function* allFactoryLists(): IterableIterator<readonly Span[]> {
  for (const fn of knownFactories) yield spansOf(fn);
}

/** Build the Animator-shaped wrapper around `inner`. Push/pop the
 *  span on every gen entry; observe lifecycle from inside. */
function makeWrapper(
  fn: Function,
  args: readonly unknown[],
  parent: Span | undefined,
  inner: Animator<any>,
): Animator<any> {
  let span: Span | undefined;

  const ensureOpen = (): Span => {
    if (!span) {
      rememberFactory(fn);
      span = openSpan(fn, args, parent);
      // Add to per-factory list BEFORE notifying recorders so downstream
      // computeds (`alive`, `last`, etc.) see the span when they
      // re-evaluate inside the listener-driven flush.
      recordFactorySpan(span);
      notifySpanOpen(span);
    }
    return span;
  };

  return {
    next(t?: Tick): IteratorResult<Yieldable, any> {
      const s = ensureOpen();
      // Close *outside* withSpan so the close event's bumpTraceVersion
      // writes aren't attributed to this span's `touched` set.
      let r: IteratorResult<Yieldable, any>;
      try {
        r = withSpan(s, () => inner.next(t as Tick));
      } catch (e) {
        if (s.status === "open") closeSpan(s, "errored");
        throw e;
      }
      if (r.done && s.status === "open") closeSpan(s, "settled");
      return r;
    },
    return(v?: any): IteratorResult<Yieldable, any> {
      // `.return()` may be called by the engine on cancel without
      // ever having called `.next()` — skip; an un-resumed span
      // never "really ran".
      if (!span) return inner.return(v);
      let r: IteratorResult<Yieldable, any>;
      try {
        r = withSpan(span, () => inner.return(v));
      } catch (e) {
        if (span.status === "open") closeSpan(span, "errored");
        throw e;
      }
      if (span.status === "open") closeSpan(span, "cancelled");
      return r;
    },
    throw(e: unknown): IteratorResult<Yieldable, any> {
      const s = ensureOpen();
      let r: IteratorResult<Yieldable, any>;
      try {
        r = withSpan(s, () => inner.throw(e));
      } catch (err) {
        if (s.status === "open") closeSpan(s, "errored");
        throw err;
      }
      if (r.done && s.status === "open") closeSpan(s, "settled");
      return r;
    },
    [Symbol.iterator]() {
      return this;
    },
  } as Animator<any>;
}

/** Batch-scope a record of factories; each key becomes the scoped
 *  factory's `name`. Return type preserves the input keys; values are
 *  the wrapped factories which are call-compatible with the input. */
export function scopeAll<R extends Record<string, AnyFactory>>(
  o: R,
): { [K in keyof R]: Scoped<R[K]> } {
  const out = {} as { [K in keyof R]: Scoped<R[K]> };
  for (const k of Object.keys(o) as Array<keyof R & string>) {
    out[k] = scope(o[k]) as Scoped<R[typeof k]>;
  }
  return out;
}
