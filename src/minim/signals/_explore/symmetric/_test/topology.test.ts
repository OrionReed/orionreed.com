// topology.test.ts — verify symmetric engine correctness across
// graph shapes: chains, fan-out, fan-in (via merge), diamonds,
// merge-of-merge, deep nesting, and effect-driven re-cascade.

import { describe, expect, it, vi } from "vitest";
import { type Signal, batch, effect, lens, signal, sumPolicy } from "../index";
const lin = (m: number, b: number) =>
  ({ fwd: (v: number) => m * v + b, bwd: (t: number) => (t - b) / m });

describe("symmetric: deep chains", () => {
  it("10-deep lens chain commits correctly to root (single write)", () => {
    const root = signal(0);
    let cell: Signal<number> = root;
    for (let i = 1; i <= 10; i++) {
      const { fwd, bwd } = lin(1, i); // each layer adds i
      cell = lens(cell, fwd, bwd);
    }
    // forward: root=0 + 1+2+...+10 = 55
    expect(cell.value).toBe(55);
    // write back: target=100 → root = 100 - (1+2+...+10) = 45
    cell.value = 100;
    expect(root.value).toBe(45);
    expect(cell.value).toBe(100);
  });

  it("10-deep chain: setter runs at most ONCE per cell per cascade", () => {
    const root = signal(0);
    const setterCounts: number[] = [];
    let cell: Signal<number> = root;
    for (let i = 1; i <= 10; i++) {
      const idx = i - 1;
      setterCounts[idx] = 0;
      cell = lens(
        cell,
        (v) => v + i,
        (t) => {
          setterCounts[idx]++;
          return t - i;
        },
      );
    }
    batch(() => {
      cell.value = 100;
      cell.value = 200;
      cell.value = 300;
    });
    // Each setter ran exactly once despite 3 writes.
    for (const c of setterCounts) expect(c).toBe(1);
  });
});

describe("symmetric: fan-in via merge", () => {
  it("3-input merge with diamond topology", () => {
    const root = signal(0);
    const m = root.merge(sumPolicy);
    // three contributors, each is an identity lens
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    const c = lens(m, (v) => v, (t) => t);

    batch(() => {
      a.value = 10;
      b.value = 20;
      c.value = 30;
    });
    expect(root.value).toBe(60);
  });

  it("merge passes through stale slots across cascades", () => {
    // Cascade 1: a=1, b=2. Cascade 2: write b=10 only.
    // Slot map is RESET between cascades, so cascade 2's result is
    // just b=10 (a's previous contribution doesn't persist).
    const root = signal(0);
    const m = root.merge(sumPolicy);
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);

    batch(() => {
      a.value = 1;
      b.value = 2;
    });
    expect(root.value).toBe(3);

    b.value = 10;
    expect(root.value).toBe(10); // a's contribution gone
  });

  it("merge-of-merge: two-level aggregation", () => {
    const root = signal(0);
    const outer = root.merge(sumPolicy);
    const inner = outer.merge(sumPolicy);
    // inner has two contributors
    const x = lens(inner, (v) => v, (t) => t);
    const y = lens(inner, (v) => v, (t) => t);
    // outer has the inner merge AND a sibling lens
    const z = lens(outer, (v) => v, (t) => t);

    batch(() => {
      x.value = 1;
      y.value = 2;
      z.value = 100;
    });
    // inner folds to 3, outer folds (3 + 100) = 103.
    expect(root.value).toBe(103);
  });
});

describe("symmetric: fan-out (forward) + single write back", () => {
  it("multiple effects on derived chain re-fire once per cascade", () => {
    const root = signal(0);
    const a = lens(root, (v) => v + 1, (t) => t - 1);
    const b = lens(root, (v) => v * 2, (t) => t / 2);

    const fnA = vi.fn(() => {
      void a.value;
    });
    const fnB = vi.fn(() => {
      void b.value;
    });
    effect(fnA);
    effect(fnB);
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);

    root.value = 5;
    expect(fnA).toHaveBeenCalledTimes(2);
    expect(fnB).toHaveBeenCalledTimes(2);
    expect(a.value).toBe(6);
    expect(b.value).toBe(10);
  });
});

describe("symmetric: effect-driven re-cascade", () => {
  it("effect that writes a signal triggers another cascade", () => {
    const a = signal(0);
    const b = signal(0);
    let recursions = 0;
    effect(() => {
      const av = a.value;
      if (av > 0 && av < 5) {
        recursions++;
        b.value = av * 10;
      }
    });
    expect(b.value).toBe(0);
    a.value = 3;
    // Effect saw a=3, wrote b=30 inside flush. Loop drained b's
    // cascade in same flush.
    expect(b.value).toBe(30);
    expect(recursions).toBe(1);
  });

  it("effect writing through a lens commits to root", () => {
    const root = signal(0);
    const l = lens(root, (v) => v + 100, (t) => t - 100);
    const trigger = signal(0);
    effect(() => {
      if (trigger.value > 0) l.value = 250;
    });
    trigger.value = 1;
    expect(root.value).toBe(150);
    expect(l.value).toBe(250);
  });
});

describe("symmetric: write-coalescing semantics", () => {
  it("write same lens twice in batch → last-write-wins, setter runs once", () => {
    const root = signal(0);
    const calls = vi.fn();
    const l = lens(
      root,
      (v) => v,
      (t) => {
        calls();
        return t;
      },
    );
    batch(() => {
      l.value = 1;
      l.value = 2;
      l.value = 3;
    });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(root.value).toBe(3);
  });

  it("write same merge slot twice in batch → second replaces first", () => {
    const root = signal(0);
    const m = root.merge(sumPolicy);
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);

    batch(() => {
      a.value = 1;
      a.value = 10; // replaces a's slot
      b.value = 2;
    });
    expect(root.value).toBe(12);
  });
});

describe("symmetric: cost-shape invariants", () => {
  // We can't directly measure ns here, but we can verify that the
  // per-cell dispatch count for a bwd write equals the per-cell
  // dispatch count for a fwd propagation. Both should be O(chain
  // depth).
  it("bwd chain dispatches the same # of setters as fwd dispatches getters", () => {
    const N = 5;
    const root = signal(0);
    let getterCalls = 0;
    let setterCalls = 0;
    let cell: Signal<number> = root;
    for (let i = 0; i < N; i++) {
      cell = lens(
        cell,
        (v) => {
          getterCalls++;
          return v + 1;
        },
        (t) => {
          setterCalls++;
          return t - 1;
        },
      );
    }
    // Warm up: ensure everything is cached & clean.
    void cell.value;

    // Forward cascade: write root → read tip. Each layer's getter
    // re-runs exactly once (lazy resolution from cache invalidation).
    getterCalls = 0;
    root.value = 1;
    void cell.value;
    expect(getterCalls).toBe(N);

    // Backward cascade: single (unbatched) write cascades eagerly,
    // each put runs exactly once.
    setterCalls = 0;
    cell.value = 100;
    void cell.value;
    expect(setterCalls).toBe(N);
  });

  it("multi-write batch: bwd setters per cell = 1 (coalesced), fwd getters per cell = 1 (lazy)", () => {
    const N = 5;
    const root = signal(0);
    let getterCalls = 0;
    let setterCalls = 0;
    let cell: Signal<number> = root;
    for (let i = 0; i < N; i++) {
      cell = lens(
        cell,
        (v) => {
          getterCalls++;
          return v + 1;
        },
        (t) => {
          setterCalls++;
          return t - 1;
        },
      );
    }

    setterCalls = 0;
    batch(() => {
      for (let i = 0; i < 10; i++) cell.value = i;
    });
    // Each setter exactly once.
    expect(setterCalls).toBe(N);

    // Now read: each getter once (lazy).
    getterCalls = 0;
    void cell.value;
    expect(getterCalls).toBe(N);
  });
});
