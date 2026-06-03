// merge.test.ts — deep coverage of merge() (the backward dual of a
// multi-dep computed). Complements topology.test.ts: focuses on policy
// variants, incremental vs full fold, glitch-free fire counts, eager vs
// batched folding, mixed direct/lens contributions, and interaction with
// the view-level equality gate.

import { describe, expect, it, vi } from "vitest";
import { type MergePolicy, batch, computed, effect, lens, signal } from "../index";

const sum: MergePolicy<number> = {
  identity: 0,
  combine: (a, b) => a + b,
  remove: (a, b) => a - b,
};
const product: MergePolicy<number> = {
  identity: 1,
  combine: (a, b) => a * b,
};
const max: MergePolicy<number> = {
  identity: Number.NEGATIVE_INFINITY,
  combine: (a, b) => Math.max(a, b),
};

describe("merge policies", () => {
  it("product folds contributions multiplicatively", () => {
    const root = signal(1);
    const m = root.merge(product);
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    batch(() => {
      a.value = 3;
      b.value = 4;
    });
    expect(root.value).toBe(12);
  });

  it("max folds to the largest contribution", () => {
    const root = signal(0);
    const m = root.merge(max);
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    const c = lens(m, (v) => v, (t) => t);
    batch(() => {
      a.value = 5;
      b.value = 99;
      c.value = 12;
    });
    expect(root.value).toBe(99);
  });

  it("custom mean policy (sum then divide on read)", () => {
    // Mean as a derived read over a sum merge.
    const root = signal(0);
    const m = root.merge(sum);
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    const mean = computed(() => root.value / 2);
    batch(() => {
      a.value = 10;
      b.value = 30;
    });
    expect(root.value).toBe(40);
    expect(mean.value).toBe(20);
  });
});

describe("incremental fold (remove) matches full fold", () => {
  it("re-writing one slot updates incrementally to the same result", () => {
    const root = signal(0);
    const m = root.merge(sum); // sum has `remove`
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    batch(() => {
      a.value = 4;
      b.value = 6;
    });
    expect(root.value).toBe(10);
    // Re-write only `a` in a fresh cascade: slot map resets per settle,
    // so the result is just the latest cascade's contributions.
    batch(() => {
      a.value = 100;
      b.value = 6;
    });
    expect(root.value).toBe(106);
  });
});

describe("glitch-free fold: one downstream fire per settle", () => {
  it("a sibling effect on root fires once for a multi-contributor batch", () => {
    const root = signal(0);
    const m = root.merge(sum);
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    const c = lens(m, (v) => v, (t) => t);
    const fn = vi.fn(() => void root.value);
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    batch(() => {
      a.value = 1;
      b.value = 2;
      c.value = 3;
    });
    expect(root.value).toBe(6);
    expect(fn).toHaveBeenCalledTimes(2); // ONE fold, ONE fire
  });
});

describe("eager (unbatched) single contributor", () => {
  it("folds immediately on a lone write", () => {
    const root = signal(0);
    const m = root.merge(sum);
    const a = lens(m, (v) => v, (t) => t);
    a.value = 7; // no batch
    expect(root.value).toBe(7);
    a.value = 9;
    expect(root.value).toBe(9); // slot reset per settle → just `a`
  });
});

describe("mixed direct write + lens contributions", () => {
  it("a direct write to the merge cell folds alongside a lens", () => {
    const root = signal(0);
    const m = root.merge(sum);
    const a = lens(m, (v) => v, (t) => t);
    batch(() => {
      a.value = 5; // lens-slot contribution
      m.value = 11; // DIRECT_SLOT contribution
    });
    expect(root.value).toBe(16);
  });
});

describe("merge read-only guard", () => {
  it("merge() on a plain computed throws", () => {
    const root = signal(1);
    const c = computed(() => root.value * 2);
    expect(() => (c as { merge: (p: MergePolicy<number>) => unknown }).merge(sum)).toThrow(
      /read-only/,
    );
  });

  it("merge() on a writable lens is allowed", () => {
    const root = signal(1);
    const l = lens(root, (v) => v + 1, (t) => t - 1);
    expect(() => l.merge(sum)).not.toThrow();
  });
});

describe("merge contributor whose source resolves unchanged", () => {
  it("a fold to the current source value fires nothing downstream", () => {
    const root = signal(6);
    const m = root.merge(sum);
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    const fn = vi.fn(() => void root.value);
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    // a=2 + b=4 = 6 == current root → source gate stops propagation.
    batch(() => {
      a.value = 2;
      b.value = 4;
    });
    expect(root.value).toBe(6);
    expect(fn).toHaveBeenCalledTimes(1); // no forward fire
  });
});

describe("deep merge: merge under a lens chain", () => {
  it("a lens above a merge carries the fold to the source", () => {
    const root = signal(0);
    const scaled = lens(root, (v) => v * 2, (t) => t / 2); // root*2 view
    const m = scaled.merge(sum);
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    batch(() => {
      a.value = 8;
      b.value = 4;
    });
    // fold = 12 pushed to `scaled`; scaled.put(12) = 6 → root.
    expect(root.value).toBe(6);
    expect(scaled.value).toBe(12);
  });
});
