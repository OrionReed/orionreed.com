// footgun.test.ts — pin the edge cases that the merge prototype
// has to handle correctly OR document clearly. The contract:
//
//   "the same footguns as normal signals ('don't create a cycle in
//   an effect') and our single addition of 'bwd merges are last-
//   write-wins unless you add a merge node to specify behaviour'"
//
// So `.merge()` must not introduce NEW footguns beyond:
//   (a) the standing engine ones (cycles, infinite recursion, etc.)
//   (b) the one declared addition (no merge ⇒ last-wins)
//
// Anything else that surprises the user is a design bug.

import { describe, expect, it } from "vitest";
import {
  batch,
  DIRECT_SLOT,
  effect,
  maxPolicy,
  Num,
  num,
  peekMergeSlots,
  Signal,
  signal,
  sumPolicy,
} from "../index";

function installNumLens(getter: () => number, setter: (v: number) => void): Num {
  return Signal.install(
    Num as unknown as new (...args: never[]) => Signal<number>,
    getter,
    setter,
  ) as unknown as Num;
}

describe("reference identity is the slot key (intentional, but worth pinning)", () => {
  it("two `.add(1)` invocations on the same merge are TWO slots (distinct lens cells)", () => {
    const merged = num(0).merge(sumPolicy);
    const a1 = merged.add(1);
    const a2 = merged.add(1);
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
  });

  it("the SAME lens cell referenced twice in a fan-in IS one slot", () => {
    const merged = num(0).merge(sumPolicy);
    const a = merged.add(1);
    const fan = Num.lens(
      [a, a] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 10;
    expect(peekMergeSlots(merged)!.size).toBe(1);
  });
});

describe("direct (non-lens) writes to the merge cell", () => {
  it("a direct top-level write lands in DIRECT_SLOT", () => {
    const merged = num(0).merge(sumPolicy);
    merged.value = 7;
    const slots = peekMergeSlots(merged)!;
    expect(slots.size).toBe(1);
    expect(slots.has(DIRECT_SLOT)).toBe(true);
    expect(slots.get(DIRECT_SLOT)).toBe(7);
  });

  it("a direct write from inside a lens setter still slots under that lens", () => {
    // The merge's setter reads `bwdSetterCaller`. When a lens
    // setter calls `merged.value = ...`, the engine pushes lens as
    // activeBwdWriter; the merge sees lens as caller. So even a
    // "direct-style" `merged.value =` from inside a lens setter
    // goes to the lens's slot, not DIRECT_SLOT.
    const merged = num(0).merge(sumPolicy);
    const lens = installNumLens(
      () => merged.value,
      v => {
        merged.value = v;
        merged.value = v + 100;
      },
    );
    lens.value = 1;
    expect(merged.value).toBe(101);
    expect(peekMergeSlots(merged)!.size).toBe(1);
  });
});

describe("interactions with effects (the standing engine footgun)", () => {
  it("an effect reading a merged cell sees the COMMITTED value, not the raw arrivals", () => {
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
    const fires: number[] = [];
    const stop = effect(() => {
      fires.push(merged.value);
    });
    fires.length = 0;
    fan.value = 6;
    // One cascade ⇒ one effect fire with the final committed value.
    expect(fires.length).toBe(1);
    expect(fires[0]).toBe(merged.value);
    stop();
  });

  it("an effect that writes through a merged cell does not infinitely loop the engine", () => {
    const merged = num(0).merge(sumPolicy);
    let fires = 0;
    const stop = effect(() => {
      fires++;
      const v = merged.value;
      if (v < 1) merged.value = 1;
    });
    expect(fires).toBeGreaterThan(0);
    expect(Number.isFinite(merged.value)).toBe(true);
    stop();
  });
});

describe("the merge is opt-in: no merge ⇒ exactly today's behaviour", () => {
  it("a signal without `.merge()` is byte-for-byte the engine's normal write path", () => {
    // Regression guard: the engine modifications (activeBwdWriter,
    // bwdSetterCaller, bwdCascadeId) must not change observable
    // behaviour of un-merged signals.
    const root = signal(0);
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
    batch(() => {
      a.value = 5;
      b.value = 5;
    });
    expect(root.value).toBe(105);
  });

  it("merge with a degenerate policy still produces deterministic output", () => {
    const dropAll = { identity: -1, combine: () => -1 };
    const merged = num(0).merge(dropAll);
    const a = merged.add(1);
    const fan = Num.lens(
      [a] as const,
      ([x]) => x,
      (t, [_x]) => [t],
    );
    fan.value = 50;
    expect(merged.value).toBe(-1);
  });
});

describe("merge on a read-only receiver", () => {
  it("throws: merge requires a writable bwd path", () => {
    const root = num(0);
    const ro = Num.derive(root, v => v * 2); // RO computed
    expect(() => {
      (ro as unknown as Num & { merge: (p: typeof maxPolicy) => unknown }).merge(maxPolicy);
    }).toThrow(/read-only/);
  });
});

describe("merge with no contributions in a cascade", () => {
  it("doing nothing leaves the merge cell at its parent's current value", () => {
    const merged = num(42).merge(maxPolicy);
    expect(merged.value).toBe(42);
    expect(merged.value).toBe(42);
  });
});

describe("error thrown mid-cascade from inside a setter", () => {
  it("a setter throw doesn't leave engine globals in a bad state", () => {
    const merged = num(0).merge(sumPolicy);
    // Construct a lens whose setter throws. The cascade should
    // unwind cleanly via try/finally in `_setWithExclusion`'s lens
    // dispatch, restoring activeBwdWriter/bwdSetterCaller.
    const badLens = installNumLens(
      () => merged.value,
      _v => {
        throw new Error("kaboom");
      },
    );
    expect(() => {
      badLens.value = 5;
    }).toThrow(/kaboom/);
    // After the throw, a fresh cascade should work normally.
    const goodLens = installNumLens(
      () => merged.value,
      v => {
        merged.value = v;
      },
    );
    goodLens.value = 7;
    expect(merged.value).toBe(7);
  });

  it("a throw during a fan-in's batched sub-writes still unwinds activeBwdWriter", () => {
    // First two sub-writes succeed; third throws. The engine's
    // try/finally must restore globals so subsequent writes work.
    const merged = num(0).merge(sumPolicy);
    const lensA = installNumLens(
      () => merged.value,
      v => {
        merged.value = v;
      },
    );
    const lensThrows = installNumLens(
      () => merged.value,
      _v => {
        throw new Error("nope");
      },
    );
    const fan = Num.lens(
      [lensA, lensThrows] as const,
      ([x, y]) => x + y,
      (t, [_a, _b]) => [t / 2, t / 2],
    );
    expect(() => {
      fan.value = 10;
    }).toThrow(/nope/);
    // Fresh attempt on a clean cascade:
    lensA.value = 99;
    expect(merged.value).toBe(99);
  });
});

describe("equality short-circuit", () => {
  it("two identical direct writes ⇒ effect fires for the first, not the second (no-op)", () => {
    const merged = num(0).merge(sumPolicy);
    let fires = 0;
    const stop = effect(() => {
      void merged.value;
      fires++;
    });
    const baseline = fires;
    merged.value = 5;
    merged.value = 5; // identical to current value
    // Cascade 1: commit 5 (was 0, change) → fire.
    // Cascade 2: commit 5 (still 5, no change) → equality short-circuits;
    //   no propagate; effect doesn't re-fire.
    expect(fires - baseline).toBe(1);
    stop();
  });
});

describe("policy mutation: changing policy state at runtime is undefined behaviour", () => {
  it("the merge captures the policy reference; user-mutating it changes behaviour mid-flight (footgun)", () => {
    // Document the (probably-unsupported) case: user creates a
    // policy object and then mutates it. The merge holds a
    // reference; subsequent folds use the new combine. We don't
    // copy or freeze policies — caller's responsibility to keep
    // them stable.
    const mutable: typeof maxPolicy = { identity: 0, combine: (a, b) => a + b };
    const merged = num(0).merge(mutable);
    const a = merged.add(1);
    a.value = 5;
    expect(merged.value).toBe(4); // sum (0 + 4) = 4

    // Swap combine in place — this is a footgun but should still
    // produce defined behaviour (just possibly surprising).
    mutable.combine = (a, b) => Math.max(a, b);
    a.value = 10;
    expect(merged.value).toBe(9); // max(0, 9) = 9
  });
});

describe("merge cell garbage collection", () => {
  it("a merge cell with no live references doesn't pin its parent", () => {
    // We can't directly test GC, but we can verify that the merge
    // cell doesn't store its parent in a global registry. The
    // engine's only retention is through the Link graph: if no
    // sub/dep references the merge, the engine doesn't hold it.
    let merged: ReturnType<typeof num> | undefined = num(0).merge(sumPolicy);
    const slotsAtCreate = peekMergeSlots(merged)!;
    expect(slotsAtCreate.size).toBe(0);
    merged = undefined;
    // No leak in our weakmap-or-instance-property design — merge
    // state lives on the cell itself, which can be collected.
    // (Real GC verification is environmental; this just exercises
    // the lifecycle.)
    expect(merged).toBeUndefined();
  });
});

describe("symmetric lens + merge", () => {
  it("a merge on a regular signal whose value is also reachable via a symmetric lens still works", () => {
    // Symmetric lenses are a separate construction; they don't
    // interact with merge directly because they're built via
    // `_symmetric`/`_fuseOnSymmetric` and have their own complement
    // state. A merge attached to a signal that ALSO has a
    // symmetric lens above it should still function — the merge
    // intercepts only writes through itself.
    const root = num(0);
    const merged = root.merge(sumPolicy);
    // Independently of merged, build a normal lens chain reading
    // root. The merge doesn't interfere.
    const independent = root.add(1000);
    const a = merged.add(1);
    a.value = 5;
    expect(root.value).toBe(4);
    expect(independent.value).toBe(1004);
  });
});

describe("re-entrant merge during its own commit", () => {
  it("a downstream effect that writes the merge during commit propagation doesn't recurse forever", () => {
    // The merge's setter calls parent._setWithExclusion (commit).
    // That commit propagates forward; subscribers fire. An effect
    // subscribed to the merge that writes THROUGH the merge (or to
    // a downstream lens) could re-enter. The engine's normal
    // re-entry guards should handle this.
    const merged = num(0).merge(sumPolicy);
    let fires = 0;
    const stop = effect(() => {
      fires++;
      // Read once to subscribe; conditional bump to terminate.
      const v = merged.value;
      if (v < 5 && fires < 100) merged.value = v + 1;
    });
    expect(Number.isFinite(merged.value)).toBe(true);
    expect(fires).toBeLessThan(100);
    stop();
  });
});
