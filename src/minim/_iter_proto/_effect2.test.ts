import { describe, it, expect } from "vitest";
import "../_test/setup";

import {
  Anim, drive, child, fromPromise, all, race, fromEvent,
  type Effect, type Animator,
} from "./effect2";

describe("effect2 / engine fast paths", () => {
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

describe("effect2 / composition", () => {
  it("all waits for all", () => {
    const anim = new Anim();
    let got: any;
    anim.run(function* () { got = yield all([child(g(0.1)), child(g(0.2))]); });
    function* g(s: number): Animator<number> { yield s; return s; }
    anim.step(0.15); expect(got).toBeUndefined();
    anim.step(0.1);  expect(got).toEqual([0.1, 0.2]);
    anim.stop();
  });

  it("race resolves with first", () => {
    const anim = new Anim();
    let r: any;
    function* g(s: number): Animator<string> { yield s; return `${s}`; }
    anim.run(function* () { r = yield race([child(g(0.1)), child(g(0.5))]); });
    anim.step(0.15);
    expect(r).toBe("0.1");
    anim.stop();
  });

  it("child returns R", () => {
    const anim = new Anim();
    let v: any;
    function* sub(): Animator<number> { yield; return 42; }
    anim.run(function* () { v = yield child(sub()); });
    anim.step(1 / 60);
    expect(v).toBe(42);
    anim.stop();
  });
});

describe("effect2 / yield Promise sugar", () => {
  it("yield Promise resolves and resumes", async () => {
    const anim = new Anim();
    let v: any;
    anim.run(function* () { v = yield Promise.resolve(7); });
    await Promise.resolve(); await Promise.resolve();
    expect(v).toBe(7);
    anim.stop();
  });
});

describe("effect2 / cancel cascade", () => {
  it("cancelling parent cascades to child", () => {
    const anim = new Anim();
    let leafFin = false;
    function* leaf(): Animator {
      try { yield (() => () => {}) as Effect<void>; }
      finally { leafFin = true; }
    }
    const stop = anim.run(function* () { yield child(leaf()); });
    stop();
    expect(leafFin).toBe(true);
    anim.stop();
  });

  it("cancelling parent cascades through all", () => {
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
    expect(aFin && bFin).toBe(true);
    anim.stop();
  });
});

describe("effect2 / fromEvent and error", () => {
  it("fromEvent resumes once and unsubscribes", () => {
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

  it("throw is routed to onError", () => {
    const anim = new Anim();
    let captured: unknown;
    anim.onError = (e) => { captured = e; };
    anim.run(function* () { throw new Error("boom"); });
    anim.step(0);
    expect((captured as Error).message).toBe("boom");
    anim.stop();
  });
});
