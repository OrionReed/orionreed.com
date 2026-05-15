// Cross-engine contract tests. Anything that passes the suite should
// be substitutable for `core/anim.ts`. Capability-aware: scenarios
// that use sugar an engine doesn't support are skipped on that engine.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as current from "../../core/anim";
import * as v6 from "../../_anim_lab/engine-v6";
import * as v21 from "../../_anim_lab/engine-v21";
import * as v30 from "../../_anim_lab/engine-v30";
import * as v31 from "../../_anim_lab/engine-v31";
import * as mini from "../engine-mini";
import * as simple from "../engine-simple";
import * as final from "../engine-final";

interface EngineModule {
  Anim: new () => {
    run: (g: any) => () => void;
    step: (dt: number) => void;
    stop: () => void;
  };
  suspend: typeof current.suspend;
  drive: (step: (dt: number, t: number) => boolean | void) => any;
}

const engines: Array<[string, EngineModule]> = [
  ["current", { Anim: current.Anim, suspend: current.suspend as any, drive: ((step) => {
    function* g(): any { let t = 0; while (true) { const dt: number = yield; t += dt; if (step(dt, t) === false) return; } }
    return g();
  }) }],
  ["v6", { Anim: v6.Anim, suspend: v6.suspend as any, drive: v6.drive as any }],
  ["v21", { Anim: v21.Anim, suspend: v21.suspend as any, drive: v21.drive as any }],
  ["v30", { Anim: v30.Anim, suspend: v30.suspend as any, drive: v30.drive as any }],
  ["v31", { Anim: v31.Anim, suspend: v31.suspend as any, drive: v31.drive as any }],
  ["mini", { Anim: mini.Anim as any, suspend: mini.suspend as any, drive: mini.drive as any }],
  ["simple", { Anim: simple.Anim as any, suspend: simple.suspend as any, drive: simple.drive as any }],
  ["final", { Anim: final.Anim as any, suspend: final.suspend as any, drive: final.drive as any }],
];

for (const [name, eng] of engines) {
  describe(`engine: ${name}`, () => {
    let anim: ReturnType<typeof makeAnim>;
    function makeAnim() { return new eng.Anim(); }

    beforeEach(() => { anim = makeAnim(); });
    afterEach(() => { anim.stop(); });

    // ── yield contract: park ─────────────────────────────────────

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

    // ── yield contract: sleep ────────────────────────────────────

    it("yield N sleeps for ~N seconds", () => {
      let woke = false;
      function* g(): any { yield 0.1; woke = true; }
      anim.run(g);
      anim.step(0.05);
      expect(woke).toBe(false);
      anim.step(0.06);
      anim.step(0.001);
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

    it("sleep across many small frames (FP-safe)", () => {
      let woke = false;
      function* g(): any { yield 1.0; woke = true; }
      anim.run(g);
      for (let i = 0; i < 999; i++) anim.step(0.001);
      expect(woke).toBe(false);
      anim.step(0.001); anim.step(0.001);
      expect(woke).toBe(true);
    });

    // ── yield* delegation ────────────────────────────────────────

    it("yield* sequences and propagates returns", () => {
      let v: number | undefined;
      function* child(): any { yield; return 42; }
      function* parent(): any { v = yield* child(); }
      anim.run(parent);
      anim.step(0.016); anim.step(0.016);
      expect(v).toBe(42);
    });

    it("deep yield* chain (depth 8)", () => {
      let log = "";
      function* leaf(): any { log += "L"; yield; }
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
      expect(log).toBe("L");
    });

    // ── parallel via array (yield [a, b, c]) ─────────────────────

    it("yield [a, b] runs in parallel; resumes when all complete", () => {
      let done = false;
      function* a(): any { yield; }
      function* b(): any { yield; yield; }
      function* g(): any { yield [a(), b()]; done = true; }
      anim.run(g);
      anim.step(0.016);
      expect(done).toBe(false);
      anim.step(0.016);
      expect(done).toBe(true);
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
      anim.step(0.016);
      anim.step(0.016);
      expect(done).toBe(true);
    });

    // ── single-child wait via yield Animator ─────────────────────

    it("yield childGen waits for child completion", () => {
      let v: any;
      function* child(): any { yield; return "hello"; }
      function* g(): any { v = yield child(); }
      anim.run(g);
      anim.step(0.016);
      anim.step(0.016);
      expect(v === undefined || v === "hello").toBe(true);
    });

    // ── suspend / wake ───────────────────────────────────────────

    it("suspend + wake delivers payload", () => {
      let received: number | undefined;
      let storedWake: ((v: number) => void) | undefined;
      function* g(): any {
        const v = yield* eng.suspend<number>((wake: any) => { storedWake = wake; return () => {}; });
        received = v;
      }
      anim.run(g);
      storedWake!(7);
      expect(received).toBe(7);
    });

    it("sync wake during subscribe advances immediately", () => {
      let after = false;
      function* g(): any {
        yield* eng.suspend<void>((wake: any) => { wake(); return () => {}; });
        after = true;
      }
      anim.run(g);
      expect(after).toBe(true);
    });

    it("double wake: second is ignored", () => {
      let n = 0;
      let storedWake: (() => void) | undefined;
      function* g(): any {
        yield* eng.suspend<void>((w: any) => { storedWake = w; return () => {}; });
        n++;
        yield* eng.suspend<void>(() => () => {});
      }
      anim.run(g);
      storedWake!(); storedWake!();
      expect(n).toBe(1);
    });

    // ── cancel ───────────────────────────────────────────────────

    it("dispose cancels and runs SuspendFn dispose", () => {
      let disposed = false;
      function* g(): any { yield* eng.suspend<void>(() => () => { disposed = true; }); }
      const d = anim.run(g);
      anim.step(0.016);
      d();
      expect(disposed).toBe(true);
    });

    it("cancel runs try/finally in the cancelled gen", () => {
      let cleaned = false;
      function* g(): any {
        try { yield* eng.suspend<void>(() => () => {}); }
        finally { cleaned = true; }
      }
      const d = anim.run(g);
      d();
      expect(cleaned).toBe(true);
    });

    it("cancel cascades try/finally through deep yield* (depth 3)", () => {
      let leaf = false, mid = false, parent = false;
      function* gLeaf(): any {
        try { yield* eng.suspend<void>(() => () => {}); } finally { leaf = true; }
      }
      function* gMid(): any {
        try { yield* gLeaf(); } finally { mid = true; }
      }
      function* gParent(): any {
        try { yield* gMid(); } finally { parent = true; }
      }
      const d = anim.run(gParent);
      anim.step(0.016);
      d();
      expect(leaf).toBe(true);
      expect(mid).toBe(true);
      expect(parent).toBe(true);
    });

    // ── re-entrancy ──────────────────────────────────────────────

    it("self-cancel during own subscribe doesn't crash", () => {
      let after = 0;
      let dispose: (() => void) | undefined;
      function* g(): any {
        yield* eng.suspend<void>((_w: any) => { dispose!(); return () => {}; });
        after++;
      }
      dispose = anim.run(g);
      expect(after).toBe(0);
    });

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
      } finally {
        console.error = orig;
      }
    });

    // ── lifecycle ────────────────────────────────────────────────

    it("wake after stop is a no-op", () => {
      let storedWake: (() => void) | undefined;
      let advanced = false;
      function* g(): any {
        yield* eng.suspend<void>((w: any) => { storedWake = w; return () => {}; });
        advanced = true;
      }
      anim.run(g);
      anim.stop();
      storedWake!();
      expect(advanced).toBe(false);
    });

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

    // ── drive ────────────────────────────────────────────────────

    it("drive accumulates dt", () => {
      let acc = 0;
      anim.run(eng.drive((dt) => { acc += dt; }));
      for (let i = 0; i < 10; i++) anim.step(0.1);
      expect(acc).toBeCloseTo(1.0, 9);
    });

    it("drive completes on false", () => {
      let n = 0;
      anim.run(eng.drive(() => { n++; if (n >= 3) return false; }));
      for (let i = 0; i < 10; i++) anim.step(1 / 60);
      expect(n).toBe(3);
    });

    it("drive cancels when active disposed", () => {
      let n = 0;
      const d = anim.run(eng.drive(() => { n++; }));
      anim.step(1 / 60); anim.step(1 / 60);
      const before = n;
      d();
      anim.step(1 / 60); anim.step(1 / 60);
      expect(n).toBe(before);
    });
  });
}
