// network-utils.test.ts — `each`, `when`.

import { describe, expect, it } from "vitest";
import { cell, each } from "../index";
import { when as whenLifecycle } from "../network-utils";

describe("each — reactive collection lifecycle", () => {
  it("body runs for initial items, cleanup runs for removed items", () => {
    type Edge = { a: number; b: number };
    const e1: Edge = { a: 1, b: 2 };
    const e2: Edge = { a: 3, b: 4 };
    const e3: Edge = { a: 5, b: 6 };
    const items = cell<Edge[]>([e1, e2]);
    const built: Edge[] = [];
    const removed: Edge[] = [];
    const handle = each(items, item => {
      built.push(item);
      return () => removed.push(item);
    });
    expect(built).toEqual([e1, e2]);
    expect(removed).toEqual([]);

    // Add e3.
    items.value = [e1, e2, e3];
    expect(built).toEqual([e1, e2, e3]);
    expect(removed).toEqual([]);

    // Remove e2.
    items.value = [e1, e3];
    expect(built).toEqual([e1, e2, e3]);
    expect(removed).toEqual([e2]);

    handle.dispose();
    // Disposal cleans up everything left (e1, e3 still active; e2
    // was already cleaned up).
    expect(removed).toContain(e1);
    expect(removed).toContain(e2);
    expect(removed).toContain(e3);
  });

  it("identity is by reference, not by structural equality", () => {
    const e1 = { id: 1 };
    const e1Copy = { id: 1 }; // same shape, different object
    const items = cell<{ id: number }[]>([e1]);
    let builds = 0;
    let cleanups = 0;
    const handle = each(items, () => {
      builds++;
      return () => {
        cleanups++;
      };
    });
    expect(builds).toBe(1);
    expect(cleanups).toBe(0);

    // Replace e1 with e1Copy: structurally identical, but different ref.
    // Body should rebuild for the new ref; cleanup the old.
    items.value = [e1Copy];
    expect(builds).toBe(2);
    expect(cleanups).toBe(1);
    handle.dispose();
  });

  it("dispose on empty collection cleans up zero items", () => {
    const items = cell<number[]>([]);
    let builds = 0;
    const handle = each(items, () => {
      builds++;
      return () => {};
    });
    expect(builds).toBe(0);
    handle.dispose(); // shouldn't blow up
  });
});

describe("when — boolean lifecycle", () => {
  it("body runs while truthy, cleanup on falsy", () => {
    const flag = cell(false);
    let active = 0;
    const handle = whenLifecycle(flag, () => {
      active++;
      return () => {
        active--;
      };
    });
    expect(active).toBe(0);

    flag.value = true;
    expect(active).toBe(1);

    flag.value = false;
    expect(active).toBe(0);

    flag.value = true;
    expect(active).toBe(1);

    handle.dispose();
    expect(active).toBe(0);
  });

  it("multiple flips while same body runs once per truthy span", () => {
    const flag = cell(true);
    let builds = 0;
    let cleanups = 0;
    const handle = whenLifecycle(flag, () => {
      builds++;
      return () => {
        cleanups++;
      };
    });
    expect(builds).toBe(1);

    // Re-write same truthy value (no-op for `===` equality).
    flag.value = true;
    expect(builds).toBe(1);
    expect(cleanups).toBe(0);

    flag.value = false;
    expect(cleanups).toBe(1);

    flag.value = true;
    expect(builds).toBe(2);

    handle.dispose();
  });
});

describe("cell — strict factory with identity passthrough", () => {
  it("plain value is wrapped in a fresh cell", () => {
    const p = cell(42);
    expect(p.value).toBe(42);
    p.value = 99;
    expect(p.value).toBe(99);
  });

  it("existing cell is returned untouched", () => {
    const original = cell(7);
    const p = cell(original);
    expect(p).toBe(original); // same reference
    original.value = 8;
    expect(p.value).toBe(8); // mutations propagate
  });

  it("works for non-numeric types", () => {
    const p = cell({ x: 1, y: 2 });
    expect(p.value).toEqual({ x: 1, y: 2 });
  });
});
