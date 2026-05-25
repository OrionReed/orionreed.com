// fanin.test.ts — N-input lens via `Cls.lens([...], ...)` and
// `Cls.derive([...], ...)`.

import { describe, expect, it } from "vitest";
import { effect, Num, num, Vec, vec } from "../index";

describe("N-input lens: read-only (Cls.derive([...], fn))", () => {
  it("sum of two nums", () => {
    const a = num(3);
    const b = num(4);
    const sum = Num.derive([a, b] as const, vals => vals[0] + vals[1]);
    expect(sum.value).toBe(7);
    a.value = 10;
    expect(sum.value).toBe(14);
    b.value = 5;
    expect(sum.value).toBe(15);
  });

  it("midpoint of two vecs (no bwd → RO)", () => {
    const a = vec(0, 0);
    const b = vec(100, 200);
    const mid = Vec.derive([a, b] as const, vals => ({
      x: (vals[0].x + vals[1].x) / 2,
      y: (vals[0].y + vals[1].y) / 2,
    }));
    expect(mid.value).toEqual({ x: 50, y: 100 });
    a.value = { x: 50, y: 50 };
    expect(mid.value).toEqual({ x: 75, y: 125 });
  });

  it("throws on write to RO", () => {
    const a = num(1);
    const b = num(2);
    const sum = Num.derive([a, b] as const, vals => vals[0] + vals[1]);
    expect(() => {
      (sum as unknown as { value: number }).value = 99;
    }).toThrow();
  });
});

describe("N-input lens: writable (Cls.lens([...], fwd, bwd))", () => {
  it("midpoint handle: writing target moves both endpoints by half-delta", () => {
    const a = vec(0, 0);
    const b = vec(100, 100);
    const mid = Vec.lens(
      [a, b] as const,
      vals => ({ x: (vals[0].x + vals[1].x) / 2, y: (vals[0].y + vals[1].y) / 2 }),
      (target, vals) => {
        const [av, bv] = vals;
        const cur = { x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 };
        const dx = target.x - cur.x;
        const dy = target.y - cur.y;
        return [
          { x: av.x + dx, y: av.y + dy },
          { x: bv.x + dx, y: bv.y + dy },
        ];
      },
    );
    expect(mid.value).toEqual({ x: 50, y: 50 });
    mid.value = { x: 100, y: 100 };
    expect(a.value).toEqual({ x: 50, y: 50 });
    expect(b.value).toEqual({ x: 150, y: 150 });
  });

  it("split a sum: write distributes equally", () => {
    const a = num(1);
    const b = num(2);
    const sum = Num.lens(
      [a, b] as const,
      vals => vals[0] + vals[1],
      (s, vals) => {
        const [x, y] = vals;
        const cur = x + y;
        const delta = s - cur;
        return [x + delta / 2, y + delta / 2];
      },
    );
    expect(sum.value).toBe(3);
    sum.value = 10;
    expect(a.value).toBe(4.5);
    expect(b.value).toBe(5.5);
  });

  it("partial bwd: skip some inputs (the 'pinned' one)", () => {
    const x = num(0);
    const y = num(0);
    const k = num(2);
    const r = Num.lens(
      [x, y, k] as const,
      vals => vals[0] + vals[2] * vals[1],
      (target, vals) => {
        const [xv, yv, kv] = vals;
        const cur = xv + kv * yv;
        const delta = target - cur;
        return [xv + delta / 2, yv + delta / (2 * kv), undefined];
      },
    );
    r.value = 10;
    expect(k.value).toBe(2);
    expect(x.value).toBeCloseTo(5, 9);
    expect(y.value).toBeCloseTo(2.5, 9);
    expect(r.value).toBeCloseTo(10, 9);
  });

  it("write fires downstream effect ONCE even though N parents update", () => {
    const a = num(0);
    const b = num(0);
    const sum = Num.lens(
      [a, b] as const,
      vals => vals[0] + vals[1],
      (s, vals) => {
        const [x, y] = vals;
        const cur = x + y;
        const delta = s - cur;
        return [x + delta / 2, y + delta / 2];
      },
    );
    let fires = 0;
    const stop = effect(() => {
      void sum.value;
      fires++;
    });
    fires = 0;
    sum.value = 100;
    expect(fires).toBe(1);
    expect(sum.value).toBe(100);
    stop();
  });

  it("stateless bwd (1-arg): engine skips parent peek", () => {
    // axes-style: write target.x and target.y directly to parents,
    // no need to read current values.
    const x = num(0);
    const y = num(0);
    const v = Vec.lens(
      [x, y] as const,
      (vals): { x: number; y: number } => ({ x: vals[0], y: vals[1] }),
      (target: { x: number; y: number }) => [target.x, target.y] as never,
    );
    v.value = { x: 10, y: 20 };
    expect(x.value).toBe(10);
    expect(y.value).toBe(20);
  });
});

describe("N-input lens: composes with regular lenses", () => {
  it("aggregate used as input to a chain", () => {
    const a = num(3);
    const b = num(4);
    const sum = Num.derive([a, b] as const, vals => vals[0] + vals[1]);
    const scaled = sum.scale(2);
    expect(scaled.value).toBe(14);
    expect(() => {
      (scaled as unknown as { value: number }).value = 99;
    }).toThrow();
  });

  it("aggregate's .x field-lens (when output is Vec)", () => {
    const a = vec(1, 2);
    const b = vec(3, 4);
    const mid = Vec.derive([a, b] as const, vals => ({
      x: (vals[0].x + vals[1].x) / 2,
      y: (vals[0].y + vals[1].y) / 2,
    }));
    const x = mid.x;
    expect(x.value).toBe(2);
  });
});

describe("N-input lens: relate-like bidirectional (single parent in array)", () => {
  it("Celsius ↔ Fahrenheit: edit either", () => {
    const c = num(0);
    const f = Num.lens(
      [c] as const,
      vals => (vals[0] * 9) / 5 + 32,
      (fv, _vals) => [((fv - 32) * 5) / 9],
    );
    expect(f.value).toBe(32);
    c.value = 100;
    expect(f.value).toBe(212);
    f.value = 0;
    expect(c.value).toBeCloseTo(-17.778, 3);
  });
});
