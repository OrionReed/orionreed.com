import { describe, it, expect } from "vitest";
import "../_test/setup";
import { Anim, TracedAnim, drive, ignoreErrors, fromEvent, type Animator, type SuspendFn } from "./v9_lean";

describe("v9 / yield contract + start/stop/step/onStep", () => {
  it("start + step", () => {
    const a = new Anim();
    let dt: any;
    a.start(function* () { dt = yield; });
    a.step(0.025);
    expect(dt).toBeCloseTo(0.025, 9);
  });

  it("yield N sleeps", () => {
    const a = new Anim();
    let woke = false;
    a.start(function* () { yield 0.1; woke = true; });
    a.step(0.05); expect(woke).toBe(false);
    a.step(0.06); expect(woke).toBe(true);
  });

  it("yield childGen returns R", () => {
    const a = new Anim();
    let v: any;
    function* sub(): Animator<number> { yield; return 42; }
    a.start(function* () { v = yield sub(); });
    a.step(1 / 60);
    expect(v).toBe(42);
  });

  it("yield [a, b] returns tuple", () => {
    const a = new Anim();
    let r: any;
    function* x(): Animator<string> { yield; return "x"; }
    function* y(): Animator<string> { yield; yield; return "y"; }
    a.start(function* () { r = yield [x(), y()]; });
    a.step(1 / 60); a.step(1 / 60);
    expect(r).toEqual(["x", "y"]);
  });

  it("model-a: yield childGen propagates throw", () => {
    const a = new Anim();
    a.onError = () => {};
    let caught: any;
    function* bad(): Animator { throw new Error("boom"); yield; }
    a.start(function* () { try { yield bad(); } catch (e) { caught = e; } });
    a.step(0);
    expect((caught as Error).message).toBe("boom");
  });

  it("yield Promise resolves", async () => {
    const a = new Anim();
    let v: any;
    a.start(function* () { v = yield Promise.resolve(7); });
    await Promise.resolve(); await Promise.resolve();
    expect(v).toBe(7);
  });

  it("cancel runs try/finally without throw", () => {
    const a = new Anim();
    let fin = false, err: any;
    const stop = a.start(function* () {
      try { yield (() => () => {}) as SuspendFn<void>; }
      catch (e) { err = e; }
      finally { fin = true; }
    });
    stop();
    expect(fin).toBe(true);
    expect(err).toBeUndefined();
  });

  it("drive (no ticker fast path)", () => {
    const a = new Anim();
    let acc = 0;
    a.start(function* () { yield* drive((dt) => { acc += dt; if (acc >= 0.5) return false; }); });
    for (let i = 0; i < 60; i++) a.step(1 / 60);
    expect(acc).toBeGreaterThanOrEqual(0.5);
  });

  it("onStep is sugar for drive", () => {
    const a = new Anim();
    let n = 0;
    const off = a.onStep(() => { n++; });
    for (let i = 0; i < 5; i++) a.step(1 / 60);
    off();
    a.step(1 / 60);
    expect(n).toBe(5);
  });

  it("ignoreErrors swallows", () => {
    const a = new Anim();
    let v: any;
    function* bad(): Animator<number> { throw new Error("x"); yield; return 1; }
    a.start(function* () { v = yield* ignoreErrors(bad()); });
    a.step(0);
    expect(v).toBeUndefined();
  });

  it("fromEvent resumes on first emission", () => {
    const a = new Anim();
    let v: any, emit!: (n: number) => void;
    a.start(function* () { v = yield fromEvent<number>((cb) => { emit = cb; return () => {}; }); });
    emit(99);
    expect(v).toBe(99);
  });
});

describe("v9 / TracedAnim", () => {
  it("captures parent linkage and timing", () => {
    const a = new TracedAnim();
    function* child(): Animator<number> { yield; return 7; }
    a.start(function* () { yield child(); });
    a.step(1 / 60);
    expect(a.spans.size).toBe(2);
    const root = [...a.spans.values()].find((s) => s.parentId === null)!;
    const kid = [...a.spans.values()].find((s) => s.parentId === root.id)!;
    expect(kid.status).toBe("complete");
    expect(kid.value).toBe(7);
    expect(root.status).toBe("complete");
  });

  it("captures cancel distinct from complete", () => {
    const a = new TracedAnim();
    const stop = a.start(function* () { yield (() => () => {}) as SuspendFn<void>; });
    stop();
    const root = [...a.spans.values()][0];
    expect(root.status).toBe("cancelled");
  });

  it("captures error", () => {
    const a = new TracedAnim();
    a.onError = () => {};
    a.start(function* () { throw new Error("oops"); });
    a.step(0);
    const root = [...a.spans.values()][0];
    expect(root.status).toBe("error");
  });
});
