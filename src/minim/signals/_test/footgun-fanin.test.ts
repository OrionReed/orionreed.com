// footgun-fanin.test.ts — adversarial probes for the N-input lens
// surface (`Cls.lens([...], ...)` / `Cls.derive([...], ...)`).

import { describe, expect, it } from "vitest";
import { cell, effect, Num, num } from "../index";

describe("N-input lens: reactive args inside fwd", () => {
  it("fwd reads an external cell: tracked, re-fires on its change", () => {
    const a = num(1);
    const b = num(2);
    const k = cell(1);
    const sum = Num.derive([a, b] as const, vals => vals[0] + vals[1] * k.value);
    let observed = -1;
    const stop = effect(() => {
      observed = sum.value;
    });
    expect(observed).toBe(3); // 1 + 2*1
    k.value = 10;
    expect(observed).toBe(21); // 1 + 2*10
    a.value = 5;
    expect(observed).toBe(25); // 5 + 2*10
    stop();
  });

  it("FOOTGUN: untracked-read in fwd via .peek skips the dep", () => {
    const a = num(1);
    const k = cell(0);
    const result = Num.derive([a] as const, vals => vals[0] + k.peek());
    let observed = -1;
    const stop = effect(() => {
      observed = result.value;
    });
    expect(observed).toBe(1);
    k.value = 100;
    expect(observed).toBe(1); // FOOTGUN: stale!

    a.value = 5;
    expect(observed).toBe(105); // re-eval triggered by parent change
    stop();
  });
});

describe("N-input lens: nested aggregations", () => {
  it("aggregation of aggregations: chain works correctly", () => {
    const a = num(1);
    const b = num(2);
    const c = num(3);
    const d = num(4);
    const sumAB = Num.derive([a, b] as const, vals => vals[0] + vals[1]);
    const sumCD = Num.derive([c, d] as const, vals => vals[0] + vals[1]);
    const sumAll = Num.derive([sumAB, sumCD] as const, vals => vals[0] + vals[1]);
    expect(sumAll.value).toBe(10);
    a.value = 10;
    expect(sumAll.value).toBe(19);
    d.value = 40;
    expect(sumAll.value).toBe(55);
  });
});

describe("N-input lens: side effects in fwd (caller error pattern)", () => {
  it("FOOTGUN: side effects in fwd re-fire on every read", () => {
    const a = num(0);
    let sideEffectCount = 0;
    const result = Num.derive([a] as const, vals => {
      sideEffectCount++;
      return vals[0] * 2;
    });
    sideEffectCount = 0;
    expect(result.value).toBe(0);
    expect(sideEffectCount).toBe(1);
    expect(result.value).toBe(0);
    expect(sideEffectCount).toBe(1);
    a.value = 5;
    expect(result.value).toBe(10);
    expect(sideEffectCount).toBe(2);
  });
});

describe("N-input lens: writable bwd with writeable parent that's itself a lens", () => {
  it("Num.lens([num.scale(2)]) — write target writes through the scale lens", () => {
    const n = num(0);
    const scaled = n.scale(2);
    const result = Num.lens(
      [scaled as Num] as const,
      vals => vals[0] + 100,
      (target, _vals) => [target - 100],
    );
    n.value = 5;
    expect(scaled.value).toBe(10);
    expect(result.value).toBe(110);

    (result as unknown as { value: number }).value = 200;
    expect(n.value).toBe(50);
    expect(scaled.value).toBe(100);
    expect(result.value).toBe(200);
  });
});

describe("N-input lens: bwd that returns wrong-length array", () => {
  it("FOOTGUN: bwd returning fewer elements: missing parents stay unchanged", () => {
    const a = num(1);
    const b = num(2);
    const sum = Num.lens(
      [a, b] as const,
      vals => vals[0] + vals[1],
      // biome-ignore lint/suspicious/noExplicitAny: testing bad usage
      (target, vals) => [target - vals[1]] as any,
    );
    (sum as unknown as { value: number }).value = 100;
    expect(a.value).toBe(98);
    expect(b.value).toBe(2);
    expect(sum.value).toBe(100);
  });
});

describe("N-input lens: very deep aggregation tree", () => {
  it("16 leaves aggregated through 4 levels: write-read works", () => {
    const leaves = Array.from({ length: 16 }, (_, i) => num(i));
    let level: ReadonlyArray<Num> = leaves;
    while (level.length > 1) {
      const next: Num[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(Num.derive([level[i]!, level[i + 1]!] as const, vals => vals[0] + vals[1]));
      }
      level = next;
    }
    expect(level[0]!.value).toBe(120);
    leaves[0]!.value = 100;
    expect(level[0]!.value).toBe(220);
  });
});
