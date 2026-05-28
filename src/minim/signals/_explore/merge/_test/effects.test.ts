// effects.test.ts — `.merge()` interacting with effects. The promise:
// effects compose with merge nodes exactly the way they compose with
// any other lens — merge is transparent forward, so subscribers
// observe the committed value. The cascade boundary defined by
// `bwdCascadeId` doesn't change effect scheduling.
//
// ⚠ See semantic-guarantees.test.ts for the user-facing contract.
//   Some tests here assert specific `fires.length` counts. Those
//   depend on the engine's batching/equality-short-circuit details
//   and are NOT contract — the contract (N2) is "users should rely
//   on FINAL VALUES, not fire counts". Fire-count assertions here
//   are regression guards for the current scheduler.
//
// Cases covered:
//   1. Effect subscribed to the merge cell.
//   2. Effect subscribed to the underlying parent (below the merge).
//   3. Effect subscribed to a leaf ABOVE the merge.
//   4. Effect subscribed to two points; consistent values after one cascade.
//   5. Multiple effects on the same merge.
//   6. Effect lifecycle (subscribe/unsubscribe doesn't leak state).
//   7. Effect that writes through a merge — propagation terminates.
//   8. Effect that drives a fan-in whose bwd lands at the merge.

import { describe, expect, it } from "vitest";
import { effect, maxPolicy, Num, num, sumPolicy } from "../index";

describe("effect subscribing to the merge cell", () => {
  it("sees committed values (after fold), once per VALUE-CHANGING arrival", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    const fires: number[] = [];
    const stop = effect(() => {
      fires.push(merged.value);
    });
    expect(fires).toEqual([0]); // initial run
    fires.length = 0;
    fan.value = 6;
    // One cascade, one effect fire with the committed merge value.
    expect(fires.length).toBe(1);
    expect(fires[0]).toBe(merged.value);
    stop();
  });

  it("idempotent fold + equality short-circuit ⇒ effect fires only once even with multiple arrivals", () => {
    const root = num(0);
    const merged = root.merge(maxPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    const fires: number[] = [];
    const stop = effect(() => {
      fires.push(merged.value);
    });
    fires.length = 0;
    fan.value = 6;
    expect(fires.length).toBe(1);
    stop();
  });
});

describe("effect subscribing BELOW the merge (the underlying parent)", () => {
  it("sees the same committed value the merge committed", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    const mergeFires: number[] = [];
    const rootFires: number[] = [];
    const stop1 = effect(() => {
      mergeFires.push(merged.value);
    });
    const stop2 = effect(() => {
      rootFires.push(root.value);
    });
    mergeFires.length = 0;
    rootFires.length = 0;
    fan.value = 6;
    // Both effects see the same final value (merged is an identity
    // view over root).
    expect(mergeFires[mergeFires.length - 1]).toBe(rootFires[rootFires.length - 1]);
    expect(root.value).toBe(merged.value);
    stop1();
    stop2();
  });
});

describe("effect subscribing ABOVE the merge (a leaf above)", () => {
  it("after a fan-in write, the leaf re-evaluates with merge's committed value propagated up", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    const fires: number[] = [];
    const stop = effect(() => {
      fires.push(a.value); // `a` is ABOVE the merge in fwd direction
    });
    fires.length = 0;
    fan.value = 6;
    // After the cascade, root has been written by the merge fold;
    // `a` re-derives from root and the effect fires with the new
    // value.
    expect(fires.length).toBeGreaterThan(0);
    expect(fires[fires.length - 1]).toBe(a.value);
    stop();
  });
});

describe("two effects subscribed to different points", () => {
  it("both see consistent values after one cascade", () => {
    const root = num(1);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    let lastMerged = 0;
    let lastA = 0;
    const stop1 = effect(() => {
      lastMerged = merged.value;
    });
    const stop2 = effect(() => {
      lastA = a.value;
    });
    fan.value = 10;
    // a.value === merged.value + 1 must hold after settling.
    expect(lastA).toBe(lastMerged + 1);
    stop1();
    stop2();
  });
});

describe("multiple effects on the same merge cell", () => {
  it("all fire once per cascade with the same committed value", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    let e1Fires = 0;
    let e2Fires = 0;
    const stop1 = effect(() => {
      void merged.value;
      e1Fires++;
    });
    const stop2 = effect(() => {
      void merged.value;
      e2Fires++;
    });
    const before1 = e1Fires;
    const before2 = e2Fires;
    fan.value = 6;
    expect(e1Fires - before1).toBe(1);
    expect(e2Fires - before2).toBe(1);
    stop1();
    stop2();
  });
});

describe("effect lifecycle: unsubscribing doesn't break merge state", () => {
  it("subscribe → cascade → unsubscribe → cascade → all fine", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    const fires: number[] = [];
    const stop = effect(() => {
      fires.push(merged.value);
    });
    fires.length = 0;
    fan.value = 6;
    expect(fires.length).toBe(1);
    stop();
    fan.value = 12;
    // Effect was disposed; no new fires. But merge state and root
    // value should update normally.
    expect(fires.length).toBe(1);
    expect(merged.value).toBe(root.value);
  });
});

describe("effect that writes through a merge", () => {
  it("does not infinite-loop the engine (standing footgun, user's responsibility)", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    let fires = 0;
    const stop = effect(() => {
      fires++;
      const v = merged.value;
      if (v < 3) merged.value = v + 1;
    });
    // The condition stops the recursion at v=3.
    expect(fires).toBeGreaterThan(0);
    expect(Number.isFinite(merged.value)).toBe(true);
    stop();
  });
});

describe("effect that drives a fan-in (whose bwd lands at the merge)", () => {
  it("effect-initiated fan-in writes flow through merge correctly", () => {
    const root = num(0);
    const merged = root.merge(sumPolicy);
    const a = merged.add(1);
    const b = merged.scale(2);
    const fan = Num.lens(
      [a, b] as const,
      ([x, y]) => x + y,
      (t, [x, y]) => {
        const tot = x + y || 1;
        return [(t * x) / tot, (t * y) / tot];
      },
    );
    const trigger = num(0);
    const stop = effect(() => {
      const t = trigger.value;
      if (t > 0) fan.value = t * 10;
    });
    trigger.value = 1;
    // fan.value=10 cascades through merge; root commits the fold.
    expect(Number.isFinite(root.value)).toBe(true);
    expect(root.value).not.toBe(0);
    stop();
  });
});
