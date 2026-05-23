// fanin.test.ts — multi-input lens primitive.

import { describe, expect, it } from "vitest";
import { effect, fanin, num, Num, vec, Vec } from "../index";

describe("fanin: read-only (no bwd)", () => {
  it("sum of two nums", () => {
    const a = num(3);
    const b = num(4);
    const sum = fanin(Num, [a, b], (x, y) => x + y);
    expect(sum.value).toBe(7);
    a.value = 10;
    expect(sum.value).toBe(14);
    b.value = 5;
    expect(sum.value).toBe(15);
  });

  it("midpoint of two vecs (no bwd → RO)", () => {
    const a = vec(0, 0);
    const b = vec(100, 200);
    const mid = fanin(Vec, [a, b], (av, bv) => ({
      x: (av.x + bv.x) / 2,
      y: (av.y + bv.y) / 2,
    }));
    expect(mid.value).toEqual({ x: 50, y: 100 });
    a.value = { x: 50, y: 50 };
    expect(mid.value).toEqual({ x: 75, y: 125 });
  });

  it("fanin: throws on write to RO", () => {
    const a = num(1);
    const b = num(2);
    const sum = fanin(Num, [a, b], (x, y) => x + y);
    expect(() => {
      (sum as unknown as { value: number }).value = 99;
    }).toThrow();
  });
});

describe("fanin: writable with bwd", () => {
  it("midpoint handle: writing target moves both endpoints by half-delta", () => {
    const a = vec(0, 0);
    const b = vec(100, 100);
    const mid = fanin(
      Vec,
      [a, b] as const,
      (av, bv) => ({ x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 }),
      (target, av, bv) => {
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
    (mid as unknown as { value: { x: number; y: number } }).value = { x: 100, y: 100 };
    expect(a.value).toEqual({ x: 50, y: 50 });
    expect(b.value).toEqual({ x: 150, y: 150 });
  });

  it("split a sum: write distributes equally", () => {
    const a = num(1);
    const b = num(2);
    const sum = fanin(
      Num,
      [a, b] as const,
      (x, y) => x + y,
      (s, x, y) => {
        const cur = x + y;
        const delta = s - cur;
        return [x + delta / 2, y + delta / 2];
      },
    );
    expect(sum.value).toBe(3);
    (sum as unknown as { value: number }).value = 10; // delta = +7, half to each
    expect(a.value).toBe(4.5);
    expect(b.value).toBe(5.5);
  });

  it("partial bwd: skip some inputs (e.g., the 'pinned' one)", () => {
    const x = num(0);
    const y = num(0);
    const k = num(2);
    // Result = x + k*y. Writing back: split between x and y, leave k alone.
    const r = fanin(
      Num,
      [x, y, k] as const,
      (xv, yv, kv) => xv + kv * yv,
      (target, xv, yv, kv) => {
        const cur = xv + kv * yv;
        const delta = target - cur;
        // Apply half delta to x, kv * (delta/2) / kv = delta/(2kv) to y.
        return [xv + delta / 2, yv + delta / (2 * kv), undefined];
        // k is `undefined` → not written.
      },
    );
    (r as unknown as { value: number }).value = 10;
    expect(k.value).toBe(2); // untouched
    expect(x.value).toBeCloseTo(5, 9);
    expect(y.value).toBeCloseTo(2.5, 9);
    expect(r.value).toBeCloseTo(10, 9);
  });

  it("write fires downstream effect ONCE even though N parents update", () => {
    const a = num(0);
    const b = num(0);
    const sum = fanin(
      Num,
      [a, b] as const,
      (x, y) => x + y,
      (s, x, y) => {
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
    (sum as unknown as { value: number }).value = 100;
    // a and b both update inside batch. Effect fires exactly once.
    expect(fires).toBe(1);
    expect(sum.value).toBe(100);
    stop();
  });
});

describe("fanin: composes with regular lenses", () => {
  it("fanin used as input to a chain", () => {
    const a = num(3);
    const b = num(4);
    const sum = fanin(Num, [a, b] as const, (x, y) => x + y);
    // .scale(2) on top of fanin's RO output: stays RO.
    const scaled = sum.scale(2);
    expect(scaled.value).toBe(14);
    expect(() => {
      (scaled as unknown as { value: number }).value = 99;
    }).toThrow();
  });

  it("fanin's .x field-lens (when output is Vec)", () => {
    const a = vec(1, 2);
    const b = vec(3, 4);
    const mid = fanin(
      Vec,
      [a, b] as const,
      (av, bv) => ({ x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 }),
    );
    // .x is a field lens onto the fanin's RO output → also RO.
    const x = mid.x;
    expect(x.value).toBe(2);
  });
});

describe("fanin: relate-like bidirectional", () => {
  it("two cells related via fanin (works like relate but with different shape)", () => {
    // C↔F via fanin (a single F output computed from C and back).
    // Note: this isn't quite the same shape as relate — fanin produces
    // a derived cell, while relate makes two existing cells covary.
    const c = num(0);
    const f = fanin(
      Num,
      [c] as const,
      cv => (cv * 9) / 5 + 32,
      (fv, _cv) => [((fv - 32) * 5) / 9],
    );
    expect(f.value).toBe(32);
    c.value = 100;
    expect(f.value).toBe(212);
    (f as unknown as { value: number }).value = 0;
    expect(c.value).toBeCloseTo(-17.778, 3);
  });
});
