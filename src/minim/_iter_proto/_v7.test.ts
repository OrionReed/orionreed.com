import { describe, it, expect } from "vitest";
import "../_test/setup";

import {
  Anim, drive, race, withTimeout, fromEvent,
  type Effect, type Animator,
} from "./v7_lean";

// ───────────────────────── yield contract ─────────────────────────

describe("v7 / yield contract", () => {
  it("yield; parks 1 frame, resumes with dt", () => {
    const anim = new Anim();
    let dt: number | undefined;
    anim.run(function* () { dt = yield; });
    anim.step(0.025);
    expect(dt).toBeCloseTo(0.025, 9);
    anim.stop();
  });
  it("yield N parks N seconds", () => {
    const anim = new Anim();
    let woke = false;
    anim.run(function* () { yield 0.1; woke = true; });
    anim.step(0.05); expect(woke).toBe(false);
    anim.step(0.06); expect(woke).toBe(true);
    anim.stop();
  });
  it("yield 0 is sync tail-call", () => {
    const anim = new Anim();
    let order = "";
    anim.run(function* () { order += "a"; yield 0; order += "b"; });
    expect(order).toBe("ab");
    anim.stop();
  });
  it("yield* delegates and propagates return", () => {
    const anim = new Anim();
    let got: number | undefined;
    function* child(): Animator<number> { yield; return 99; }
    anim.run(function* () { got = yield* child(); });
    anim.step(1 / 60); anim.step(1 / 60);
    expect(got).toBe(99);
    anim.stop();
  });
  it("yield childGen waits, resumes with child's return value", () => {
    const anim = new Anim();
    let v: any;
    function* sub(): Animator<number> { yield; return 42; }
    anim.run(function* () { v = yield sub(); });
    anim.step(1 / 60);
    expect(v).toBe(42);
    anim.stop();
  });
  it("yield [a, b] runs in parallel, resumes with [Ra, Rb]", () => {
    const anim = new Anim();
    let r: any;
    function* a(): Animator<string> { yield; return "a"; }
    function* b(): Animator<string> { yield; yield; return "b"; }
    anim.run(function* () { r = yield [a(), b()]; });
    anim.step(0.016); anim.step(0.016);
    expect(r).toEqual(["a", "b"]);
    anim.stop();
  });
  it("yield [] resumes with []", () => {
    const anim = new Anim();
    let r: any;
    anim.run(function* () { r = yield [] as any; });
    expect(r).toEqual([]);
    anim.stop();
  });
});

// ───────────────────────── Promise sugar ─────────────────────────

describe("v7 / Promise", () => {
  it("yield Promise resumes with value", async () => {
    const anim = new Anim();
    let v: any;
    anim.run(function* () { v = yield Promise.resolve(7); });
    await Promise.resolve(); await Promise.resolve();
    expect(v).toBe(7);
    anim.stop();
  });
  it("rejection routes via onError", async () => {
    const anim = new Anim();
    let err: any;
    anim.onError = (e) => { err = e; };
    anim.run(function* () { yield Promise.reject(new Error("boom")); });
    await Promise.resolve(); await Promise.resolve();
    expect((err as Error).message).toBe("boom");
    anim.stop();
  });
  it("array of promises waits for all", async () => {
    const anim = new Anim();
    let r: any;
    anim.run(function* () { r = yield [Promise.resolve(1), Promise.resolve(2)]; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(r).toEqual([1, 2]);
    anim.stop();
  });
});

// ───────────────────────── Effect / drive / suspend ─────────────────────────

describe("v7 / Effect", () => {
  it("yield drive(cb) — onFrame ticker fast path", () => {
    const anim = new Anim();
    let acc = 0;
    anim.run(function* () {
      yield drive((dt) => { acc += dt; if (acc >= 0.5) return false; });
    });
    for (let i = 0; i < 60; i++) anim.step(1 / 60);
    expect(acc).toBeGreaterThanOrEqual(0.5);
    anim.stop();
  });
  it("Effect can sync-wake during install", () => {
    const anim = new Anim();
    let after = false;
    anim.run(function* () {
      yield ((wake) => { wake(); return () => {}; }) as Effect<void>;
      after = true;
    });
    expect(after).toBe(true);
    anim.stop();
  });
  it("Effect can deliver payload", () => {
    const anim = new Anim();
    let v: any, storedWake!: (n: number) => void;
    anim.run(function* () {
      v = yield ((wake) => { storedWake = wake as any; return () => {}; }) as Effect<number>;
    });
    storedWake(13);
    expect(v).toBe(13);
    anim.stop();
  });
});

// ───────────────────────── cancel cascade ─────────────────────────

describe("v7 / cancel cascade", () => {
  it("dispose runs Effect dispose", () => {
    const anim = new Anim();
    let disposed = false;
    const stop = anim.run(function* () {
      yield (() => () => { disposed = true; }) as Effect<void>;
    });
    anim.step(0.016);
    stop();
    expect(disposed).toBe(true);
    anim.stop();
  });
  it("parent cancel cascades to single-child", () => {
    const anim = new Anim();
    let leafFin = false;
    function* leaf(): Animator {
      try { yield (() => () => {}) as Effect<void>; }
      finally { leafFin = true; }
    }
    const stop = anim.run(function* () { yield leaf(); });
    anim.step(0.016);
    stop();
    expect(leafFin).toBe(true);
    anim.stop();
  });
  it("parent cancel cascades through array children", () => {
    const anim = new Anim();
    let aFin = false, bFin = false;
    function* leaf(flag: () => void): Animator {
      try { yield (() => () => {}) as Effect<void>; }
      finally { flag(); }
    }
    const stop = anim.run(function* () {
      yield [leaf(() => { aFin = true; }), leaf(() => { bFin = true; })];
    });
    anim.step(0.016);
    stop();
    expect(aFin && bFin).toBe(true);
    anim.stop();
  });
  it("stop() runs try/finally in pending gens", () => {
    const anim = new Anim();
    let cleaned = 0;
    function* g(): Animator { try { yield; } finally { cleaned++; } }
    anim.run(g); anim.run(g); anim.run(g);
    anim.stop();
    expect(cleaned).toBe(3);
  });
});

// ───────────────────────── error handling ─────────────────────────

describe("v7 / error", () => {
  it("throw in gen routes to onError; siblings continue", () => {
    const anim = new Anim();
    anim.onError = () => {};
    let other = false;
    anim.run(function* () { throw new Error("boom"); });
    anim.run(function* () { yield; other = true; });
    anim.step(0.016);
    expect(other).toBe(true);
    anim.stop();
  });
  it("child throw unblocks parent (resumes with undefined)", () => {
    const anim = new Anim();
    anim.onError = () => {};
    let parentDone = false;
    anim.run(function* () {
      yield (function* (): Animator { throw new Error("boom"); })();
      parentDone = true;
    });
    anim.step(0.016);
    expect(parentDone).toBe(true);
    anim.stop();
  });
});

// ───────────────────────── compositional stdlib ─────────────────────────

describe("v7 / race + withTimeout", () => {
  it("race resolves with first to finish", () => {
    const anim = new Anim();
    function* slow(): Animator<string> { yield 1.0; return "slow"; }
    function* fast(): Animator<string> { yield 0.05; return "fast"; }
    let r: any;
    anim.run(function* () { r = yield race([slow(), fast()]); });
    anim.step(0.1);
    expect(r).toBe("fast");
    anim.stop();
  });
  it("withTimeout returns ok when fast", () => {
    const anim = new Anim();
    function* fast(): Animator<number> { yield 0.05; return 42; }
    let r: any;
    anim.run(function* () { r = yield withTimeout(fast(), 1.0); });
    anim.step(0.1);
    expect(r).toEqual({ kind: "ok", value: 42 });
    anim.stop();
  });
  it("withTimeout returns timeout when slow", () => {
    const anim = new Anim();
    function* slow(): Animator<number> { yield 1.0; return 42; }
    let r: any;
    anim.run(function* () { r = yield withTimeout(slow(), 0.1); });
    anim.step(0.2);
    expect(r.kind).toBe("timeout");
    anim.stop();
  });
});

describe("v7 / fromEvent", () => {
  it("resumes on first emission, unsubscribes", () => {
    const anim = new Anim();
    let v: any, unsubbed = false, emit!: (n: number) => void;
    anim.run(function* () {
      v = yield fromEvent<number>((cb) => { emit = cb; return () => { unsubbed = true; }; });
    });
    emit(99);
    expect(v).toBe(99);
    expect(unsubbed).toBe(true);
    anim.stop();
  });
});
