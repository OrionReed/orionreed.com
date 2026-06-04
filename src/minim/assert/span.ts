// Span — one factory invocation. The assert package's single nominal
// data type; everything else is a function over Spans and Signals.
//
// Identity is `fn` (the factory reference); a Span is one particular
// call, possibly nested. `scope()`'s wrapper opens it on first `.next()`,
// captures parent at construction, closes on settle/cancel/error.
//
// This module never stamps `start` / `end` — the recorder does, on the
// open/close listener, keeping the engine assert-free. `currentSpan` is
// a single module slot; `withSpan` push/pop is correct around any
// synchronous gen body (used by `scope` and `record`).

import type { Cell } from "@minim/signals";

export type SpanStatus = "open" | "settled" | "cancelled" | "errored";

/** One factory invocation, possibly nested. */
export interface Span {
  readonly id: number;
  /** Factory reference; the canonical identity. */
  readonly fn: Function;
  /** Display name from `scope()`'s arg or `fn.name`. Kept separate so
   *  bundler renames of named function expressions don't leak in. */
  readonly name: string;
  readonly args: readonly unknown[];
  readonly parent?: Span;
  /** Set by the recorder on open. `0` outside a `record()` session. */
  start: number;
  /** Set by the recorder on close. */
  end?: number;
  status: SpanStatus;
  /** Signals written while this span (not its descendants) was on top
   *  of the stack. Populated by the recorder; empty otherwise. */
  readonly touched: Set<Cell<unknown>>;
}

/** Top-of-stack span; read by `scope` (parent capture) and `record`
 *  (write attribution). */
export let currentSpan: Span | undefined;

/** Run `fn` with `currentSpan = s`, restoring on exit. Keeps the stack
 *  consistent through `yield`, `yield*`, and re-entrant calls. */
export function withSpan<T>(s: Span | undefined, fn: () => T): T {
  const prev = currentSpan;
  currentSpan = s;
  try {
    return fn();
  } finally {
    currentSpan = prev;
  }
}

/** Lifecycle listeners; each `record()` adds a pair. Multiple recorders
 *  coexist. They stamp `s.start` / `s.end`; this module is engine-agnostic. */
const openListeners = new Set<(s: Span) => void>();
const closeListeners = new Set<(s: Span) => void>();

/** Register span-lifecycle listeners. Returns disposer. */
export function addSpanListener(open: (s: Span) => void, close: (s: Span) => void): () => void {
  openListeners.add(open);
  closeListeners.add(close);
  return () => {
    openListeners.delete(open);
    closeListeners.delete(close);
  };
}

let nextId = 1;

/** Create a span (`start` = 0; recorder stamps it). Does NOT notify —
 *  finish bookkeeping, then call `notifySpanOpen(s)`. */
export function openSpan(
  fn: Function,
  name: string,
  args: readonly unknown[],
  parent: Span | undefined,
): Span {
  return {
    id: nextId++,
    fn,
    name,
    args,
    parent,
    start: 0,
    status: "open",
    touched: new Set(),
  };
}

/** Notify recorders that `s` opened. Call AFTER per-factory bookkeeping
 *  downstream observers may read. */
export function notifySpanOpen(s: Span): void {
  for (const cb of openListeners) cb(s);
}

/** End `s` with `status` (no-op if already closed); fires close listeners. */
export function closeSpan(s: Span, status: Exclude<SpanStatus, "open">): void {
  if (s.status !== "open") return;
  s.status = status;
  for (const cb of closeListeners) cb(s);
}
