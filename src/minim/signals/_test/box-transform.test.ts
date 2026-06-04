// box-transform.test.ts — confirm Box + Transform work with the pattern.

import { describe, expect, it } from "vitest";
import {
  Box,
  box,
  effect,
  isComputed,
  isLens,
  num,
  Transform,
  transform,
  Vec,
  vec,
} from "../index";

describe("Box", () => {
  it("box(x,y,w,h) writable, all 4 field lenses work", () => {
    const b = box(10, 20, 100, 50);
    expect(b).toBeInstanceOf(Box);
    expect(b.value).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    b.x.value = 5;
    b.w.value = 200;
    expect(b.value).toEqual({ x: 5, y: 20, w: 200, h: 50 });
  });

  it("invertible expand returns Lens", () => {
    const b = box(0, 0, 100, 50);
    const expanded = b.expand(10);
    expect(isLens(expanded)).toBe(true);
    expect(expanded.value).toEqual({ x: -10, y: -10, w: 120, h: 70 });
    expanded.value = { x: 0, y: 0, w: 100, h: 50 };
    expect(b.value).toEqual({ x: 10, y: 10, w: 80, h: 30 });
  });

  it("at(u,v) returns RO Vec", () => {
    const b = box(0, 0, 100, 50);
    const c = b.center;
    expect(c).toBeInstanceOf(Vec);
    expect(isComputed(c)).toBe(true);
    expect(c.value).toEqual({ x: 50, y: 25 });
  });

  it("memoised .center / .top / .left", () => {
    const b = box();
    expect(b.center).toBe(b.center);
    expect(b.top).toBe(b.top);
  });

  it("area is computed", () => {
    const b = box(0, 0, 4, 5);
    expect(b.area.value).toBe(20);
    b.w.value = 10;
    expect(b.area.value).toBe(50);
  });

  it("Box.derive / Box.lens / Box.is", () => {
    const b = box(0, 0, 10, 10);
    const half = Box.derive(() => ({ ...b.value, w: b.value.w / 2 }));
    expect(isComputed(half)).toBe(true);
    expect(half.value.w).toBe(5);

    const lens = Box.lens(
      [b] as const,
      ([v]) => v,
      v => [v],
    );
    expect(isLens(lens)).toBe(true);

    expect(Box.is(b)).toBe(true);
    expect(Box.is({} as unknown)).toBe(false);
  });
});

describe("Transform", () => {
  it("transform(init) wires bindings", () => {
    const tx = num(5);
    const tr = transform({ translate: { x: 0, y: 0 }, rotate: 0.5 });
    expect(tr).toBeInstanceOf(Transform);
    expect(tr.value.rotate).toBe(0.5);
    expect(tr.translate.value).toEqual({ x: 0, y: 0 });
    void tx;
  });

  it("nested Vec field lens (.translate.x writable)", () => {
    const tr = transform();
    tr.translate.x.value = 50;
    expect(tr.value.translate).toEqual({ x: 50, y: 0 });
  });

  it("Num field lens (.rotate writable)", () => {
    const tr = transform({ rotate: 0 });
    tr.rotate.value = Math.PI;
    expect(tr.value.rotate).toBeCloseTo(Math.PI);
  });

  it("Transform.scale is the Vec axis lens (not invertible method)", () => {
    const tr = transform({ scale: { x: 1, y: 1 } });
    expect(tr.scale).toBeInstanceOf(Vec);
    tr.scale.value = { x: 2, y: 2 };
    expect(tr.value.scale).toEqual({ x: 2, y: 2 });
  });

  it("invertible add returns writable Lens", () => {
    const tr = transform();
    const moved = tr.add({
      translate: { x: 1, y: 1 },
      scale: { x: 0, y: 0 },
      origin: { x: 0, y: 0 },
      rotate: 0,
      opacity: 0,
    });
    expect(isLens(moved)).toBe(true);
    moved.value = {
      translate: { x: 5, y: 5 },
      scale: { x: 1, y: 1 },
      origin: { x: 0, y: 0 },
      rotate: 0,
      opacity: 1,
    };
    expect(tr.value.translate).toEqual({ x: 4, y: 4 });
  });

  it("effect across deep field access", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    const xs: number[] = [];
    effect(() => {
      xs.push(tr.translate.x.value);
    });
    tr.translate.x.value = 10;
    tr.translate.x.value = 20;
    expect(xs).toEqual([0, 10, 20]);
  });
});

describe("Sanity — Num/Vec from earlier still work", () => {
  it("vec field lens", () => {
    const v = vec(1, 2);
    v.x.value = 9;
    expect(v.value).toEqual({ x: 9, y: 2 });
  });
});
