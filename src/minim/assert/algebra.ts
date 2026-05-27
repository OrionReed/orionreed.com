// Bool-signal primitives. The whole claim algebra is built from
// these three functions plus signal arithmetic.
//
//   intervals(scope)   — convert a Scope (factory / span / bool sig)
//                        to a single bool signal: "is this open now?".
//   latch(p, init, sc) — invariant/liveness latch with auto re-arm
//                        on `sc` rising edges.
//   firstOf(...e)      — generalized event ordering over bool sigs.
//
// All return `Read<boolean>` (or, for `firstOf`, `Read<{first,at}>`).
// Composition with `and` / `or` / `not` is just signal algebra.

import { derive, effect, type Read, signal } from "@minim/signals";
import { activeRecorder } from "./record";
import { type Scoped } from "./scope";
import { type Span } from "./span";

/** Anything an interval can be derived from. */
export type Scope = Scoped<any> | Span | Read<boolean>;

const ALWAYS_TRUE: Read<boolean> = derive(() => true);

/** "Is this scope open right now?" — one converter for the whole
 *  parameter zoo. Spans become a one-shot interval (closed-and-stays-
 *  closed); scoped factories become class-quantified ("any open
 *  invocation"); bool signals pass through. */
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

/** Latch a predicate. Returns a Read<boolean> whose value:
 *
 *    init = true:   stays true until `pred` is observed false within
 *                   `scope`; flips to false and stays. Re-arms (back
 *                   to true) on each `scope` rising edge.
 *
 *    init = false:  stays false until `pred` is observed true within
 *                   `scope`; flips to true and stays. Re-arms on
 *                   each `scope` rising edge.
 *
 *  Outside `scope`, `pred` is not consulted — the latch holds at
 *  its current value. With `scope = always()`, the latch is forever-
 *  evaluated. */
export function latch(
  pred: Read<boolean>,
  init: boolean,
  scope: Read<boolean> = ALWAYS_TRUE,
): Read<boolean> {
  const held = signal(init);
  let prevScope = false;

  effect(() => {
    const inScope = scope.value;
    // Force-track pred.value before any short-circuit so deps stay live.
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

/** First event to fire wins. Each input is a `Read<boolean>` treated
 *  as an event whose "fire" is the false→true edge.
 *
 *  Returns `{ first, at }` where `first` is the index of the winner
 *  and `at` is the timestamp from the recorder clock — or undefined
 *  if no input has fired yet. Decision is sticky: once decided,
 *  ignores further edges. */
export function firstOf(
  ...events: Read<boolean>[]
): Read<{ first: number; at: number } | undefined> {
  const result = signal<{ first: number; at: number } | undefined>(undefined);
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

// ─── helpers ────────────────────────────────────────────────────

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
