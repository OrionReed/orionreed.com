// footgun-fanin.test.ts — adversarial probes for `fanin`.

import { describe, expect, it } from "vitest";
import { effect, fanin, Num, num, signal } from "../index";

describe("fanin: reactive args inside fwd", () => {
  it("fwd reads an external signal: tracked, re-fires on its change", () => {
    const a = num(1);
    const b = num(2);
    const k = signal(1);
    const sum = fanin(Num, [a, b] as const, vals => vals[0] + vals[1] * k.value);
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
    const k = signal(0);
    const result = fanin(Num, [a] as const, vals => vals[0] + k.peek());
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

describe("fanin: nested fanin (aggregations of aggregations)", () => {
  it("fanin of fanins: chain works correctly", () => {
    const a = num(1);
    const b = num(2);
    const c = num(3);
    const d = num(4);
    const sumAB = fanin(Num, [a, b] as const, vals => vals[0] + vals[1]);
    const sumCD = fanin(Num, [c, d] as const, vals => vals[0] + vals[1]);
    const sumAll = fanin(Num, [sumAB, sumCD] as const, vals => vals[0] + vals[1]);
    expect(sumAll.value).toBe(10);
    a.value = 10;
    expect(sumAll.value).toBe(19);
    d.value = 40;
    expect(sumAll.value).toBe(55);
  });
});

describe("fanin: side effects in fwd (caller error pattern)", () => {
  it("FOOTGUN: side effects in fwd re-fire on every read", () => {
    const a = num(0);
    let sideEffectCount = 0;
    const result = fanin(Num, [a] as const, vals => {
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

describe("fanin: writable bwd with writeable parent that's itself a lens", () => {
  it("fanin([num.scale(2)]) — write target writes through the scale lens", () => {
    const n = num(0);
    const scaled = n.scale(2);
    const result = fanin(
      Num,
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

describe("fanin: bwd that returns wrong-length array", () => {
  it("FOOTGUN: bwd returning fewer elements: missing parents stay unchanged", () => {
    const a = num(1);
    const b = num(2);
    const sum = fanin(
      Num,
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

describe("fanin: very deep aggregation tree", () => {
  it("16 leaves aggregated through 4 levels: write-read works", () => {
    const leaves = Array.from({ length: 16 }, (_, i) => num(i));
    let level: ReadonlyArray<Num> = leaves;
    while (level.length > 1) {
      const next: Num[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(fanin(Num, [level[i]!, level[i + 1]!] as const, vals => vals[0] + vals[1]));
      }
      level = next;
    }
    expect(level[0]!.value).toBe(120);
    leaves[0]!.value = 100;
    expect(level[0]!.value).toBe(220);
  });
});
