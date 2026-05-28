// chain.test.ts — `.merge()` placed at various positions in a lens
// chain. The instance-method form gives the user explicit
// topological placement of merge nodes; this file pins what each
// placement means.
//
// Cardinal positions:
//   1. AT root (signal-mode receiver): `num(0).merge(p)`
//   2. MID-CHAIN (lens receiver above more lenses):
//        `num(0).add(1).merge(p).scale(2)`
//   3. AT LEAF (no chain after): same as mid-chain w/o children
//   4. ABOVE A FAN-IN (multiple parents below, single merge above):
//        `merge.add(1)` and `merge.scale(2)` both descend through merge
//   5. BELOW A FAN-IN (fan-in views feed into merge): the merge sees
//      the fan-in node as ITS upstream caller — one slot for the
//      whole fan-in. Tests pin that this is the structural truth.
//
// Also: fusion barrier behaviour — a merge cell breaks the fused
// chain on both sides. Subsequent `.lens()` after a merge starts a
// fresh fusion segment rooted at the merge.

import { describe, expect, it } from "vitest";
import {
  maxPolicy,
  Num,
  num,
  peekMergeAcc,
  peekMergeSlots,
  Signal,
  sumPolicy,
} from "../index";

describe("position 1: merge at root", () => {
  it("returns a new cell whose value reads the underlying signal", () => {
    const root = num(42);
    const merged = root.merge(sumPolicy);
    expect(merged).not.toBe(root);
    expect(merged.value).toBe(42);
    root.value = 100;
    expect(merged.value).toBe(100);
  });

  it("a direct write to merge commits via parent (root) and dedupes by DIRECT slot", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    merged.value = 5;
    expect(root.value).toBe(5);
    expect(peekMergeSlots(merged)!.size).toBe(1);
  });
});

describe("position 2: merge mid-chain", () => {
  it("forward: identity over its parent — merge.value === parent.value", () => {
    const root = num(0);
    const added = root.add(1);
    const merged = added.merge(sumPolicy);
    const scaled = merged.scale(2);
    expect(merged.value).toBe(1);
    expect(scaled.value).toBe(2);
    root.value = 10;
    expect(merged.value).toBe(11);
    expect(scaled.value).toBe(22);
  });

  it("backward through scale → merge → added → root: cascade flows through merge intact", () => {
    const root = num(0);
    const added = root.add(1);
    const merged = added.merge(sumPolicy);
    const scaled = merged.scale(2);
    scaled.value = 14;
    // scale.bwd(14) = 7 → arrives at merge under slot `scaled` ⇒ committed via added.setter
    // added.bwd(7) = 6 → root := 6
    expect(root.value).toBe(6);
  });

  it("a fan-in BELOW the merge produces multiple slots IN the merge", () => {
    const root = num(0);
    const added = root.add(1);
    const merged = added.merge(sumPolicy); // merge mid-chain
    const left = merged.scale(2);
    const right = merged.add(10);
    const both = Num.lens(
      [left, right] as const,
      ([l, r]) => l + r,
      (t, [l, r]) => {
        const tot = l + r || 1;
        return [(t * l) / tot, (t * r) / tot];
      },
    );
    both.value = 30;
    // The merge sits ABOVE left and right; both lens chains cascade
    // INTO it. Two slots arrive in the merge cell.
    expect(peekMergeSlots(merged)!.size).toBe(2);
  });
});

describe("position 3: merge at leaf (no children)", () => {
  it("acts like an identity view; direct writes commit through to parent", () => {
    const root = num(0);
    const merged = root.add(1).merge(sumPolicy);
    expect(merged.value).toBe(1);
    merged.value = 5;
    // merged.setter: slot=DIRECT, fold=5, commit to add(1).
    // add(1).setter: root := 5 - 1 = 4.
    expect(root.value).toBe(4);
    expect(merged.value).toBe(5);
  });
});

describe("fusion barrier behaviour", () => {
  it("lenses built ABOVE a merge see the merge as their parent, not the merge's parent", () => {
    // If fusion crossed the merge boundary, `merged.scale(2)` would
    // collapse into a cell whose setter writes directly to root,
    // bypassing the merge logic. Test: when we write through the
    // child, the merge slot is populated — meaning the cascade
    // really did pass through it.
    const root = num(0);
    const added = root.add(1);
    const merged = added.merge(sumPolicy);
    const scaled = merged.scale(2);
    scaled.value = 14;
    // Must have a slot entry — the cascade went merge.setter →
    // added.setter. If fusion had erased the merge, no slot would
    // be recorded.
    expect(peekMergeSlots(merged)!.size).toBe(1);
    // And the slot key must be the immediate caller (= `scaled`).
    const slots = peekMergeSlots(merged)!;
    const keys = Array.from(slots.keys());
    expect(keys).toContain(scaled);
  });

  it("lenses built BELOW the merge do not fuse into the merge's parent either", () => {
    // The `added` lens stays as the merge's parent — it's not
    // collapsed into the underlying root cell. Verify by checking
    // the FOLDED commit goes through added.bwd (not directly to
    // root).
    const root = num(10);
    const added = root.add(1);
    const merged = added.merge(maxPolicy);
    const leftScale = merged.scale(2);
    const rightScale = merged.scale(3);
    const fan = Num.lens(
      [leftScale, rightScale] as const,
      ([l, r]) => l + r,
      (t, [l, r]) => {
        const tot = l + r || 1;
        return [(t * l) / tot, (t * r) / tot];
      },
    );
    fan.value = 100;
    // root=10 → added=11 → ls=22, rs=33 → fan.value=100:
    //   ls' = 100*22/55 = 40 → merge via leftScale.bwd = 20
    //   rs' = 100*33/55 = 60 → merge via rightScale.bwd = 20
    //   max(20, 20) = 20 → committed to `added` → added.bwd(20) = 19
    expect(root.value).toBe(19);
    // The fact that root commits to 19 (= 20 - 1) and not 20 itself
    // confirms `added.bwd` ran on the folded value.
  });
});

describe("polymorphic this: chain methods after .merge() still return the receiver class", () => {
  it("Num.merge(...).add(...) → Num", () => {
    const merged = num(0).merge(sumPolicy);
    const added = merged.add(5);
    expect(added).toBeInstanceOf(Num);
  });
});

describe("multiple writes through one chain branch", () => {
  it("sequential cascades reset the slot map between user calls", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    a.value = 5; // cascade 1: slot[a]=4, commit 4
    expect(peekMergeAcc(merged)).toBe(4);
    a.value = 10; // cascade 2: fresh slot map, slot[a]=9, commit 9
    expect(peekMergeAcc(merged)).toBe(9);
  });
});

describe("long chains around the merge", () => {
  it("a long fused chain ABOVE the merge cascades all writes back through the merge", () => {
    // merged.add(1).scale(2).add(3) fuses to one cell whose parent
    // (per fusion barrier) is `merged`. Writing the leaf cascades:
    //   leaf.bwd → merge.setter → committed via merged.parent.setter
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const leaf = merged.add(1).scale(2).add(3);
    leaf.value = 17;
    // leaf.bwd: 17 → after .add(3).bwd: 14 → after .scale(2).bwd: 7 → after .add(1).bwd: 6.
    // merge slot[leaf]=6, fold=6, commit to root: 6.
    expect(root.value).toBe(6);
  });

  it("a long fused chain BELOW the merge: identity-then-merge-then-rest", () => {
    // root.add(1).scale(2).merge(p).add(3)
    //   - prefix (root.add(1).scale(2)) fuses into one cell whose
    //     parent is root.
    //   - merge sits on top of that fused cell (fusion barrier).
    //   - the .add(3) above the merge fuses with merge as its
    //     parent.
    const root = num(0);
    const prefix = root.add(1).scale(2); // = (root+1)*2 = 2
    const merged = prefix.merge(sumPolicy);
    const tail = merged.add(3);
    expect(tail.value).toBe(5); // (0+1)*2 + 3
    tail.value = 11;
    // tail.bwd: 11 → after .add(3).bwd: 8 → merge slot[tail]=8, fold=8, commit to prefix.
    // prefix's setter (fused chain): root := (8 / 2) - 1 = 3.
    expect(root.value).toBe(3);
  });
});

describe("merge cell as a parent for further .merge() calls", () => {
  it("merge-on-merge: outer merge sees inner merge as its caller slot", () => {
    // Two merges stacked. Topology:
    //   root → inner = root.merge(sum) → outer = inner.merge(max)
    // When something cascades into outer and folds, outer's
    // commit goes to inner. inner sees outer (the calling lens) as
    // its slot. inner folds across slots and commits to root.
    const root = num(0);
    const inner = root.merge(sumPolicy);
    const outer = inner.merge(maxPolicy);
    outer.value = 7; // direct write to outer
    // outer.setter: slot[DIRECT]=7, max(-Inf, 7) = 7, commit to inner.
    // inner.setter: slot[outer]=7 (calling lens), sum(0, 7) = 7, commit to root.
    expect(root.value).toBe(7);
    expect(peekMergeSlots(outer)!.size).toBe(1);
    expect(peekMergeSlots(inner)!.size).toBe(1);
  });
});
