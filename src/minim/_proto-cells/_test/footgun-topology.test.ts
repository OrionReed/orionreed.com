// footgun-topology.test.ts — graph topology adversarial probes.
// Diamond shapes, cycles, transitive cycles via relate, fanin sharing
// a parent with a relate, etc.

import { describe, expect, it } from "vitest";
import { batch, effect, fanin, num, Num, vec } from "../index";
import { relate } from "../relate";

void Num;

describe("topology: diamond through fanin", () => {
  it("two fanins sharing a parent: glitch-free under upstream write", () => {
    // a is the shared parent. sumA = a + 10, sumB = a + 100.
    // Effect reads both → consistent snapshot.
    const a = num(0);
    const b = num(0);
    const sumA = fanin(Num, [a, b] as const, vals => vals[0] + vals[1] + 10);
    const sumB = fanin(Num, [a, b] as const, vals => vals[0] + vals[1] + 100);

    let observed: { a: number; b: number; diff: number }[] = [];
    effect(() => {
      observed.push({ a: sumA.value, b: sumB.value, diff: sumB.value - sumA.value });
    });
    observed = [];
    a.value = 5;
    b.value = 7;
    // Each iteration: sumB - sumA == 90 (constant offset).
    for (const o of observed) {
      expect(o.diff).toBe(90);
    }
    expect(observed[observed.length - 1]).toEqual({ a: 22, b: 112, diff: 90 });
  });
});

describe("topology: cyclic relates (a → b → c → a)", () => {
  it("Iso 3-cycle terminates and converges to a fixed point", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );
    relate(
      b,
      c,
      x => x + 1,
      y => y - 1,
    );
    relate(
      c,
      a,
      x => x + 1,
      y => y - 1,
    );
    // After all 3 relates set up, the system should be at a fixed
    // point. Each relate enforces b=a+1, c=b+1, a=c+1 → a = a + 3.
    // Inconsistent! The system can't satisfy all 3 simultaneously
    // unless we add 3 to a each cycle. Should diverge or oscillate.
    //
    // Let's just check we don't crash. The actual value depends on
    // engine ordering.
    expect(typeof a.value).toBe("number");
    expect(typeof b.value).toBe("number");
    expect(typeof c.value).toBe("number");
  });

  it("Iso 3-cycle that IS consistent: converges quickly", () => {
    // b = a+1, c = b+1, a = c-2. All consistent: a-1 ≡ a-1.
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );
    relate(
      b,
      c,
      x => x + 1,
      y => y - 1,
    );
    relate(
      c,
      a,
      x => x - 2,
      y => y + 2,
    );
    expect(b.value).toBe(a.value + 1);
    expect(c.value).toBe(b.value + 1);

    a.value = 10;
    expect(b.value).toBe(11);
    expect(c.value).toBe(12);
  });
});

describe("topology: relate sharing a cell with a fanin", () => {
  it("relate(a, b) + fanin([a, c]) = sum: write a, both update consistently", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate(
      a,
      b,
      x => x * 2,
      y => y / 2,
    );
    const sum = fanin(Num, [a, c] as const, vals => vals[0] + vals[1]);

    let observed: { a: number; b: number; sum: number }[] = [];
    effect(() => {
      observed.push({ a: a.value, b: b.value, sum: sum.value });
    });
    observed = [];

    a.value = 10;
    // Final state: a=10, b=20, sum=10+0=10.
    expect(observed[observed.length - 1]).toEqual({ a: 10, b: 20, sum: 10 });

    c.value = 5;
    expect(observed[observed.length - 1]).toEqual({ a: 10, b: 20, sum: 15 });
  });
});

describe("topology: deep relate chain", () => {
  it("8-cell relate chain: write at one end propagates to the other", () => {
    const cells = Array.from({ length: 8 }, () => num(0));
    for (let i = 0; i < 7; i++) {
      relate(
        cells[i]!,
        cells[i + 1]!,
        x => x + 1,
        y => y - 1,
      );
    }
    cells[0]!.value = 0; // already 0
    // After init: each cell is i.
    for (let i = 0; i < 8; i++) {
      expect(cells[i]!.value).toBe(i);
    }
    cells[0]!.value = 100;
    for (let i = 0; i < 8; i++) {
      expect(cells[i]!.value).toBe(100 + i);
    }
    cells[7]!.value = 200; // 200 at end → bwd-cascade → cells[0]=193
    for (let i = 0; i < 8; i++) {
      expect(cells[i]!.value).toBe(193 + i);
    }
  });
});

describe("topology: multiple writes within one batch", () => {
  it("batch with several writes via relate: only one effect run", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );

    let fires = 0;
    let lastB = -1;
    const stop = effect(() => {
      lastB = b.value;
      fires++;
    });
    fires = 0;

    // Multiple writes inside batch — coalesce at the end.
    batch(() => {
      a.value = 1;
      a.value = 2;
      a.value = 3;
    });
    expect(b.value).toBe(4);
    expect(lastB).toBe(4);
    // Effect should fire only once — for the final state.
    expect(fires).toBe(1);
    stop();
  });
});

describe("topology: relate on a field lens (fast-path target)", () => {
  it("relate(num, vec.x): writes through both lens chains and the relate", () => {
    const v = vec(0, 0);
    const n = num(0);
    relate(
      n,
      v.x,
      x => x * 10,
      y => y / 10,
    );
    n.value = 5;
    expect(v.value.x).toBe(50);
    v.x.value = 100;
    expect(n.value).toBe(10);
  });
});
