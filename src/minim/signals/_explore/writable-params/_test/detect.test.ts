// detect.test.ts — does construction-time diamond detection catch the
// real cases without false-positives?

import { describe, expect, it } from "vitest";
import { Num, num, vec, type Writable } from "../../../index";
import { numAddW } from "../wp";
import { analyzeParents, lensTracked, transitiveRoots, vecRightTracked } from "../wp-detect";

describe("transitiveRoots: walks single-source lens chains", () => {
  it("primitive: roots to itself", () => {
    const a = num(0);
    expect([...transitiveRoots(a)]).toEqual([a]);
  });

  it("scale lens: roots to its source", () => {
    const a = num(0);
    const b = a.scale(2);
    expect([...transitiveRoots(b)]).toEqual([a]);
  });

  it("3-deep chain: roots to bottom primitive", () => {
    const a = num(0);
    const b = a.scale(2).add(1).clamp(0, 100);
    expect([...transitiveRoots(b)]).toEqual([a]);
  });
});

describe("analyzeParents: detects diamond constructions", () => {
  it("two distinct primitives: no diamond", () => {
    const a = num(0);
    const b = num(0);
    const report = analyzeParents([a, b]);
    expect(report.hasDiamond).toBe(false);
    expect(report.overlaps).toEqual([]);
  });

  it("two views of same primitive: diamond detected", () => {
    const raw = num(0);
    const v1 = raw.add(1);
    const v2 = raw.scale(2);
    const report = analyzeParents([v1, v2]);
    expect(report.hasDiamond).toBe(true);
    expect(report.overlaps.length).toBe(1);
    expect(report.overlaps[0]!.root).toBe(raw);
  });

  it("three parents, two share a root: only the overlapping pair flagged", () => {
    const a = num(0);
    const b = num(0);
    const v1 = a.add(1);
    const v2 = a.scale(2); // shares a
    const v3 = b; // independent
    const report = analyzeParents([v1, v2, v3]);
    expect(report.hasDiamond).toBe(true);
    expect(report.overlaps.length).toBe(1);
    expect(report.overlaps[0]).toEqual({ i: 0, j: 1, root: a });
  });

  it("two primitives passed in directly: only flagged if SAME instance", () => {
    const a = num(0);
    const report = analyzeParents([a, a]);
    // Same primitive passed twice → diamond.
    expect(report.hasDiamond).toBe(true);
  });

  it("DEEPER diamond: 3-deep chain sharing root with another 4-deep chain", () => {
    const root = num(0);
    const chainA = root.add(1).scale(2);
    const chainB = root.scale(3).clamp(0, 100).add(5);
    const report = analyzeParents([chainA, chainB]);
    expect(report.hasDiamond).toBe(true);
    expect(report.overlaps[0]!.root).toBe(root);
  });
});

describe("lensTracked: opt-in error policy", () => {
  it("default 'allow': no throw on diamond", () => {
    const raw = num(10);
    const v1 = raw.add(0);
    const v2 = raw.add(0);
    expect(() => {
      const sum = lensTracked(
        [v1, v2] as const,
        ([a, b]) => a + b,
        (t, [a, b]) => {
          const cur = a + b;
          const delta = t - cur;
          return [a + delta / 2, b + delta / 2] as const;
        },
      );
      void sum.value;
    }).not.toThrow();
  });

  it("'error' policy throws at construction", () => {
    const raw = num(10);
    const v1 = raw.add(0);
    const v2 = raw.add(0);
    expect(() => {
      lensTracked(
        [v1, v2] as const,
        ([a, b]) => a + b,
        (t, [a, b]) => {
          const cur = a + b;
          const delta = t - cur;
          return [a + delta / 2, b + delta / 2] as const;
        },
        Num,
        { diamonds: "error" },
      );
    }).toThrow(/diamond detected/);
  });

  it("'warn' policy logs but proceeds", () => {
    const raw = num(10);
    const v1 = raw.add(0);
    const v2 = raw.add(0);
    let warned = false;
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      if (msg.includes("diamond")) warned = true;
    };
    try {
      const sum = lensTracked(
        [v1, v2] as const,
        ([a, b]) => a + b,
        (t, [a, b]) => {
          const cur = a + b;
          const delta = t - cur;
          return [a + delta / 2, b + delta / 2] as const;
        },
        Num,
        { diamonds: "warn" },
      );
      expect(warned).toBe(true);
      expect(sum.value).toBe(20);
    } finally {
      console.warn = origWarn;
    }
  });

  it("no diamond, no warning, no error", () => {
    const a = num(0);
    const b = num(0);
    let warned = false;
    const origWarn = console.warn;
    console.warn = () => {
      warned = true;
    };
    try {
      const sum = lensTracked(
        [a, b] as const,
        ([av, bv]) => av + bv,
        (t, [av, bv]) => {
          const delta = t - (av + bv);
          return [av + delta / 2, bv + delta / 2] as const;
        },
        Num,
        { diamonds: "error" },
      );
      expect(warned).toBe(false);
      expect(sum.value).toBe(0);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("vecRightTracked: integration", () => {
  it("normal case (a, n distinct): no diamond, works as vecRightW", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightTracked(a, n);
    expect(b.value).toEqual({ x: 15, y: 20 });
    b.value = { x: 100, y: 25 };
    expect(b.value).toEqual({ x: 100, y: 25 });
  });

  it("pathological case (a's x and n share a primitive): detected with 'error'", () => {
    // Construct: n = (something derived from a's underlying x)
    // We need a as a Vec whose x is derived from the same prim as n.
    // Easiest: use field() to extract x from a's primitive, then use n
    // that ALSO derives from that x.
    //
    // Demonstrate detection on lensTracked directly with overlapping parents:
    const n1 = num(5);
    const aliased = n1.add(0);
    expect(() => {
      lensTracked(
        [n1, aliased] as const,
        ([a, b]) => a + b,
        (t, [a, _b]) => [a, t - a] as const,
        Num,
        { diamonds: "error" },
      );
    }).toThrow(/diamond/);
  });
});

describe("LIMITATION: detection requires using tracked factories all the way down", () => {
  it("untracked multi-source lens (Cls.lens(...) direct) leaves wp-parents unknown", () => {
    // If you build a wp lens via raw Cls.lens(...), its parents aren't
    // tagged → if it becomes a parent of another wp lens, the walker
    // bottoms out at the untracked lens cell, not its true roots.
    //
    // This is a LIMITATION OF DETECTION. The runtime semantics are
    // unchanged; we just can't statically detect through opaque
    // multi-input edges.
    const a = num(10);
    const b = num(20);
    // Built with the untracked numAddW from wp.ts (no _wpParents tagged):
    const sum = numAddW(a, b, 0.5);

    // Now wrap sum + a in a wp lens. We'd LIKE this to detect that
    // sum's roots include a (so [sum, a] is a diamond on root a).
    // It does NOT, because sum isn't tagged with its parents.
    expect(() => {
      lensTracked(
        [sum, a] as const,
        ([s, av]) => s + av,
        (t, [s, _av]) => [s, t - s] as const,
        Num,
        { diamonds: "error" },
      );
    }).not.toThrow();
    // VERDICT: detection is opt-in by-construction. Migrating all wp
    // factories to use lensTracked closes this gap.
  });
});
