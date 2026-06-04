// fast-check arbitraries for the suite. Replaces the hand-rolled
// mulberry32 PRNGs scattered through the old tests — the win is
// shrinking: a failing fuzz case collapses to a minimal repro instead of
// a seed you have to replay by hand.

import fc from "fast-check";

/** A finite number in a sane range (no NaN/Infinity). */
export const finite = (min = -1e6, max = 1e6): fc.Arbitrary<number> =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

/** A short sequence of finite write values. */
export const writes = (min = -1e3, max = 1e3): fc.Arbitrary<number[]> =>
  fc.array(finite(min, max), { minLength: 1, maxLength: 8 });

/** Chain depth for backward-walk tests. */
export const depth = (max = 12): fc.Arbitrary<number> => fc.integer({ min: 1, max });

/** Fan-in width for split/reconverge tests. */
export const width = (max = 8): fc.Arbitrary<number> => fc.integer({ min: 1, max });

/** A permutation of `[0, n)`, for confluence / write-order tests. */
export const permutation = (n: number): fc.Arbitrary<number[]> =>
  fc
    .constant(Array.from({ length: n }, (_unused, i) => i))
    .chain(xs => fc.shuffledSubarray(xs, { minLength: n, maxLength: n }));
