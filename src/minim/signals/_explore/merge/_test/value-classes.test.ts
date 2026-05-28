// value-classes.test.ts — `.merge()` on typed value classes (Vec,
// object types). Polymorphic-`this` return preserves the receiver's
// class through the merge, so chains keep their typed surface.

import { describe, expect, it } from "vitest";
import {
  field,
  type MergePolicy,
  Num,
  num,
  peekMergeSlots,
  Signal,
  spreadPolicy,
  Vec,
  vec,
} from "../index";

type V = { x: number; y: number };

describe("polymorphic-this: chain methods preserve typed receiver", () => {
  it("Num.merge → Num", () => {
    const m = num(0).merge({ identity: 0, combine: (a, b) => a + b });
    expect(m).toBeInstanceOf(Num);
    expect(m.add).toBeInstanceOf(Function);
  });

  it("Vec.merge → Vec", () => {
    const m = vec(0, 0).merge(spreadPolicy<V>({ x: 0, y: 0 }));
    expect(m).toBeInstanceOf(Vec);
    expect(m.x).toBeDefined();
    expect(m.y).toBeDefined();
  });
});

describe("Vec merge with spread policy", () => {
  it("two field lenses (.x and .y) each contribute a partial-object update", () => {
    const root = vec(0, 0) as unknown as Signal<V>;
    const merged = root.merge(spreadPolicy<V>({ x: 0, y: 0 }));
    const v = merged as unknown as Vec;
    // Fan-in: two field lenses, each writes a full V with only one
    // field changed. Spread fold combines them so both updates land.
    const fan = Signal.install(
      Vec as unknown as new (...args: never[]) => Signal<V>,
      () => v.value,
      (_t: V) => {
        v.x.value = 7;
        v.y.value = 9;
      },
    ) as unknown as Vec;
    fan.value = { x: 7, y: 9 };
    expect(root.value).toEqual({ x: 7, y: 9 });
    expect(merged.value).toEqual({ x: 7, y: 9 });
  });
});

describe("Vec merge with custom policy: midpoint of contributions", () => {
  it("a midpoint policy combines incoming vec writes by averaging x and y", () => {
    const midpointPolicy: MergePolicy<V & { count?: number }> = {
      identity: { x: 0, y: 0, count: 0 },
      combine: (a, b) => {
        const ca = a.count ?? 0;
        // Each `b` arriving from a slot is a fresh contribution
        // (count: 1). Fold accumulates sum + total count, exposes
        // average via x/y.
        const cb = b.count ?? 1;
        const cTot = ca + cb;
        if (cTot === 0) return { x: 0, y: 0, count: 0 };
        const xTot = a.x * ca + b.x * cb;
        const yTot = a.y * ca + b.y * cb;
        return { x: xTot / cTot, y: yTot / cTot, count: cTot };
      },
    };
    const root = vec(0, 0) as unknown as Signal<V & { count?: number }>;
    const merged = root.merge(midpointPolicy);
    const a = merged as unknown as Vec;
    // Build two field lenses that each rewrite the whole vec to a
    // chosen target. Then a fan-in that splits the target between
    // them. Each lens contributes a different vec; midpoint merges.
    const lensA = Signal.install(
      Vec as unknown as new (...args: never[]) => Signal<V>,
      () => merged.value,
      (v: V) => {
        a.value = v;
      },
    ) as unknown as Vec;
    const lensB = Signal.install(
      Vec as unknown as new (...args: never[]) => Signal<V>,
      () => merged.value,
      (v: V) => {
        a.value = v;
      },
    ) as unknown as Vec;
    const fan = Signal.install(
      Vec as unknown as new (...args: never[]) => Signal<V>,
      () => merged.value,
      (_t: V) => {
        lensA.value = { x: 10, y: 0 };
        lensB.value = { x: 0, y: 20 };
      },
    ) as unknown as Vec;
    fan.value = { x: 0, y: 0 };
    // Two slots arrive: (10, 0) and (0, 20). Midpoint = (5, 10).
    expect(root.value.x).toBeCloseTo(5);
    expect(root.value.y).toBeCloseTo(10);
  });
});

describe("merge composed with field lenses", () => {
  it("merge above, field lenses below: field writes go to merge slots distinctly", () => {
    type S = { hp: number; mana: number };
    const root = num<S>({ hp: 100, mana: 50 }) as unknown as Signal<S>;
    const merged = root.merge(spreadPolicy<S>({ hp: 100, mana: 50 }));
    const hp = field(merged as unknown as Signal<S>, "hp", Num);
    const mana = field(merged as unknown as Signal<S>, "mana", Num);
    const fan = Signal.install(
      Num as unknown as new (...args: never[]) => Signal<number>,
      () => hp.value + mana.value,
      (_t: number) => {
        hp.value = 75;
        mana.value = 30;
      },
    ) as unknown as Num;
    fan.value = 105;
    expect(root.value).toEqual({ hp: 75, mana: 30 });
    // Both field lenses are distinct slots on the merge.
    expect(peekMergeSlots(merged)!.size).toBe(2);
  });
});

describe("merge that survives forward identity-view caching", () => {
  it("after a write, reading merge.value re-derives via parent.value", () => {
    const root = num(0);
    const merged = root.merge({ identity: 0, combine: (_a, b) => b });
    // Initial read sets cachedValue.
    expect(merged.value).toBe(0);
    root.value = 42;
    // Even though merged is a lens (caches), the parent read in
    // its getter detects the change and re-derives.
    expect(merged.value).toBe(42);
  });
});

describe("merge in a chain whose final value is the receiver class shape", () => {
  it("a merge on a Vec inside a longer chain still returns Vec subclass instances", () => {
    const v = vec(0, 0);
    const m = v.merge(spreadPolicy<V>({ x: 0, y: 0 }));
    const moved = m.offset(5, 10);
    expect(moved).toBeInstanceOf(Vec);
  });
});
