// Bool-signal primitives. The claim algebra is these three plus signal
// arithmetic; compose with `and` / `or` / `not`.
//
//   intervals(scope)   — Scope → "is this open now?" bool signal.
//   latch(p, init, sc) — invariant/liveness latch, auto re-arm on `sc`.
//   firstOf(...e)      — event ordering over bool signals.

import { derive, effect, type Read, cell } from "@minim/signals";
import { activeRecorder } from "./record";
import type { Scoped } from "./scope";
import type { Span } from "./span";

/** Anything an interval can be derived from. */
export type Scope = Scoped<any> | Span | Read<boolean>;

const ALWAYS_TRUE: Read<boolean> = derive(() => true);

/** "Is this scope open right now?" Spans → one-shot interval; scoped
 *  factories → "any open invocation"; bool signals pass through. */
export function intervals(s: Scope): Read<boolean> {
  if (isScoped(s)) return s.alive;
  if (isSpan(s)) {
    return derive(() => s.status === "open");
  }
  return s;
}

/** Always-true scope; useful as a default when no scope is given. */
export function always(): Read<boolean> {
  return ALWAYS_TRUE;
}

/** Latch a predicate. Holds at `init` until `pred` is observed `!init`
 *  within `scope`, then flips and stays; re-arms on each `scope` rising
 *  edge. Outside `scope`, `pred` isn't consulted (latch holds). */
export function latch(
  pred: Read<boolean>,
  init: boolean,
  scope: Read<boolean> = ALWAYS_TRUE,
): Read<boolean> {
  const held = cell(init);
  let prevScope = false;

  effect(() => {
    const inScope = scope.value;
    // Track pred.value before any short-circuit so deps stay live.
    const pv = pred.value;
    if (inScope && !prevScope) {
      held.value = init;
    }
    prevScope = inScope;
    if (!inScope) return;
    if (held.peek() === init && pv !== init) {
      held.value = !init;
    }
  });

  return held;
}

/** First false→true edge wins. Returns `{ first, at }` (winner index +
 *  recorder-clock time), or undefined until one fires. Sticky once decided. */
export function firstOf(
  ...events: Read<boolean>[]
): Read<{ first: number; at: number } | undefined> {
  const result = cell<{ first: number; at: number } | undefined>(undefined);
  const prev = events.map(e => e.peek());

  effect(() => {
    if (result.peek() !== undefined) {
      for (const e of events) e.value;
      return;
    }
    for (let i = 0; i < events.length; i++) {
      const v = events[i].value;
      if (v && !prev[i]) {
        const at = activeRecorder()?.anim.clock ?? 0;
        result.value = { first: i, at };
        prev[i] = v;
        return;
      }
      prev[i] = v;
    }
  });

  return result;
}

function isScoped(v: unknown): v is Scoped<any> {
  return typeof v === "function" && "alive" in (v as object) && "last" in (v as object);
}

function isSpan(v: unknown): v is Span {
  return (
    typeof v === "object" &&
    v !== null &&
    "status" in (v as object) &&
    "fn" in (v as object) &&
    "id" in (v as object)
  );
}
