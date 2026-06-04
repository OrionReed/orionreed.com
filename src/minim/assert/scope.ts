// scope() — wrap a factory so its invocations carry identity.
//
// The wrapped factory returns an Animator-shaped wrapper that:
//   - captures parent at construction (call-site `currentSpan`).
//   - opens the span on first `.next()` (start aligns to engine clock).
//   - pushes `currentSpan = self` around every `.next()`/`.return()`/
//     `.throw()`, so attribution flows through `yield`, `yield*`, and
//     nesting (the parent wrapper is on the stack while its body runs).
//   - closes on done, cancellation, or error.
//
// Per-factory queries (`alive`, `last`, `runs`, `duration`, `touched`,
// `touchedDeep`) hang off the wrapper as lazy signal getters.

import type { Animator, Tick, Yieldable } from "@minim/core";
import { derive, type Read, type Cell, cell } from "@minim/signals";
import { closeSpan, currentSpan, notifySpanOpen, openSpan, type Span, withSpan } from "./span";

/** Factory function shape. */
type AnyFactory = (...args: any[]) => Animator<any>;

/** Bumped by record() on each open/close so derived signals refresh. */
const traceVersion = cell(0);

/** Bump so `alive` / `last` / `runs` etc. recompute. Called by record(). */
export function bumpTraceVersion(): void {
  traceVersion.value++;
}

/** Version signal driving the lazy per-factory stat signals. */
export function traceVersionSignal(): Read<number> {
  return traceVersion;
}

/** Per-factory live history; survives `stop()` so post-stop queries work. */
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
  readonly touched: Read<readonly Cell<unknown>[]>;
  /** Signals written during the most recent invocation, plus its
   *  descendants. */
  readonly touchedDeep: Read<readonly Cell<unknown>[]>;
}

/** Wrap `fn` so its invocations open Spans with identity = fn.
 *
 *      const fadeIn = scope("fadeIn", function* () { … });
 *      const fadeIn = scope(function* () { … });
 *
 *  Prefer the name-first form: bare `fn.name` gets renamed by bundlers
 *  when an inner `function* fadeIn` collides with an outer `const fadeIn`. */
export function scope<F extends AnyFactory>(fn: F): Scoped<F>;
export function scope<F extends AnyFactory>(name: string, fn: F): Scoped<F>;
export function scope<F extends AnyFactory>(...args: [F] | [string, F]): Scoped<F> {
  const [name, fn] =
    typeof args[0] === "string" ? (args as [string, F]) : [undefined, args[0] as F];
  const tagged = name ?? fn.name ?? "anon";
  const factory = ((...args: Parameters<F>): ReturnType<F> => {
    const parent = currentSpan;
    const inner = fn(...args) as Animator<any>;
    return makeWrapper(fn, tagged, args, parent, inner) as ReturnType<F>;
  }) as Scoped<F>;

  Object.defineProperty(factory, "name", {
    value: tagged,
    configurable: true,
  });

  // Lazy stat signals: allocate the Computed on first access, memoize
  // after. Each reads `traceVersion` directly so it dirties on every
  // open/close — an `allSpans` intermediate fails because spansOf()
  // returns a stable array ref that signal equality treats as unchanged.
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
    derive(() => {
      traceVersion.value;
      const list = spansOf(fn);
      return list.length === 0 ? undefined : list[list.length - 1];
    }),
  );

  Object.defineProperty(factory, "alive", {
    get: lazy(() =>
      derive(() => {
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
      derive(() => {
        traceVersion.value;
        return spansOf(fn).length;
      }),
    ).get,
  });

  Object.defineProperty(factory, "duration", {
    get: lazy(() =>
      derive(() => {
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
      derive(() => {
        traceVersion.value;
        const list = spansOf(fn);
        if (list.length === 0) return [];
        return Array.from(list[list.length - 1].touched);
      }),
    ).get,
  });

  Object.defineProperty(factory, "touchedDeep", {
    get: lazy(() =>
      derive(() => {
        traceVersion.value;
        const list = spansOf(fn);
        if (list.length === 0) return [];
        return collectTouchedDeep(list[list.length - 1]);
      }),
    ).get,
  });

  return factory;
}

/** Union of `touched` over `root` and its descendants (via `parent`
 *  back-links). */
function collectTouchedDeep(root: Span): Cell<unknown>[] {
  const out = new Set<Cell<unknown>>(root.touched);
  // `parent` is a back-link, so walk every span and test ancestry.
  // `descends(s, root)` is O(depth); traces are small in practice.
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

/** Parallel list of seen factories — WeakMap isn't iterable. */
const knownFactories: Function[] = [];
export function rememberFactory(fn: Function): void {
  if (!spansByFactory.has(fn)) knownFactories.push(fn);
}
function* allFactoryLists(): IterableIterator<readonly Span[]> {
  for (const fn of knownFactories) yield spansOf(fn);
}

/** Animator-shaped wrapper around `inner`: push/pop the span on each
 *  gen entry, observe lifecycle from inside. */
function makeWrapper(
  fn: Function,
  name: string,
  args: readonly unknown[],
  parent: Span | undefined,
  inner: Animator<any>,
): Animator<any> {
  let span: Span | undefined;

  const ensureOpen = (): Span => {
    if (!span) {
      rememberFactory(fn);
      span = openSpan(fn, name, args, parent);
      // Record BEFORE notifying so downstream computeds see the span
      // when they re-evaluate during the listener-driven flush.
      recordFactorySpan(span);
      notifySpanOpen(span);
    }
    return span;
  };

  return {
    next(t?: Tick): IteratorResult<Yieldable, any> {
      const s = ensureOpen();
      // Close outside withSpan so the close event's writes aren't
      // attributed to this span's `touched` set.
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
      // Engine may `.return()` on cancel before any `.next()`; an
      // un-resumed span never really ran, so skip it.
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

/** Batch-scope a record of factories; each key becomes the `name`. */
export function scopeAll<R extends Record<string, AnyFactory>>(
  o: R,
): { [K in keyof R]: Scoped<R[K]> } {
  const out = {} as { [K in keyof R]: Scoped<R[K]> };
  for (const k of Object.keys(o) as Array<keyof R & string>) {
    out[k] = scope(k, o[k]) as Scoped<R[typeof k]>;
  }
  return out;
}
