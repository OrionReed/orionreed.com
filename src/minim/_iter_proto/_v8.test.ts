import { describe, it, expect } from "vitest";
import "../_test/setup";

import {
  Anim, drive, race, withTimeout, ignoreErrors, fromEvent, tracedAnim,
  type SuspendFn, type Animator,
} from "./v8";

// ───────────────────────── yield contract ─────────────────────────

describe("v8 / yield contract", () => {
  it("yield; parks 1 frame, resumes with dt", () => {
    const a = new Anim();
    let dt: any;
    a.run(function* () { dt = yield; });
    a.step(0.025);
    expect(dt).toBeCloseTo(0.025, 9);
  });
  it("yield N parks N seconds, resumes with frame dt", () => {
    const a = new Anim();
    let woke = false, dt: any;
    a.run(function* () { dt = yield 0.1; woke = true; });
    a.step(0.05); expect(woke).toBe(false);
    a.step(0.06); expect(woke).toBe(true);
    expect(dt).toBeCloseTo(0.06, 9);
  });
  it("yield 0 sync tail-call, resumes with 0", () => {
    const a = new Anim();
    let v: any;
    a.run(function* () { v = yield 0; });
    expect(v).toBe(0);
  });
  it("yield childGen resumes with R", () => {
    const a = new Anim();
    let v: any;
    function* sub(): Animator<number> { yield; return 42; }
    a.run(function* () { v = yield sub(); });
    a.step(1 / 60);
    expect(v).toBe(42);
  });
  it("yield* delegates and propagates return", () => {
    const a = new Anim();
    let v: any;
    function* sub(): Animator<string> { yield; return "ok"; }
    a.run(function* () { v = yield* sub(); });
    a.step(1 / 60);
    a.step(1 / 60); // one more tick to settle
    expect(v).toBe("ok");
  });
  it("yield [a, b] resumes with tuple", () => {
    const a = new Anim();
    let r: any;
    function* x(): Animator<string> { yield; return "x"; }
    function* y(): Animator<string> { yield; yield; return "y"; }
    a.run(function* () { r = yield [x(), y()]; });
    a.step(1 / 60); a.step(1 / 60);
    expect(r).toEqual(["x", "y"]);
  });
  it("yield [] resumes with []", () => {
    const a = new Anim();
    let r: any;
    a.run(function* () { r = yield [] as any; });
    expect(r).toEqual([]);
  });
});

// ───────────────────────── model-a errors ─────────────────────────

describe("v8 / model-a error propagation", () => {
  it("yield childGen() — child throw propagates to parent's try/catch", () => {
    const a = new Anim();
    a.onError = () => {};
    let caught: any, after = false;
    function* bad(): Animator { throw new Error("boom"); yield; }
    a.run(function* () {
      try { yield bad(); } catch (e) { caught = e; }
      after = true;
    });
    a.step(0);
    expect((caught as Error).message).toBe("boom");
    expect(after).toBe(true);
  });

  it("yield [bad, ok] — first error cancels siblings, throws to parent", () => {
    const a = new Anim();
    a.onError = () => {};
    let caught: any, sibFin = false;
    function* bad(): Animator { yield; throw new Error("boom"); }
    function* ok(): Animator {
      try { yield 1.0; } finally { sibFin = true; }
    }
    a.run(function* () {
      try { yield [bad(), ok()]; } catch (e) { caught = e; }
    });
    a.step(0.016); // both spawned, bad throws on its second tick
    expect((caught as Error).message).toBe("boom");
    expect(sibFin).toBe(true);
  });

  it("yield Promise.reject(e) throws to parent (matches await)", async () => {
    const a = new Anim();
    a.onError = () => {};
    let caught: any;
    a.run(function* () {
      try { yield Promise.reject(new Error("nope")); }
      catch (e) { caught = e; }
    });
    await Promise.resolve(); await Promise.resolve();
    expect((caught as Error).message).toBe("nope");
  });

  it("uncaught errors bubble to anim.onError at root", () => {
    const a = new Anim();
    let captured: any;
    a.onError = (e) => { captured = e; };
    a.run(function* () { throw new Error("unhandled"); });
    a.step(0);
    expect((captured as Error).message).toBe("unhandled");
  });

  it("ignoreErrors wrapper swallows", () => {
    const a = new Anim();
    let v: any;
    function* bad(): Animator<number> { throw new Error("x"); yield; return 1; }
    a.run(function* () { v = yield* ignoreErrors(bad()); });
    a.step(0);
    expect(v).toBeUndefined();
  });
});

// ───────────────────────── cancel (gen.return) is silent ─────────────────────────

describe("v8 / cancel is distinct from error", () => {
  it("dispose calls gen.return — try/finally runs, no throw", () => {
    const a = new Anim();
    let finallyRan = false, errCaught: any;
    function* g(): Animator {
      try { yield (() => () => {}) as SuspendFn<void>; }
      catch (e) { errCaught = e; }
      finally { finallyRan = true; }
    }
    const stop = a.run(g);
    a.step(0.016);
    stop();
    expect(finallyRan).toBe(true);
    expect(errCaught).toBeUndefined();
  });

  it("cancel cascades to children but doesn't throw", () => {
    const a = new Anim();
    let leafFin = false, leafErr: any;
    function* leaf(): Animator {
      try { yield (() => () => {}) as SuspendFn<void>; }
      catch (e) { leafErr = e; }
      finally { leafFin = true; }
    }
    const stop = a.run(function* () { yield leaf(); });
    a.step(0.016);
    stop();
    expect(leafFin).toBe(true);
    expect(leafErr).toBeUndefined();
  });
});

// ───────────────────────── combinators ─────────────────────────

describe("v8 / drive + race + withTimeout", () => {
  it("drive accumulates dt, completes on false", () => {
    const a = new Anim();
    let acc = 0;
    a.run(function* () { yield* drive((dt) => { acc += dt; if (acc >= 0.5) return false; }); });
    for (let i = 0; i < 60; i++) a.step(1 / 60);
    expect(acc).toBeGreaterThanOrEqual(0.5);
  });

  it("race resolves with first; siblings cancel", () => {
    const a = new Anim();
    let r: any, slowFin = false;
    function* slow(): Animator<string> {
      try { yield 1.0; return "slow"; } finally { slowFin = true; }
    }
    function* fast(): Animator<string> { yield 0.05; return "fast"; }
    a.run(function* () { r = yield race([slow(), fast()]); });
    a.step(0.1);
    expect(r).toBe("fast");
    expect(slowFin).toBe(true);
  });

  it("withTimeout returns ok when fast", () => {
    const a = new Anim();
    let r: any;
    function* fast(): Animator<number> { yield 0.05; return 42; }
    a.run(function* () { r = yield* withTimeout(fast(), 1.0); });
    a.step(0.1);
    expect(r).toEqual({ kind: "ok", value: 42 });
  });

  it("withTimeout returns timeout when slow", () => {
    const a = new Anim();
    let r: any;
    function* slow(): Animator<number> { yield 5.0; return 99; }
    a.run(function* () { r = yield* withTimeout(slow(), 0.1); });
    a.step(0.2);
    expect(r.kind).toBe("timeout");
  });
});

// ───────────────────────── observer + tracedAnim ─────────────────────────

describe("v8 / observer + tracedAnim", () => {
  it("observer sees spawn/complete with parent linkage", () => {
    const a = new Anim();
    const events: any[] = [];
    a.observer = {
      spawn(id, parentId) { events.push(["spawn", id, parentId]); },
      complete(id, v) { events.push(["complete", id, v]); },
    };
    function* child(): Animator<number> { yield; return 7; }
    a.run(function* () { yield child(); });
    a.step(1 / 60);
    const spawns = events.filter((e) => e[0] === "spawn");
    expect(spawns.length).toBe(2);
    expect(spawns[0][2]).toBe(null); // root
    expect(spawns[1][2]).toBe(spawns[0][1]); // child's parent = root's id
  });

  it("observer sees error", () => {
    const a = new Anim();
    a.onError = () => {};
    const events: any[] = [];
    a.observer = { error(id, err) { events.push(["error", id, (err as Error).message]); } };
    a.run(function* () { throw new Error("oops"); });
    a.step(0);
    expect(events).toEqual([["error", 1, "oops"]]);
  });

  it("observer sees cancel distinct from complete/error", () => {
    const a = new Anim();
    const kinds: string[] = [];
    a.observer = {
      complete(id) { kinds.push("complete:" + id); },
      cancel(id) { kinds.push("cancel:" + id); },
      error(id) { kinds.push("error:" + id); },
    };
    const stop = a.run(function* () { yield (() => () => {}) as SuspendFn<void>; });
    stop();
    expect(kinds).toEqual(["cancel:1"]);
  });

  it("tracedAnim collects spans with parent links", () => {
    const a = tracedAnim();
    function* child(): Animator<number> { yield; return 7; }
    a.run(function* () { yield child(); });
    a.step(1 / 60);
    expect(a.spans.size).toBe(2);
    const root = [...a.spans.values()].find((s) => s.parentId === null)!;
    const kid = [...a.spans.values()].find((s) => s.parentId === root.id)!;
    expect(kid.status).toBe("complete");
    expect(kid.value).toBe(7);
    expect(root.status).toBe("complete");
  });
});

// ───────────────────────── Promise sugar ─────────────────────────

describe("v8 / Promise", () => {
  it("yield Promise resolves and resumes", async () => {
    const a = new Anim();
    let v: any;
    a.run(function* () { v = yield Promise.resolve(7); });
    await Promise.resolve(); await Promise.resolve();
    expect(v).toBe(7);
  });

  it("yield [Promise, Promise] resolves with tuple", async () => {
    const a = new Anim();
    let r: any;
    a.run(function* () { r = yield [Promise.resolve(1), Promise.resolve(2)]; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(r).toEqual([1, 2]);
  });
});

// ───────────────────────── fromEvent ─────────────────────────

describe("v8 / fromEvent", () => {
  it("resumes on first emission and unsubscribes", () => {
    const a = new Anim();
    let v: any, unsubbed = false, emit!: (n: number) => void;
    a.run(function* () {
      v = yield fromEvent<number>((cb) => { emit = cb; return () => { unsubbed = true; }; });
    });
    emit(99);
    expect(v).toBe(99);
    expect(unsubbed).toBe(true);
  });
});
