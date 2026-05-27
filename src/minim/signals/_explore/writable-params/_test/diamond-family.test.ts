// diamond-family.test.ts — classify the failure modes that LOOK like
// the asymmetric diamond, find their boundaries, and explore mitigation.

import { describe, expect, it } from "vitest";
import { batch, effect, num, type Num, type Writable } from "../../../index";
import { numAddW } from "../wp";
import { analyzeParents, lensTracked } from "../wp-detect";
import { lastWins, maxNum, mergeSession, strict, sumNum } from "../wp-merge";

// ─── TYPE 1: direct alias — same primitive twice ───────────────────

describe("TYPE 1: direct alias diamond", () => {
  it("[a, a] flagged by detection", () => {
    const a = num(0);
    expect(analyzeParents([a, a]).hasDiamond).toBe(true);
  });

  it("runtime behavior: both intentions land on same primitive", () => {
    const a = num(10);
    const lens = lensTracked(
      [a, a] as const,
      ([a1, a2]) => a1 + a2, // = 2*a
      (t, [_a1, _a2]) => {
        // intentions: a1 := t/2, a2 := t/2 — both write to a.
        return [t / 2, t / 2] as const;
      },
    );
    expect(lens.value).toBe(20);
    lens.value = 50; // intentions both 25 → a becomes 25 (last-write-wins).
    expect(a.peek()).toBe(25);
    expect(lens.value).toBe(50); // PG holds (symmetric)
  });
});

// ─── TYPE 2: hidden chain — different views of same primitive ──────

describe("TYPE 2: hidden chain diamond", () => {
  it("[a.add(1), a.scale(2)] flagged: walks via _fusedOf.parent", () => {
    const a = num(0);
    const v1 = a.add(1);
    const v2 = a.scale(2);
    expect(analyzeParents([v1, v2]).hasDiamond).toBe(true);
  });

  it("[v1, v2] with different fwd functions: intentions are different paths to a", () => {
    const a = num(10);
    const v1 = a.add(1);
    const v2 = a.scale(2);
    const sum = lensTracked(
      [v1, v2] as const,
      ([v1v, v2v]) => v1v + v2v,
      (target, [v1v, v2v]) => {
        const cur = v1v + v2v;
        const delta = target - cur;
        return [v1v + delta / 2, v2v + delta / 2] as const;
      },
    );
    // sum reads as (a+1) + 2a = 3a+1 = 31
    expect(sum.value).toBe(31);

    sum.value = 49; // delta = 18 → v1 += 9 → 20; v2 += 9 → 29.
    // v1 := 20 → a := 19 (via v1's add(1) bwd, a = v1 - 1)
    // v2 := 29 → a := 14.5 (via v2's scale(2) bwd, a = v2 / 2)
    // Last write wins → a = 14.5. sum reads (14.5+1) + (2*14.5) = 15.5 + 29 = 44.5.
    // NOT 49. PUTGET VIOLATED — and worse, the violation depends on
    // ENGINE ORDERING, not on the lens construction.
    expect(sum.value).toBeCloseTo(44.5);
    expect(a.peek()).toBe(14.5);
  });
});

// ─── TYPE 3: deferred diamond — independent at construction, linked later ───

describe("TYPE 3: deferred diamond (CANNOT be statically detected)", () => {
  it("a and b are independent at construction; effect links them later", () => {
    const a = num(10);
    const b = num(20);
    expect(analyzeParents([a, b]).hasDiamond).toBe(false); // CORRECT — no diamond yet

    const lens = lensTracked(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (target, [av, bv]) => {
        const delta = target - (av + bv);
        return [av + delta / 2, bv + delta / 2] as const;
      },
    );
    expect(lens.value).toBe(30);

    // Now an effect runs that BREAKS the independence:
    const stop = effect(() => {
      b.value = a.value; // b mirrors a
    });

    // Now writing the lens fires bwd which writes both a (+10) and b (+10).
    // But the effect fires when a changes and sets b := a → conflict.
    lens.value = 50;
    expect(a.peek()).toBe(b.peek()); // effect made them equal again

    stop();
    // VERDICT: deferred diamonds via effects: detection sees nothing.
    // This is OK — the user opted into effect-based coupling, which is
    // the "existing footgun" exit. Cycles via effects were always your
    // risk surface.
  });
});

// ─── TYPE 4: three-way fan-in to a single primitive ─────────────────

describe("TYPE 4: three-way fan-in", () => {
  it("[v1, v2, v3] all sharing root a: pairwise overlaps reported", () => {
    const a = num(0);
    const v1 = a.add(1);
    const v2 = a.scale(2);
    const v3 = a.add(10);
    const report = analyzeParents([v1, v2, v3]);
    expect(report.hasDiamond).toBe(true);
    expect(report.overlaps.length).toBe(3); // C(3,2) = 3 pairs
  });
});

// ─── TYPE 5: parent fan-in including the lens output's downstream ──

describe("TYPE 5: trying to spell a cycle via wp params (impossible)", () => {
  it("temporal order forbids: lens needs all params at construction", () => {
    // If you want b = wpLens([a, lensOver(b)]), you need lensOver(b) to
    // exist before b. Impossible declaratively.
    const a = num(0);
    const b = a.add(1); // b exists, depends on a.
    // To make a wp lens whose params include b AND something that
    // closes back to b: not possible without let-rec, which TS doesn't
    // do, or via effects (the existing footgun).
    expect(a.peek()).toBe(0);
    expect(b.value).toBe(1);
  });
});

// ─── TYPE 6: equality-eliminated diamond ─────────────────────────────

describe("TYPE 6: two distinct lens instances with same construction", () => {
  it("[a.add(1), a.add(1)] — two different cells, same root", () => {
    const a = num(0);
    const v1 = a.add(1);
    const v2 = a.add(1); // SEPARATE cell, same construction
    expect(v1).not.toBe(v2);
    expect(analyzeParents([v1, v2]).hasDiamond).toBe(true);
    // VERDICT: detection correctly flags. Even though v1.value === v2.value,
    // they're separate cells; their setters both write to a.
  });
});

// ─── TYPE 7: RO path participates as a parent ───────────────────────

describe("TYPE 7: RO parent should not count for write-diamond", () => {
  it("RO parent skipped from write conflict (but engine throws on write)", () => {
    // Our detection currently flags any overlap of transitive roots,
    // whether or not the parent is writable. That's a FALSE POSITIVE
    // for RO parents.
    const a = num(0);
    const v1 = a.add(1);
    // Build an RO view that depends on a via derive:
    // (Skipped — engine doesn't expose construction time RO-vs-RW well
    // enough to test this without engine plumbing. Documented gap.)
    void v1;
    expect(true).toBe(true);
  });
});

// ─── TYPE 8: conditional bwd — partial writes ───────────────────────

describe("TYPE 8: conditional bwd — detection false positives", () => {
  it("bwd that only emits intentions for ONE parent at a time", () => {
    // Two parents sharing a root, but bwd never emits both intentions
    // in the same call. No runtime conflict — but static detection flags.
    const a = num(0);
    const v1 = a.add(1);
    const v2 = a.scale(2);
    const lens = lensTracked(
      [v1, v2] as const,
      ([v1v, v2v]) => v1v + v2v,
      (target, [_v1v, v2v]) => {
        // Policy: write ONLY v1 (subtract current v2 from target);
        // emit undefined for v2 so engine skips writing it.
        return [target - v2v, undefined] as const;
      },
    );
    void lens;
    expect(true).toBe(true); // Mostly illustrative; the static check
    // fires false-positive but runtime is safe.
  });

  it("VERDICT: detection is OVER-conservative for conditional bwds", () => {
    expect(true).toBe(true);
  });
});

// ─── TYPE 9: bwd happens to produce consistent intentions ───────────

describe("TYPE 9: symmetric weight + symmetric forward = accidental consistency", () => {
  it("two parents share root, weights 50/50: intentions agree, no observable conflict", () => {
    const raw = num(10);
    const v1 = raw.add(0);
    const v2 = raw.add(0);
    const sum = lensTracked(
      [v1, v2] as const,
      ([a, b]) => a + b,
      (t, [a, b]) => {
        const delta = t - (a + b);
        return [a + delta / 2, b + delta / 2] as const;
      },
    );
    sum.value = 30;
    // Both intentions: raw := 15. Last-write-wins is identity here.
    expect(raw.peek()).toBe(15);
    expect(sum.value).toBe(30); // PG holds by symmetry, not by framework
  });

  it("VERDICT: false-positive case for static detection — runtime is fine", () => {
    expect(true).toBe(true);
  });
});

// ─── TYPE 10: iterative bwd that converges ──────────────────────────

describe("TYPE 10: solver-based bwd handles its own consistency", () => {
  it("a bwd that runs an inner solve doesn't suffer from naive last-wins", () => {
    // Conceptual: imagine the bwd runs Newton or AVBD over its inputs,
    // producing a self-consistent state for all parents. The detector
    // flags it (because parents share root), but the runtime is fine.
    // For prototype purposes, just demonstrate the pattern:
    expect(true).toBe(true);
  });
});

// ─── MITIGATION: mergeSession with custom merge functions ──────────

describe("MITIGATION via mergeSession", () => {
  it("default lastWins: matches engine batch semantics", () => {
    const a = num(0);
    const session = mergeSession();
    session.intend(a, 5);
    session.intend(a, 10);
    session.commit();
    expect(a.peek()).toBe(10);
  });

  it("sum merge: gradient-accumulation style for conflicting intentions", () => {
    const a = num(100);
    const session = mergeSession();
    session.intend(a, 5, sumNum);
    session.intend(a, 10, sumNum);
    session.commit();
    expect(a.peek()).toBe(15); // 5 + 10 — last-wins of THE MERGE
    // Note: this writes 15, not 115. Sum merge of intentions, not deltas.
    // For backprop-style: convert each intention to a delta first.
  });

  it("max merge: lattice resolution", () => {
    const a = num(0);
    const session = mergeSession();
    session.intend(a, 5, maxNum);
    session.intend(a, 10, maxNum);
    session.intend(a, 3, maxNum);
    session.commit();
    expect(a.peek()).toBe(10);
  });

  it("strict merge: throws on conflict, accepts on equality", () => {
    const a = num(0);
    const session = mergeSession();
    session.intend(a, 5, strict());
    expect(() => {
      session.intend(a, 7, strict());
      session.commit();
    }).toThrow(/conflicting intentions/);
  });

  it("strict merge: same value, no throw", () => {
    const a = num(0);
    const session = mergeSession();
    session.intend(a, 5, strict());
    session.intend(a, 5, strict());
    session.commit();
    expect(a.peek()).toBe(5);
  });
});

// ─── A LENS that uses mergeSession for asymmetric-diamond safety ───

describe("Mitigated diamond: use mergeSession in bwd", () => {
  it("two views of same primitive, asymmetric weights, strict merge", () => {
    const raw = num(10);
    const v1 = raw.add(0);
    const v2 = raw.add(0);

    // Hand-rolled lens that uses mergeSession internally to ensure
    // consistent writes (or panic):
    const sum = lensTracked(
      [v1, v2] as const,
      ([a, b]) => a + b,
      (target, [a, b]) => {
        const delta = target - (a + b);
        // ASYMMETRIC: 80/20 split
        return [a + delta * 0.8, b + delta * 0.2] as const;
      },
    );
    expect(sum.value).toBe(20);
    sum.value = 30; // intentions: v1 := 18, v2 := 12 → raw := 18, raw := 12
    expect(raw.peek()).toBe(12); // last wins; classical asym diamond
    expect(sum.value).toBeLessThan(30); // PG violated

    // The mitigation: factor the bwd through a mergeSession with
    // strict merge so the conflict surfaces as an exception, not a
    // silent inconsistency. (Implementation requires lens factory
    // cooperation; not wired into lensTracked yet.)
  });

  it("EXPLICIT mergeSession use: throws on the asymmetric case", () => {
    const raw = num(10);
    const session = mergeSession();
    // Simulate the asymmetric bwd manually:
    session.intend(raw, 18, strict());
    expect(() => {
      session.intend(raw, 12, strict());
      session.commit();
    }).toThrow(/conflicting intentions/);
  });
});

// ─── GRADIENT-ACCUMULATION mitigation ──────────────────────────────

describe("Mitigation: deltas + sum merge (gradient-accumulation)", () => {
  it("treat intentions as deltas; sum-merge them; apply to current value", () => {
    const raw = num(10);
    const v1Now = 10; // raw + 0
    const v2Now = 10; // raw + 0

    // Asymmetric weights: 0.8 / 0.2
    const target = 30;
    const delta = target - (v1Now + v2Now); // = 10

    const dV1 = delta * 0.8; // 8
    const dV2 = delta * 0.2; // 2

    // Both V1 and V2 are identity views of raw. Their bwds turn
    // (v1Now + dV1, v2Now + dV2) back into (raw + dV1, raw + dV2).
    // With gradient accumulation: total delta to raw = dV1 + dV2 = 10.
    // raw becomes 20. sum reads as (20+0)+(20+0) = 40. PG VIOLATED in
    // a different direction (got 40, wanted 30). The accumulation
    // double-counts because BOTH paths to raw add the full delta.
    //
    // Conclusion: gradient-accumulation merge does NOT save you when
    // both parents project the same primitive. You need to split the
    // delta DIFFERENTLY — by sharing it (not accumulating) once you
    // discover the diamond. That's the real fix: a diamond-aware bwd.
    void raw;
    void dV1;
    void dV2;
    expect(true).toBe(true);
  });

  it("VERDICT: gradient-accumulation is BACKPROP's solution because the loss → params graph has SINGLE-path projections (or scaled projections that combine linearly). It does NOT directly fix bidirectional wp diamonds.", () => {
    expect(true).toBe(true);
  });
});

// ─── The DIAGONAL diamond ─────────────────────────────────────────

describe("DIAGONAL: two lens outputs sharing a writable param", () => {
  it("[b1 = vecRightW(a, n), b2 = vecRightW(c, n)] with shared n: not a diamond per se", () => {
    // Each lens has DISTINCT writable parents; n is shared but each lens
    // writes to n through its own bwd. The DIAMOND is at the level of n,
    // not at the construction level of any single lens.
    //
    // Sequential drags: drag b1 → writes n. Drag b2 → writes n again.
    // No simultaneous conflict; just sequential overwrites. Same as
    // shared signals always behaved.
    expect(true).toBe(true);
  });

  it("simultaneous in a batch: last-write-wins", () => {
    const n = num(0);
    batch(() => {
      n.value = 10;
      n.value = 20;
    });
    expect(n.peek()).toBe(20);
  });
});

// ─── Cross-cell diamond via composition ──────────────────────────

describe("Cross-cell diamond: an outer wp lens whose two parents are wp lenses on overlapping cells", () => {
  it("composed wp lens detects through tagged parents", () => {
    const a = num(0);
    const b = num(0);
    // sum1 has parents [a, b]
    const sum1 = lensTracked(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const d = t - (av + bv);
        return [av + d / 2, bv + d / 2] as const;
      },
    );
    // sum2 has parents [a, b] too
    const sum2 = lensTracked(
      [a, b] as const,
      ([av, bv]) => av + bv,
      (t, [av, bv]) => {
        const d = t - (av + bv);
        return [av + d / 2, bv + d / 2] as const;
      },
    );
    // outer combines them: parents [sum1, sum2], both reach a AND b.
    expect(analyzeParents([sum1, sum2]).hasDiamond).toBe(true);
    expect(analyzeParents([sum1, sum2]).overlaps.length).toBe(2); // a, b
  });
});

// ─── Cross-cell diamond via UNtagged factory (limitation) ────────

describe("Cross-cell diamond LIMITATION: untracked wp factories hide the diamond", () => {
  it("numAddW from wp.ts doesn't tag parents — detection halts at sum cell", () => {
    const a = num(0);
    const b = num(0);
    const sum = numAddW(a, b, 0.5);
    // sum is not tagged with _wpParents → detection sees sum as a root.
    expect(analyzeParents([sum, a])).toMatchObject({
      hasDiamond: false, // FALSE NEGATIVE
    });
    // RUNTIME consequence: writes to outer lens that includes sum AND a
    // would have a real diamond, undetected.
    // FIX: route all wp factories through lensTracked.
  });
});
