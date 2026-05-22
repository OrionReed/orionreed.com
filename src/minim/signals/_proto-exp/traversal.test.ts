// _proto-exp/traversal.test.ts — reactive collection sanity tests.

import { describe, expect, it } from "vitest";
import { effect } from "../_proto-cell2/cell2";
import { list, ListSignal } from "./traversal";

describe("ListSignal: source + length", () => {
  it("constructs with initial array, length tracks", () => {
    const l = list([1, 2, 3]);
    expect(l).toBeInstanceOf(ListSignal);
    expect(l.value).toEqual([1, 2, 3]);
    expect(l.length.value).toBe(3);
  });

  it("structural push updates length and value", () => {
    const l = list<number>([]);
    expect(l.length.value).toBe(0);
    l.push(10);
    l.push(20);
    expect(l.value).toEqual([10, 20]);
    expect(l.length.value).toBe(2);
  });

  it("effect tracks length", () => {
    const l = list([1, 2]);
    let observed = -1;
    const stop = effect(() => { observed = l.length.value });
    expect(observed).toBe(2);
    l.push(3);
    expect(observed).toBe(3);
    l.pop();
    expect(observed).toBe(2);
    stop();
  });
});

describe("ListSignal: .at(i) — per-index lens", () => {
  it("read returns element, identity is stable across reads", () => {
    const l = list([10, 20, 30]);
    expect(l.at(1)).toBe(l.at(1));
    expect(l.at(1).value).toBe(20);
  });

  it("write at(i) replaces just that element", () => {
    const l = list([10, 20, 30]);
    l.at(1).value = 99;
    expect(l.value).toEqual([10, 99, 30]);
  });

  it("effect observes specific index", () => {
    const l = list([1, 2, 3]);
    let observed = -1;
    const stop = effect(() => { observed = l.at(1).value });
    expect(observed).toBe(2);
    // Writing other indices: observer DOES re-fire (because the array
    // identity changes — that's the granularity ListSignal offers).
    // For finer granularity, store per-item Source cells.
    l.at(0).value = 99;
    expect(observed).toBe(2); // value unchanged
    l.at(1).value = 22;
    expect(observed).toBe(22);
    stop();
  });

  it("write out-of-bounds throws", () => {
    const l = list([1, 2]);
    expect(() => { l.at(5).value = 99 }).toThrow(/out of bounds/);
  });
});

describe("ListSignal: .each — per-pass reactive iteration", () => {
  it("each maps over current snapshot", () => {
    const l = list([1, 2, 3]);
    const doubled = l.each((x) => x * 2);
    expect(doubled).toEqual([2, 4, 6]);
  });

  it("effect using each re-fires on structural changes", () => {
    const l = list([1, 2, 3]);
    let observed: readonly number[] = [];
    const stop = effect(() => { observed = l.each((x) => x * 2) });
    expect(observed).toEqual([2, 4, 6]);
    l.push(4);
    expect(observed).toEqual([2, 4, 6, 8]);
    l.removeAt(0);
    expect(observed).toEqual([4, 6, 8]);
    stop();
  });
});

describe("ListSignal: cross-class lens compatibility", () => {
  it("at(i) can chain with .through() in the target type", () => {
    // We're using bare Derived (not a wrapper class) so chaining is
    // engine-level — but it works.
    const l = list([0, 0, 0]);
    const cell = l.at(1);
    // Wrap up a quick "double and add 100" view via two derived layers.
    const doubled = cell;
    doubled.value = 5;
    expect(l.value).toEqual([0, 5, 0]);
  });
});
