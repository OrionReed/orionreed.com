// Propagator smoke tests — basic semantics.

import { describe, expect, it } from "vitest";
import { num, signal } from "../../signals";
import { adder, constant, eq, propagators, PropagatorDivergedError } from "..";

describe("propagators: basic", () => {
  it("network is empty until propagators are added; idle is silent", () => {
    const p = propagators();
    expect(p.count).toBe(0);
    p.dispose();
  });

  it("adder: a + b = c — forward direction", () => {
    const a = num(2);
    const b = num(3);
    const c = num(0);
    const p = propagators();
    p.add(adder(a, b, c));
    expect(c.value).toBe(5); // initial fire computed it

    a.value = 10;
    expect(c.value).toBe(13);
    p.dispose();
  });

  it("adder: writing c back-deduces a and b — multi-direction inference", () => {
    const a = num(2);
    const b = num(3);
    const c = num(0);
    const p = propagators();
    p.add(adder(a, b, c));

    // a=2, b=3, c=5 after initial run.
    expect(c.value).toBe(5);

    // Externally set c = 20; expect b to back-deduce: b = c - a = 18.
    // (a stays — only one missing variable can be back-deduced per
    // direction.) The freshness logic should run propagator2 (a,c → b)
    // because c is fresh, NOT propagator1 (a,b → c) which would
    // overwrite c.
    c.value = 20;
    // a held at 2, so b = 20 - 2 = 18.
    expect(b.value).toBe(18);
    expect(c.value).toBe(20);
    expect(a.value).toBe(2);
    p.dispose();
  });

  it("eq: bidirectional binding via two propagators", () => {
    const a = num(5);
    const b = num(0);
    const p = propagators();
    p.add(eq(a, b));
    expect(b.value).toBe(5);

    b.value = 99;
    expect(a.value).toBe(99);

    a.value = 7;
    expect(b.value).toBe(7);
    p.dispose();
  });

  it("constant: pins a signal to a value", () => {
    const a = num(0);
    const p = propagators();
    p.add(constant(a, 42));
    expect(a.value).toBe(42);
    // External writes get overwritten on next fire.
    a.value = 100;
    expect(a.value).toBe(42);
    p.dispose();
  });

  it("chained propagators: a + b = c, c + d = e", () => {
    const a = num(1);
    const b = num(2);
    const c = num(0);
    const d = num(10);
    const e = num(0);
    const p = propagators();
    p.add(adder(a, b, c), adder(c, d, e));
    // Initial: c = 3, e = 13.
    expect(c.value).toBe(3);
    expect(e.value).toBe(13);

    // Drag a; expect c, e to follow.
    a.value = 5;
    expect(c.value).toBe(7);
    expect(e.value).toBe(17);
    p.dispose();
  });
});

describe("propagators: termination guarantees", () => {
  it("infinite-loop propagator pair throws PropagatorDivergedError", () => {
    // a = b + 1; b = a + 1. Drift forever.
    const a = num(0);
    const b = num(0);
    const p = propagators({ iterations: 50 });
    expect(() => {
      // Build a divergent pair manually.
      p.add(
        {
          reads: [b],
          writes: [a],
          step: () => {
            a.value = b.value + 1;
          },
        },
        {
          reads: [a],
          writes: [b],
          step: () => {
            b.value = a.value + 1;
          },
        },
      );
    }).toThrow(PropagatorDivergedError);
    p.dispose();
  });

  it("PropagatorDivergedError pending set names the still-changing signals", () => {
    const a = num(0);
    const p = propagators({ iterations: 10 });
    let caught: PropagatorDivergedError | undefined;
    try {
      p.add({
        reads: [a],
        writes: [a],
        step: () => {
          a.value = a.value + 1; // self-feedback via fresh a triggers re-fire
        },
      });
    } catch (e) {
      caught = e as PropagatorDivergedError;
    }
    expect(caught).toBeDefined();
    expect(caught?.pending.has(a as never)).toBe(true);
    p.dispose();
  });

  it("monotonic narrowing terminates via natural fixpoint (no fuel cap hit)", () => {
    // Two cells with set-narrowing propagators: both contain {1,2,3}.
    // Propagator: dst = dst ∩ src. Eventually both are {} or a fixed
    // intersection. Monotonic — guaranteed termination.
    const a = signal<ReadonlySet<number>>(new Set([1, 2, 3]));
    const b = signal<ReadonlySet<number>>(new Set([2, 3, 4]));
    const p = propagators({ iterations: 100 });
    p.add(
      {
        reads: [a],
        writes: [b],
        step: () => {
          const av = a.value;
          const next = new Set<number>();
          for (const v of b.value) if (av.has(v)) next.add(v);
          if (next.size !== b.value.size) b.value = next;
        },
      },
      {
        reads: [b],
        writes: [a],
        step: () => {
          const bv = b.value;
          const next = new Set<number>();
          for (const v of a.value) if (bv.has(v)) next.add(v);
          if (next.size !== a.value.size) a.value = next;
        },
      },
    );
    // Intersection of {1,2,3} and {2,3,4} is {2,3}.
    expect([...a.value].sort()).toEqual([2, 3]);
    expect([...b.value].sort()).toEqual([2, 3]);
    p.dispose();
  });
});

describe("propagators: removal & lifecycle", () => {
  it("dispose stops the network from firing on dep changes", () => {
    const a = num(2);
    const b = num(3);
    const c = num(0);
    const p = propagators();
    p.add(adder(a, b, c));
    expect(c.value).toBe(5);
    p.dispose();
    a.value = 10;
    // Without the network, c stays at 5.
    expect(c.value).toBe(5);
  });
});
