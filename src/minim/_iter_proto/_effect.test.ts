import { describe, it, expect } from "vitest";
import "../_test/setup";

import {
  Anim, frame, sleep, drive, child, fromPromise, all, race, withTimeout, fromEvent,
  type Effect, type Animator,
} from "./effect";

const noop = (): void => {};

describe("effect / engine basics", () => {
  it("yield frame parks 1 step, resumes with dt", () => {
    const anim = new Anim();
    let dt: number | undefined;
    anim.run(function* () { dt = yield frame; });
    anim.step(0.025);
    expect(dt).toBeCloseTo(0.025, 9);
    anim.stop();
  });

  it("yield sleep(s) parks until elapsed", () => {
    const anim = new Anim();
    let woke = false;
    anim.run(function* () { yield sleep(0.1); woke = true; });
    anim.step(0.05); expect(woke).toBe(false);
    anim.step(0.06); expect(woke).toBe(true);
    anim.stop();
  });

  it("sleep(0) wakes synchronously", () => {
    const anim = new Anim();
    let after = false;
    anim.run(function* () { yield sleep(0); after = true; });
    expect(after).toBe(true);
    anim.stop();
  });

  it("yield* delegates (sequential)", () => {
    const anim = new Anim();
    let order = "";
    function* a(): Animator { order += "a"; yield frame; order += "A"; }
    function* b(): Animator { order += "b"; yield frame; order += "B"; }
    anim.run(function* () { yield* a(); yield* b(); });
    anim.step(1 / 60); anim.step(1 / 60);
    expect(order).toBe("aAbB");
    anim.stop();
  });

  it("drive accumulates dt, completes on false", () => {
    const anim = new Anim();
    let acc = 0;
    anim.run(function* () {
      yield drive((dt) => { acc += dt; if (acc >= 0.5) return false; });
    });
    for (let i = 0; i < 60; i++) anim.step(1 / 60);
    expect(acc).toBeGreaterThanOrEqual(0.5);
    anim.stop();
  });
});

describe("effect / composition", () => {
  it("all waits for every effect", () => {
    const anim = new Anim();
    let got: number[] | undefined;
    anim.run(function* () {
      got = (yield all([sleep(0.1), sleep(0.2)])) as number[];
    });
    anim.step(0.15); expect(got).toBeUndefined();
    anim.step(0.1);  expect(got!.length).toBe(2);
    anim.stop();
  });

  it("all([]) wakes synchronously with []", () => {
    const anim = new Anim();
    let got: any;
    anim.run(function* () { got = yield all([]); });
    expect(got).toEqual([]);
    anim.stop();
  });

  it("race resolves with the first; cancels the rest", () => {
    const anim = new Anim();
    let cancelledLate = false;
    const slow: Effect<string> = (wake, a) => {
      const off = a.onFrame((dt) => {});
      return () => { cancelledLate = true; off(); };
    };
    let first: any;
    anim.run(function* () {
      first = yield race([sleep(0.05), slow]);
    });
    anim.step(0.1);
    expect(first).toBeCloseTo(0.1, 5);
    expect(cancelledLate).toBe(true);
    anim.stop();
  });

  it("withTimeout returns ok when fast", () => {
    const anim = new Anim();
    let r: any;
    anim.run(function* () { r = yield withTimeout(sleep(0.05), 1.0); });
    anim.step(0.1);
    expect(r.kind).toBe("ok");
    anim.stop();
  });

  it("withTimeout returns timeout when slow", () => {
    const anim = new Anim();
    let r: any;
    anim.run(function* () { r = yield withTimeout(sleep(2.0), 0.1); });
    anim.step(0.2);
    expect(r.kind).toBe("timeout");
    anim.stop();
  });

  it("child runs sibling, returns its R", () => {
    const anim = new Anim();
    let got: any;
    function* sub(): Animator<number> { yield frame; return 42; }
    anim.run(function* () { got = yield child(sub()); });
    anim.step(1 / 60);
    expect(got).toBe(42);
    anim.stop();
  });
});

describe("effect / promise sugar", () => {
  it("yield Promise resolves and resumes", async () => {
    const anim = new Anim();
    let v: any;
    anim.run(function* () { v = yield Promise.resolve(7); });
    await Promise.resolve(); await Promise.resolve();
    expect(v).toBe(7);
    anim.stop();
  });

  it("fromPromise is the explicit form", async () => {
    const anim = new Anim();
    let v: any;
    anim.run(function* () { v = yield fromPromise(Promise.resolve("hi")); });
    await Promise.resolve(); await Promise.resolve();
    expect(v).toBe("hi");
    anim.stop();
  });
});

describe("effect / cancel cascade", () => {
  it("cancelling parent disposes effect", () => {
    const anim = new Anim();
    let disposed = false;
    const subscribe: Effect<void> = () => () => { disposed = true; };
    const stop = anim.run(function* () { yield subscribe; });
    stop();
    expect(disposed).toBe(true);
    anim.stop();
  });

  it("cancelling parent cascades to child(g)", () => {
    const anim = new Anim();
    let leafFinally = false;
    function* leaf(): Animator {
      try { yield ((wake) => () => {}) as Effect<void>; }
      finally { leafFinally = true; }
    }
    const stop = anim.run(function* () { yield child(leaf()); });
    stop();
    expect(leafFinally).toBe(true);
    anim.stop();
  });

  it("cancelling parent cascades through all([…])", () => {
    const anim = new Anim();
    let aFin = false, bFin = false;
    function* leaf(flag: () => void): Animator {
      try { yield (() => () => {}) as Effect<void>; }
      finally { flag(); }
    }
    const stop = anim.run(function* () {
      yield all([child(leaf(() => { aFin = true; })), child(leaf(() => { bFin = true; }))]);
    });
    stop();
    expect(aFin).toBe(true);
    expect(bFin).toBe(true);
    anim.stop();
  });
});

describe("effect / fromEvent (subscription)", () => {
  it("resumes on first emission and unsubscribes", () => {
    const anim = new Anim();
    let v: any;
    let unsubbed = false;
    let emit!: (n: number) => void;
    anim.run(function* () {
      v = yield fromEvent<number>((cb) => { emit = cb; return () => { unsubbed = true; }; });
    });
    expect(emit).toBeDefined();
    emit(99);
    expect(v).toBe(99);
    expect(unsubbed).toBe(true);
    anim.stop();
  });
});

describe("effect / error handling", () => {
  it("throw in gen is routed to onError, others continue", () => {
    const anim = new Anim();
    let other = false;
    let captured: unknown;
    anim.onError = (e) => { captured = e; };
    anim.run(function* () { throw new Error("boom"); });
    anim.run(function* () { yield frame; other = true; });
    anim.step(1 / 60);
    expect((captured as Error).message).toBe("boom");
    expect(other).toBe(true);
    anim.stop();
  });
});
