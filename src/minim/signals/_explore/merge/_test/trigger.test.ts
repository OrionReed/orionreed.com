// trigger.test.ts — §10 step 3: distinguish eager (fold-on-arrival)
// from lazy (deposit-then-resolve) merge triggers. The current
// prototype implements ONLY eager fold-on-arrival.
//
// What these tests pin:
//
//   1. For order-independent policies, eager and lazy are
//      observationally equivalent on the FINAL value (recorded so
//      a future lazy implementation can diff).
//   2. Where they differ: per-arrival side effects under eager
//      vs. once-per-cascade under lazy. The engine's writeHook is
//      the most accessible probe.
//   3. The current prototype CANNOT support an order-dependent
//      policy correctly — arrival order is structural, not
//      semantic. Tests assert this is broken, so the lazy trigger
//      is recognised as a precondition for non-commutative policies.

import { describe, expect, it } from "vitest";
import {
  batch,
  maxPolicy,
  type MergePolicy,
  Num,
  num,
  setSignalWriteHook,
  type Signal,
  sumPolicy,
} from "../index";

function diamond(policy: MergePolicy<number>, rootInit = 1) {
  const root = num(rootInit);
  const merged = root.merge(policy);
  const a = merged.add(1);
  const b = merged.scale(2);
  const s = Num.lens(
    [a, b] as const,
    ([av, bv]) => av + bv,
    (target, [av, bv]) => {
      const tot = av + bv;
      if (tot === 0) return [target / 2, target / 2];
      return [(target * av) / tot, (target * bv) / tot];
    },
  );
  return { root, merged, a, b, s };
}

describe("eager fold-on-arrival: side-effect timing", () => {
  it("writeHook fires once per VALUE-CHANGING arrival on the underlying root", () => {
    const calls: Signal<unknown>[] = [];
    const unhook = setSignalWriteHook(sig => {
      calls.push(sig);
    });
    try {
      const { root, s } = diamond(sumPolicy);
      s.value = 10;
      const rootCalls = calls.filter(c => c === root);
      // Two arrivals, both change acc (0→4, then 4→6.5), both
      // fire writeHook on the underlying root.
      expect(rootCalls.length).toBe(2);
    } finally {
      unhook();
    }
  });

  it("idempotent policies: engine equality short-circuit hides redundant arrivals", () => {
    const calls: Signal<unknown>[] = [];
    const unhook = setSignalWriteHook(sig => {
      calls.push(sig);
    });
    try {
      const { root, s } = diamond(maxPolicy);
      s.value = 10;
      // Two arrivals (4 then 2.5); max keeps 4 on second; equality
      // short-circuit suppresses the second writeHook on root.
      expect(calls.filter(s => s === root).length).toBe(1);
    } finally {
      unhook();
    }
  });

  it("final value matches what a lazy trigger would produce for order-independent policies", () => {
    const { root, s } = diamond(maxPolicy);
    s.value = 10;
    expect(root.value).toBe(4);
  });
});

describe("eager fold breaks for ORDER-DEPENDENT policies", () => {
  /** Non-commutative policy: "first writer wins". */
  const firstWinsPolicy: MergePolicy<number> = {
    identity: Number.NaN,
    combine: (acc, x) => (Number.isNaN(acc) ? x : acc),
  };

  it("the result depends on cascade arrival order (which is structural, not semantic)", () => {
    function diamondFirstWins(parentsOrder: "ab" | "ba") {
      const root = num(1);
      const merged = root.merge(firstWinsPolicy);
      const a = merged.add(1);
      const b = merged.scale(2);
      const parents = parentsOrder === "ab" ? ([a, b] as const) : ([b, a] as const);
      const s = Num.lens(
        parents,
        ([x, y]) => x + y,
        (target, [x, y]) => {
          const tot = x + y || 1;
          return [(target * x) / tot, (target * y) / tot];
        },
      );
      return { root, s };
    }
    const fwd = diamondFirstWins("ab");
    fwd.s.value = 10;
    const rev = diamondFirstWins("ba");
    rev.s.value = 10;
    expect(fwd.root.value).not.toBe(rev.root.value);
  });

  it("two top-level writes are SEPARATE cascades; first-wins applies cascade-locally", () => {
    let result1: number;
    {
      const r = num(1);
      const m = r.merge(firstWinsPolicy);
      const aa = m.add(1);
      const bb = m.scale(2);
      batch(() => {
        aa.value = 7;
        bb.value = 9;
      });
      result1 = r.value;
    }
    let result2: number;
    {
      const r = num(1);
      const m = r.merge(firstWinsPolicy);
      const aa = m.add(1);
      const bb = m.scale(2);
      batch(() => {
        bb.value = 9;
        aa.value = 7;
      });
      result2 = r.value;
    }
    // Each write is its own cascade; the SECOND wins (since each
    // cascade resets and commits its single contribution).
    expect(result1).toBe(4.5);
    expect(result2).toBe(6);
  });
});

describe("the lazy trigger — NOT IMPLEMENTED, but here's what it would test", () => {
  it.todo("lazy: writeHook fires ONCE per cascade, regardless of arrival count");
  it.todo("lazy + order-independent: same final value as eager (oracle equivalence)");
  it.todo("lazy + order-dependent: combine receives an unordered set, not a sequence");
  it.todo("lazy: effects subscribed to root fire once per cascade (not per arrival)");
  it.todo("lazy: peek() between writes within a batch sees the merge as Pending");
});
