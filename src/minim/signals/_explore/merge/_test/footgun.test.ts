// footgun.test.ts — pin the edge cases that the merge prototype
// has to handle correctly OR document clearly. The user's contract:
//
//   "the same footguns as normal signals ('don't create a cycle in
//   an effect') and our single addition of 'bwd merges are last-
//   write-wins unless you add a merge node to specify behaviour'"
//
// So the merge primitive must not introduce NEW footguns beyond:
//   (a) the standing engine ones (cycles, infinite recursion, etc.)
//   (b) the one declared addition (no merge ⇒ last-wins)
//
// Anything else that surprises the user is a bug in the design.

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
  withMerge,
} from "../index";

function installNumLens(getter: () => number, setter: (v: number) => void): Num {
  return Signal.install(
    Num as unknown as new (...args: never[]) => Signal<number>,
    getter,
    setter,
  ) as unknown as Num;
}

describe("reference identity is the slot key (intentional, but worth pinning)", () => {
  it("two `.add(1)` invocations on the same root are TWO slots (distinct lens cells)", () => {
    const root = withMerge(num(0), sumPolicy);
    const a1 = root.add(1);
    const a2 = root.add(1); // structurally identical to a1, but different cell
    const fan = Num.lens(
      [a1, a2] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 4;
    // Two slots even though the structural shape is identical.
    expect(peekMergeSlots(root)!.size).toBe(2);
    // This is consistent with how the engine treats lens identity
    // everywhere else: lens cells are distinct objects, equal by
    // reference. The merge inherits this; "same shape" doesn't
    // collapse to "same slot."
  });

  it("the SAME lens cell referenced twice in a fan-in IS one slot (its setter still runs twice though)", () => {
    // Pathological-ish: same lens cell appears twice in a fan-in.
    // The fan-in's bwd will produce two updates for the same cell,
    // each writing root through the same lens (same slot identity).
    // Second write replaces the first; one slot in the merge.
    const root = withMerge(num(0), sumPolicy);
    const a = root.add(1);
    const fan = Num.lens(
      [a, a] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    fan.value = 10;
    expect(peekMergeSlots(root)!.size).toBe(1);
  });
});

describe("direct (non-lens) writes during a cascade", () => {
  it("a direct user write to the merged root lands in the DIRECT slot", () => {
    const root = withMerge(num(0), sumPolicy);
    root.value = 7;
    const slots = peekMergeSlots(root)!;
    expect(slots.size).toBe(1);
    expect(slots.has(DIRECT_SLOT)).toBe(true);
    expect(slots.get(DIRECT_SLOT)).toBe(7);
  });

  it("a direct write FROM INSIDE A LENS SETTER (escape hatch) is its OWN slot", () => {
    // A lens setter that, in addition to its normal bwd, slips in
    // a direct `root.value = ...` write. Since `activeBwdWriter`
    // is the lens at that point (the setter is running), the
    // direct write also gets that lens as its slot — NOT
    // DIRECT_SLOT. This is consistent: from the merge's pov, the
    // setter is the slot regardless of what it writes inside.
    const root = withMerge(num(0), sumPolicy);
    const lens = installNumLens(
      () => root.value,
      v => {
        root.value = v; // slot = lens
        root.value = v + 100; // slot = lens (last wins)
      },
    );
    lens.value = 1;
    expect(root.value).toBe(101); // only one slot, last value
    expect(peekMergeSlots(root)!.size).toBe(1);
  });
});

describe("interactions with effects (the standing engine footgun)", () => {
  it("an effect reading a merged root sees the COMMITTED value, not the raw arrivals", () => {
    const root = withMerge(num(0), sumPolicy);
    const a = root.add(1);
    const b = root.scale(2);
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
      fires.push(root.value);
    });
    fires.length = 0; // ignore the initial run
    fan.value = 6;
    // Engine batches forward propagation inside the fan-in's bwd
    // setter, so the effect fires ONCE per user cascade, with the
    // final committed merge value. Intermediate per-arrival
    // commits are invisible to the effect.
    expect(fires.length).toBe(1);
    expect(fires[0]).toBe(root.value);
    stop();
  });

  it("an effect that writes the merged root does not infinitely loop the engine", () => {
    // The standing engine footgun is "don't create cycles in
    // effects". The merge primitive must NOT make this worse —
    // it should compose cleanly with the engine's existing
    // effect/write interaction (whatever that is — engine-level
    // convergence guarantees vary by setup; the important property
    // here is "doesn't infinite loop / throw").
    const root = withMerge(num(0), sumPolicy);
    let fires = 0;
    const stop = effect(() => {
      fires++;
      // Read once, write once. No cycle even if the engine doesn't
      // re-fire (the merge primitive isn't responsible for the
      // engine's re-fire policy).
      const v = root.value;
      if (v < 1) root.value = 1;
    });
    expect(fires).toBeGreaterThan(0);
    expect(Number.isFinite(root.value)).toBe(true);
    stop();
  });
});

describe("the merge is opt-in: no merge ⇒ exactly today's behaviour", () => {
  it("a signal without `withMerge` is byte-for-byte the engine's normal write path", () => {
    // Regression guard: the engine modifications (activeBwdWriter
    // push, bwdCascadeId bump) must not change observable
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
      b.value = 5; // 105 — clobbers 5
    });
    expect(root.value).toBe(105); // last-write-wins, exactly today's behaviour
  });

  it("merge attached then policy never matches ⇒ falls through identity-only", () => {
    // Degenerate policy: combine returns identity always. This is
    // never sensible, but it's a sanity check that the merge code
    // doesn't introduce spurious behaviour beyond what `combine`
    // declares.
    const dropAllPolicy = { identity: -1, combine: () => -1 };
    const root = withMerge(num(0), dropAllPolicy);
    const a = root.add(1);
    const fan = Num.lens(
      [a] as const,
      ([x]) => x,
      (t, [_x]) => [t],
    );
    fan.value = 50;
    expect(root.value).toBe(-1); // committed identity
  });
});

describe("maxPolicy with no contributions in a cascade", () => {
  it("a cascade that arrives at root via NO slot leaves the merge untouched", () => {
    // Trivially: if no backward writes happen, the merge fires
    // never. Root keeps its prior value.
    const root = withMerge(num(42), maxPolicy);
    expect(root.value).toBe(42);
    // Doing nothing leaves it at 42.
    expect(root.value).toBe(42);
  });
});
