// semantic-guarantees.test.ts — the explicit user-facing contract.
//
// This file states what `.merge()` actually GUARANTEES and tests
// each guarantee against multiple constructions and (where
// possible) randomized inputs. It also enumerates what we
// explicitly DO NOT guarantee, with tests that observe the
// unspecified behaviour so future implementation drift doesn't
// silently move into a "guarantee" position by accident.
//
// Use this file as the reference for what consumers can rely on.
// Every other test file in the suite should be testing scenarios
// REDUCIBLE TO these guarantees — or it's testing implementation,
// not contract.
//
// ── The Contract ────────────────────────────────────────────────
//
//   G1. Opt-in. A signal/lens with no `.merge()` behaves exactly
//       as the unmodified engine would. Adding `.merge()` ONLY
//       affects cascades that route through the merge cell.
//
//   G2. Forward identity. `merged.value === parent.value` at all
//       times. The merge is transparent forward.
//
//   G3. Slot identity = the immediately-upstream lens. When a
//       backward write arrives at a merge cell, its slot key is
//       the lens whose setter is one frame UP on the bwd stack.
//       Direct (non-lens) writes share a single `DIRECT_SLOT`.
//
//   G4. Per-slot dedupe. Within one cascade, repeated writes from
//       the same slot REPLACE — the slot's contribution is the
//       LAST write from that slot.
//
//   G5. Cross-slot fold from identity. Each fold starts at
//       `policy.identity` and reduces ALL current slots via
//       `policy.combine`.
//
//   G6. Cascade boundary = one user-initiated `.value =` call on
//       a lens cell, including everything its setter dispatches
//       (fan-ins, nested lenses, batches). Two sequential user
//       calls are two cascades regardless of batching.
//
//   G7. Fusion barrier. `_fuse` does not collapse a merge cell
//       with its parent or its children. Chained `.lens()` /
//       `.merge()` on a merge create a fresh fused segment rooted
//       at the merge.
//
//   G8. Commutativity REQUIRED for predictable cross-slot results.
//       The engine does NOT promise a cross-slot arrival order. A
//       non-commutative `policy.combine` will produce arrival-
//       order-sensitive results (unspecified).
//
//   G9. Engine-global quiescence. Outside any lens cascade (before
//       any user write, between top-level writes, after a write
//       completes), `activeBwdWriter` and `bwdSetterCaller` are
//       both `undefined`.
//
//   G10. Engine integrity. The canonical engine's forward
//        propagation, equality short-circuit, batch semantics,
//        effect scheduling, and computed evaluation are unchanged
//        by the merge layer's engine modifications.
//
// ── What we explicitly DO NOT promise ───────────────────────────
//
//   N1. Specific cross-slot arrival order — see G8. Tests
//       observing it are documenting current behaviour, not
//       contract.
//   N2. Specific writeHook fire count per cascade. The engine's
//       equality short-circuit suppresses redundant fires; the
//       exact count depends on policy idempotency, value equality
//       runs, and engine batching. Users should rely on FINAL
//       VALUES, not fire counts.
//   N3. Specific shape of `peekMergeSlots()` between cascades. It
//       is reset lazily, on the merge's next fire. Stale state
//       between cascades is an artifact of debug introspection.
//   N4. Stability of slot identity if the user rebuilds the same
//       lens via separate `.lens()` calls — each call creates a
//       new cell, hence a new slot. Reference identity governs.

import { describe, expect, it } from "vitest";
import {
  _activeBwdWriter,
  _bwdSetterCaller,
  batch,
  DIRECT_SLOT,
  effect,
  maxPolicy,
  type MergePolicy,
  Num,
  num,
  peekMergeAcc,
  peekMergeSlots,
  Signal,
  signal,
  sumPolicy,
  Vec,
  vec,
} from "../index";

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function installNumLens(getter: () => number, setter: (v: number) => void): Num {
  return Signal.install(
    Num as unknown as new (...args: never[]) => Signal<number>,
    getter,
    setter,
  ) as unknown as Num;
}

/** Deterministic PRNG so randomized tests are reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ════════════════════════════════════════════════════════════════
// G1 — Opt-in
// ════════════════════════════════════════════════════════════════

describe("G1: opt-in — no merge means exactly the unmodified engine", () => {
  it("a complex DAG with no .merge() is byte-for-byte the canonical engine", () => {
    // Mirror of a representative DAG. Record arrivals at root.
    const root = signal(0);
    const arrivals: number[] = [];
    const orig = root._setWithExclusion.bind(root);
    root._setWithExclusion = function (next, ex) {
      arrivals.push(next);
      orig(next, ex);
    };
    const a = installNumLens(
      () => root.value,
      v => {
        root.value = v;
      },
    );
    const b = installNumLens(
      () => root.value,
      v => {
        root.value = v + 100;
      },
    );
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, _) => [t / 2, t / 2],
    );
    fan.value = 10;
    // Without a merge, last-write-wins exactly as canonical engine.
    expect(arrivals.length).toBe(2);
    expect(arrivals).toEqual([5, 105]); // a's bwd, then b's bwd
    expect(root.value).toBe(105); // last wins
  });

  it("adding a merge on a SIBLING signal does not affect an unrelated root", () => {
    const unrelated = num(0);
    const mergedRoot = num(0).merge(sumPolicy);
    void mergedRoot;
    // Writing the unrelated root is a normal signal write.
    unrelated.value = 42;
    expect(unrelated.value).toBe(42);
  });
});

// ════════════════════════════════════════════════════════════════
// G2 — Forward identity
// ════════════════════════════════════════════════════════════════

describe("G2: forward identity — merged.value === parent.value, always", () => {
  it("holds at construction time", () => {
    const root = num(7);
    const merged = root.merge(sumPolicy);
    expect(merged.value).toBe(root.value);
  });

  it("holds after a parent write", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    root.value = 5;
    expect(merged.value).toBe(root.value);
  });

  it("holds after a merge-mediated cascade", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    expect(merged.value).toBe(root.value);
  });

  it("holds when the parent is itself a fused lens chain", () => {
    const root = num(0);
    const lensed = root.add(1).scale(2); // fused
    const merged = lensed.merge(sumPolicy);
    expect(merged.value).toBe(lensed.value);
    root.value = 5;
    expect(merged.value).toBe(lensed.value);
  });
});

// ════════════════════════════════════════════════════════════════
// G3 — Slot identity = the immediately-upstream lens
// ════════════════════════════════════════════════════════════════

describe("G3: slot identity is the lens whose setter is one frame up", () => {
  it("via fan-in: each fan-in parent is a distinct slot", () => {
    const merged = num(0).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    const slots = peekMergeSlots(merged)!;
    expect(slots.has(a)).toBe(true);
    expect(slots.has(b)).toBe(true);
  });

  it("via user-authored Signal.install: the user's lens IS the slot", () => {
    const merged = num(0).merge(sumPolicy);
    const userLens = installNumLens(
      () => merged.value,
      v => {
        merged.value = v;
      },
    );
    userLens.value = 5;
    expect(peekMergeSlots(merged)!.has(userLens)).toBe(true);
  });

  it("via direct (non-lens) write: slot key is the DIRECT_SLOT sentinel", () => {
    const merged = num(0).merge(sumPolicy);
    merged.value = 5;
    expect(peekMergeSlots(merged)!.has(DIRECT_SLOT)).toBe(true);
  });

  it("nested lenses: outer-then-inner produces nested-inner as slot for inner-write", () => {
    // outer.setter calls inner.value = ...; inner.setter writes
    // merge. When inner writes merge, activeBwdWriter is inner;
    // bwdSetterCaller is outer. Merge sees `inner` as slot key.
    const merged = num(0).merge(sumPolicy);
    const inner = installNumLens(
      () => merged.value,
      v => {
        merged.value = v;
      },
    );
    const outer = installNumLens(
      () => merged.value,
      v => {
        inner.value = v;
      },
    );
    outer.value = 7;
    // Inner is the slot, NOT outer. Outer never touched merge directly.
    expect(peekMergeSlots(merged)!.has(inner)).toBe(true);
    expect(peekMergeSlots(merged)!.has(outer)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// G4 — Per-slot dedupe
// ════════════════════════════════════════════════════════════════

describe("G4: per-slot dedupe — repeated writes from one slot REPLACE", () => {
  it("a lens writing its parent K times in one cascade counts as one contribution", () => {
    // Property-check: parametrize over K = 1..20.
    for (let k = 1; k <= 20; k++) {
      const root = num(0);
      const merged = root.merge(sumPolicy);
      const lens = installNumLens(
        () => merged.value,
        v => {
          for (let i = 0; i < k; i++) merged.value = v + i;
        },
      );
      lens.value = 0;
      // The last write is `v + (k-1)`. Sum is one slot ⇒ that value.
      expect(merged.value).toBe(k - 1);
    }
  });

  it("a fan-in that writes the same parent multiple times: only last contributes", () => {
    // Construct a fan-in [a, a] — both slots are `a` (same cell).
    // The fan's bwd writes a TWICE; the second replaces the first
    // at slot[a]; merge holds one contribution.
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const fan = Num.lens(
      [a, a] as const,
      ([x, y]) => x + y,
      (t, _) => [t / 2, t / 2],
    );
    fan.value = 10;
    expect(peekMergeSlots(merged)!.size).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// G5 — Cross-slot fold from identity
// ════════════════════════════════════════════════════════════════

describe("G5: cross-slot fold starts from policy.identity each cascade", () => {
  // CONTRACT (always true regardless of implementation):
  //   finalCommittedValue === reduce(combine, [...slots], identity)
  //
  // IMPLEMENTATION DETAIL (current eager design):
  //   the engine re-folds from identity on EVERY arrival, so the
  //   number of `combine` calls grows quadratically with slot count.
  //   A lazy implementation would call `combine` once per slot per
  //   cascade. Both satisfy the contract.

  it("CONTRACT: the final committed value equals reduce(combine, slots, identity)", () => {
    const merged = num(0).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    const slots = peekMergeSlots(merged)!;
    let manual = sumPolicy.identity;
    for (const v of slots.values()) manual = sumPolicy.combine(manual, v as number);
    expect(merged.value).toBe(manual);
  });

  it("CONTRACT: combine is observed to receive `identity` as its first `acc` argument in any fold", () => {
    // The contract doesn't pin HOW MANY combine calls happen — only
    // that any actual fold seen by the user's policy starts from
    // identity. We assert: the FIRST combine call ever made on this
    // policy has `acc === identity`. The eager implementation will
    // satisfy this trivially (every fold starts at identity); a
    // lazy implementation must also satisfy it.
    let firstAccSeen: number | undefined;
    const tracedSum: MergePolicy<number> = {
      identity: 0,
      combine(acc, x) {
        if (firstAccSeen === undefined) firstAccSeen = acc;
        return acc + x;
      },
    };
    const merged = num(0).merge(tracedSum);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    expect(firstAccSeen).toBe(0); // === identity
  });
});

// ════════════════════════════════════════════════════════════════
// G6 — Cascade boundary
// ════════════════════════════════════════════════════════════════

describe("G6: one user `.value =` call = one cascade", () => {
  it("a fan-in cascade is ONE cascade (multiple sub-writes share id)", () => {
    const merged = num(0).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    // Both contributions present in the slot map after the cascade.
    expect(peekMergeSlots(merged)!.size).toBe(2);
  });

  it("two sequential top-level writes (no batch) are TWO cascades", () => {
    const merged = num(0).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    a.value = 5; // cascade 1: slot[a]=4
    expect(peekMergeAcc(merged)).toBe(4);
    b.value = 5; // cascade 2: fresh; slot[b]=2.5
    expect(peekMergeAcc(merged)).toBe(2.5);
  });

  it("two top-level writes INSIDE a batch are still TWO cascades", () => {
    // Batching is forward-only; it does NOT bundle bwd writes.
    const merged = num(0).merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    batch(() => {
      a.value = 5;
      b.value = 5;
    });
    // Second cascade resets; final state reflects only b's write.
    expect(peekMergeAcc(merged)).toBe(2.5);
  });

  it("a single cascade can include arbitrary nested lens writes via the setter", () => {
    const merged = num(0).merge(sumPolicy);
    const inner = installNumLens(
      () => merged.value,
      v => {
        merged.value = v;
      },
    );
    const outer = installNumLens(
      () => merged.value,
      v => {
        inner.value = v;
        merged.value = v + 100;
      },
    );
    outer.value = 1;
    // Two slots present (inner, outer) ⇒ both wrote within one cascade.
    expect(peekMergeSlots(merged)!.size).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════
// G7 — Fusion barrier
// ════════════════════════════════════════════════════════════════

describe("G7: fusion does not collapse a merge cell", () => {
  // CONTRACT (observable): writes through any chain that crosses
  // the merge actually pass through merge's setter — i.e., the
  // merge intercepts them. If fusion erroneously bypassed the
  // merge, writes would arrive directly at the merge's parent and
  // the merge would have no record of them.
  //
  // IMPLEMENTATION DETAIL: the engine signals "fusion barrier" by
  // leaving `_fusedOf` undefined on the merge cell. Subsequent
  // `_fuse` calls see this and treat the merge as a fusion root.
  // Users shouldn't depend on the internal flag shape.

  it("CONTRACT: writes through a child of the merge cascade THROUGH the merge (slot entry recorded)", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const child = merged.add(1);
    child.value = 5;
    expect(peekMergeSlots(merged)!.size).toBe(1);
    expect(peekMergeSlots(merged)!.has(child)).toBe(true);
  });

  it("CONTRACT: writes through a child commit the FOLDED value to the merge's parent (not the raw child write)", () => {
    // If fusion bypassed the merge, root would receive `4` (the
    // raw output of child.bwd). With the merge in place, root
    // receives sum-fold([4]) = 4 — same number, but for a
    // non-trivial policy like max + multiple slots the difference
    // would be visible. Use max with a fanin to make it observable.
    const root = num(0);
    const merged = root.merge(maxPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 6;
    // root=0 → a=1, b=0 → updates [6, 0] → a.bwd=5, b.bwd=0.
    // If merge were bypassed: last-write-wins, root=0 (b's
    // contribution clobbered a's). With merge: max(5, 0) = 5.
    expect(root.value).toBe(5);
  });

  it("IMPLEMENTATION: merge cell's _fusedOf is undefined (internal flag check; not contract)", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const fusedOf = (merged as Num & { _fusedOf?: unknown })._fusedOf;
    expect(fusedOf).toBeUndefined();
  });

  it("IMPLEMENTATION: lenses chained off a merge have _fusedOf.parent === merge", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const child = merged.add(1);
    const fusedOf = (child as Num & { _fusedOf?: { parent: unknown } })._fusedOf;
    expect(fusedOf?.parent).toBe(merged);
  });
});

// ════════════════════════════════════════════════════════════════
// G8 — Commutativity required
// ════════════════════════════════════════════════════════════════

describe("G8: non-commutative policies have unspecified cross-slot order", () => {
  it("symmetric policies are arrival-order-independent (verified by permutation)", () => {
    // Property test: with 3 fan-in parents, every permutation of
    // their order yields the SAME final value for sum (commutative).
    const baseValues: number[] = [];
    function diamondWith(perm: readonly number[]) {
      const merged = num(0).merge(sumPolicy);
      const lenses = [merged.add(1), merged.scale(2), merged.add(10)] as const;
      const ordered = perm.map(i => lenses[i]!) as unknown as readonly [Num, Num, Num];
      const fan = Num.lens(
        ordered,
        ([a, b, c]) => a + b + c,
        (t, [a, b, c]) => {
          const tot = a + b + c || 1;
          return [(t * a) / tot, (t * b) / tot, (t * c) / tot];
        },
      );
      fan.value = 30;
      return merged.value;
    }
    // All 6 permutations of [0,1,2]
    const perms: number[][] = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const p of perms) baseValues.push(diamondWith(p));
    // All should be equal under sum (commutative).
    for (let i = 1; i < baseValues.length; i++) {
      expect(baseValues[i]).toBeCloseTo(baseValues[0]!);
    }
  });

  it("idempotent policies (max) are arrival-order-independent (verified by permutation)", () => {
    function diamondWith(perm: readonly number[]) {
      const merged = num(0).merge(maxPolicy);
      const lenses = [merged.add(1), merged.scale(2), merged.add(10)] as const;
      const ordered = perm.map(i => lenses[i]!) as unknown as readonly [Num, Num, Num];
      const fan = Num.lens(
        ordered,
        ([a, b, c]) => a + b + c,
        (t, [a, b, c]) => {
          const tot = a + b + c || 1;
          return [(t * a) / tot, (t * b) / tot, (t * c) / tot];
        },
      );
      fan.value = 30;
      return merged.value;
    }
    const results = [
      diamondWith([0, 1, 2]),
      diamondWith([0, 2, 1]),
      diamondWith([1, 0, 2]),
      diamondWith([1, 2, 0]),
      diamondWith([2, 0, 1]),
      diamondWith([2, 1, 0]),
    ];
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBeCloseTo(results[0]!);
    }
  });

  it("NON-commutative policy: results DEPEND on arrival order (unspecified behaviour)", () => {
    // Documenting that we DON'T promise stability here.
    const firstWins: MergePolicy<number> = {
      identity: Number.NaN,
      combine: (acc, x) => (Number.isNaN(acc) ? x : acc),
    };
    function diamondWith(perm: readonly number[]) {
      const merged = num(1).merge(firstWins);
      const lenses = [merged.add(1), merged.scale(2)] as const;
      const ordered = perm.map(i => lenses[i]!) as unknown as readonly [Num, Num];
      const fan = Num.lens(
        ordered,
        ([a, b]) => a + b,
        (t, [a, b]) => {
          const tot = a + b || 1;
          return [(t * a) / tot, (t * b) / tot];
        },
      );
      fan.value = 10;
      return merged.value;
    }
    const r1 = diamondWith([0, 1]);
    const r2 = diamondWith([1, 0]);
    // Different! This is the unspecified behaviour. Users CANNOT
    // rely on either value being canonical.
    expect(r1).not.toBe(r2);
  });
});

// ════════════════════════════════════════════════════════════════
// G9 — Engine-global quiescence
// ════════════════════════════════════════════════════════════════

describe("G9: activeBwdWriter / bwdSetterCaller are undefined outside cascades", () => {
  it("before any write, both are undefined", () => {
    expect(_activeBwdWriter()).toBeUndefined();
    expect(_bwdSetterCaller()).toBeUndefined();
  });

  it("after a cascade completes, both return to undefined", () => {
    const merged = num(0).merge(sumPolicy);
    const a = merged.add(1);
    a.value = 5;
    expect(_activeBwdWriter()).toBeUndefined();
    expect(_bwdSetterCaller()).toBeUndefined();
  });

  it("after an exception during a cascade, both return to undefined (try/finally guarantee)", () => {
    const merged = num(0).merge(sumPolicy);
    const bad = installNumLens(
      () => merged.value,
      _v => {
        throw new Error("oops");
      },
    );
    expect(() => {
      bad.value = 5;
    }).toThrow(/oops/);
    expect(_activeBwdWriter()).toBeUndefined();
    expect(_bwdSetterCaller()).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// G10 — Engine integrity
// ════════════════════════════════════════════════════════════════

describe("G10: existing engine semantics unchanged for un-merged signals", () => {
  it("forward propagation: a write to a parent re-derives subscribers", () => {
    const root = num(0);
    let derives = 0;
    const view = Num.derive(root, v => {
      derives++;
      return v * 2;
    });
    void view.value;
    const baseline = derives;
    root.value = 5;
    void view.value;
    expect(derives - baseline).toBe(1);
    expect(view.value).toBe(10);
  });

  it("equality short-circuit: writing the same value doesn't re-derive", () => {
    const root = num(0);
    let derives = 0;
    const view = Num.derive(root, v => {
      derives++;
      return v;
    });
    void view.value;
    const baseline = derives;
    root.value = 0; // same
    void view.value;
    expect(derives - baseline).toBe(0);
  });

  it("batch: multiple writes inside batch fire subscribers once", () => {
    const root = num(0);
    let fires = 0;
    const stop = effect(() => {
      void root.value;
      fires++;
    });
    const baseline = fires;
    batch(() => {
      root.value = 1;
      root.value = 2;
      root.value = 3;
    });
    expect(fires - baseline).toBe(1);
    stop();
  });
});

// ════════════════════════════════════════════════════════════════
// PROPERTY: random commutative-policy stress test
// ════════════════════════════════════════════════════════════════

describe("PROPERTY: random fan-in sizes with sum policy give consistent results", () => {
  it("multiple seeds, sizes 2-5: result is the sum of slot contributions", () => {
    const rng = mulberry32(0xdecaf);
    for (let trial = 0; trial < 30; trial++) {
      const slotCount = 2 + Math.floor(rng() * 4); // 2..5
      const merged = num(0).merge(sumPolicy);
      const lenses = Array.from({ length: slotCount }, (_, i) => merged.add(i + 1));
      const fan = Num.lens(
        lenses as unknown as readonly Num[],
        vals => vals.reduce((a, b) => a + b, 0),
        (t, vals) => {
          const tot = vals.reduce((a, b) => a + b, 0) || 1;
          return vals.map(v => (t * v) / tot);
        },
      );
      const target = 100 + Math.floor(rng() * 100);
      fan.value = target;
      // After cascade, the slot map size equals the lens count.
      const slots = peekMergeSlots(merged)!;
      expect(slots.size).toBe(slotCount);
      // Manual sum of the recorded slots equals merged.value.
      let manual = 0;
      for (const v of slots.values()) manual += v as number;
      expect(merged.value).toBeCloseTo(manual);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// NEGATIVE: explicitly DO NOT promise these
// ════════════════════════════════════════════════════════════════

describe("NEGATIVE: cross-slot arrival order is observable today but NOT promised", () => {
  it("two fan-in orderings produce values that HAPPEN to match for commutative policy", () => {
    // The mere fact that current arrival is array-index-order does
    // not mean it will stay that way. The TRUE guarantee is G8
    // (commutativity). Tests should target FINAL VALUES, not order.
    const merged1 = num(0).merge(sumPolicy);
    const a1 = merged1.add(1);
    const b1 = merged1.scale(2);
    Num.lens(
      [a1, b1] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    ).value = 6;

    const merged2 = num(0).merge(sumPolicy);
    const a2 = merged2.add(1);
    const b2 = merged2.scale(2);
    Num.lens(
      [b2, a2] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    ).value = 6;
    // Same final value for commutative policy regardless of order.
    expect(merged1.value).toBeCloseTo(merged2.value);
  });
});

describe("NEGATIVE: peekMergeSlots between cascades shows stale state (debug only)", () => {
  it("stale slot map persists between cascades for merges that don't fire", () => {
    const m1 = num(0).merge(sumPolicy);
    const m2 = num(0).merge(sumPolicy);
    m1.value = 5;
    m2.value = 10; // m2 fires, m1 doesn't
    // m1's slot map STILL holds its prior contribution — this is
    // an artifact of debug introspection and is not user-visible.
    expect(peekMergeSlots(m1)!.size).toBeGreaterThan(0);
    // The user-visible value is correct:
    expect(m1.value).toBe(5);
  });
});

describe("NEGATIVE: rebuilding lens gives a fresh slot (reference identity governs)", () => {
  it("two calls to `.add(1)` create distinct slots", () => {
    const merged = num(0).merge(sumPolicy);
    const a1 = merged.add(1);
    const a2 = merged.add(1); // same shape, different cell
    const fan = Num.lens(
      [a1, a2] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 4;
    expect(peekMergeSlots(merged)!.size).toBe(2);
    // Users wanting to dedupe at the value-class level need to
    // share a single lens reference.
  });
});

// ════════════════════════════════════════════════════════════════
// Vec-class smoke for G2/G3 over richer value type
// ════════════════════════════════════════════════════════════════

describe("guarantees hold over typed value classes (Vec)", () => {
  it("G2: vec merge forward-identity", () => {
    type V = { x: number; y: number };
    const root = vec(0, 0) as unknown as Signal<V>;
    const merged = root.merge<V>({
      identity: { x: 0, y: 0 },
      combine: (a, b) => ({ ...a, ...b }),
    });
    expect(merged.value).toEqual(root.value);
    (root as unknown as Vec).x.value = 7;
    expect(merged.value).toEqual(root.value);
  });
});
