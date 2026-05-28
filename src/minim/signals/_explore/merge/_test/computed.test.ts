// computed.test.ts — `.merge()` interacting with read-only derived
// views (computeds). Forward-only consumers of a merge should see
// the committed value, and computeds whose dependencies cross the
// merge should re-derive correctly when the merge folds and commits.
//
// Cases covered:
//   1. Computed reading the merge cell — direct fwd subscriber.
//   2. Computed reading the parent BELOW the merge — equivalent
//      view because merge is fwd-identity.
//   3. Computed reading a lens ABOVE the merge — re-derives after
//      cascade commits via merge.
//   4. Computed fed INTO a fan-in whose bwd lands at the merge.
//   5. Chain of computeds spanning the merge.
//   6. Equality short-circuit at computeds suppresses no-op re-derives.

import { describe, expect, it } from "vitest";
import { derive, maxPolicy, Num, num, sumPolicy } from "../index";

describe("computed reading the merge cell", () => {
  it("returns merge.value, re-derives when merge commits", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const doubled = Num.derive(merged, v => v * 2);
    expect(doubled.value).toBe(0);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    expect(doubled.value).toBe(merged.value * 2);
  });
});

describe("computed reading the parent BELOW the merge", () => {
  it("same value as a computed reading the merge cell (merge is fwd-identity)", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const viaRoot = Num.derive(root, v => v);
    const viaMerged = Num.derive(merged, v => v);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    expect(viaRoot.value).toBe(viaMerged.value);
  });
});

describe("computed reading a lens ABOVE the merge", () => {
  it("re-derives after merge commits and value propagates up", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    // A computed reading `a` — `a` is upstream of the merge in fwd
    // direction, so the computed re-derives when root (= merged)
    // changes after a cascade.
    const view = Num.derive(a, v => v + 100);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    expect(view.value).toBe(a.value + 100);
  });
});

describe("computed fed INTO a fan-in whose bwd lands at the merge", () => {
  it("fan-in reads the computed normally; bwd-write to fan-in cascades through merge", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const computed_b = Num.derive(merged, v => v * 3);
    // Fan-in: one writable parent (a) + one RO computed (computed_b).
    // bwd can only write to the writable parent — common pattern
    // for "view of a derived value + an editable handle".
    const fan = Num.lens(
      [a, computed_b] as const,
      ([x, y]) => x + y,
      (target, [x, _y]) => {
        // RO parent: returning `undefined` for the second slot
        // means "skip this parent". Only `a` gets written.
        return [target, undefined];
      },
    );
    fan.value = 5;
    // a slot: a.bwd(5) = 4 → arrives at merge under slot `a`.
    // No second slot for computed_b — RO parent gets skipped.
    expect(root.value).toBe(4);
    expect(computed_b.value).toBe(merged.value * 3);
  });
});

describe("chain of computeds spanning the merge", () => {
  it("composes correctly: cascade settles, every computed in the chain agrees", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const viewA = Num.derive(a, v => v * 10);
    const viewMerged = Num.derive(merged, v => v + 100);
    const viewRoot = Num.derive(root, v => v - 1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    // After settle: root.value, merged.value, a.value all consistent
    expect(viewA.value).toBe(a.value * 10);
    expect(viewMerged.value).toBe(merged.value + 100);
    expect(viewRoot.value).toBe(root.value - 1);
  });
});

describe("equality short-circuit", () => {
  it("idempotent merge + same final folded value ⇒ downstream computeds don't re-derive", () => {
    // max policy: first arrival sets acc=high; second arrival
    // doesn't change acc; engine's `prev === next` check
    // suppresses the second commit's downstream propagation.
    const root = num(0);
    const merged = root.merge(maxPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    let derivations = 0;
    const view = derive(() => {
      derivations++;
      return merged.value * 7;
    });
    void view.value; // initial derive
    const baseline = derivations;
    fan.value = 6;
    void view.value; // pull to trigger any needed re-derive
    // With max + equality short-circuit, the second arrival's
    // identical folded value suppresses propagation; view re-derives
    // AT MOST once for the whole cascade (or even 0 times if the
    // final folded value equals the prior).
    expect(derivations - baseline).toBeLessThanOrEqual(1);
  });
});

describe("untracked reads from inside a computed", () => {
  it("an untracked read of the merge cell doesn't subscribe the computed", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    let derivations = 0;
    const peeker = derive(() => {
      derivations++;
      // Use .peek() to bypass tracking
      return merged.peek();
    });
    void peeker.value;
    const baseline = derivations;
    root.value = 42;
    void peeker.value; // not re-derived (no subscription)
    expect(derivations - baseline).toBe(0);
  });
});
