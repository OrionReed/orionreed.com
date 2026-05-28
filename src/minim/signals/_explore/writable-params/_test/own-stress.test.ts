// own-stress.test.ts — adversarial probes for the own() mechanism.
//
// What can go wrong? Cycles via effects? External writes to the owned
// cell? Batched writes that hit multiple parents? Lens chains in the
// owned signal? Symmetric drag through quantize/cyclic? Etc.

import { describe, expect, it } from "vitest";
import { batch, effect, type Num, num, own, type Writable } from "../../../index";

describe("external writes to the owned cell — runtime enforcement", () => {
  it("locked: external `.value =` throws", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));
    expect(b.value).toBe(130);

    // External code attempts to write — should throw via lockToOwner.
    expect(() => {
      slack.value = 20;
    }).toThrow(/external writes not permitted/);

    // Reads still work.
    expect(slack.value).toBe(30);
  });

  it("locked but lens factory can still write internally", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    // Internal write via owner context — works.
    b.value = 145; // bwd writes slack inside withinOwner(token)
    expect(slack.value).toBe(45);
    expect(b.value).toBe(145);
  });

  it("locked but reaction can still write internally", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));
    void b;

    // Drag-a triggers reaction, which writes slack via owner context.
    a.value = 110;
    expect(slack.value).toBe(20);
  });
});

describe("batched edits", () => {
  it("batch: simultaneous edit to a and slack — last write wins?", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    batch(() => {
      a.value = 110;
      // The reaction would normally fire here; batched so deferred.
    });
    // After batch settles: reaction fires once with a=110.
    expect(slack.value).toBe(20);
    expect(b.value).toBe(130);
  });

  it("batch with multiple sequential a-writes: reaction fires once at end", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    batch(() => {
      a.value = 110;
      a.value = 120;
      a.value = 130;
    });
    expect(slack.value).toBe(0 < 5 ? 5 : 0); // 130 - 130 = 0, clamps to 5
    // Actually desired_slack = 130 - 130 = 0. Clamps to 5. b = 135.
    expect(slack.value).toBe(5);
    expect(b.value).toBe(135);
  });
});

describe("lens chain in the owned signal", () => {
  it("owned `num().clamp().scale()` — composition works", () => {
    const a = num(0);
    // slack range [5, 50] then scaled by 2 → effective view range [10, 100].
    const slack = num(30).clamp(5, 50).scale(2) as Writable<Num>;
    expect(slack.value).toBe(60);

    const b = a.add(own(slack));
    expect(b.value).toBe(60);

    // Drag a: desired_slack = 60 - 10 = 50. Through scale: underlying clamp gets 25.
    // 25 is in [5,50]. slack reads 50. b = 10 + 50 = 60. ✓
    a.value = 10;
    expect(slack.value).toBe(50);
    expect(b.value).toBe(60);

    // Drag a past saturation: desired_slack = 60 - (-100) = 160. Through scale → 80.
    // Clamp [5,50] → 50. slack reads 100. b = -100 + 100 = 0.
    a.value = -100;
    expect(slack.value).toBe(100);
    expect(b.value).toBe(0); // b drifted
  });
});

describe("effects subscribed to b — glitch-freedom (the surprise win)", () => {
  it("drag-a with slack absorbing: effect does NOT fire (b unchanged)", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    let fires = 0;
    let last = 0;
    const stop = effect(() => {
      last = b.value;
      fires++;
    });

    expect(fires).toBe(1); // construction
    expect(last).toBe(130);

    a.value = 110; // slack absorbs → b stays at 130
    // Trace:
    //   - propagate walks a's subs in subscription order:
    //     network (added at construction) → queued first
    //     b (added when effect first read b.value) → walks its subs → effect
    //   - Queue: [network, effect].
    //   - flush() runs network first: writes slack := 20. b re-marked Pending.
    //   - effect runs: checkDirty walks deps, calls b._update.
    //   - b._update returns false (b's value is 130, unchanged) → equality
    //     short-circuits propagation → effect doesn't run.
    // So fires stays at 1!
    expect(fires).toBe(1); // GLITCH-FREE: b unchanged means effect skipped
    expect(last).toBe(130);

    stop();
  });

  it("drag-a that drifts b: effect fires once with the SETTLED value", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    let fires = 0;
    let last = 0;
    const stop = effect(() => {
      last = b.value;
      fires++;
    });

    expect(fires).toBe(1);
    expect(last).toBe(130);

    a.value = 200; // slack saturates at 5, b drifts to 205
    // Network runs first (writes slack), then effect runs and sees b = 205.
    // No intermediate b = 230 ever materializes because b is lazy and the
    // network always runs before the effect (subscription order).
    expect(fires).toBe(2); // one extra fire, with SETTLED value
    expect(last).toBe(205); // no intermediate 230

    stop();
  });
});

describe("composition with regular w() (mixed mode)", () => {
  it("own() inside a stack with non-own siblings", () => {
    // c = a +ʷ (own(slack))   — but wait we don't have an `add` method
    // that takes mixed params yet. Skip — out of prototype scope.
    expect(true).toBe(true);
  });
});

describe("re-entrant edits via effects", () => {
  it("effect that writes b when a changes — does it cycle?", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    let fires = 0;
    const stop = effect(() => {
      const av = a.value;
      fires++;
      if (fires < 3 && av < 1000) {
        // Write b on each effect fire.
        b.value = av + 50;
      }
    });

    // Initial fire writes b = 150. b's bwd: slack := 50, residual to a.
    // a := 100 (no change because slack absorbed fully).
    // Then drag a — that fires effect again. Cycle?

    a.value = 200;
    // Effect fires, av=200, writes b = 250. b's bwd: slack := 50 (max), residual
    // = 150 - (50-50) = 150 (slack already at 50!). Actually wait:
    //   slack was 50 (from initial fire). gv=50. delta = 250 - (200+50) = 0.
    //   slack := 50 + 0 = 50, no change. a := 200 + 0 = 200. b = 250.
    // Then reaction fires (a changed from 100 to 200 inside the effect).
    //   bIntended = 250. desired = 250 - 200 = 50. slack already 50.
    expect(fires).toBeGreaterThan(0); // didn't infinite-loop
    stop();
  });
});

describe("drift-on-saturation accepts the settled state", () => {
  it("repeated saturating drags accumulate drift in bIntended", () => {
    const a = num(0);
    const slack = num(0).clamp(-10, 10);
    const b = a.add(own(slack));
    expect(b.value).toBe(0);

    // Wild back-and-forth drags that saturate slack on each big jump.
    // bIntended drifts with each saturating step. The final b position
    // depends on the cumulative drift — NOT a clean return to origin.
    // The invariant: b = a + slack at the end, and slack is in range.
    for (let i = 0; i < 50; i++) {
      a.value = Math.sin(i) * 100;
    }
    a.value = 0; // back to a = 0
    expect(b.value).toBe(a.peek() + slack.value);
    expect(slack.value).toBeGreaterThanOrEqual(-10);
    expect(slack.value).toBeLessThanOrEqual(10);
  });
});

describe("PutGet under symmetric drag", () => {
  it("after dragging a, writing b reads back exactly (PG)", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    a.value = 110; // drag a
    expect(b.value).toBe(130);

    b.value = 140; // write b
    expect(b.value).toBe(140); // PG holds
  });
});

describe("chained own() lenses: drag-a cascades through both reactions", () => {
  it("c = b.add(own(s2)), b = a.add(own(s1)) — drag a, both reactions fire", () => {
    const a = num(100);
    const s1 = num(30).clamp(5, 50);
    const s2 = num(40).clamp(10, 80);
    const b = a.add(own(s1));
    const c = b.add(own(s2));
    expect(b.value).toBe(130);
    expect(c.value).toBe(170);

    // Drag a in-range for both.
    a.value = 110;
    // N1: desired_s1 = 130 - 110 = 20. In range. b stays at 130.
    // N2: b didn't change → no fire. bIntended_c still 170.
    expect(s1.value).toBe(20);
    expect(s2.value).toBe(40);
    expect(b.value).toBe(130);
    expect(c.value).toBe(170);

    // Drag a past s1's range; b drifts; N2 reacts and s2 saturates too.
    // With drift-on-saturation:
    //   N1: desired_s1 = -70, clamps to 5. bIntended_b drifts to 200+5=205.
    //   N2: b changed → desired_s2 = 170 - 205 = -35, clamps to 10.
    //       bIntended_c drifts to 205+10=215.
    a.value = 200;
    expect(s1.value).toBe(5);
    expect(s2.value).toBe(10);
    expect(b.value).toBe(205);
    expect(c.value).toBe(215);

    // Drag a back with a big jump. s1 saturates AGAIN; bIntended_b drifts
    // again. s2 can absorb fully (no re-drift on s2). c stays at 215.
    a.value = 100;
    // N1: desired_s1 = 205-100=105, clamps to 50. bIntended_b drifts to 150.
    // N2: b=150 → desired_s2 = 215-150=65. In range. s2:=65. c=215 stable.
    expect(s1.value).toBe(50);
    expect(s2.value).toBe(65);
    expect(b.value).toBe(150);
    expect(c.value).toBe(215);
  });
});

describe("ownership: diamond via shared transitive root (the remaining hole)", () => {
  it("DOCUMENT: two distinct own()s through the same primitive — silent breakage", () => {
    // Two views of the same root. Each gets its own `own()` brand,
    // claim() succeeds for both (different brand objects). But the
    // engine doesn't know they share a transitive primitive.
    const a1 = num(100);
    const a2 = num(50);
    const root = num(30); // SHARED ROOT
    const view1 = root.clamp(5, 50); // a writable view
    const view2 = root.clamp(5, 50); // another writable view

    const b1 = a1.add(own(view1));
    const b2 = a2.add(own(view2));
    expect(b1.value).toBe(130);
    expect(b2.value).toBe(80);

    // Drag a1: N1 writes view1 := 130 - 110 = 20. view1's bwd writes root := 20.
    // view2 reads root and computes its own value = clamp(20, 5, 50) = 20.
    // b2's value becomes a2 + view2 = 50 + 20 = 70 (drifted from 80).
    // N2's reaction does NOT fire (a2 didn't change).
    a1.value = 110;
    expect(view1.value).toBe(20);
    expect(view2.value).toBe(20); // ← changed because shared root
    expect(b1.value).toBe(130);
    expect(b2.value).toBe(70); // ← SILENTLY DRIFTED. PG violated for b2.

    // Production fix: claim() walks transitive roots; flags shared-root
    // diamonds. The wp-detect.ts machinery already does this for w().
  });
});

describe("own() in a non-writable slot — RO use is fine", () => {
  it("own()-branded cell can be read normally; brand only matters at writable slot", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const branded = own(slack);

    // The brand just wraps the signal. We can still read the underlying.
    expect(branded.sig.value).toBe(30);

    // If we never use it in a writable slot, no claim happens.
    expect(branded._claimedBy).toBe(undefined);

    // Now claim it.
    const b = a.add(branded);
    expect(branded._claimedBy).toBeDefined();
    expect(b.value).toBe(130);
  });
});

describe("constant edge: zero deltas", () => {
  it("writing b to its current value is a no-op", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    b.value = 130; // no change
    expect(a.peek()).toBe(100);
    expect(slack.value).toBe(30);
  });

  it("dragging a to its current value doesn't fire reaction", () => {
    const a = num(100);
    const slack = num(30).clamp(5, 50);
    const b = a.add(own(slack));

    a.value = 100; // no change; equals short-circuit at root
    expect(slack.value).toBe(30);
    expect(b.value).toBe(130);
  });
});
