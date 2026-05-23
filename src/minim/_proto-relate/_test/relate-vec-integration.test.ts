// relate-vec-integration.test.ts — relations work over the Vec value
// class's two construction patterns:
//
//   Pattern 1 (axes): `vec(numX, numY)` returns a *bidirectional lens*
//     onto two source Nums. Writing `v.value = {x, y}` propagates back
//     to the Nums (engine-level pin fires for the Nums). Cluster cells
//     are the Nums themselves.
//
//   Pattern 2 (source): `new Vec({x, y})` returns a Vec *source*.
//     `.x` and `.y` are field-lens views onto it. Writing
//     `v.x.value = ...` triggers the field-lens setter, which writes
//     `v.value = {...prev, x: ...}` — that's a write to the Vec
//     source, NOT to v.x directly. The pin hook fires for v, not v.x.
//
// For pattern 1 there's no integration issue — pin hook lands on the
// source Nums which ARE in the cluster. For pattern 2, the cluster
// must somehow learn that v's pin implies v.x and v.y are pinned.
// This file tests both patterns; pattern 2's working/limitations
// should be visible from the test outcomes.

import { describe, expect, it } from "vitest";
import { dist, point } from "../constraints";
import { num, vec } from "../index";

describe("Pattern 1: vec(numX, numY) — axes binding to source Nums", () => {
  it("dragging the Vec writes to source Nums; cluster sees it", () => {
    // Source Nums; v is a bidirectional lens.
    const ax = num(0);
    const ay = num(0);
    const bx = num(5);
    const by = num(0);
    const A = vec(ax, ay);
    const B = vec(bx, by);

    // Constraint over the source Nums (decompose at constraint
    // construction).
    dist(point(ax, ay), point(bx, by), 5);

    // Write through the Vec composite — this writes to ax, ay.
    A.value = { x: -3, y: 0 };
    expect(ax.value).toBe(-3);
    expect(ay.value).toBe(0);
    // Constraint enforced: |A-B| = 5.
    expect(Math.hypot(ax.value - bx.value, ay.value - by.value)).toBeCloseTo(5, 4);
  });

  it("writes to a single axis (numX directly) propagate to the Vec composite", () => {
    const ax = num(0);
    const ay = num(0);
    const bx = num(5);
    const by = num(0);
    const A = vec(ax, ay);
    void A;
    dist(point(ax, ay), point(bx, by), 5);
    ax.value = -3;
    // |A-B| = 5 maintained
    expect(Math.hypot(ax.value - bx.value, ay.value - by.value)).toBeCloseTo(5, 4);
    // A's composite value reflects the post-solve state.
    expect(A.value.x).toBe(-3);
  });
});

describe("Pattern 2: new Vec(...) — Vec source, .x/.y are field lenses", () => {
  it("writing v.value reflows other cluster cells (parent-tracked)", () => {
    // The relation runtime registers `v` as a parent of `v.x` and
    // `v.y` via `point(v)` overload. Writing `v.value = {...}` fires
    // pinHook for v, runtime maps to v.x/v.y, marks them as pinned,
    // solver runs.
    const A = vec(0, 0); // Vec source, axes default-bound to literals
    const B = vec(5, 0);
    dist(point(A), point(B), 5);
    // |AB| = 5 initially. Write A — B should reflow.
    A.value = { x: -3, y: 0 };
    expect(A.value.x).toBe(-3);
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(5, 4);
  });

  it("writing v.x.value (field lens write) reflows the rest", () => {
    // Same as above but via field lens. The setter on A.x writes
    // A.value = {...A.peek(), x: new}, which fires pinHook for A.
    const A = vec(0, 0);
    const B = vec(5, 0);
    dist(point(A), point(B), 5);
    A.x.value = -3;
    expect(A.value.x).toBe(-3);
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(5, 4);
  });
});

describe("Native Vec integration — point() Vec overload", () => {
  it("equilateral triangle from three Vec sources", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(0.5, Math.sqrt(3) / 2);
    dist(point(A), point(B), 1);
    dist(point(B), point(C), 1);
    dist(point(C), point(A), 1);

    // Drag A as a Vec — both axes pin in one batch via the
    // composite write.
    A.value = { x: 5, y: 0 };
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(1, 3);
    expect(Math.hypot(B.value.x - C.value.x, B.value.y - C.value.y)).toBeCloseTo(1, 3);
    expect(Math.hypot(C.value.x - A.value.x, C.value.y - A.value.y)).toBeCloseTo(1, 3);
  });
});
