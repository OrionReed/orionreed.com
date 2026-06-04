// new-primitives.test.ts — primitives natural under N-input lenses.

import { describe, expect, it } from "vitest";
import { cell, num, vec } from "../index";
import {
  angleLens,
  bezier2,
  bezier3,
  clampedMean,
  diffLens,
  distanceLens,
  pulleySum,
  reflectionLens,
  vecLerp,
} from "../new-primitives";

describe("distanceLens", () => {
  it("computes Euclidean distance", () => {
    const a = vec(0, 0);
    const b = vec(3, 4);
    const d = distanceLens(a, b);
    expect(d.value).toBe(5);
    a.value = { x: 1, y: 1 };
    expect(d.value).toBeCloseTo(Math.hypot(2, 3));
  });
});

describe("angleLens", () => {
  it("computes atan2 between two points", () => {
    const a = vec(0, 0);
    const b = vec(1, 0);
    const ang = angleLens(a, b);
    expect(ang.value).toBe(0);
    b.value = { x: 0, y: 1 };
    expect(ang.value).toBeCloseTo(Math.PI / 2);
  });
});

describe("reflectionLens", () => {
  it("reflects a point across a horizontal axis", () => {
    const p = vec(2, 5);
    const a = vec(0, 0);
    const b = vec(10, 0); // horizontal x-axis
    const r = reflectionLens(p, a, b);
    expect(r.value).toEqual({ x: 2, y: -5 });
  });

  it("writes propagate back through the involution to `point`", () => {
    const p = vec(2, 5);
    const a = vec(0, 0);
    const b = vec(10, 0);
    const r = reflectionLens(p, a, b);
    expect(r.value).toEqual({ x: 2, y: -5 });
    // Drag the reflected point: write back through the (involutive)
    // bwd. Original point updates; axis untouched.
    r.value = { x: 7, y: -3 };
    expect(p.value).toEqual({ x: 7, y: 3 });
    expect(a.value).toEqual({ x: 0, y: 0 });
    expect(b.value).toEqual({ x: 10, y: 0 });
    // Forward read reflects again — should match what we wrote.
    expect(r.value).toEqual({ x: 7, y: -3 });
  });
});

describe("vecLerp", () => {
  it("read: linear interpolation between two vecs", () => {
    const a = vec(0, 0);
    const b = vec(10, 20);
    const t = cell(0.5);
    const m = vecLerp(a, b, t);
    expect(m.value).toEqual({ x: 5, y: 10 });
    t.value = 0.25;
    expect(m.value).toEqual({ x: 2.5, y: 5 });
  });

  it("write: drag the interpolated point shifts both endpoints", () => {
    const a = vec(0, 0);
    const b = vec(10, 20);
    const t = cell(0.5);
    const m = vecLerp(a, b, t);
    (m as unknown as { value: { x: number; y: number } }).value = { x: 100, y: 100 };
    // Both endpoints shifted by (95, 90).
    expect(a.value).toEqual({ x: 95, y: 90 });
    expect(b.value).toEqual({ x: 105, y: 110 });
    expect(t.value).toBe(0.5); // t unchanged
  });
});

describe("pulleySum", () => {
  it("sum of two nums with redistribution on write", () => {
    const a = num(3);
    const b = num(7);
    const s = pulleySum(a, b);
    expect(s.value).toBe(10);
    s.value = 20; // delta = +10, half each
    expect(a.value).toBe(8);
    expect(b.value).toBe(12);
    expect(s.value).toBe(20);
  });
});

describe("diffLens", () => {
  it("a - b with anti-symmetric writeback", () => {
    const a = num(10);
    const b = num(3);
    const d = diffLens(a, b);
    expect(d.value).toBe(7);
    d.value = 11; // delta = +4, a += 2, b -= 2
    expect(a.value).toBe(12);
    expect(b.value).toBe(1);
    expect(d.value).toBe(11);
  });
});

describe("clampedMean", () => {
  it("read clamps the mean", () => {
    const a = num(50);
    const b = num(50);
    const m = clampedMean([a, b], 0, 10);
    expect(m.value).toBe(10);
  });

  it("write clamps then distributes", () => {
    const a = num(0);
    const b = num(0);
    const m = clampedMean([a, b], 0, 10);
    m.value = 100; // clamped to 10 first
    expect(a.value).toBe(10);
    expect(b.value).toBe(10);
    m.value = -50;
    expect(a.value).toBe(0);
    expect(b.value).toBe(0);
  });
});

describe("bezier2 / bezier3", () => {
  it("quadratic at t=0.5 = midpoint of (p0p1, p1p2) midpoints", () => {
    const p0 = vec(0, 0);
    const p1 = vec(10, 10);
    const p2 = vec(20, 0);
    const t = cell(0.5);
    const b = bezier2(p0, p1, p2, t);
    expect(b.value).toEqual({ x: 10, y: 5 });
  });

  it("cubic endpoints at t=0 and t=1", () => {
    const p0 = vec(0, 0);
    const p1 = vec(1, 5);
    const p2 = vec(9, 5);
    const p3 = vec(10, 0);
    const t = cell(0);
    const b = bezier3(p0, p1, p2, p3, t);
    expect(b.value).toEqual({ x: 0, y: 0 });
    t.value = 1;
    expect(b.value).toEqual({ x: 10, y: 0 });
    t.value = 0.5;
    // Symmetric curve: b(0.5).y should be max
    expect(b.value.x).toBe(5);
    expect(b.value.y).toBeCloseTo(3.75);
  });
});
