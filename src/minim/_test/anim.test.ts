// Anim runtime tests. Covers the full yield contract, the runtime's
// re-entrancy / sync-resolve / error-isolation guarantees, and the
// drive() and AnimObserver integrations. One file because there's
// one engine.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Anim,
  suspend,
  drive,
  detach,
  type AnimObserver,
  type Animator,
} from "@minim/core";

describe("yield contract", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("yield; parks one frame", () => {
    let log = "";
    function* g(): any { log += "a"; yield; log += "b"; }
    anim.start(g);
    expect(log).toBe("a");
    anim.step(0.016);
    expect(log).toBe("ab");
  });

  it("the resume value of a frame yield is dt", () => {
    let saw: number | undefined;
    function* g(): any { saw = yield; }
    anim.start(g);
    anim.step(0.025);
    expect(saw).toBeCloseTo(0.025, 9);
  });

  it("repeated parking ticks once per frame", () => {
    let n = 0;
    function* g(): any { while (true) { yield; n++; } }
    anim.start(g);
    for (let i = 0; i < 10; i++) anim.step(0.016);
    expect(n).toBe(10);
  });

  it("yield N sleeps for ~N seconds", () => {
    let woke = false;
    function* g(): any { yield 0.1; woke = true; }
    anim.start(g);
    anim.step(0.05); expect(woke).toBe(false);
    anim.step(0.06); anim.step(0.001);
    expect(woke).toBe(true);
  });

  it("yield 0 is a tail-call (no frame consumed)", () => {
    let order = "";
    function* g(): any { order += "a"; yield 0; order += "b"; }
    anim.start(g);
    expect(order).toBe("ab");
  });

  it("many tail-calls in one frame", () => {
    let n = 0;
    function* g(): any { for (let i = 0; i < 100; i++) { yield 0; n++; } }
    anim.start(g);
    expect(n).toBe(100);
  });

  it("sleep across many small frames is FP-safe", () => {
    let woke = false;
    function* g(): any { yield 1.0; woke = true; }
    anim.start(g);
    for (let i = 0; i < 999; i++) anim.step(0.001);
    expect(woke).toBe(false);
    anim.step(0.001); anim.step(0.001);
    expect(woke).toBe(true);
  });

  it("yield* sequences and propagates returns", () => {
    let v: number | undefined;
    function* child(): any { yield; return 42; }
    function* parent(): any { v = yield* child(); }
    anim.start(parent);
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
    anim.start(makeChain(8));
    anim.step(0.016);
    expect(leafTicks).toBe(1);
  });

  it("yield [a, b] runs in parallel; resumes when all complete", () => {
    let done = false;
    function* a(): any { yield; }
    function* b(): any { yield; yield; }
    function* g(): any { yield [a(), b()]; done = true; }
    anim.start(g);
    anim.step(0.016); expect(done).toBe(false);
    anim.step(0.016); expect(done).toBe(true);
  });

  it("yield [] sync-completes", () => {
    let done = false;
    function* g(): any { yield [] as any; done = true; }
    anim.start(g);
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
    anim.start(g);
    anim.step(0.016); anim.step(0.016);
    expect(done).toBe(true);
  });

  it("yield childGen waits for child completion (single-child fast path)", () => {
    let after = false;
    function* child(): any { yield; yield; }   // two-frame child
    function* g(): any { yield child(); after = true; }
    anim.start(g);
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
    anim.start(g);
    storedWake!(7);
    expect(received).toBe(7);
  });

  it("sync wake during subscribe advances immediately", () => {
    let after = false;
    function* g(): any {
      yield* suspend<void>((wake) => { wake(); return () => {}; });
      after = true;
    }
    anim.start(g);
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
    anim.start(g);
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
    anim.start(a); anim.start(b);
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
    anim.start(g);
    expect(n).toBe(5);
  });

  it("wake after stop is a no-op", () => {
    let storedWake: (() => void) | undefined;
    let advanced = false;
    function* g(): any {
      yield* suspend<void>((w) => { storedWake = w; return () => {}; });
      advanced = true;
    }
    anim.start(g);
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
    const d = anim.start(g);
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
    const d = anim.start(g);
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
    const d = anim.start(gParent);
    anim.step(0.016);
    d();
    expect(leaf).toBe(true);
    expect(mid).toBe(true);
    expect(parent).toBe(true);
  });

  it("dispose called twice is idempotent", () => {
    let cleaned = 0;
    function* g(): any { try { yield* suspend(() => () => {}); } finally { cleaned++; } }
    const d = anim.start(g);
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
    dispose = anim.start(g);
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
    dispose = anim.start(g);
    anim.step(0.016);
    expect(after).toBe(1);
    anim.step(0.016);
    expect(afterMore).toBe(0);
  });

  it("parent cancel cascades to child spawned via Suspend's spawn arg", () => {
    let leafDisposed = false;
    function* leaf(): any { yield* suspend(() => () => { leafDisposed = true; }); }
    function* parent(): any {
      yield* suspend((_w, spawn) => { spawn(leaf()); return () => {}; });
    }
    const d = anim.start(parent);
    anim.step(0.016);
    d();
    expect(leafDisposed).toBe(true);
  });

  it("parent cancel cascades to children spawned via yield-array", () => {
    let leafDisposed = false;
    function* leaf(): any {
      try { yield* suspend(() => () => {}); } finally { leafDisposed = true; }
    }
    function* parent(): any { yield [leaf(), leaf()]; }
    const d = anim.start(parent);
    anim.step(0.016);
    d();
    expect(leafDisposed).toBe(true);
  });

  it("stop() during a step doesn't lose pending cancels", () => {
    let cleaned = 0;
    function* g(): any { try { yield; } finally { cleaned++; } }
    anim.start(g); anim.start(g); anim.start(g);
    anim.stop();
    expect(cleaned).toBe(3);
  });

  it("running stop() inside a cancel cleanup doesn't crash", () => {
    function* g(): any {
      try { yield* suspend(() => () => {}); }
      finally { anim.stop(); }
    }
    const d = anim.start(g);
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
      anim.start(bad);
      anim.start(good);
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
      anim.start(parent);
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
    anim.start(drive((dt) => { acc += dt; }));
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
    anim.start(drive((_dt, t) => { lastT = t; }));
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
    anim.start(g);
    anim.step(0); anim.step(0); anim.step(0);
    expect(n).toBe(3);
  });

  it("anim is reusable after stop", () => {
    let n = 0;
    function* g(): any { yield; n++; }
    anim.start(g); anim.step(0.016);
    anim.stop();
    expect(n).toBe(1);
    anim.start(g); anim.step(0.016);
    expect(n).toBe(2);
  });

  it("clock resets to 0 on stop", () => {
    function* g(): any { while (true) yield; }
    anim.start(g);
    anim.step(0.5); anim.step(0.5);
    expect(anim.clock).toBeCloseTo(1.0, 9);
    anim.stop();
    expect(anim.clock).toBe(0);
  });

  it("cancelling 1000 actives in a tight loop doesn't crash or leak", () => {
    const ds: Array<() => void> = [];
    function* g(): any { yield; }
    for (let i = 0; i < 1000; i++) ds.push(anim.start(g));
    anim.step(0.016);
    for (const d of ds) d();
    anim.step(0.016);
    // sanity: nothing thrown, anim still usable
    expect(typeof anim.step).toBe("function");
  });
});

describe("AnimObserver", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("fires spawn/complete with monotonic ids", () => {
    const spans: Array<[string, number, number | undefined]> = [];
    const obs: AnimObserver = {
      spawn: (id, parentId) => spans.push(["spawn", id, parentId]),
      complete: (id) => spans.push(["complete", id, undefined]),
    };
    anim.observer = obs;
    function* g(): any { yield; }
    anim.start(g); anim.start(g);
    anim.step(0.016); anim.step(0.016);
    const spawns = spans.filter((s) => s[0] === "spawn");
    expect(spawns.length).toBe(2);
    expect(spawns[0][1]).toBe(1);
    expect(spawns[1][1]).toBe(2);
    expect(spans.filter((s) => s[0] === "complete").length).toBe(2);
  });

  it("fires cancel on dispose", () => {
    let cancels = 0;
    anim.observer = { cancel: () => cancels++ };
    function* g(): any { yield* suspend(() => () => {}); }
    const d = anim.start(g);
    d();
    expect(cancels).toBe(1);
  });

  it("links child to parent via parentId on spawn-from-suspend", () => {
    const spawns: Array<[number, number | undefined]> = [];
    anim.observer = { spawn: (id, parentId) => spawns.push([id, parentId]) };
    function* leaf(): any { yield; }
    function* parent(): any {
      yield* suspend((_w, spawn) => { spawn(leaf()); return () => {}; });
    }
    anim.start(parent);
    anim.step(0.016);
    expect(spawns.length).toBe(2);
    expect(spawns[0][1]).toBeUndefined();    // parent has no parentId
    expect(spawns[1][1]).toBe(spawns[0][0]); // leaf's parentId === parent's id
  });
});

describe("composability", () => {
  it("mapDt scales dt seen by the inner gen", async () => {
    const { mapDt } = await import("@minim/core");
    const anim = new Anim();
    let lastDt = 0;
    function* g(): any { while (true) { lastDt = yield; } }
    anim.start(mapDt((dt) => dt * 0.5, g()));
    anim.step(1.0);
    expect(lastDt).toBeCloseTo(0.5, 9);
    anim.stop();
  });

  it("mapDt(0, ...) freezes numeric `yield N` sleeps", async () => {
    // `at(0)` is the universal pause primitive: dt=0 stalls per-frame
    // drive callbacks AND wall-clock sleeps, because mapDt expands
    // numeric yields into per-frame accumulators that obey the scale.
    const { mapDt } = await import("@minim/core");
    const anim = new Anim();
    let done = false;
    function* g(): any { yield 1.0; done = true; }
    anim.start(mapDt(() => 0, g()));
    for (let i = 0; i < 200; i++) anim.step(0.016);
    expect(done).toBe(false);
    anim.stop();
  });

  it("mapDt with a reactive scale pauses and resumes a sleep", async () => {
    const { mapDt } = await import("@minim/core");
    const anim = new Anim();
    let done = false;
    let scale = 1;
    function* g(): any { yield 1.0; done = true; }
    anim.start(mapDt((dt) => dt * scale, g()));
    // Run halfway under scale=1.
    for (let i = 0; i < 30; i++) anim.step(1 / 60);
    expect(done).toBe(false);
    // Pause: 1000 frames pass, sleep doesn't progress.
    scale = 0;
    for (let i = 0; i < 1000; i++) anim.step(1 / 60);
    expect(done).toBe(false);
    // Resume: finishes after roughly the remaining half-second.
    scale = 1;
    for (let i = 0; i < 60; i++) anim.step(1 / 60);
    expect(done).toBe(true);
    anim.stop();
  });

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
    anim.start(parent);
    expect(log).toBe("before after");
  });

  it("survives parent cancel", () => {
    let subTicks = 0;
    function* sub(): any { while (true) { yield; subTicks++; } }
    function* parent(): any { yield detach(sub()); yield 999; }
    const stop = anim.start(parent);
    anim.step(0.016);
    expect(subTicks).toBe(1);
    stop();
    anim.step(0.016);
    expect(subTicks).toBe(2);
  });

  it("dies on engine.stop()", () => {
    let subTicks = 0;
    function* sub(): any { while (true) { yield; subTicks++; } }
    anim.start(function* () { yield detach(sub()); });
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
  it("drive composes with mapDt for time-scaling", async () => {
    const { mapDt } = await import("@minim/core");
    const anim = new Anim();
    let total = 0;
    anim.start(function* () {
      yield* mapDt((dt: number) => dt * 2, drive((dt) => { total += dt; }));
    });
    anim.step(0.05);
    anim.step(0.05);
    expect(total).toBeCloseTo(0.2, 9); // 2 * (0.05 + 0.05)
    anim.stop();
  });

  it("yield [number, gen] mixes sleeps and gens in parallel", () => {
    const anim = new Anim();
    let order = "";
    function* gen(): any { order += "gen-start "; yield; order += "gen-end "; }
    function* g(): any { order += "before "; yield [0.05, gen()]; order += "after"; }
    anim.start(g);
    expect(order).toBe("before gen-start ");
    anim.step(0.05);
    anim.step(0.001);
    expect(order).toBe("before gen-start gen-end after");
    anim.stop();
  });
});

describe("scope-scale (withScale)", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  // ── Basic withScale semantics ────────────────────────────────────────

  it("withScale(0.5, g) halves dt seen by g", async () => {
    const { withScale } = await import("@minim/core");
    const dts: number[] = [];
    function* g(): any { while (true) dts.push(yield); }
    anim.start(withScale(() => 0.5, g()));
    anim.step(0.1);
    anim.step(0.1);
    expect(dts[0]).toBeCloseTo(0.05, 9);
    expect(dts[1]).toBeCloseTo(0.05, 9);
  });

  it("withScale(0, g) pauses execution — gen body never runs after first yield", async () => {
    const { withScale } = await import("@minim/core");
    let ticks = 0;
    function* g(): any { while (true) { yield; ticks++; } }
    anim.start(withScale(() => 0, g()));
    for (let i = 0; i < 20; i++) anim.step(0.016);
    expect(ticks).toBe(0);
  });

  it("withScale(0, g) freezes numeric sleeps", async () => {
    const { withScale } = await import("@minim/core");
    let done = false;
    function* g(): any { yield 1.0; done = true; }
    anim.start(withScale(() => 0, g()));
    for (let i = 0; i < 200; i++) anim.step(0.016);
    expect(done).toBe(false);
  });

  it("withScale(2, g) doubles speed: 0.5s sleep finishes in ~0.25s real", async () => {
    const { withScale } = await import("@minim/core");
    let done = false;
    function* g(): any { yield 0.5; done = true; }
    anim.start(withScale(() => 2, g()));
    for (let i = 0; i < 14; i++) anim.step(1 / 60); // ~0.23s real — not done yet
    expect(done).toBe(false);
    for (let i = 0; i < 3; i++) anim.step(1 / 60);  // ~0.28s real — past 0.25s
    expect(done).toBe(true);
  });

  // ── Propagation through orchestration ────────────────────────────────

  it("withScale(0, race(a, b)) pauses both children", async () => {
    const { withScale, race } = await import("@minim/core");
    let log = "";
    function* a(): any { while (true) { yield; log += "a"; } }
    function* b(): any { while (true) { yield; log += "b"; } }
    anim.start(withScale(() => 0, race(a(), b())));
    for (let i = 0; i < 10; i++) anim.step(0.016);
    expect(log).toBe("");
  });

  it("withScale(0, race(a, b)) can be cancelled cleanly", async () => {
    const { withScale, race } = await import("@minim/core");
    let cleanedA = false, cleanedB = false;
    function* a(): any {
      try { while (true) yield; } finally { cleanedA = true; }
    }
    function* b(): any {
      try { while (true) yield; } finally { cleanedB = true; }
    }
    const stop = anim.start(withScale(() => 0, race(a(), b())));
    for (let i = 0; i < 5; i++) anim.step(0.016);
    stop();
    expect(cleanedA).toBe(true);
    expect(cleanedB).toBe(true);
  });

  it("withScale(0.5, race(a, b)) slows both children's timers", async () => {
    const { withScale, race } = await import("@minim/core");
    let done = false;
    function* a(): any { yield 0.2; done = true; }
    function* b(): any { while (true) yield; }
    anim.start(withScale(() => 0.5, race(a(), b())));
    // 15 frames × 1/60 ≈ 0.25s real → 0.125s local: not done
    for (let i = 0; i < 15; i++) anim.step(1 / 60);
    expect(done).toBe(false);
    // 25 more frames × 1/60 ≈ 0.67s total real → 0.33s local: past 0.2
    for (let i = 0; i < 25; i++) anim.step(1 / 60);
    expect(done).toBe(true);
  });

  it("withScale(0, yield [a, b]) pauses all parallel children", async () => {
    const { withScale } = await import("@minim/core");
    let ticks = 0;
    function* child(): any { while (true) { yield; ticks++; } }
    function* parent(): any { yield [child(), child()]; }
    anim.start(withScale(() => 0, parent()));
    for (let i = 0; i < 10; i++) anim.step(0.016);
    expect(ticks).toBe(0);
  });

  // ── Reactive scale ───────────────────────────────────────────────────

  it("reactive scale: pause then resume continues from where it stopped", async () => {
    const { withScale } = await import("@minim/core");
    let scale = 1;
    let ticks = 0;
    function* g(): any { while (true) { yield; ticks++; } }
    anim.start(withScale(() => scale, g()));
    anim.step(0.016); anim.step(0.016);
    expect(ticks).toBe(2);
    scale = 0;
    for (let i = 0; i < 100; i++) anim.step(0.016);
    expect(ticks).toBe(2);
    scale = 1;
    anim.step(0.016); anim.step(0.016);
    expect(ticks).toBe(4);
  });

  it("reactive scale: sleep resumes after pause without drift", async () => {
    const { withScale } = await import("@minim/core");
    let done = false;
    let scale = 1;
    function* g(): any { yield 1.0; done = true; }
    anim.start(withScale(() => scale, g()));
    for (let i = 0; i < 30; i++) anim.step(1 / 60);     // ~0.5s local
    expect(done).toBe(false);
    scale = 0;
    for (let i = 0; i < 1000; i++) anim.step(1 / 60);   // paused, no progress
    expect(done).toBe(false);
    scale = 1;
    for (let i = 0; i < 40; i++) anim.step(1 / 60);     // ~0.67s more local
    expect(done).toBe(true);
  });

  // ── Nesting ──────────────────────────────────────────────────────────

  it("nested withScale(0.5, withScale(0.5, g)) compounds to 0.25x", async () => {
    const { withScale } = await import("@minim/core");
    const dts: number[] = [];
    function* g(): any { while (true) dts.push(yield); }
    function* inner(): any { yield* withScale(() => 0.5, g()); }
    anim.start(withScale(() => 0.5, inner()));
    anim.step(1.0);
    expect(dts[0]).toBeCloseTo(0.25, 3);
  });

  it("withScale(1, race(slow, timer)) still resolves via timer", async () => {
    const { withScale, race } = await import("@minim/core");
    let cleaned = false;
    function* slow(): any {
      try { while (true) yield; } finally { cleaned = true; }
    }
    anim.start(withScale(() => 1, race(slow(), 0.1)));
    for (let i = 0; i < 20; i++) anim.step(0.02);
    expect(cleaned).toBe(true);
  });
});
