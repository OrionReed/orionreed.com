// Span — one factory invocation. The single nominal data type of the
// assert package; everything else is a function over Spans and Signals.
//
// Identity is `fn` (the factory function reference). A Span instance
// represents a *particular* call: one start, one end, possibly nested
// inside another span. The wrapper installed by `scope()` opens the
// span on first `.next()`, captures its parent at construction, and
// closes it on completion / cancellation / error.
//
// Time:  this module does not stamp `start` / `end`. The recorder
//        owns its anim and writes them on the open/close listener
//        — keeps the engine free of assert-specific state.
//
// Stack: `currentSpan` is a single module-level slot. JS is single-
//        threaded; `withSpan(s, fn)` push/pop is correct around any
//        synchronous gen body (including nested `yield*`). Used by
//        `scope` for parent capture and by `record` for write
//        attribution.

import type { Signal } from "@minim/signals";

export type SpanStatus = "open" | "settled" | "cancelled" | "errored";

/** One factory invocation, possibly nested. */
export interface Span {
  readonly id: number;
  /** Factory reference; the canonical identity. */
  readonly fn: Function;
  readonly args: readonly unknown[];
  readonly parent?: Span;
  /** Set by the recorder on open. `0` outside a `record()` session. */
  start: number;
  /** Set by the recorder on close. */
  end?: number;
  status: SpanStatus;
  /** Signals whose `set value` fired while this exact span was on
   *  top of the stack (not its descendants). Populated lazily by the
   *  recorder; remains empty when no recorder is active. */
  readonly touched: Set<Signal<unknown>>;
}

/** Top-of-stack span (synchronous, single-slot). Read by:
 *   - `scope` at factory-call time to capture parent.
 *   - `record`'s write hook to attribute signal writes. */
export let currentSpan: Span | undefined;

/** Replace the current span and run `fn`; restore on exit. The push
 *  pattern around `gen.next()` (inside scope wrappers) keeps the
 *  stack consistent through `yield`, `yield*`, and re-entrant calls. */
export function withSpan<T>(s: Span | undefined, fn: () => T): T {
  const prev = currentSpan;
  currentSpan = s;
  try {
    return fn();
  } finally {
    currentSpan = prev;
  }
}

/** Listeners registered by `record()`. Each `record()` adds a pair;
 *  multiple recorders coexist (e.g. two demos on the same page). The
 *  recorder is responsible for stamping `s.start` / `s.end` from its
 *  anim's clock — this module is engine-agnostic. */
const openListeners = new Set<(s: Span) => void>();
const closeListeners = new Set<(s: Span) => void>();

/** Register span-lifecycle listeners. Returns disposer. */
export function addSpanListener(
  open: (s: Span) => void,
  close: (s: Span) => void,
): () => void {
  openListeners.add(open);
  closeListeners.add(close);
  return () => {
    openListeners.delete(open);
    closeListeners.delete(close);
  };
}

let nextId = 1;

/** Create a span object. `start` is left at `0`; the recorder stamps
 *  it from `anim.clock` when `notifySpanOpen` reaches the listener.
 *  Does NOT notify listeners — the caller must finish bookkeeping
 *  (e.g. `recordFactorySpan`) first and then call `notifySpanOpen(s)`
 *  so downstream computeds see the new span when they re-evaluate. */
export function openSpan(
  fn: Function,
  args: readonly unknown[],
  parent: Span | undefined,
): Span {
  return {
    id: nextId++,
    fn,
    args,
    parent,
    start: 0,
    status: "open",
    touched: new Set(),
  };
}

/** Notify all active recorders that `s` was opened. Call AFTER any
 *  per-factory bookkeeping that downstream observers might want to
 *  read (e.g. `spansByFactory`). */
export function notifySpanOpen(s: Span): void {
  for (const cb of openListeners) cb(s);
}

/** Mark `s` as ended with the given status. No-op if already closed.
 *  Listeners fire after the status is updated; the recorder stamps
 *  `s.end` inside its listener. */
export function closeSpan(s: Span, status: Exclude<SpanStatus, "open">): void {
  if (s.status !== "open") return;
  s.status = status;
  for (const cb of closeListeners) cb(s);
}
