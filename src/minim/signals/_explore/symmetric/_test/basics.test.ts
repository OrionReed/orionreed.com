// basics.test.ts — sanity-check the symmetric engine.
//
// We verify:
//   - Forward: read, write, derive, effect re-runs.
//   - Backward: lens read/write, chained lenses, coalescing.
//   - Merge: aggregates contributions across multiple lenses.
//   - Symmetric cost: lens setter runs ONCE per cascade even with
//     multiple writes.
//   - Intermediate observation: each lens cell in a chain is
//     observable (no fusion to root).

import { describe, expect, it, vi } from "vitest";
import { batch, computed, derive, effect, lens, signal, sumPolicy } from "../index";

describe("symmetric engine: forward basics", () => {
  it("signal read/write", () => {
    const s = signal(0);
    expect(s.value).toBe(0);
    s.value = 5;
    expect(s.value).toBe(5);
  });

  it("derive recomputes lazily on read", () => {
    const s = signal(2);
    const d = derive(s, (v) => v * 10);
    expect(d.value).toBe(20);
    s.value = 3;
    expect(d.value).toBe(30);
  });

  it("computed (auto-tracking)", () => {
    const a = signal(1);
    const b = signal(2);
    const c = computed(() => a.value + b.value);
    expect(c.value).toBe(3);
    a.value = 10;
    expect(c.value).toBe(12);
  });

  it("effect re-runs on dep change", () => {
    const s = signal(0);
    const fn = vi.fn(() => {
      void s.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    s.value = 1;
    expect(fn).toHaveBeenCalledTimes(2);
    s.value = 2;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("batch coalesces effect fires", () => {
    const s = signal(0);
    const t = signal(0);
    const fn = vi.fn(() => {
      void s.value;
      void t.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    batch(() => {
      s.value = 1;
      t.value = 2;
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("symmetric engine: lens basics", () => {
  it("lens read forwards, write backwards", () => {
    const s = signal(5);
    const l = lens(
      s,
      (v) => v * 2,
      (target) => target / 2,
    );
    expect(l.value).toBe(10);
    l.value = 20;
    expect(s.value).toBe(10);
    expect(l.value).toBe(20);
  });

  it("two-deep lens chain commits to root", () => {
    const root = signal(1);
    const a = lens(
      root,
      (v) => v + 10,
      (target) => target - 10,
    );
    const b = lens(
      a,
      (v) => v * 2,
      (target) => target / 2,
    );
    expect(b.value).toBe(22); // (1+10)*2
    b.value = 30;
    // 30 → a: 15 → root: 5
    expect(root.value).toBe(5);
    expect(a.value).toBe(15);
    expect(b.value).toBe(30);
  });

  it("intermediate cells in chain ARE observable (no fusion)", () => {
    // Each lens is a real node. Subscribing to the middle of a chain
    // works without forcing a re-derive of all layers.
    const root = signal(1);
    const mid = lens(
      root,
      (v) => v + 100,
      (target) => target - 100,
    );
    const tip = lens(
      mid,
      (v) => v * 2,
      (target) => target / 2,
    );

    const seen: number[] = [];
    effect(() => {
      seen.push(mid.value);
    });
    expect(seen).toEqual([101]);

    tip.value = 220; // mid: 110, root: 10 (deferred cascade)
    // Lazy bwd: cascade deferred. Triggering read commits + fires effect.
    expect(mid.value).toBe(110);
    expect(seen[seen.length - 1]).toBe(110);
    expect(root.value).toBe(10);
  });
});

describe("symmetric engine: coalescing (the design payoff)", () => {
  it("setter runs ONCE per cascade even with multiple writes", () => {
    const root = signal(0);
    const setterCalls = vi.fn();
    const l = lens(
      root,
      (v) => v,
      (target) => {
        setterCalls();
        return target;
      },
    );

    // Three writes in a batch — setter should run ONCE.
    batch(() => {
      l.value = 1;
      l.value = 2;
      l.value = 3;
    });
    expect(setterCalls).toHaveBeenCalledTimes(1);
    expect(root.value).toBe(3);
  });

  it("HYBRID: eager cascade outside batch, lazy inside", () => {
    // Hybrid dispatch (perf-driven):
    //   * Unbatched writes cascade immediately (matches alien-speed).
    //   * Batched writes deposit + coalesce; one setter call per
    //     cell at batch exit, regardless of write count.
    // Both yield the same settled state by the next observation.
    const root = signal(0);
    const setterCalls = vi.fn();
    const l = lens(
      root,
      (v) => v,
      (target) => {
        setterCalls();
        return target;
      },
    );
    // Unbatched: cascade is immediate.
    l.value = 5;
    expect(setterCalls).toHaveBeenCalledTimes(1);
    expect(root.value).toBe(5);

    // Batched: cascade deferred until batch exit; multiple writes
    // collapse to one setter run.
    batch(() => {
      l.value = 6;
      l.value = 7;
      l.value = 8;
      expect(setterCalls).toHaveBeenCalledTimes(1);
    });
    expect(setterCalls).toHaveBeenCalledTimes(2);
    expect(root.value).toBe(8);
  });

  it("effects fire ONCE for a batch of bwd writes through a chain", () => {
    const root = signal(0);
    const l1 = lens(
      root,
      (v) => v,
      (target) => target,
    );
    const l2 = lens(
      l1,
      (v) => v,
      (target) => target,
    );
    const l3 = lens(
      l2,
      (v) => v,
      (target) => target,
    );
    const fn = vi.fn(() => {
      void root.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);

    batch(() => {
      l3.value = 1;
      l3.value = 2;
      l3.value = 3;
      l1.value = 99;
      l3.value = 5;
    });
    // All bwd writes coalesce into a single fwd flush.
    expect(fn).toHaveBeenCalledTimes(2);
    expect(root.value).toBe(5);
  });
});

describe("symmetric engine: merge basics", () => {
  it("merge aggregates contributions from multiple lenses", () => {
    const root = signal(0);
    const m = root.merge(sumPolicy);
    const a = lens(
      m,
      (v) => v,
      (target) => target,
    );
    const b = lens(
      m,
      (v) => v,
      (target) => target,
    );
    const c = lens(
      m,
      (v) => v,
      (target) => target,
    );

    batch(() => {
      a.value = 1;
      b.value = 2;
      c.value = 3;
    });
    // sum of contributions: 1 + 2 + 3 = 6.
    expect(root.value).toBe(6);
  });

  it("merge re-write to same slot replaces (not double-counts)", () => {
    const root = signal(0);
    const m = root.merge(sumPolicy);
    const a = lens(
      m,
      (v) => v,
      (target) => target,
    );
    const b = lens(
      m,
      (v) => v,
      (target) => target,
    );

    batch(() => {
      a.value = 1;
      a.value = 10; // replaces a's slot (not 1 + 10)
      b.value = 2;
    });
    expect(root.value).toBe(12);
  });
});
