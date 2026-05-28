// trigger.test.ts — §10 step 3: distinguish eager (fold-on-arrival)
// from lazy (deposit-then-resolve) merge triggers.
//
// The current prototype implements ONLY eager fold-on-arrival.
// These tests pin two things:
//
//   1. For order-independent policies, eager and lazy are
//      observationally equivalent on the FINAL value. Where they
//      differ is in INTERMEDIATE side-effects: the engine's write
//      hook (and any downstream sub that bypasses batching) fires
//      once per arrival under eager, once per cascade under lazy.
//
//   2. The current prototype CANNOT support an order-dependent
//      policy correctly. Eager fold of a non-commutative combine
//      depends on the engine's arrival order — which is determined
//      by lens construction order, not by anything semantically
//      meaningful. Tests assert this is broken today, so that
//      adding the lazy trigger is recognised as a precondition for
//      non-commutative policies, not a free addition.

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
  withMerge,
} from "../index";

function diamond(policy: MergePolicy<number>, rootInit = 1) {
  const root = withMerge(num(rootInit), policy);
  const a = root.add(1);
  const b = root.scale(2);
  const s = Num.lens(
    [a, b] as const,
    ([av, bv]) => av + bv,
    (target, [av, bv]) => {
      const tot = av + bv;
      if (tot === 0) return [target / 2, target / 2];
      return [(target * av) / tot, (target * bv) / tot];
    },
  );
  return { root, a, b, s };
}

describe("eager fold-on-arrival: side-effect timing", () => {
  it("writeHook fires once per VALUE-CHANGING arrival (NOT once per cascade)", () => {
    // Use `sum` because under `max` the second arrival's folded
    // value equals the first (2.5 < 4 → max stays 4), so the
    // engine's equality short-circuit suppresses the second
    // writeHook even though the merge intercept ran twice. The
    // sum policy doesn't have that property — both arrivals
    // change the acc, both fire writeHook.
    const calls: { sig: Signal<unknown> }[] = [];
    const unhook = setSignalWriteHook(sig => {
      calls.push({ sig });
    });
    try {
      const { root, s } = diamond(sumPolicy);
      s.value = 10;
      const rootCalls = calls.filter(c => c.sig === root);
      // Two cascade arrivals, both change acc (0→4, then 4→6.5),
      // both fire writeHook. The lazy trigger would fire ONCE
      // per cascade no matter how many arrivals.
      expect(rootCalls.length).toBe(2);
    } finally {
      unhook();
    }
  });

  it("the engine's equality short-circuit hides arrivals that don't change acc", () => {
    // Useful corollary: for IDEMPOTENT folds (max/min/union),
    // arrivals that don't move the acc are invisible to
    // downstream — the engine treats them as no-ops. This is
    // why §3 promises "the existing equality short-circuit
    // converges it" for the cheap path: the engine ALREADY
    // does the right thing structurally; merge just needs to
    // not get in the way.
    const calls: Signal<unknown>[] = [];
    const unhook = setSignalWriteHook(sig => {
      calls.push(sig);
    });
    try {
      const { root, s } = diamond(maxPolicy);
      s.value = 10;
      expect(calls.filter(s => s === root).length).toBe(1);
    } finally {
      unhook();
    }
  });

  it("final value matches the lazy trigger for any order-independent policy", () => {
    // We don't have a lazy implementation to compare against, so
    // this test is conditional: for ANY order-independent fold,
    // the final value is determined entirely by the multiset of
    // arrivals and the fold. Eager and lazy agree on multisets,
    // so they agree on the final value. The test simply records
    // the value the prototype produces, so a future lazy
    // implementation can diff against it.
    const { root, s } = diamond(maxPolicy);
    s.value = 10;
    expect(root.value).toBe(4);
  });
});

describe("eager fold breaks for ORDER-DEPENDENT policies", () => {
  /** Non-commutative policy: "first writer wins". Eager fold-on-
   *  arrival reads this as `combine(acc, x) = acc === identity ? x
   *  : acc` — sensitive to which arrival is first. */
  const firstWinsPolicy: MergePolicy<number> = {
    identity: Number.NaN, // sentinel: "no first yet"
    combine: (acc, x) => (Number.isNaN(acc) ? x : acc),
  };

  it("the result depends on cascade arrival order (which is structural, not semantic)", () => {
    // Forward fan-in order: [a, b] → cascade arrives a first.
    const fwd = diamond(firstWinsPolicy);
    fwd.s.value = 10;
    const fwdValue = fwd.root.value;

    // Reversed fan-in order: [b, a] → cascade arrives b first.
    const root = withMerge(num(1), firstWinsPolicy);
    const a = root.add(1);
    const b = root.scale(2);
    const sReversed = Num.lens(
      [b, a] as const,
      ([bv, av]) => av + bv,
      (target, [bv, av]) => {
        const tot = av + bv;
        if (tot === 0) return [target / 2, target / 2];
        return [(target * bv) / tot, (target * av) / tot];
      },
    );
    sReversed.value = 10;
    const revValue = root.value;

    // The order-dependent policy yields DIFFERENT values for the
    // two fan-in orders. The user wrote `[a, b]` vs `[b, a]` as a
    // construction-time choice, but the resulting reactive
    // behaviour disagrees. The lazy trigger would buffer both
    // arrivals and let the user's policy receive them as an
    // unordered set — at which point the policy's "first" has to
    // come from somewhere other than arrival order (e.g. an
    // explicit slot identity).
    expect(fwdValue).not.toBe(revValue);
  });

  it("batch over two top-level writes ALSO depends on textual write order", () => {
    const root = withMerge(num(1), firstWinsPolicy);
    const a = root.add(1);
    const b = root.scale(2);
    let result1: number;
    {
      const r = withMerge(num(1), firstWinsPolicy);
      const aa = r.add(1);
      const bb = r.scale(2);
      batch(() => {
        aa.value = 7; // a.bwd(7) = 6 → root acc = 6
        bb.value = 9; // b.bwd(9) = 4.5 → first-wins keeps 6
      });
      result1 = r.value;
    }
    let result2: number;
    {
      const r = withMerge(num(1), firstWinsPolicy);
      const aa = r.add(1);
      const bb = r.scale(2);
      batch(() => {
        bb.value = 9; // root acc = 4.5
        aa.value = 7; // first-wins keeps 4.5
      });
      result2 = r.value;
    }
    void root;
    void a;
    void b;
    expect(result1).toBe(6);
    expect(result2).toBe(4.5);
    expect(result1).not.toBe(result2);
    // CONCLUSION: order-dependent policy + eager arrival = the
    // result is a function of TEXTUAL order, which is sensible
    // for `first-wins` over explicit batched writes but NOT for
    // structural arrival order from a fan-in. Conflating these
    // is the symptom; the cure is the lazy trigger plus an
    // explicit slot identity passed into `combine`.
  });
});

describe("the lazy trigger \u2014 NOT IMPLEMENTED, but here's what it would test", () => {
  it.todo("lazy: writeHook fires ONCE per cascade, regardless of arrival count");
  it.todo("lazy + order-independent: same final value as eager (oracle equivalence)");
  it.todo("lazy + order-dependent: combine receives an unordered set, not a sequence");
  it.todo("lazy: effects subscribed to root fire once per cascade (not per arrival)");
  it.todo("lazy: peek() between writes within a batch sees the merge as Pending, resolves on read");
});
