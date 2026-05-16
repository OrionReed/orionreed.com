// Anim runtime tests. Covers the full yield contract, the runtime's
// re-entrancy / sync-resolve / error-isolation guarantees, and the
// drive() and AnimObserver integrations. One file because there's
// one engine.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Anim,
  suspend,
  drive,
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
    anim.run(g);
    expect(log).toBe("a");
    anim.step(0.016);
    expect(log).toBe("ab");
  });

  it("the resume value of a frame yield is dt", () => {
    let saw: number | undefined;
    function* g(): any { saw = yield; }
    anim.run(g);
    anim.step(0.025);
    expect(saw).toBeCloseTo(0.025, 9);
  });

  it("repeated parking ticks once per frame", () => {
    let n = 0;
    function* g(): any { while (true) { yield; n++; } }
    anim.run(g);
    for (let i = 0; i < 10; i++) anim.step(0.016);
    expect(n).toBe(10);
  });

  it("yield N sleeps for ~N seconds", () => {
    let woke = false;
    function* g(): any { yield 0.1; woke = true; }
    anim.run(g);
    anim.step(0.05); expect(woke).toBe(false);
    anim.step(0.06); anim.step(0.001);
    expect(woke).toBe(true);
  });

  it("yield 0 is a tail-call (no frame consumed)", () => {
    let order = "";
    function* g(): any { order += "a"; yield 0; order += "b"; }
    anim.run(g);
    expect(order).toBe("ab");
  });

  it("many tail-calls in one frame", () => {
    let n = 0;
    function* g(): any { for (let i = 0; i < 100; i++) { yield 0; n++; } }
    anim.run(g);
    expect(n).toBe(100);
  });

  it("sleep across many small frames is FP-safe", () => {
    let woke = false;
    function* g(): any { yield 1.0; woke = true; }
    anim.run(g);
    for (let i = 0; i < 999; i++) anim.step(0.001);
    expect(woke).toBe(false);
    anim.step(0.001); anim.step(0.001);
    expect(woke).toBe(true);
  });

  it("yield* sequences and propagates returns", () => {
    let v: number | undefined;
    function* child(): any { yield; return 42; }
    function* parent(): any { v = yield* child(); }
    anim.run(parent);
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
    anim.run(makeChain(8));
    anim.step(0.016);
    expect(leafTicks).toBe(1);
  });

  it("yield [a, b] runs in parallel; resumes when all complete", () => {
    let done = false;
    function* a(): any { yield; }
    function* b(): any { yield; yield; }
    function* g(): any { yield [a(), b()]; done = true; }
    anim.run(g);
    anim.step(0.016); expect(done).toBe(false);
    anim.step(0.016); expect(done).toBe(true);
  });

  it("yield [] sync-completes", () => {
    let done = false;
    function* g(): any { yield [] as any; done = true; }
    anim.run(g);
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
    anim.run(g);
    anim.step(0.016); anim.step(0.016);
    expect(done).toBe(true);
  });

  it("yield childGen waits for child completion (single-child fast path)", () => {
    let after = false;
    function* child(): any { yield; yield; }   // two-frame child
    function* g(): any { yield child(); after = true; }
    anim.run(g);
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
    anim.run(g);
    storedWake!(7);
    expect(received).toBe(7);
  });

  it("sync wake during subscribe advances immediately", () => {
    let after = false;
    function* g(): any {
      yield* suspend<void>((wake) => { wake(); return () => {}; });
      after = true;
    }
    anim.run(g);
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
    anim.run(g);
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
    anim.run(a); anim.run(b);
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
    anim.run(g);
    expect(n).toBe(5);
  });

  it("wake after stop is a no-op", () => {
    let storedWake: (() => void) | undefined;
    let advanced = false;
    function* g(): any {
      yield* suspend<void>((w) => { storedWake = w; return () => {}; });
      advanced = true;
    }
    anim.run(g);
    anim.stop();
    storedWake!();
    expect(advanced).toBe(false);
  });
});

describe("cancel", () => {
  let anim: Anim;
  beforeEach(() => { anim = new Anim(); });
  afterEach(() => { anim.stop(); });

  it("dispose cancels and runs SuspendFn dispose", () => {
    let disposed = false;
    function* g(): any { yield* suspend<void>(() => () => { disposed = true; }); }
    const d = anim.run(g);
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
    const d = anim.run(g);
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
    const d = anim.run(gParent);
    anim.step(0.016);
    d();
    expect(leaf).toBe(true);
    expect(mid).toBe(true);
    expect(parent).toBe(true);
  });

  it("dispose called twice is idempotent", () => {
    let cleaned = 0;
    function* g(): any { try { yield* suspend(() => () => {}); } finally { cleaned++; } }
    const d = anim.run(g);
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
    dispose = anim.run(g);
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
    dispose = anim.run(g);
    anim.step(0.016);
    expect(after).toBe(1);
    anim.step(0.016);
    expect(afterMore).toBe(0);
  });

  it("parent cancel cascades to child spawned via SuspendFn's spawn arg", () => {
    let leafDisposed = false;
    function* leaf(): any { yield* suspend(() => () => { leafDisposed = true; }); }
    function* parent(): any {
      yield* suspend((_w, spawn) => { spawn(leaf()); return () => {}; });
    }
    const d = anim.run(parent);
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
    const d = anim.run(parent);
    anim.step(0.016);
    d();
    expect(leafDisposed).toBe(true);
  });

  it("stop() during a step doesn't lose pending cancels", () => {
    let cleaned = 0;
    function* g(): any { try { yield; } finally { cleaned++; } }
    anim.run(g); anim.run(g); anim.run(g);
    anim.stop();
    expect(cleaned).toBe(3);
  });

  it("running stop() inside a cancel cleanup doesn't crash", () => {
    function* g(): any {
      try { yield* suspend(() => () => {}); }
      finally { anim.stop(); }
    }
    const d = anim.run(g);
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
      anim.run(bad);
      anim.run(good);
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
      anim.run(parent);
      anim.step(0.016); anim.step(0.016);
      expect(parentDone).toBe(true);
    } finally { console.error = orig; }
  });

  it("drive cb that throws is isolated", () => {
    const orig = console.error; console.error = () => {};
    try {
      let other = 0;
      anim.run(drive(() => { throw new Error("drive boom"); }));
      anim.run(drive(() => { other++; }));
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
    anim.run(drive((dt) => { acc += dt; }));
    for (let i = 0; i < 10; i++) anim.step(0.1);
    expect(acc).toBeCloseTo(1.0, 9);
  });

  it("completes on returning false", () => {
    let n = 0;
    anim.run(drive(() => { n++; if (n >= 3) return false; }));
    for (let i = 0; i < 10; i++) anim.step(1 / 60);
    expect(n).toBe(3);
  });

  it("cancel mid-flight stops the cb firing", () => {
    let n = 0;
    const d = anim.run(drive(() => { n++; }));
    anim.step(1 / 60); anim.step(1 / 60);
    const at = n;
    d();
    anim.step(1 / 60); anim.step(1 / 60); anim.step(1 / 60);
    expect(n).toBe(at);
  });

  it("`t` is time since registration", () => {
    let lastT = 0;
    anim.run(drive((_dt, t) => { lastT = t; }));
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
    anim.run(g);
    anim.step(0); anim.step(0); anim.step(0);
    expect(n).toBe(3);
  });

  it("anim is reusable after stop", () => {
    let n = 0;
    function* g(): any { yield; n++; }
    anim.run(g); anim.step(0.016);
    anim.stop();
    expect(n).toBe(1);
    anim.run(g); anim.step(0.016);
    expect(n).toBe(2);
  });

  it("clock resets to 0 on stop", () => {
    function* g(): any { while (true) yield; }
    anim.run(g);
    anim.step(0.5); anim.step(0.5);
    expect(anim.clock).toBeCloseTo(1.0, 9);
    anim.stop();
    expect(anim.clock).toBe(0);
  });

  it("cancelling 1000 actives in a tight loop doesn't crash or leak", () => {
    const ds: Array<() => void> = [];
    function* g(): any { yield; }
    for (let i = 0; i < 1000; i++) ds.push(anim.run(g));
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
    anim.run(g); anim.run(g);
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
    const d = anim.run(g);
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
    anim.run(parent);
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
    anim.run(mapDt((dt) => dt * 0.5, g()));
    anim.step(1.0);
    expect(lastDt).toBeCloseTo(0.5, 9);
    anim.stop();
  });

  it("withTimeout cancels inner after the cap", async () => {
    const { withTimeout } = await import("@minim/core");
    const anim = new Anim();
    let cleaned = false;
    function* slow(): any {
      try { while (true) yield; } finally { cleaned = true; }
    }
    anim.run(withTimeout(0.1, slow()));
    for (let i = 0; i < 20; i++) anim.step(0.02);
    expect(cleaned).toBe(true);
    anim.stop();
  });

  it("record + replay: source runs once, replays don't re-enter", async () => {
    const { record, replay } = await import("@minim/core");
    let runCount = 0;
    function* src(): any { runCount++; yield 0.05; yield 0.05; }
    const anim = new Anim();
    const trace: any[] = [];
    anim.run(record(trace, src()));
    for (let f = 0; f < 10; f++) anim.step(0.02);
    anim.stop();
    expect(runCount).toBe(1);
    runCount = 0;
    for (let r = 0; r < 10; r++) {
      const a2 = new Anim();
      a2.run(replay(trace) as Animator);
      for (let f = 0; f < 10; f++) a2.step(0.02);
      a2.stop();
    }
    expect(runCount).toBe(0);
  });
});
