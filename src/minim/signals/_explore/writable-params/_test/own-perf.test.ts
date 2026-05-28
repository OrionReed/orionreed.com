// own-perf.test.ts — rough perf characterization of the own() mechanism.
// Compares to bare-signal write cost and to existing share() lens cost.
// Numbers are machine-specific; we only assert loose bounds (no
// pathological slowdown).

import { describe, expect, it } from "vitest";
import { num, own, share } from "../../../index";

const N = 10_000;
const HOT_LIMIT_MS = 200; // CI tolerance

function bench(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe("perf: drag-cell write loop", () => {
  it("bare signal write x N", () => {
    const a = num(0);
    const t = bench(() => {
      for (let i = 0; i < N; i++) a.value = i;
    });
    expect(t).toBeLessThan(HOT_LIMIT_MS);
  });

  it("share() lens write x N (drag b)", () => {
    const a = num(0);
    const slack = num(0).clamp(-100, 100);
    const b = a.add(share(slack));
    const t = bench(() => {
      for (let i = 0; i < N; i++) b.value = i;
    });
    expect(t).toBeLessThan(HOT_LIMIT_MS * 2);
  });

  it("own() lens: drag b (view-write path, same as share())", () => {
    const a = num(0);
    const slack = num(0).clamp(-100, 100);
    const b = a.add(own(slack));
    const t = bench(() => {
      for (let i = 0; i < N; i++) b.value = i;
    });
    expect(t).toBeLessThan(HOT_LIMIT_MS * 2);
  });

  it("own() lens: drag a (parent-change reaction fires every iteration)", () => {
    const a = num(0);
    const slack = num(0).clamp(-100, 100);
    const b = a.add(own(slack));
    void b;
    const t = bench(() => {
      for (let i = 0; i < N; i++) a.value = i;
    });
    // Parent-change reaction adds work per iteration; should still be
    // well under the hot limit at 10k iterations.
    expect(t).toBeLessThan(HOT_LIMIT_MS * 3);
  });
});

describe("perf: read loop", () => {
  it("own() lens: hot read loop x N", () => {
    const a = num(50);
    const slack = num(20).clamp(0, 100);
    const b = a.add(own(slack));
    let acc = 0;
    const t = bench(() => {
      for (let i = 0; i < N; i++) acc += b.value;
    });
    expect(acc).toBeGreaterThan(0);
    expect(t).toBeLessThan(HOT_LIMIT_MS);
  });
});

describe("perf: chained own() lenses", () => {
  it("3-deep chain, drag root", () => {
    const a = num(0);
    const s1 = num(0).clamp(-100, 100);
    const s2 = num(0).clamp(-100, 100);
    const s3 = num(0).clamp(-100, 100);
    const b = a.add(own(s1));
    const c = b.add(own(s2));
    const d = c.add(own(s3));
    void d;
    const t = bench(() => {
      for (let i = 0; i < N; i++) a.value = i;
    });
    expect(t).toBeLessThan(HOT_LIMIT_MS * 5);
  });
});
