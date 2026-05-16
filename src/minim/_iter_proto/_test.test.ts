import { describe, it, expect } from "vitest";
import "../_test/setup";

import { Pull, lerp, spring, seq, loopN, mapFrame, takeDur, zip, fromFrame } from "./pull";
import { Anim, suspend, drive } from "./push_plus";

// ──────────────────────────── pull model ────────────────────────────

describe("pull / Frame", () => {
  it("lerp emits start, ramps, lands on end", () => {
    const samples: number[] = [];
    const p = new Pull<number>();
    p.run(lerp(0, 10, 1.0), (v) => samples.push(v));
    expect(samples[0]).toBe(0);
    for (let i = 0; i < 10; i++) p.step(0.1);
    p.step(0.1);
    expect(samples[samples.length - 1]).toBe(10);
    expect(samples[5]).toBeGreaterThan(0);
    expect(samples[5]).toBeLessThan(10);
  });

  it("spring settles near target", () => {
    let last = 0;
    const p = new Pull<number>();
    p.run(spring(1.0), (v) => { last = v; });
    for (let i = 0; i < 240; i++) p.step(1 / 60);
    expect(last).toBeCloseTo(1.0, 3);
  });

  it("seq concatenates via yield*", () => {
    const samples: number[] = [];
    const p = new Pull<number>();
    p.run(seq(lerp(0, 1, 0.1), lerp(1, 2, 0.1)), (v) => samples.push(v));
    for (let i = 0; i < 25; i++) p.step(1 / 60);
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(2);
  });

  it("loopN repeats", () => {
    const samples: number[] = [];
    const p = new Pull<number>();
    p.run(loopN(3, () => lerp(0, 1, 0.05)), (v) => samples.push(v));
    let zeros = 0;
    for (let i = 0; i < 30; i++) p.step(1 / 60);
    for (const s of samples) if (s === 0) zeros++;
    expect(zeros).toBe(3);
  });

  it("mapFrame transforms values", () => {
    const samples: number[] = [];
    const p = new Pull<number>();
    p.run(mapFrame(lerp(0, 1, 0.1), (v) => v * 100), (v) => samples.push(v));
    for (let i = 0; i < 10; i++) p.step(1 / 60);
    expect(samples[samples.length - 1]).toBe(100);
  });

  it("takeDur truncates", () => {
    const samples: number[] = [];
    const p = new Pull<number>();
    p.run(takeDur(lerp(0, 1, 1.0), 0.2), (v) => samples.push(v));
    for (let i = 0; i < 20; i++) p.step(1 / 60);
    expect(samples[samples.length - 1]).toBeLessThan(1.0);
  });

  it("zip yields tuples in lockstep", () => {
    const samples: number[][] = [];
    const p = new Pull<number[]>();
    p.run(zip(lerp(0, 1, 0.1), lerp(10, 20, 0.1)), (v) => samples.push(v));
    for (let i = 0; i < 10; i++) p.step(1 / 60);
    const last = samples[samples.length - 1];
    expect(last[0]).toBeCloseTo(1.0, 5);
    expect(last[1]).toBeCloseTo(20.0, 5);
  });

  it("dispose stops emission", () => {
    const samples: number[] = [];
    const p = new Pull<number>();
    const stop = p.run(lerp(0, 1, 1.0), (v) => samples.push(v));
    p.step(0.1);
    const before = samples.length;
    stop();
    p.step(0.1); p.step(0.1);
    expect(samples.length).toBe(before);
  });
});

describe("pull → push bridge (fromFrame)", () => {
  it("fromFrame can be driven by push runtime", () => {
    const anim = new Anim();
    let last = 0;
    const tick = fromFrame(spring(1.0), (v) => { last = v; });
    anim.run(drive((dt) => { if (!tick(dt)) return false; }));
    for (let i = 0; i < 240; i++) anim.step(1 / 60);
    expect(last).toBeCloseTo(1.0, 3);
    anim.stop();
  });
});

// ─────────────────────── push_plus extensions ───────────────────────

describe("push_plus / yield Promise", () => {
  it("resumes generator with resolved value", async () => {
    const anim = new Anim();
    let got: any;
    anim.run(function* () {
      got = yield Promise.resolve(42);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toBe(42);
    anim.stop();
  });

  it("rejection propagates as throw inside generator", async () => {
    const anim = new Anim();
    anim.onError = () => {};
    let caught: any;
    anim.run(function* () {
      try { yield Promise.reject(new Error("nope")); }
      catch (e) { caught = e; }
    });
    await Promise.resolve();
    await Promise.resolve();
    expect((caught as Error)?.message).toBe("nope");
    anim.stop();
  });

  it("array of promises waits for all", async () => {
    const anim = new Anim();
    let got: any;
    anim.run(function* () {
      got = yield [Promise.resolve(1), Promise.resolve(2)];
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toEqual([1, 2]);
    anim.stop();
  });
});

describe("push_plus / cancel-with-reason", () => {
  it("handle.cancel(reason) injects throw into gen", () => {
    const anim = new Anim();
    anim.onError = () => {};
    let received: any;
    const h = anim.run(function* () {
      try { yield* suspend(() => () => {}); }
      catch (e) { received = e; }
    });
    h.cancel(new Error("user-cancel"));
    expect((received as Error)?.message).toBe("user-cancel");
    anim.stop();
  });

  it("handle() (no-arg) is a plain return-cancel", () => {
    const anim = new Anim();
    let cleanRan = false, threwReason: any;
    const h = anim.run(function* () {
      try { yield* suspend(() => () => {}); }
      catch (e) { threwReason = e; }
      finally { cleanRan = true; }
    });
    h();
    expect(cleanRan).toBe(true);
    expect(threwReason).toBeUndefined();
    anim.stop();
  });
});

describe("push_plus / Symbol.dispose", () => {
  it("[Symbol.dispose]() cancels", () => {
    const anim = new Anim();
    let cleaned = false;
    const h = anim.run(function* () {
      try { yield* suspend(() => () => {}); }
      finally { cleaned = true; }
    });
    h[Symbol.dispose]();
    expect(cleaned).toBe(true);
    anim.stop();
  });
});
