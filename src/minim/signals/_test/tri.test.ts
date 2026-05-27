// tri.test.ts — Tri (three-valued bool) runtime + aggregate laws.
//
// Coverage:
//   - tri() factory, basic reads / writes / equality.
//   - not() — involution on true/false, fixed at "mixed".
//   - Kleene and / or helpers (the algebra).
//   - Tri.allOf — read classification, write broadcast, mixed-write
//     no-op, GetPut.
//   - Tri.anyOf — dual.
//   - Nested tree aggregates: clicking the root cascades to all leaves;
//     reading the root reflects mixed states from any descendant.

import { describe, expect, it } from "vitest";
import { bool } from "../values/bool";
import { and, not, or, Tri, tri } from "../values/tri";

// ─── Factory ──────────────────────────────────────────────────────

describe("tri() factory", () => {
  it("seeds a writable cell from a literal", () => {
    const t = tri(true);
    expect(t).toBeInstanceOf(Tri);
    expect(t.value).toBe(true);
    t.value = false;
    expect(t.value).toBe(false);
    t.value = "mixed";
    expect(t.value).toBe("mixed");
  });

  it("default is 'mixed'", () => {
    expect(tri().value).toBe("mixed");
  });

  it("identity-passes an existing writable Tri", () => {
    const a = tri(true);
    expect(tri(a)).toBe(a);
  });
});

// ─── Kleene algebra ───────────────────────────────────────────────

describe("Kleene algebra (free fns)", () => {
  it("not: true ↔ false, mixed fixed", () => {
    expect(not(true)).toBe(false);
    expect(not(false)).toBe(true);
    expect(not("mixed")).toBe("mixed");
  });

  it("and: false dominates; mixed only when both are known-true is broken", () => {
    expect(and(true, true)).toBe(true);
    expect(and(true, false)).toBe(false);
    expect(and(false, true)).toBe(false);
    expect(and(false, false)).toBe(false);
    expect(and(true, "mixed")).toBe("mixed");
    expect(and("mixed", true)).toBe("mixed");
    expect(and(false, "mixed")).toBe(false); // known false dominates
    expect(and("mixed", false)).toBe(false);
    expect(and("mixed", "mixed")).toBe("mixed");
  });

  it("or: true dominates; mixed otherwise unless both known-false", () => {
    expect(or(true, true)).toBe(true);
    expect(or(true, false)).toBe(true);
    expect(or(false, true)).toBe(true);
    expect(or(false, false)).toBe(false);
    expect(or(true, "mixed")).toBe(true); // known true dominates
    expect(or("mixed", true)).toBe(true);
    expect(or(false, "mixed")).toBe("mixed");
    expect(or("mixed", false)).toBe("mixed");
    expect(or("mixed", "mixed")).toBe("mixed");
  });
});

// ─── Tri.not() ────────────────────────────────────────────────────

describe("Tri.not()", () => {
  it("reads negation", () => {
    const t = tri(true);
    const n = t.not();
    expect(n.value).toBe(false);
    t.value = false;
    expect(n.value).toBe(true);
    t.value = "mixed";
    expect(n.value).toBe("mixed");
  });

  it("involution: not().not() round-trips for every state", () => {
    for (const v of [true, false, "mixed"] as const) {
      const t = tri(v);
      expect(t.not().not().value).toBe(v);
    }
  });

  it("writes propagate through not()", () => {
    const t = tri(true);
    const n = t.not();
    n.value = true; // source becomes false
    expect(t.value).toBe(false);
    n.value = "mixed"; // source stays "mixed" (involutive)
    expect(t.value).toBe("mixed");
  });
});

// ─── Tri.allOf ───────────────────────────────────────────────────

describe("Tri.allOf(parents)", () => {
  it("all true → true", () => {
    const items = [bool(true), bool(true), bool(true)];
    expect(Tri.allOf(items).value).toBe(true);
  });

  it("all false → false", () => {
    const items = [bool(false), bool(false), bool(false)];
    expect(Tri.allOf(items).value).toBe(false);
  });

  it("any disagreement → 'mixed'", () => {
    const items = [bool(true), bool(false), bool(true)];
    expect(Tri.allOf(items).value).toBe("mixed");
  });

  it("write true broadcasts to all", () => {
    const items = [bool(false), bool(false), bool(true)];
    const agg = Tri.allOf(items);
    agg.value = true;
    expect(items.every(b => b.value)).toBe(true);
    expect(agg.value).toBe(true);
  });

  it("write false broadcasts to all", () => {
    const items = [bool(true), bool(true), bool(false)];
    const agg = Tri.allOf(items);
    agg.value = false;
    expect(items.every(b => !b.value)).toBe(true);
    expect(agg.value).toBe(false);
  });

  it("write 'mixed' is a no-op (cannot synthesize disagreement)", () => {
    const items = [bool(true), bool(true), bool(true)];
    const agg = Tri.allOf(items);
    agg.value = "mixed";
    expect(items.every(b => b.value)).toBe(true);
    expect(agg.value).toBe(true);
  });

  it("changes to any parent propagate to the aggregate", () => {
    const items = [bool(true), bool(true), bool(true)];
    const agg = Tri.allOf(items);
    expect(agg.value).toBe(true);
    items[1]!.value = false;
    expect(agg.value).toBe("mixed");
    items[0]!.value = false;
    items[2]!.value = false;
    expect(agg.value).toBe(false);
  });

  it("GetPut: writing back the read value is a no-op", () => {
    // All three states tested.
    for (const startState of [
      [true, true, true],
      [false, false, false],
      [true, false, true],
    ] as const) {
      const items = startState.map(b => bool(b));
      const agg = Tri.allOf(items);
      const v = agg.value;
      agg.value = v;
      const after = items.map(b => b.value);
      expect(after).toEqual([...startState]);
    }
  });

  it("PutPut: only the last write survives", () => {
    const items = [bool(false), bool(true), bool(false)];
    const agg = Tri.allOf(items);
    agg.value = true;
    agg.value = false;
    expect(items.every(b => !b.value)).toBe(true);
  });
});

// ─── Tri.anyOf ───────────────────────────────────────────────────

describe("Tri.anyOf(parents)", () => {
  it("any true → true (when no false present is the pure case)", () => {
    expect(Tri.anyOf([bool(true), bool(true)]).value).toBe(true);
  });

  it("mixed when at least one true AND one false", () => {
    expect(Tri.anyOf([bool(true), bool(false)]).value).toBe("mixed");
  });

  it("all false → false", () => {
    expect(Tri.anyOf([bool(false), bool(false)]).value).toBe(false);
  });

  it("write true sets all", () => {
    const items = [bool(false), bool(false)];
    const any = Tri.anyOf(items);
    any.value = true;
    expect(items.every(b => b.value)).toBe(true);
  });

  it("write false sets all", () => {
    const items = [bool(true), bool(true)];
    const any = Tri.anyOf(items);
    any.value = false;
    expect(items.every(b => !b.value)).toBe(true);
  });
});

// ─── Nested aggregates (tree-like) ───────────────────────────────

describe("Nested Tri aggregates — tree structure", () => {
  it("multiple aggregates over the same leaves stay independent", () => {
    const a = bool(true);
    const b = bool(false);
    const c = bool(true);
    const aggAll = Tri.allOf([a, b, c]);
    const aggAB = Tri.allOf([a, b]);
    const aggBC = Tri.allOf([b, c]);

    expect(aggAll.value).toBe("mixed");
    expect(aggAB.value).toBe("mixed");
    expect(aggBC.value).toBe("mixed");

    aggAB.value = true; // sets a and b to true
    expect(a.value).toBe(true);
    expect(b.value).toBe(true);
    expect(c.value).toBe(true); // unchanged
    expect(aggAll.value).toBe(true);
    expect(aggBC.value).toBe(true);
  });

  it("clicking the root cascades to all descendants", () => {
    // Tree: root = [folder1, folder2]
    //   folder1 = [leaf1, leaf2]
    //   folder2 = [leaf3, leaf4, leaf5]
    const l1 = bool(false);
    const l2 = bool(true);
    const l3 = bool(true);
    const l4 = bool(false);
    const l5 = bool(true);
    const folder1 = Tri.allOf([l1, l2]);
    const folder2 = Tri.allOf([l3, l4, l5]);
    const root = Tri.allOf([l1, l2, l3, l4, l5]);

    expect(root.value).toBe("mixed");
    expect(folder1.value).toBe("mixed");
    expect(folder2.value).toBe("mixed");

    root.value = true;
    expect(l1.value && l2.value && l3.value && l4.value && l5.value).toBe(true);
    expect(folder1.value).toBe(true);
    expect(folder2.value).toBe(true);
  });

  it("clicking a subfolder cascades only to its descendants", () => {
    const l1 = bool(true);
    const l2 = bool(true);
    const l3 = bool(false);
    const folder1 = Tri.allOf([l1, l2]);
    const root = Tri.allOf([l1, l2, l3]);

    expect(folder1.value).toBe(true);
    expect(root.value).toBe("mixed");

    folder1.value = false;
    expect(l1.value).toBe(false);
    expect(l2.value).toBe(false);
    expect(l3.value).toBe(false); // unchanged
    expect(root.value).toBe(false); // now all leaves false
  });

  it("reading a folder reflects descendant state immediately", () => {
    const l1 = bool(true);
    const l2 = bool(true);
    const folder = Tri.allOf([l1, l2]);
    expect(folder.value).toBe(true);
    l1.value = false;
    expect(folder.value).toBe("mixed");
    l2.value = false;
    expect(folder.value).toBe(false);
  });
});
