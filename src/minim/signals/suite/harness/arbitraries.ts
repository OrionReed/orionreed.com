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

// ─── Random sound topologies ────────────────────────────────────────
//
// A serializable description of a write-through DAG, built only from
// operations that preserve PutGet so a write of any reachable target
// reads back exactly: invertible affine 1→1 steps (k ∈ {-1, 1}, no float
// drift) and even-split N→1 fan-ins. Every subtree owns fresh sources,
// so the result is a tree (no shared source / diamond) — the case where
// read-back is unambiguous. Shared-source soundness, which depends on a
// designated-anchor `bwd` and isn't expressible through the generic
// adapter, is covered by `_test/bwd-soundness.test.ts`.

export type TreePlan =
  | { t: "leaf" }
  | { t: "affine"; k: 1 | -1; b: number; child: TreePlan }
  | { t: "sum"; kids: TreePlan[] };

/** Random PutGet-preserving write-through tree, depth-bounded. */
export const treePlan = (maxDepth = 4): fc.Arbitrary<TreePlan> =>
  fc.letrec<{ node: TreePlan }>(tie => ({
    node: fc.oneof(
      { maxDepth, depthIdentifier: "tree" },
      fc.constant<TreePlan>({ t: "leaf" }),
      fc.record({
        t: fc.constant<"affine">("affine"),
        k: fc.constantFrom<1 | -1>(1, -1),
        b: fc.integer({ min: -1000, max: 1000 }),
        child: tie("node"),
      }),
      fc.record({
        t: fc.constant<"sum">("sum"),
        kids: fc.array(tie("node"), { minLength: 2, maxLength: 4 }),
      }),
    ),
  })).node;
