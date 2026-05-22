// mix.test.ts — semantics of `mix(Cls, parts, merge, writeback?)`
// and the first-class merge/writeback values + combinators.

import { describe, expect, it } from "vitest";
import { effect, Mix, mix, num, Num, signal, vec, Vec } from "../index";

describe("mix: read-only mode (no writeback)", () => {
  it("Num + mean: read tracks contributors", () => {
    const a = num(0);
    const b = num(10);
    const m = mix(Num, [a, b], Mix.mean);
    expect(m).toBeInstanceOf(Num);
    expect(m.value).toBe(5);
    a.value = 20;
    expect(m.value).toBe(15);
  });

  it("Vec + mean: returns a Vec", () => {
    const a = vec(0, 0);
    const b = vec(10, 20);
    const m = mix(Vec, [a, b], Mix.mean);
    expect(m).toBeInstanceOf(Vec);
    expect(m.value).toEqual({ x: 5, y: 10 });
  });

  it("writes throw when no writeback configured", () => {
    const m = mix(Num, [num(0), num(10)], Mix.mean);
    expect(() => {
      (m as unknown as { value: number }).value = 99;
    }).toThrow();
  });

  it("accepts thunks as parts (wrapped in tracked computed)", () => {
    const x = signal(3);
    // Bare thunk — closure-read signals become deps.
    const m = mix(Num, [() => x.value * 2, () => x.value + 1], Mix.mean);
    // mean of 6 and 4 = 5
    expect(m.value).toBe(5);
    x.value = 10;
    // mean of 20 and 11 = 15.5
    expect(m.value).toBe(15.5);
  });

  it("accepts literals as parts (frozen contribution)", () => {
    const a = num(0);
    const m = mix(Num, [a, 100], Mix.mean);
    expect(m.value).toBe(50);
    a.value = 200;
    expect(m.value).toBe(150);
  });
});

describe("mix: with writeback (RW)", () => {
  it("mean + deltaEven: write distributes delta evenly", () => {
    const a = num(0);
    const b = num(10);
    const m = mix(Num, [a, b], Mix.mean, Mix.deltaEven);
    expect(m.value).toBe(5);
    (m as unknown as { value: number }).value = 8; // delta = 3
    expect(a.value).toBe(3);
    expect(b.value).toBe(13);
    expect(m.value).toBe(8);
  });

  it("Vec mean + deltaEven", () => {
    const a = vec(0, 0);
    const b = vec(10, 10);
    const m = mix(Vec, [a, b], Mix.mean, Mix.deltaEven);
    expect(m.value).toEqual({ x: 5, y: 5 });
    (m as unknown as { value: { x: number; y: number } }).value = { x: 15, y: 15 };
    // delta (10, 10) to each
    expect(a.value).toEqual({ x: 10, y: 10 });
    expect(b.value).toEqual({ x: 20, y: 20 });
  });

  it("replaceFirst writeback (trait-free)", () => {
    const a = num(0);
    const b = num(0);
    const m = mix(Num, [a, b], Mix.mean, Mix.replaceFirst);
    (m as unknown as { value: number }).value = 99;
    expect(a.value).toBe(99);
    expect(b.value).toBe(0);
  });

  it("custom writeback: 'a absorbs 2× the per-contributor share'", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    const m = mix(Num, [a, b, c], Mix.mean, (next, parts) => {
      const N = parts.length;
      const cur = (parts[0]!.value + parts[1]!.value + parts[2]!.value) / N;
      // Change in total = (next - cur) * N. We split that change
      // such that a gets 2x and b,c each get x → 4x = N*(next-cur).
      const x = (N * (next - cur)) / 4;
      return [parts[0]!.value + 2 * x, parts[1]!.value + x, parts[2]!.value + x];
    });
    (m as unknown as { value: number }).value = 4; // delta_mean = 4, delta_total = 12
    // 4x = 12 → x = 3. a += 6, b += 3, c += 3. New mean = (6+3+3)/3 = 4. ✓
    expect(a.value).toBe(6);
    expect(b.value).toBe(3);
    expect(c.value).toBe(3);
    expect(m.value).toBe(4);
  });
});

describe("mix: weights via record-form parts", () => {
  it("weighted mean: contributions scaled by their weight", () => {
    const a = num(0);
    const b = num(100);
    // a weight 3, b weight 1 — mean = (0*3 + 100*1) / 4 = 25
    const m = mix(
      Num,
      [
        { src: a, weight: 3 },
        { src: b, weight: 1 },
      ],
      Mix.mean,
    );
    expect(m.value).toBe(25);
  });

  it("reactive weights: updates when weight signals change", () => {
    const a = num(0);
    const b = num(100);
    const wa = signal(1);
    const wb = signal(1);
    const m = mix(
      Num,
      [
        { src: a, weight: wa },
        { src: b, weight: wb },
      ],
      Mix.mean,
    );
    expect(m.value).toBe(50);
    wa.value = 3;
    // mean = (0*3 + 100*1) / 4 = 25
    expect(m.value).toBe(25);
    wb.value = 0;
    // mean = (0*3 + 100*0) / 3 = 0
    expect(m.value).toBe(0);
  });

  it("mixed: bare Val + record form", () => {
    const a = num(0);
    const b = num(100);
    // a bare (weight=1), b weighted 3 — mean = (0*1 + 100*3) / 4 = 75
    const m = mix(Num, [a, { src: b, weight: 3 }], Mix.mean);
    expect(m.value).toBe(75);
  });

  it("proportional writeback: high-weight absorbs more delta", () => {
    const a = num(0);
    const b = num(0);
    const m = mix(
      Num,
      [
        { src: a, weight: 1 },
        { src: b, weight: 3 },
      ],
      Mix.mean,
      Mix.proportional,
    );
    // cur = 0; delta = 4; a += (1/4)*4 = 1; b += (3/4)*4 = 3
    (m as unknown as { value: number }).value = 4;
    expect(a.value).toBeCloseTo(1);
    expect(b.value).toBeCloseTo(3);
  });
});

describe("mix: other built-in merges", () => {
  it("sum: weighted sum without normalisation", () => {
    const a = num(2);
    const b = num(3);
    const m = mix(Num, [a, b], Mix.sum);
    expect(m.value).toBe(5);
  });

  it("priority: highest-weight contributor wins", () => {
    const a = num(1);
    const b = num(2);
    const c = num(3);
    const m = mix(
      Num,
      [
        { src: a, weight: 1 },
        { src: b, weight: 5 },
        { src: c, weight: 2 },
      ],
      Mix.priority,
    );
    expect(m.value).toBe(2); // b wins (highest weight)
  });

  it("latest: last contributor wins", () => {
    const m = mix(Num, [num(1), num(2), num(3)], Mix.latest);
    expect(m.value).toBe(3);
  });

  it("firstNonNull: fallback chain", () => {
    const a = signal<number | null>(null);
    const b = signal<number | null>(null);
    const c = signal<number | null>(42);
    const m = mix(
      Num as unknown as new (...a: never[]) => Num,
      [a as unknown as () => number, b as unknown as () => number, c as unknown as () => number],
      Mix.firstNonNull,
    );
    expect(m.value).toBe(42);
    b.value = 7;
    expect(m.value).toBe(7);
    a.value = 1;
    expect(m.value).toBe(1);
  });

  it("min / max", () => {
    const a = num(5);
    const b = num(2);
    const c = num(8);
    const lo = mix(Num, [a, b, c], Mix.min);
    const hi = mix(Num, [a, b, c], Mix.max);
    expect(lo.value).toBe(2);
    expect(hi.value).toBe(8);
    a.value = 1;
    expect(lo.value).toBe(1);
    expect(hi.value).toBe(8);
  });
});

describe("mix: combinators", () => {
  it("top(n, base): only top-n by weight contribute", () => {
    const a = num(10);
    const b = num(20);
    const c = num(30);
    // weights 1, 5, 2 — top 2 are b (5) and c (2); mean = (20*5 + 30*2) / 7 ≈ 22.86
    const m = mix(
      Num,
      [
        { src: a, weight: 1 },
        { src: b, weight: 5 },
        { src: c, weight: 2 },
      ],
      Mix.top(2, Mix.mean),
    );
    expect(m.value).toBeCloseTo((20 * 5 + 30 * 2) / 7);
  });

  it("above(threshold, base): drops below-threshold contributors", () => {
    const a = num(10);
    const b = num(20);
    const c = num(30);
    // weights 0.05, 1, 1 — above(0.1) drops a; mean = (20 + 30) / 2 = 25
    const m = mix(
      Num,
      [
        { src: a, weight: 0.05 },
        { src: b, weight: 1 },
        { src: c, weight: 1 },
      ],
      Mix.above(0.1, Mix.mean),
    );
    expect(m.value).toBe(25);
  });

  it("reweight(fn, base): remaps weights before merge", () => {
    const a = num(0);
    const b = num(100);
    // sq the weights: 1→1, 2→4. mean = (0*1 + 100*4) / 5 = 80
    const m = mix(
      Num,
      [
        { src: a, weight: 1 },
        { src: b, weight: 2 },
      ],
      Mix.reweight((p) => p.weight * p.weight, Mix.mean),
    );
    expect(m.value).toBe(80);
  });
});

describe("mix: reactive integration", () => {
  it("effect re-fires on contributor change", () => {
    const a = num(0);
    const b = num(10);
    const m = mix(Num, [a, b], Mix.mean);
    let observed = NaN;
    const stop = effect(() => {
      observed = m.value;
    });
    expect(observed).toBe(5);
    a.value = 20;
    expect(observed).toBe(15);
    stop();
  });

  it("effect re-fires on writeback round trip", () => {
    const a = num(0);
    const b = num(10);
    const m = mix(Num, [a, b], Mix.mean, Mix.deltaEven);
    let observed = NaN;
    const stop = effect(() => {
      observed = m.value;
    });
    expect(observed).toBe(5);
    (m as unknown as { value: number }).value = 100;
    expect(observed).toBe(100);
    stop();
  });
});

describe("mix: edge cases", () => {
  it("empty parts: merge throws on first read", () => {
    const m = mix(Num, [], Mix.mean);
    expect(() => m.value).toThrow(/no contributors/);
  });

  it("zero-total-weight mean: falls back to first contribution", () => {
    const a = num(7);
    const b = num(13);
    const m = mix(
      Num,
      [
        { src: a, weight: 0 },
        { src: b, weight: 0 },
      ],
      Mix.mean,
    );
    expect(m.value).toBe(7);
  });

  it("zero-total-weight proportional: falls back to deltaEven", () => {
    const a = num(0);
    const b = num(0);
    const m = mix(
      Num,
      [
        { src: a, weight: 0 },
        { src: b, weight: 0 },
      ],
      Mix.mean,
      Mix.proportional,
    );
    (m as unknown as { value: number }).value = 10;
    // Falls back to even: cur=0, delta=10; each += 10
    expect(a.value).toBe(10);
    expect(b.value).toBe(10);
  });
});
