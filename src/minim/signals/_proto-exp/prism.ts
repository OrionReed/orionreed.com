// _proto-exp/prism.ts — prism for nullable / sum-type cells.
//
// A lens narrows: takes a parent and produces a focused view of part
// of it (Vec → x). A prism is the dual: it succeeds when the parent
// matches a particular case, fails (in some way) otherwise.
//
// Use cases:
//   - Signal<T | undefined>.present() → Signal<T> view; throws on undefined
//   - Signal<Result>.ok() / .err() — narrow to a tagged-union case
//   - Signal<unknown>.is(predicate) — type-narrow
//
// Two flavors:
//   strictPrism: throws on case-miss (Maybe-narrowed reads/writes fail)
//   safePrism:   returns a fallback for missed reads; ignores miss for writes
//
// Built on .lensTo with appropriate fwd/bwd that handle the case logic.

import { Signal } from "../signal";
import { Num } from "../values/num";

/** "Present-or-default": when source is non-undefined, returns it; on
 *  undefined, returns fallback. Writes only succeed when source is
 *  currently present. */
export function presentOr<T>(
  source: Signal<T | undefined>,
  Wrap: unknown,
  fallback: T,
): Signal<T> {
  return (source as unknown as {
    lensTo(C: unknown, f: (s: T | undefined) => T, b: (v: T, s: T | undefined) => T | undefined): Signal<T>;
  }).lensTo(
    Wrap,
    (s) => (s === undefined ? fallback : s),
    (v, s) => (s === undefined ? s : v),
  );
}

/** "Present-or-throw" — strict narrowing. Reading an absent value
 *  throws; writing to an absent slot also throws. */
export function present<T>(
  source: Signal<T | undefined>,
  Wrap: unknown,
): Signal<T> {
  return (source as unknown as {
    lensTo(C: unknown, f: (s: T | undefined) => T, b: (v: T, s: T | undefined) => T | undefined): Signal<T>;
  }).lensTo(
    Wrap,
    (s) => {
      if (s === undefined) throw new TypeError("present: source is undefined");
      return s;
    },
    (v, s) => {
      if (s === undefined) throw new TypeError("present: cannot write to absent slot");
      return v;
    },
  );
}

/** Sum-type prism: focuses on a specific tag of a discriminated union.
 *  `tag` selects the case; `extract` pulls the payload; `embed` rewraps
 *  on write. The `Read` is undefined when the source is in a different
 *  case (use `presentOr` on top if you want a fallback). */
export function caseOf<S, T>(
  source: Signal<S>,
  // Wrap typed loosely — variance constraints on Signal<T> defeat
  // strict typing here. Cast at consumer boundary.
  Wrap: unknown,
  matches: (s: S) => boolean,
  extract: (s: S) => T,
  embed: (t: T, s: S) => S,
): Signal<T | undefined> {
  return (source as unknown as {
    lensTo(C: unknown, f: (s: S) => T | undefined, b: (v: T | undefined, s: S) => S): Signal<T | undefined>;
  }).lensTo(
    Wrap,
    (s) => (matches(s) ? extract(s) : undefined),
    (t, s) => (t === undefined || !matches(s) ? s : embed(t, s)),
  );
}

// Use Num as the wrapper class for these convenience helpers (most
// nullable numeric examples use Num); other types use their own wrapper.
export { Num };
