// Anim runtime tests. Covers the full yield contract, the runtime's
// re-entrancy / sync-resolve / error-isolation guarantees, and the
// drive() integration. One file because there's one engine.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Anim,
  suspend,
  drive,
  detach,
  type Animator,
} from "@minim/core";

describe("yield contract", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("yield; parks one frame", () => {
    let log = "";
    function* g(): any { log += "a"; yield; log += "b"; }
    anim.start(g());
    expect(log).toBe("a");
    anim.step(0.016);
    expect(log).toBe("ab");
  });

  it("the resume value of a frame yield is a Tick", () => {
    let saw: { dt: number; elapsed: number } | undefined;
    function* g(): any { saw = yield; }
    anim.start(g());
    anim.step(0.025);
    expect(saw!.dt).toBeCloseTo(0.025, 9);
    expect(saw!.elapsed).toBeCloseTo(0.025, 9);
  });

  it("sleep wake reports sub-frame dt (only time owed since wake)", () => {
    // Gen sleeps until t=0.05. Steps 0.04 then 0.02 — wakes mid-second-step
    // (clock crosses 0.05 at +0.01 into a 0.02 dt). Effective dt = 0.01.
    let saw: { dt: number; elapsed: number } | undefined;
    function* g(): any { saw = yield 0.05; }
    anim.start(g());
    anim.step(0.04);
    expect(saw).toBeUndefined();
    anim.step(0.02);
    expect(saw!.dt).toBeCloseTo(0.01, 9);
    expect(saw!.elapsed).toBeCloseTo(0.06, 9);
  });

  it("repeated parking ticks once per frame", () => {
    let n = 0;
    function* g(): any { while (true) { yield; n++; } }
    anim.start(g());
    for (let i = 0; i < 10; i++) anim.step(0.016);
    expect(n).toBe(10);
  });

  it("yield N sleeps for ~N seconds", () => {
    let woke = false;
    function* g(): any { yield 0.1; woke = true; }
    anim.start(g());
    anim.step(0.05); expect(woke).toBe(false);
    anim.step(0.06); anim.step(0.001);
    expect(woke).toBe(true);
  });

  it("yield 0 parks (same as `yield`; no tail-call special case)", () => {
    let order = "";
    function* g(): any { order += "a"; yield 0; order += "b"; }
    anim.start(g());
    expect(order).toBe("a");
    anim.step(0.016);
    expect(order).toBe("ab");
  });

  it("yield N < 0 parks (same as `yield`)", () => {
    let order = "";
    function* g(): any { order += "a"; yield -1; order += "b"; }
    anim.start(g());
    expect(order).toBe("a");
    anim.step(0.016);
    expect(order).toBe("ab");
  });

  it("sleep across many small frames is FP-safe", () => {
    let woke = false;
    function* g(): any { yield 1.0; woke = true; }
    anim.start(g());
    for (let i = 0; i < 999; i++) anim.step(0.001);
    expect(woke).toBe(false);
    anim.step(0.001); anim.step(0.001);
    expect(woke).toBe(true);
  });

  it("yield* sequences and propagates returns", () => {
    let v: number | undefined;
    function* child(): any { yield; return 42; }
    function* parent(): any { v = yield* child(); }
    anim.start(parent());
    anim.step(0.016); anim.step(0.016);
    expect(v).toBe(42);
  });

  it("deep yield* chain (depth 8) ticks the leaf", () => {
    let leafTicks = 0;
    function* leaf(): any { leafTicks++; yield; }
    function makeChain(d: number): () => any {
      let cur: () => any = leaf;
      for (let i = 0; i < d; i++) {
        const inner = cur;
        cur = function* (): any { yield* inner(); };
      }
      return cur;
    }
    anim.start(makeChain(8)());
    anim.step(0.016);
    expect(leafTicks).toBe(1);
  });

  it("yield [a, b] runs in parallel; resumes when all complete", () => {
    let done = false;
    function* a(): any { yield; }
    function* b(): any { yield; yield; }
    function* g(): any { yield [a(), b()]; done = true; }
    anim.start(g());
    anim.step(0.016); expect(done).toBe(false);
    anim.step(0.016); expect(done).toBe(true);
  });

  it("yield [] sync-completes", () => {
    let done = false;
    function* g(): any { yield [] as any; done = true; }
    anim.start(g());
    expect(done).toBe(true);
  });

  it("yield [...20] handles many parallel children", () => {
    const N = 20;
    let done = false;
    function* leaf(): any { yield; }
    function* g(): any {
      const kids = Array.from({ length: N }, () => leaf());
      yield kids; done = true;
    }
    anim.start(g());
    anim.step(0.016); anim.step(0.016);
    expect(done).toBe(true);
  });

  it("yield childGen waits for child completion (single-child fast path)", () => {
    let after = false;
    function* child(): any { yield; yield; }   // two-frame child
    function* g(): any { yield child(); after = true; }
    anim.start(g());
    anim.step(0.016); expect(after).toBe(false);   // child still on its 2nd yield
    anim.step(0.016); expect(after).toBe(true);    // child completes; parent advances
  });
});

describe("suspend / wake", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("delivers payload via wake", () => {
    let received: number | undefined;
    let storedWake: ((v: number) => void) | undefined;
    function* g(): any {
      const v = yield* suspend<number>((wake) => { storedWake = wake; return () => {}; });
      received = v;
    }
    anim.start(g());
    storedWake!(7);
    expect(received).toBe(7);
  });

  it("sync wake during subscribe advances immediately", () => {
    let after = false;
    function* g(): any {
      yield* suspend<void>((wake) => { wake(); return () => {}; });
      after = true;
    }
    anim.start(g());
    expect(after).toBe(true);
  });

  it("double wake — second is ignored", () => {
    let n = 0;
    let storedWake: (() => void) | undefined;
    function* g(): any {
      yield* suspend<void>((w) => { storedWake = w; return () => {}; });
      n++;
      yield* suspend<void>(() => () => {});
    }
    anim.start(g());
    storedWake!(); storedWake!();
    expect(n).toBe(1);
  });

  it("wake fired during another wake doesn't crash", () => {
    let wA: (() => void) | undefined;
    let wB: (() => void) | undefined;
    let aResumed = false, bResumed = false;
    function* a(): any {
      yield* suspend<void>((w) => { wA = w; return () => {}; });
      aResumed = true;
      if (wB) wB();
    }
    function* b(): any {
      yield* suspend<void>((w) => { wB = w; return () => {}; });
      bResumed = true;
    }
    anim.start(a()); anim.start(b());
    wA!();
    expect(aResumed).toBe(true);
    expect(bResumed).toBe(true);
  });

  it("multiple sync-wake suspends in a row", () => {
    let n = 0;
    function* g(): any {
      for (let i = 0; i < 5; i++) {
        yield* suspend<void>((w) => { w(); return () => {}; });
        n++;
      }
    }
    anim.start(g());
    expect(n).toBe(5);
  });

  it("wake after stop is a no-op", () => {
    let storedWake: (() => void) | undefined;
    let advanced = false;
    function* g(): any {
      yield* suspend<void>((w) => { storedWake = w; return () => {}; });
      advanced = true;
    }
    anim.start(g());
    anim.stop();
    storedWake!();
    expect(advanced).toBe(false);
  });
});

describe("cancel", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("dispose cancels and runs Suspend dispose", () => {
    let disposed = false;
    function* g(): any { yield* suspend<void>(() => () => { disposed = true; }); }
    const d = anim.start(g());
    anim.step(0.016);
    d();
    expect(disposed).toBe(true);
  });

  it("runs try/finally in the cancelled gen", () => {
    let cleaned = false;
    function* g(): any {
      try { yield* suspend<void>(() => () => {}); }
      finally { cleaned = true; }
    }
    const d = anim.start(g());
    d();
    expect(cleaned).toBe(true);
  });

  it("cascades try/finally through deep yield* (depth 3)", () => {
    let leaf = false, mid = false, parent = false;
    function* gLeaf(): any {
      try { yield* suspend<void>(() => () => {}); } finally { leaf = true; }
    }
    function* gMid(): any { try { yield* gLeaf(); } finally { mid = true; } }
    function* gParent(): any { try { yield* gMid(); } finally { parent = true; } }
    const d = anim.start(gParent());
    anim.step(0.016);
    d();
    expect(leaf).toBe(true);
    expect(mid).toBe(true);
    expect(parent).toBe(true);
  });

  it("dispose called twice is idempotent", () => {
    let cleaned = 0;
    function* g(): any { try { yield* suspend(() => () => {}); } finally { cleaned++; } }
    const d = anim.start(g());
    d(); d(); d();
    expect(cleaned).toBe(1);
  });

  it("self-cancel via captured disposer (during own subscribe)", () => {
    let after = 0;
    let dispose: (() => void) | undefined;
    function* g(): any {
      yield* suspend<void>((_w) => { dispose!(); return () => {}; });
      after++;
    }
    dispose = anim.start(g());
    expect(after).toBe(0);
  });

  it("self-cancel mid-frame: sync code after dispose still runs (until next yield)", () => {
    let after = 0;
    let afterMore = 0;
    let dispose: (() => void) | undefined;
    function* g(): any {
      yield;
      dispose!();
      after++;
      yield;
      afterMore++;
    }
    dispose = anim.start(g());
    anim.step(0.016);
    expect(after).toBe(1);
    anim.step(0.016);
    expect(afterMore).toBe(0);
  });

  it("parent cancel cascades to children spawned via yield-array", () => {
    let leafDisposed = false;
    function* leaf(): any {
      try { yield* suspend(() => () => {}); } finally { leafDisposed = true; }
    }
    function* parent(): any { yield [leaf(), leaf()]; }
    const d = anim.start(parent());
    anim.step(0.016);
    d();
    expect(leafDisposed).toBe(true);
  });

  it("stop() during a step doesn't lose pending cancels", () => {
    let cleaned = 0;
    function* g(): any { try { yield; } finally { cleaned++; } }
    anim.start(g()); anim.start(g()); anim.start(g());
    anim.stop();
    expect(cleaned).toBe(3);
  });

  it("running stop() inside a cancel cleanup doesn't crash", () => {
    function* g(): any {
      try { yield* suspend(() => () => {}); }
      finally { anim.stop(); }
    }
    const d = anim.start(g());
    expect(() => d()).not.toThrow();
  });
});

describe("error isolation", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("error in one gen doesn't halt others", () => {
    const orig = console.error; console.error = () => {};
    try {
      let other = false;
      function* bad(): any { throw new Error("boom"); yield; }
      function* good(): any { yield; other = true; }
      anim.start(bad());
      anim.start(good());
      anim.step(0.016);
      expect(other).toBe(true);
    } finally { console.error = orig; }
  });

  it("error in child gen doesn't poison parent", () => {
    const orig = console.error; console.error = () => {};
    try {
      let parentDone = false;
      function* bad(): any { yield; throw new Error("child boom"); }
      function* parent(): any {
        try { yield* bad(); } catch { /* swallow */ }
        parentDone = true;
      }
      anim.start(parent());
      anim.step(0.016); anim.step(0.016);
      expect(parentDone).toBe(true);
    } finally { console.error = orig; }
  });

  it("drive cb that throws is isolated", () => {
    const orig = console.error; console.error = () => {};
    try {
      let other = 0;
      anim.start(drive(() => { throw new Error("drive boom"); }));
      anim.start(drive(() => { other++; }));
      anim.step(1 / 60); anim.step(1 / 60);
      expect(other).toBeGreaterThan(0);
    } finally { console.error = orig; }
  });
});

describe("drive", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("accumulates dt", () => {
    let acc = 0;
    anim.start(drive((tick) => { acc += tick.dt; }));
    for (let i = 0; i < 10; i++) anim.step(0.1);
    expect(acc).toBeCloseTo(1.0, 9);
  });

  it("completes on returning false", () => {
    let n = 0;
    anim.start(drive(() => { n++; if (n >= 3) return false; }));
    for (let i = 0; i < 10; i++) anim.step(1 / 60);
    expect(n).toBe(3);
  });

  it("cancel mid-flight stops the cb firing", () => {
    let n = 0;
    const d = anim.start(drive(() => { n++; }));
    anim.step(1 / 60); anim.step(1 / 60);
    const at = n;
    d();
    anim.step(1 / 60); anim.step(1 / 60); anim.step(1 / 60);
    expect(n).toBe(at);
  });

  it("`t` is time since registration", () => {
    let lastT = 0;
    anim.start(drive((_tick, t) => { lastT = t; }));
    anim.step(0.1); anim.step(0.1); anim.step(0.1);
    expect(lastT).toBeCloseTo(0.3, 9);
  });
});

describe("lifecycle", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("zero-dt step still ticks parked actives", () => {
    let n = 0;
    function* g(): any { while (true) { yield; n++; } }
    anim.start(g());
    anim.step(0); anim.step(0); anim.step(0);
    expect(n).toBe(3);
  });

  it("anim is reusable after stop", () => {
    let n = 0;
    function* g(): any { yield; n++; }
    anim.start(g()); anim.step(0.016);
    anim.stop();
    expect(n).toBe(1);
    anim.start(g()); anim.step(0.016);
    expect(n).toBe(2);
  });

  it("clock is monotonic across stop/restart", () => {
    function* g(): any { while (true) yield; }
    anim.start(g());
    anim.step(0.5); anim.step(0.5);
    expect(anim.clock).toBeCloseTo(1.0, 9);
    anim.stop();
    // Clock survives stop — it's a wall-clock counter, not session state.
    expect(anim.clock).toBeCloseTo(1.0, 9);
    anim.start(g());
    anim.step(0.5);
    expect(anim.clock).toBeCloseTo(1.5, 9);
  });

  it("cancelling 1000 actives in a tight loop doesn't crash or leak", () => {
    const ds: Array<() => void> = [];
    function* g(): any { yield; }
    for (let i = 0; i < 1000; i++) ds.push(anim.start(g()));
    anim.step(0.016);
    for (const d of ds) d();
    anim.step(0.016);
    // sanity: nothing thrown, anim still usable
    expect(typeof anim.step).toBe("function");
  });
});

describe("composability", () => {
  it("race(gen, sleep) cancels inner after the time cap", async () => {
    // What used to be `withTimeout(0.1, slow())` is now just
    // `race(slow(), 0.1)` — a numeric sleep races against the work,
    // loser is cancelled. One concept (race) instead of two.
    const { race } = await import("@minim/core");
    const anim = new Anim();
    let cleaned = false;
    function* slow(): any {
      try { while (true) yield; } finally { cleaned = true; }
    }
    anim.start(race(slow(), 0.1));
    for (let i = 0; i < 20; i++) anim.step(0.02);
    expect(cleaned).toBe(true);
    anim.stop();
  });

  // record/replay/reverse/forks dropped from core (experiment cruft).
  // If we want them back, write minimal versions; the tests can return.
});

describe("detach", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("resumes parent immediately (does NOT park)", () => {
    let log = "";
    function* sub(): any { yield 999; }
    function* parent(): any {
      log += "before ";
      yield detach(sub());
      log += "after";
    }
    anim.start(parent());
    expect(log).toBe("before after");
  });

  it("survives parent cancel", () => {
    let subTicks = 0;
    function* sub(): any { while (true) { yield; subTicks++; } }
    function* parent(): any { yield detach(sub()); yield 999; }
    const stop = anim.start(parent());
    anim.step(0.016);
    expect(subTicks).toBe(1);
    stop();
    anim.step(0.016);
    expect(subTicks).toBe(2);
  });

  it("dies on engine.stop()", () => {
    let subTicks = 0;
    function* sub(): any { while (true) { yield; subTicks++; } }
    anim.start((function* () { yield detach(sub()); })());
    anim.step(0.016);
    expect(subTicks).toBe(1);
    anim.stop();
    anim.step(0.016);
    expect(subTicks).toBe(1);
  });
});

describe("onStep", () => {
  it("fires every step with dt; disposer unsubscribes", () => {
    const anim = new Anim();
    const dts: number[] = [];
    const off = anim.onStep((dt) => dts.push(dt));
    anim.step(0.016);
    anim.step(0.02);
    off();
    anim.step(0.03);
    expect(dts).toEqual([0.016, 0.02]);
    anim.stop();
  });

  it("multiple subscribers fire in order; safe across throws", () => {
    const anim = new Anim();
    anim.onError = () => {};
    const calls: string[] = [];
    anim.onStep(() => { calls.push("a"); });
    anim.onStep(() => { calls.push("b"); throw new Error("boom"); });
    anim.onStep(() => { calls.push("c"); });
    anim.step(0.016);
    expect(calls).toEqual(["a", "b", "c"]);
    anim.stop();
  });
});

describe("composition", () => {
  it("yield [number, gen] mixes sleeps and gens in parallel", () => {
    const anim = new Anim();
    let order = "";
    function* gen(): any { order += "gen-start "; yield; order += "gen-end "; }
    function* g(): any { order += "before "; yield [0.05, gen()]; order += "after"; }
    anim.start(g());
    expect(order).toBe("before gen-start ");
    anim.step(0.05);
    anim.step(0.001);
    expect(order).toBe("before gen-start gen-end after");
    anim.stop();
  });
});

describe("re-entry", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("anim.start() inside a gen body adds active for next frame", () => {
    let childRan = false;
    function* child(): any { yield; childRan = true; }
    function* parent(): any {
      anim.start(child());
      yield;
    }
    anim.start(parent());
    expect(childRan).toBe(false);
    anim.step(0.016);
    anim.step(0.016);
    expect(childRan).toBe(true);
  });

  it("anim.step() during a step throws (re-entry guard)", () => {
    let innerError: unknown = null;
    function* outer(): any {
      yield;
      try { anim.step(0.016); }
      catch (e) { innerError = e; }
    }
    anim.start(outer());
    anim.step(0.016);
    expect(innerError).not.toBeNull();
    expect(String(innerError)).toMatch(/re-?entrant|in.?progress|step/);
  });

});
