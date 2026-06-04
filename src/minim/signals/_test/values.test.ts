// values.test.ts — Num/Vec runtime + Writable<R> behaviour.

import { describe, expect, it } from "vitest";
import { effect, isComputed, isLens, Num, num, polar, tangentPoint, Vec, vec } from "../index";

describe("Num", () => {
  it("num(v) writable, .value setter works", () => {
    const n = num(5);
    expect(n).toBeInstanceOf(Num);
    expect(n.value).toBe(5);
    n.value = 10;
    expect(n.value).toBe(10);
  });

  it("Num.derive returns RO", () => {
    const n = num(3);
    const sq = Num.derive(() => n.value * n.value);
    expect(isComputed(sq)).toBe(true);
    expect(sq.value).toBe(9);
    n.value = 4;
    expect(sq.value).toBe(16);
  });

  it("Cls.derive(parent, fwd) — cross-type RO lens", () => {
    const v = vec(3, 4);
    const m = Num.derive(v, p => Math.hypot(p.x, p.y));
    expect(m).toBeInstanceOf(Num);
    expect(isComputed(m)).toBe(true);
    expect(m.value).toBe(5);
    v.value = { x: 5, y: 12 };
    expect(m.value).toBe(13);
    expect(() => {
      (m as unknown as { value: number }).value = 0;
    }).toThrow();
  });

  it("Cls.lens(parent, fwd, bwd) — cross-type RW lens, write propagates", () => {
    const v = vec(1, 2);
    const sum = Num.lens(
      v,
      p => p.x + p.y,
      (s, p) => {
        const cur = p.x + p.y;
        if (cur === 0) return { x: s / 2, y: s / 2 };
        const k = s / cur;
        return { x: p.x * k, y: p.y * k };
      },
    );
    expect(isLens(sum)).toBe(true);
    expect(sum.value).toBe(3);
    // sum is a bare Num at the type level (RO interface merge). Cast to
    // write — at runtime the lens IS writable because we supplied bwd.
    (sum as unknown as { value: number }).value = 30;
    expect(v.value).toEqual({ x: 10, y: 20 });
  });

  it("Num.lens returns writable", () => {
    const n = num(0);
    const doubled = Num.lens(
      [n] as const,
      ([nv]) => nv * 2,
      v => [v / 2],
    );
    expect(isLens(doubled)).toBe(true);
    doubled.value = 10;
    expect(n.value).toBe(5);
  });

  it("invertible methods produce write-through lenses", () => {
    const n = num(3);
    const plus = n.add(2);
    expect(plus.value).toBe(5);
    expect(isLens(plus)).toBe(true);
    plus.value = 10;
    expect(n.value).toBe(8);
  });

  it("affine: forward and inverse", () => {
    const t = num(0.5);
    const x = t.affine(200, 30); // x ↦ 0.5 · 200 + 30 = 130
    expect(x.value).toBe(130);
    x.value = 230; // (230 − 30) / 200 = 1
    expect(t.value).toBe(1);
  });

  it("clamp lens: lossy on writes outside range", () => {
    const n = num(0.5);
    const c = n.clamp(0, 1);
    c.value = 1.5;
    expect(n.value).toBe(1); // clamped
    c.value = -0.3;
    expect(n.value).toBe(0);
    c.value = 0.7;
    expect(n.value).toBe(0.7);
  });

  it("clamp lens: reads also clamp", () => {
    const n = num(5);
    const c = n.clamp(0, 1);
    expect(c.value).toBe(1); // 5 clamped to 1 on read
  });

  it("quantize lens: snaps writes to nearest step", () => {
    const n = num(0);
    const q = n.quantize(0.25);
    q.value = 0.6;
    expect(n.value).toBe(0.5);
    q.value = 0.62;
    expect(n.value).toBe(0.5);
    q.value = 0.88;
    expect(n.value).toBe(1);
  });

  it("cyclic lens: shortest-arc on write", () => {
    const a = num(10 * Math.PI); // 5 revolutions
    const c = a.cyclic(2 * Math.PI);
    // Read passes through.
    expect(c.value).toBe(10 * Math.PI);
    // Write atan2-style: small drag from current effective angle.
    // current effective = 10π mod 2π = 0. Write 0.1 → small forward.
    c.value = 0.1;
    expect(Math.abs(a.value - (10 * Math.PI + 0.1))).toBeLessThan(0.5);
    // Reset; write the angle on the "other side of zero" — should pick
    // -0.1 (the nearest representative), not (10π + ~6.18).
    a.value = 10 * Math.PI;
    c.value = -0.1;
    expect(Math.abs(a.value - (10 * Math.PI - 0.1))).toBeLessThan(0.5);
  });
});

describe("Vec", () => {
  it("vec writable, fields cached, lens write propagates", () => {
    const v = vec(1, 2);
    expect(v.x).toBe(v.x);
    v.x.value = 99;
    expect(v.value).toEqual({ x: 99, y: 2 });
  });

  it("normalize is non-invertible", () => {
    const v = vec(3, 4);
    const n = v.normalize();
    expect(isComputed(n)).toBe(true);
    expect(n.value.x).toBeCloseTo(0.6);
  });

  it("invertible chain writes through", () => {
    const v = vec(0, 0);
    const chain = v.add({ x: 1, y: 1 }).scale(2);
    chain.value = { x: 10, y: 10 };
    expect(v.value).toEqual({ x: 4, y: 4 });
  });

  it("magnitude lazy memoised", () => {
    const v = vec(3, 4);
    expect(v.magnitude).toBe(v.magnitude);
    expect(v.magnitude.value).toBe(5);
  });

  it("effect tracking across derive", () => {
    const v = vec(1, 2);
    const sum = Num.derive(() => v.value.x + v.value.y);
    let seen = 0;
    effect(() => {
      seen = sum.value;
    });
    expect(seen).toBe(3);
    v.x.value = 10;
    expect(seen).toBe(12);
  });
});

describe("vec(num, num) — bidirectional Vec from two writable Nums", () => {
  it("write to composite propagates to both source Nums", () => {
    const x = num(0),
      y = num(0);
    const v = vec(x, y);
    v.value = { x: 10, y: 20 };
    expect(x.value).toBe(10);
    expect(y.value).toBe(20);
  });

  it("write to .x field-lens propagates to source x only", () => {
    const x = num(0),
      y = num(0);
    const v = vec(x, y);
    v.x.value = 7;
    expect(x.value).toBe(7);
    expect(y.value).toBe(0);
  });

  it("source write is visible in composite", () => {
    const x = num(0),
      y = num(0);
    const v = vec(x, y);
    x.value = 5;
    expect(v.value).toEqual({ x: 5, y: 0 });
  });
});

describe("vec() — lift literals, identity-passthrough writable Nums", () => {
  it("vec(literal, literal) seeds two fresh writable axes", () => {
    const v = vec(1, 2);
    v.value = { x: 5, y: 7 };
    expect(v.value).toEqual({ x: 5, y: 7 });
  });

  it("vec(num, literal) — literal lifts to a fresh seed, writes propagate to source num", () => {
    const x = num(3);
    const v = vec(x, 5);
    expect(v.value).toEqual({ x: 3, y: 5 });
    x.value = 10;
    expect(v.value.x).toBe(10);
    // Writing the composite updates the source x and the fresh y seed.
    v.value = { x: 20, y: 50 };
    expect(x.value).toBe(20);
    expect(v.value.y).toBe(50);
  });

  it("vec(num, Num.pin(c)) — y is structurally locked at c", () => {
    const x = num(0);
    const v = vec(x, Num.pin(100));
    v.value = { x: 5, y: 999 };
    expect(x.value).toBe(5);
    // pin absorbs the y write: read still returns the constant.
    expect(v.value.y).toBe(100);
  });
});

describe("Cls.pin — constant-projection lens", () => {
  it("Num.pin reads return the constant, writes are absorbed", () => {
    const p = Num.pin(42);
    expect(p.value).toBe(42);
    p.value = 7;
    expect(p.value).toBe(42);
  });

  it("Vec.pin works for compound value classes", () => {
    const p = Vec.pin({ x: 1, y: 2 });
    expect(p.value).toEqual({ x: 1, y: 2 });
    p.value = { x: 99, y: 99 };
    expect(p.value).toEqual({ x: 1, y: 2 });
  });
});

describe("polar(c, r, a) — bidirectional with policies", () => {
  it("forward read = c + r·(cos a, sin a)", () => {
    const c = vec(100, 100);
    const r = num(50);
    const a = num(0);
    const p = polar(c, r, a);
    expect(p.value).toEqual({ x: 150, y: 100 });
    a.value = Math.PI / 2;
    expect(p.value.x).toBeCloseTo(100);
    expect(p.value.y).toBeCloseTo(150);
  });

  it("rotate (default): write to point updates r and a; c untouched", () => {
    const c = vec(0, 0);
    const r = num(10);
    const a = num(0);
    const p = polar(c, r, a);
    p.value = { x: 0, y: 5 };
    expect(c.value).toEqual({ x: 0, y: 0 });
    expect(r.value).toBeCloseTo(5);
    expect(a.value).toBeCloseTo(Math.PI / 2);
  });

  it("translate: write shifts c; r and a unchanged", () => {
    const c = vec(0, 0);
    const r = num(10);
    const a = num(0);
    const p = polar(c, r, a, "translate");
    p.value = { x: 100, y: 50 };
    expect(c.value).toEqual({ x: 90, y: 50 });
    expect(r.value).toBe(10);
    expect(a.value).toBe(0);
  });

  it("radial: slides along the ray; only r changes", () => {
    const c = vec(0, 0);
    const r = num(10);
    const a = num(0);
    const p = polar(c, r, a, "radial");
    p.value = { x: 5, y: 5 };
    expect(r.value).toBeCloseTo(5);
    expect(a.value).toBe(0);
  });

  it("circular: slides around; only a changes", () => {
    const c = vec(0, 0);
    const r = num(10);
    const a = num(0);
    const p = polar(c, r, a, "circular");
    p.value = { x: 0, y: 100 };
    expect(a.value).toBeCloseTo(Math.PI / 2);
    expect(r.value).toBe(10);
  });

  it("nested polar — drag moon, moon's (r, a) update; planet/sun untouched", () => {
    const sun = vec(0, 0);
    const er = num(100),
      ea = num(0);
    const earth = polar(sun, er, ea);
    const mr = num(10),
      ma = num(0);
    const moon = polar(earth, mr, ma);
    moon.value = { x: 100, y: 5 };
    expect(mr.value).toBeCloseTo(5);
    expect(ma.value).toBeCloseTo(Math.PI / 2);
    expect(er.value).toBe(100);
    expect(ea.value).toBe(0);
    expect(sun.value).toEqual({ x: 0, y: 0 });
  });

  it("literal r/a are lifted to fresh seeds; rotate writes land on the seeds, not c", () => {
    // Under the new strict factory rule, literal `r` and `a` lift to
    // fresh `Writable<Num>` seeds inside polar. The rotate policy
    // writes those seeds; `c` (also literal-lifted, but rotate
    // doesn't touch center) stays put.
    const c = vec(0, 0);
    const p = polar(c, 10, 0); // r and a lifted to fresh seeds
    p.value = { x: 0, y: 5 };
    // rotate writes r and a (the lifted seeds, observable via re-read):
    expect(p.value.x).toBeCloseTo(0);
    expect(p.value.y).toBeCloseTo(5);
    // c is untouched by rotate.
    expect(c.value).toEqual({ x: 0, y: 0 });
  });

  it("Num.pin(c) locks an axis against polar's writes", () => {
    // Use pin to express "this input is structurally constant" — writes
    // through polar's bwd get projected back to the constant.
    const c = vec(0, 0);
    const r = Num.pin(10);
    const a = num(0);
    const p = polar(c, r, a); // rotate writes r and a; r absorbs.
    p.value = { x: 0, y: 5 };
    expect(r.value).toBe(10); // pin absorbed the write
    expect(a.value).toBeCloseTo(Math.PI / 2);
  });

  it("circular: shortest-arc inverse — no jumps across revolutions", () => {
    // Critical for chained inverses (e.g. solar system where angle =
    // time.scale(2π/period)): a small visual drag must produce a
    // small angle change, regardless of how many full revolutions
    // the angle has accumulated.
    const c = vec(0, 0);
    const r = num(10);
    const a = num(10 * Math.PI); // 5 full revolutions
    const p = polar(c, r, a, "circular");
    // Forward: angle 10π = effectively 0 → point at (10, 0).
    expect(p.value.x).toBeCloseTo(10);
    expect(p.value.y).toBeCloseTo(0);
    // Drag the point slightly above: tiny CCW move from angle ≈ 0.
    // atan2 would return ~+0.1; nearest-angle keeps us close to 10π.
    p.value = { x: 10, y: 1 };
    const da = a.value - 10 * Math.PI;
    expect(Math.abs(da)).toBeLessThan(0.5); // small delta, not a jump
    // And forward still tracks.
    expect(p.value.y).toBeCloseTo(1, 0);
  });

  it("rotate: shortest-arc inverse — same shortest-arc semantics", () => {
    const c = vec(0, 0);
    const r = num(10);
    const a = num(20 * Math.PI); // 10 full revolutions
    const p = polar(c, r, a);
    p.value = { x: 10, y: 1 };
    const da = a.value - 20 * Math.PI;
    expect(Math.abs(da)).toBeLessThan(0.5);
  });
});

describe("tangentPoint(p, c, r, side)", () => {
  it("point directly below pulley → tangent at the bottom of the wheel", () => {
    // Box at (0, 100), pulley at (0, 0) with r=10. For a vertical
    // rope, the tangent is at the bottom of the wheel.
    const t = tangentPoint({ x: 0, y: 100 }, { x: 0, y: 0 }, 10);
    // side -1 → tangent on the side CCW from box-to-pulley (right side
    // for y-down screen coords).
    expect(t.y).toBeCloseTo(1); // near r·sin(small angle)
    expect(t.x).toBeGreaterThan(0); // right side of wheel
  });

  it("very-far point → tangent at the side of the wheel", () => {
    // Box at (0, 1000), pulley at (0, 0). At infinity, tangent
    // approaches the perpendicular side of the wheel.
    const t = tangentPoint({ x: 0, y: 1000 }, { x: 0, y: 0 }, 10, -1);
    expect(t.x).toBeCloseTo(10, 1); // right side of wheel
    expect(t.y).toBeCloseTo(0, 0); // within 0.5 (≈ r²/d)
  });

  it("box inside circle returns the centre (degenerate)", () => {
    const t = tangentPoint({ x: 0, y: 1 }, { x: 0, y: 0 }, 10);
    expect(t).toEqual({ x: 0, y: 0 });
  });

  it("opposite side flag picks the other tangent", () => {
    const tLeft = tangentPoint({ x: 0, y: 100 }, { x: 0, y: 0 }, 10, +1);
    const tRight = tangentPoint({ x: 0, y: 100 }, { x: 0, y: 0 }, 10, -1);
    expect(Math.sign(tLeft.x)).toBe(-Math.sign(tRight.x));
  });
});

describe("up/down/left/right are invertible (chain stays writable)", () => {
  it("v.up(n).down(m) writes back through to v", () => {
    const v = vec(0, 0);
    const moved = v.up(10).right(5);
    moved.value = { x: 25, y: 30 };
    // right(5) bwd: x -= 5 → x = 20
    // up(10)   bwd: y += 10 → y = 40
    expect(v.value).toEqual({ x: 20, y: 40 });
  });

  it("vec(num, num) followed by up chain — writes propagate to source nums", () => {
    const x = num(0),
      y = num(0);
    const v = vec(x, y);
    const moved = v.right(10);
    moved.value = { x: 15, y: 3 };
    expect(x.value).toBe(5);
    expect(y.value).toBe(3);
  });
});
