// cluster-basic.test.ts — sanity checks for the lazy-solve model.

import { describe, expect, it } from "vitest";
import { num, vec } from "../../signals";
import { Cluster, distance, eq, leq, lensNum } from "../index";

describe("Cluster — basic constraint correctness (lazy-solve)", () => {
  it("eq: pinned a, write a → b matches on next read", () => {
    const c = new Cluster({ iterations: 10 });
    const a = num(3);
    const b = num(7);
    eq(c, a, b);
    c.pin(a);
    a.value = 5;
    expect(b.value).toBeCloseTo(5, 2); // first read of b triggers solve
  });

  it("eq: free settles to a common value", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(3);
    const b = num(7);
    eq(c, a, b);
    a.value = 4; // mark dirty
    // No pin: read both → solve runs, midpoint solution.
    const av = a.value;
    const bv = b.value;
    expect(av).toBeCloseTo(bv, 2);
  });

  it("distance: pinned a, drag → b at distance 5", () => {
    const c = new Cluster({ iterations: 20 });
    const a = vec(0, 0);
    const b = vec(1, 0);
    distance(c, a, b, 5);
    c.pin(a);
    a.value = { x: 0.001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(5, 1);
  });

  it("lensNum: b = 2a; pin b, solve back-propagates a = 5", () => {
    const c = new Cluster({ iterations: 30 });
    const a = num(0);
    const b = num(10);
    lensNum(c, a, b, x => 2 * x);
    c.pin(b);
    b.value = 10.0001;
    expect(a.value).toBeCloseTo(5, 1);
  });

  it("leq: a above b is pulled down", () => {
    const c = new Cluster({ iterations: 30 });
    const a = num(5);
    const b = num(3);
    leq(c, a, b);
    c.pin(b);
    b.value = 3.0001;
    expect(a.value).toBeLessThanOrEqual(b.value + 1e-2);
  });
});
