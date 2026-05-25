// vec-ops.test.ts — bidirectional Vec combinators.

import { describe, expect, it } from "vitest";
import { num, vec } from "../../signals";
import {
  keepDistance,
  onLine,
  propagators,
  vAdd,
  vBetween,
  vCentroid,
  vMidpoint,
  vOnCircle,
  vReflect,
  vSub,
} from "..";

describe("vAdd / vSub", () => {
  it("a + b = c, drag any one, others derive", () => {
    const a = vec(1, 2);
    const b = vec(3, 4);
    const c = vec(0, 0);
    const p = propagators();
    p.add(vAdd(a, b, c));
    expect(c.value).toEqual({ x: 4, y: 6 });

    a.value = { x: 10, y: 20 };
    expect(c.value).toEqual({ x: 13, y: 24 });

    c.value = { x: 100, y: 200 };
    // a fixed (was just touched); b derives = c - a = 90, 180.
    expect(b.value).toEqual({ x: 90, y: 180 });
    p.dispose();
  });

  it("vSub: a - b = c, bidirectional", () => {
    const a = vec(10, 20);
    const b = vec(3, 4);
    const c = vec(0, 0);
    const p = propagators();
    p.add(vSub(a, b, c));
    expect(c.value).toEqual({ x: 7, y: 16 });

    c.value = { x: 1, y: 2 };
    // b derives: b = a - c = 9, 18.
    expect(b.value).toEqual({ x: 9, y: 18 });
    p.dispose();
  });
});

describe("vMidpoint", () => {
  it("m = (a + b)/2", () => {
    const a = vec(0, 0);
    const b = vec(10, 20);
    const m = vec(0, 0);
    const p = propagators();
    p.add(vMidpoint(a, b, m));
    expect(m.value).toEqual({ x: 5, y: 10 });

    a.value = { x: 100, y: 200 };
    expect(m.value).toEqual({ x: 55, y: 110 });
    p.dispose();
  });

  it("drag midpoint translates both endpoints", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const m = vec(0, 0);
    const p = propagators();
    p.add(vMidpoint(a, b, m));
    // m starts at (5, 0).
    expect(m.value).toEqual({ x: 5, y: 0 });

    // Drag m by (10, 5).
    m.value = { x: 15, y: 5 };
    // Both a and b translated by (10, 5).
    expect(a.value).toEqual({ x: 10, y: 5 });
    expect(b.value).toEqual({ x: 20, y: 5 });
    p.dispose();
  });
});

describe("vCentroid", () => {
  it("centroid of a triangle", () => {
    const a = vec(0, 0);
    const b = vec(3, 0);
    const c = vec(0, 3);
    const cent = vec(0, 0);
    const p = propagators();
    p.add(vCentroid(cent, a, b, c));
    expect(cent.value).toEqual({ x: 1, y: 1 });

    // Drag a vertex.
    a.value = { x: 6, y: 0 };
    expect(cent.value).toEqual({ x: 3, y: 1 });
    p.dispose();
  });

  it("drag centroid translates all vertices", () => {
    const a = vec(0, 0);
    const b = vec(2, 0);
    const c = vec(0, 2);
    const cent = vec(0, 0);
    const p = propagators();
    p.add(vCentroid(cent, a, b, c));
    // Centroid initially at (2/3, 2/3).
    expect(cent.value.x).toBeCloseTo(2 / 3, 10);

    // Drag centroid by (1, 1).
    cent.value = { x: 2 / 3 + 1, y: 2 / 3 + 1 };
    expect(a.value.x).toBeCloseTo(1, 9);
    expect(a.value.y).toBeCloseTo(1, 9);
    expect(b.value.x).toBeCloseTo(3, 9);
    expect(b.value.y).toBeCloseTo(1, 9);
    expect(c.value.x).toBeCloseTo(1, 9);
    expect(c.value.y).toBeCloseTo(3, 9);
    p.dispose();
  });
});

describe("vBetween", () => {
  it("p = a + t(b-a), drag t to traverse", () => {
    const a = vec(0, 0);
    const b = vec(100, 0);
    const t = num(0);
    const p = vec(0, 0);
    const props = propagators();
    props.add(vBetween(a, b, t, p));

    expect(p.value).toEqual({ x: 0, y: 0 });
    t.value = 0.5;
    expect(p.value).toEqual({ x: 50, y: 0 });
    t.value = 1;
    expect(p.value).toEqual({ x: 100, y: 0 });
    props.dispose();
  });

  it("default mode: drag p, t projects onto segment", () => {
    const a = vec(0, 0);
    const b = vec(100, 0);
    const t = num(0);
    const p = vec(0, 0);
    const props = propagators();
    props.add(vBetween(a, b, t, p));

    // Drag p mid-segment.
    p.value = { x: 30, y: 5 };
    // Projection onto (0,0)-(100,0): t = 30/100 = 0.3.
    expect(t.value).toBeCloseTo(0.3, 6);
    props.dispose();
  });
});

describe("keepDistance", () => {
  it("rigid bond: drag a, b stays at distance d", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const p = propagators();
    p.add(keepDistance(a, b, 10));

    a.value = { x: 0, y: 0 }; // unchanged in distance
    expect(b.value).toEqual({ x: 10, y: 0 });

    // Drag a away.
    a.value = { x: 5, y: 5 };
    // b moves along (b-a) direction to maintain distance 10.
    const dx = b.value.x - 5;
    const dy = b.value.y - 5;
    expect(Math.hypot(dx, dy)).toBeCloseTo(10, 6);
    p.dispose();
  });

  it("reactive distance signal", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const d = num(10);
    const p = propagators();
    p.add(keepDistance(a, b, d));

    d.value = 20;
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(20, 5);

    d.value = 5;
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(5, 5);
    p.dispose();
  });
});

describe("onLine", () => {
  it("p sticks to line through a and b", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const p = vec(5, 5);
    const props = propagators();
    props.add(onLine(p, a, b));
    // Should snap p to (5, 0).
    expect(p.value).toEqual({ x: 5, y: 0 });

    p.value = { x: 8, y: 3 };
    expect(p.value).toEqual({ x: 8, y: 0 });
    props.dispose();
  });
});

describe("vOnCircle", () => {
  it("p sticks to circle around c with radius r", () => {
    const c = vec(0, 0);
    const r = 10;
    const p = vec(20, 0);
    const props = propagators();
    props.add(vOnCircle(p, c, r));
    expect(p.value).toEqual({ x: 10, y: 0 });

    // Drag p off the circle; snap to nearest point.
    p.value = { x: 0, y: 30 };
    expect(p.value.x).toBeCloseTo(0, 6);
    expect(p.value.y).toBeCloseTo(10, 6);
    props.dispose();
  });
});

describe("vReflect", () => {
  it("dst = src reflected across line a-b", () => {
    const src = vec(2, 5);
    const a = vec(0, 0);
    const b = vec(10, 0);
    const dst = vec(0, 0);
    const p = propagators();
    p.add(vReflect(src, a, b, dst));
    // Reflecting (2, 5) across x-axis = (2, -5).
    expect(dst.value).toEqual({ x: 2, y: -5 });

    // Drag src.
    src.value = { x: 7, y: -3 };
    expect(dst.value).toEqual({ x: 7, y: 3 });
    p.dispose();
  });
});
