// Parameterised test suite — runs the full yield-contract + lifecycle
// + error / cancel / observer / spawn-window gauntlet against every
// prototype variant. Each variant is a self-contained module with its
// own Anim class and `suspend` / `drive` helpers; we feed them in
// turn so we can compare correctness apples-to-apples.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "../../_test/setup";

import * as V0 from "./v0_baseline";
import * as V1 from "./v1_constants";
import * as V2 from "./v2_settlement";
import * as V3 from "./v3_minimal";
import * as V4 from "./v4_protocol";
import * as V4c from "./v4c_shared";
import * as V5 from "./v5_promise";
import * as V6 from "./v6_propagate";
import * as V7 from "./v7_simpler";
// Used inside the v7-only tests to access the v7 namespace shape.
void V7;

interface Mod {
  name: string;
  Anim: new () => any;
  suspend: typeof V0.suspend;
  drive: typeof V0.drive;
  /** Variant supports model-(b) error propagation: thrown runtime
   *  child still notifies its parent. v0/v1 don't; v2/v3 do. */
  childThrowUnblocksParent: boolean;
  /** Variant guards the SuspendFn `spawn` setup window. */
  guardsSetupWindow: boolean;
  /** Variant exposes `anim.onError` for routing engine errors. */
  hasOnError: boolean;
  /** Variant passes child's return value to parent on `yield childGen`. */
  passesChildReturn: boolean;
  /** Variant supports `yield promise`. */
  yieldPromise?: boolean;
  /** Variant's `run()` returns a `Symbol.dispose`-able handle. */
  runHandleIsDisposable?: boolean;
  /** Variant propagates child-gen throws to parent (model-a). When
   *  true, the `childThrowUnblocksParent` test is invalid (parent dies
   *  on throw); we use the model-a tests instead. */
  propagatesChildThrows?: boolean;
  /** v7+: SuspendFn is 1-arg (no spawn/anim); race/onFrame moved to
   *  built-in yieldables. Tests that exercise the old `(_w, spawn)`
   *  signature must be skipped. */
  oneArgSuspendOnly?: boolean;
  /** v7+: supports `yield { race: [...] }` built-in. */
  yieldRace?: boolean;
  /** v7+: supports `yield { frame: cb }` built-in. */
  yieldFrame?: boolean;
  /** v7+: `run()` disposer accepts a `reason` that propagates via
   *  `gen.throw`. */
  cancelWithReason?: boolean;
}

const variants: Mod[] = [
  { name: "v0_baseline",   Anim: V0.Anim, suspend: V0.suspend, drive: V0.drive,
    childThrowUnblocksParent: false, guardsSetupWindow: false, hasOnError: false, passesChildReturn: false },
  { name: "v1_constants",  Anim: V1.Anim, suspend: V1.suspend, drive: V1.drive,
    childThrowUnblocksParent: false, guardsSetupWindow: false, hasOnError: false, passesChildReturn: false },
  { name: "v2_settlement", Anim: V2.Anim, suspend: V2.suspend, drive: V2.drive,
    childThrowUnblocksParent: true,  guardsSetupWindow: true,  hasOnError: true,  passesChildReturn: false },
  { name: "v3_minimal",    Anim: V3.Anim, suspend: V3.suspend, drive: V3.drive,
    childThrowUnblocksParent: true,  guardsSetupWindow: true,  hasOnError: true,  passesChildReturn: false },
  { name: "v4_protocol",   Anim: V4.Anim, suspend: V4.suspend, drive: V4.drive,
    childThrowUnblocksParent: true,  guardsSetupWindow: true,  hasOnError: true,  passesChildReturn: true  },
  { name: "v4c_shared",    Anim: V4c.Anim, suspend: V4c.suspend, drive: V4c.drive,
    childThrowUnblocksParent: true,  guardsSetupWindow: true,  hasOnError: true,  passesChildReturn: true  },
  { name: "v5_promise",    Anim: V5.Anim, suspend: V5.suspend, drive: V5.drive,
    childThrowUnblocksParent: true,  guardsSetupWindow: true,  hasOnError: true,  passesChildReturn: true,
    yieldPromise: true, runHandleIsDisposable: true },
  { name: "v6_propagate",  Anim: V6.Anim, suspend: V6.suspend, drive: V6.drive,
    childThrowUnblocksParent: false, guardsSetupWindow: true,  hasOnError: true,  passesChildReturn: true,
    yieldPromise: true, runHandleIsDisposable: true, propagatesChildThrows: true },
  { name: "v7_simpler",    Anim: V7.Anim, suspend: V7.suspend,
    // v7's `drive` returns a FrameSpec (yieldable), not an Animator.
    // Wrap to match the test-suite shape (`anim.run(drive(...))`).
    drive: ((cb: any) => (function* (): any { yield V7.drive(cb); })()) as any,
    childThrowUnblocksParent: false, guardsSetupWindow: false, hasOnError: true,  passesChildReturn: true,
    yieldPromise: true, runHandleIsDisposable: true, propagatesChildThrows: true,
    oneArgSuspendOnly: true, yieldRace: true, yieldFrame: true, cancelWithReason: true },
];

function runSuite(M: Mod): void {
  describe(`[${M.name}] yield contract`, () => {
    let anim: any;
    beforeEach(() => { anim = new M.Anim(); });
    afterEach(() => { anim.stop(); });

    it("yield; parks one frame", () => {
      let log = "";
      function* g(): any { log += "a"; yield; log += "b"; }
      anim.run(g);
      expect(log).toBe("a");
      anim.step(0.016);
      expect(log).toBe("ab");
    });
    it("yield's resume is dt", () => {
      let saw: number | undefined;
      function* g(): any { saw = yield; }
      anim.run(g); anim.step(0.025);
      expect(saw).toBeCloseTo(0.025, 9);
    });
    it("yield N sleeps N seconds", () => {
      let woke = false;
      function* g(): any { yield 0.1; woke = true; }
      anim.run(g);
      anim.step(0.05); expect(woke).toBe(false);
      anim.step(0.06); anim.step(0.001);
      expect(woke).toBe(true);
    });
    it("yield 0 is tail-call", () => {
      let order = "";
      function* g(): any { order += "a"; yield 0; order += "b"; }
      anim.run(g);
      expect(order).toBe("ab");
    });
    it("yield* returns propagate", () => {
      let v: number | undefined;
      function* child(): any { yield; return 42; }
      function* parent(): any { v = yield* child(); }
      anim.run(parent);
      anim.step(0.016); anim.step(0.016);
      expect(v).toBe(42);
    });
    it("yield [a, b] runs in parallel", () => {
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
    it("yield childGen waits for child (single-child fast path)", () => {
      let after = false;
      function* child(): any { yield; yield; }
      function* g(): any { yield child(); after = true; }
      anim.run(g);
      anim.step(0.016); expect(after).toBe(false);
      anim.step(0.016); expect(after).toBe(true);
    });
  });

  describe(`[${M.name}] suspend/wake`, () => {
    let anim: any;
    beforeEach(() => { anim = new M.Anim(); });
    afterEach(() => { anim.stop(); });

    it("delivers payload", () => {
      let received: number | undefined;
      let storedWake: ((v: number) => void) | undefined;
      function* g(): any {
        const v = yield* M.suspend<number>((wake) => { storedWake = wake as any; return () => {}; });
        received = v;
      }
      anim.run(g);
      storedWake!(7);
      expect(received).toBe(7);
    });
    it("sync wake during subscribe advances immediately", () => {
      let after = false;
      function* g(): any {
        yield* M.suspend<void>((wake) => { wake(); return () => {}; });
        after = true;
      }
      anim.run(g);
      expect(after).toBe(true);
    });
    it("double wake — second ignored", () => {
      let n = 0;
      let storedWake: (() => void) | undefined;
      function* g(): any {
        yield* M.suspend<void>((w) => { storedWake = w; return () => {}; });
        n++;
        yield* M.suspend<void>(() => () => {});
      }
      anim.run(g);
      storedWake!(); storedWake!();
      expect(n).toBe(1);
    });
    it("multiple sync-wake suspends in a row", () => {
      let n = 0;
      function* g(): any {
        for (let i = 0; i < 5; i++) {
          yield* M.suspend<void>((w) => { w(); return () => {}; });
          n++;
        }
      }
      anim.run(g);
      expect(n).toBe(5);
    });
    it("wake after stop is no-op", () => {
      let storedWake: (() => void) | undefined;
      let advanced = false;
      function* g(): any {
        yield* M.suspend<void>((w) => { storedWake = w; return () => {}; });
        advanced = true;
      }
      anim.run(g);
      anim.stop();
      storedWake!();
      expect(advanced).toBe(false);
    });
  });

  describe(`[${M.name}] cancel`, () => {
    let anim: any;
    beforeEach(() => { anim = new M.Anim(); });
    afterEach(() => { anim.stop(); });

    it("dispose runs SuspendFn dispose", () => {
      let disposed = false;
      function* g(): any { yield* M.suspend<void>(() => () => { disposed = true; }); }
      const d = anim.run(g);
      anim.step(0.016);
      d();
      expect(disposed).toBe(true);
    });
    it("runs try/finally in cancelled gen", () => {
      let cleaned = false;
      function* g(): any {
        try { yield* M.suspend<void>(() => () => {}); }
        finally { cleaned = true; }
      }
      const d = anim.run(g);
      d();
      expect(cleaned).toBe(true);
    });
    it("dispose idempotent", () => {
      let cleaned = 0;
      function* g(): any { try { yield* M.suspend(() => () => {}); } finally { cleaned++; } }
      const d = anim.run(g);
      d(); d(); d();
      expect(cleaned).toBe(1);
    });
    it("parent cancel cascades to spawn-children", () => {
      if (M.oneArgSuspendOnly) return;
      let leafDisposed = false;
      function* leaf(): any { yield* M.suspend(() => () => { leafDisposed = true; }); }
      function* parent(): any {
        yield* M.suspend((_w: any, spawn: any) => { spawn(leaf()); return () => {}; });
      }
      const d = anim.run(parent);
      anim.step(0.016);
      d();
      expect(leafDisposed).toBe(true);
    });
    it("parent cancel cascades to yield-array children", () => {
      let leafDisposed = false;
      function* leaf(): any {
        try { yield* M.suspend(() => () => {}); } finally { leafDisposed = true; }
      }
      function* parent(): any { yield [leaf(), leaf()]; }
      const d = anim.run(parent);
      anim.step(0.016);
      d();
      expect(leafDisposed).toBe(true);
    });
    it("stop() during a step preserves pending cancels", () => {
      let cleaned = 0;
      function* g(): any { try { yield; } finally { cleaned++; } }
      anim.run(g); anim.run(g); anim.run(g);
      anim.stop();
      expect(cleaned).toBe(3);
    });
  });

  describe(`[${M.name}] error isolation`, () => {
    let anim: any;
    beforeEach(() => {
      anim = new M.Anim();
      if (M.hasOnError) anim.onError = () => {};
    });
    afterEach(() => { anim.stop(); });

    it("error in one gen doesn't halt others", () => {
      const orig = console.error; if (!M.hasOnError) console.error = () => {};
      try {
        let other = false;
        function* bad(): any { throw new Error("boom"); yield; }
        function* good(): any { yield; other = true; }
        anim.run(bad); anim.run(good);
        anim.step(0.016);
        expect(other).toBe(true);
      } finally { console.error = orig; }
    });
    it("error in `yield*` child caught by parent", () => {
      const orig = console.error; if (!M.hasOnError) console.error = () => {};
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
      const orig = console.error; if (!M.hasOnError) console.error = () => {};
      try {
        let other = 0;
        anim.run(M.drive(() => { throw new Error("drive boom"); }));
        anim.run(M.drive(() => { other++; }));
        anim.step(1 / 60); anim.step(1 / 60);
        expect(other).toBeGreaterThan(0);
      } finally { console.error = orig; }
    });
  });

  describe(`[${M.name}] drive`, () => {
    let anim: any;
    beforeEach(() => { anim = new M.Anim(); });
    afterEach(() => { anim.stop(); });

    it("accumulates dt", () => {
      let acc = 0;
      anim.run(M.drive((dt) => { acc += dt; }));
      for (let i = 0; i < 10; i++) anim.step(0.1);
      expect(acc).toBeCloseTo(1.0, 9);
    });
    it("completes on returning false", () => {
      let n = 0;
      anim.run(M.drive(() => { n++; if (n >= 3) return false; }));
      for (let i = 0; i < 10; i++) anim.step(1 / 60);
      expect(n).toBe(3);
    });
  });

  describe(`[${M.name}] new contract (model-b corrections)`, () => {
    let anim: any;
    beforeEach(() => {
      anim = new M.Anim();
      if (M.hasOnError) anim.onError = () => {};
    });
    afterEach(() => { anim.stop(); });

    it("child throw doesn't hang parent", () => {
      if (!M.childThrowUnblocksParent) return;
      const orig = console.error; if (!M.hasOnError) console.error = () => {};
      try {
        let parentDone = false;
        anim.run(function* (): any {
          yield [
            (function* (): any { throw new Error("boom"); })(),
            (function* (): any { yield 0.1; })(),
          ];
          parentDone = true;
        });
        anim.step(0.15);
        expect(parentDone).toBe(true);
      } finally { console.error = orig; }
    });

    it("single throwing child also unblocks parent (spawnOne fast path)", () => {
      if (!M.childThrowUnblocksParent) return;
      const orig = console.error; if (!M.hasOnError) console.error = () => {};
      try {
        let parentDone = false;
        anim.run(function* (): any {
          yield (function* (): any { throw new Error("boom"); })();
          parentDone = true;
        });
        anim.step(0.016);
        expect(parentDone).toBe(true);
      } finally { console.error = orig; }
    });

    it("SuspendFn spawn after setup throws", () => {
      if (!M.guardsSetupWindow || M.oneArgSuspendOnly) return;
      let captured: any;
      anim.run(function* (): any {
        yield (_wake: any, spawn: any) => { captured = spawn; return () => {}; };
      });
      anim.step(0);
      let threw = false;
      try {
        captured((function* (): any { yield; })());
      } catch { threw = true; }
      expect(threw).toBe(true);
    });

    it("onError routes thrown generator errors", () => {
      if (!M.hasOnError) return;
      let caught: unknown;
      anim.onError = (e: unknown) => { caught = e; };
      anim.run(function* (): any { throw new Error("xyz"); });
      anim.step(0);
      expect((caught as Error).message).toBe("xyz");
    });

    it("yield child resumes with child's return value", () => {
      if (!M.passesChildReturn) return;
      let got: any;
      function* child(): any { yield; return 99; }
      function* parent(): any { got = yield child(); }
      anim.run(parent);
      anim.step(0.016); anim.step(0.016);
      expect(got).toBe(99);
    });

    it("yield [a, b] resumes with tuple of return values", () => {
      if (!M.passesChildReturn) return;
      let got: any;
      function* a(): any { yield; return "a"; }
      function* b(): any { yield; yield; return "b"; }
      function* parent(): any { got = yield [a(), b()]; }
      anim.run(parent);
      anim.step(0.016); anim.step(0.016);
      expect(got).toEqual(["a", "b"]);
    });

    it("yield [] resumes with []", () => {
      if (!M.passesChildReturn) return;
      let got: any;
      function* parent(): any { got = yield [] as any; }
      anim.run(parent);
      expect(got).toEqual([]);
    });

    it("yield Promise resolves with value", async () => {
      if (!M.yieldPromise) return;
      let got: any;
      anim.run(function* (): any { got = yield Promise.resolve(42); });
      await Promise.resolve(); await Promise.resolve();
      expect(got).toBe(42);
    });

    it("yield Promise rejects → throws into parent (model-a for promises)", async () => {
      if (!M.yieldPromise) return;
      const orig = console.error; anim.onError = () => {};
      try {
        let caught: unknown;
        anim.run(function* (): any {
          try { yield Promise.reject(new Error("nope")); }
          catch (e) { caught = e; }
        });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        expect((caught as Error)?.message).toBe("nope");
      } finally { console.error = orig; }
    });

    it("Promise after cancel is ignored", async () => {
      if (!M.yieldPromise) return;
      let resolved = false;
      const d = anim.run(function* (): any {
        yield new Promise<void>((r) => setTimeout(r, 0));
        resolved = true;
      });
      d();
      await new Promise((r) => setTimeout(r, 5));
      expect(resolved).toBe(false);
    });

    it("Symbol.dispose works on run handle", () => {
      if (!M.runHandleIsDisposable) return;
      let cleaned = false;
      function* g(): any { try { yield; } finally { cleaned = true; } }
      {
        const h = anim.run(g);
        expect(typeof (h as any)[Symbol.dispose]).toBe("function");
        (h as any)[Symbol.dispose]();
      }
      expect(cleaned).toBe(true);
    });

    it("errored child resumes parent with undefined (model-b)", () => {
      if (!M.passesChildReturn || M.propagatesChildThrows) return;
      const orig = console.error; anim.onError = () => {};
      try {
        let got: any = "untouched";
        function* bad(): any { throw new Error("boom"); yield; }
        function* parent(): any { got = yield bad(); }
        anim.run(parent);
        anim.step(0);
        expect(got).toBeUndefined();
      } finally { console.error = orig; }
    });

    it("errored child throws into parent at yield site (model-a)", () => {
      if (!M.propagatesChildThrows) return;
      let caught: unknown;
      anim.onError = () => {};
      function* bad(): any { throw new Error("boom"); yield; }
      function* parent(): any {
        try { yield bad(); }
        catch (e) { caught = e; }
      }
      anim.run(parent);
      anim.step(0);
      expect((caught as Error)?.message).toBe("boom");
    });

    it("yield { race: [...] } resumes with winner", () => {
      if (!M.yieldRace) return;
      const V7m = M.Anim === V7.Anim ? V7 : null;
      if (!V7m) return;
      let got: any;
      anim.run(function* (): any {
        got = yield V7m.race(
          (function* (): any { yield 0.05; return "fast"; })(),
          (function* (): any { yield 0.5; return "slow"; })(),
        );
      });
      anim.step(0.06);
      expect(got).toBe("fast");
    });

    it("yield { race: [...] } cancels losers", () => {
      if (!M.yieldRace) return;
      const V7m = M.Anim === V7.Anim ? V7 : null;
      if (!V7m) return;
      let loserCancelled = false;
      anim.run(function* (): any {
        yield V7m.race(
          (function* (): any { yield 0.05; })(),
          (function* (): any {
            try { yield 1.0; } finally { loserCancelled = true; }
          })(),
        );
      });
      anim.step(0.06);
      expect(loserCancelled).toBe(true);
    });

    it("yield { frame: cb } drives per-frame, completes on false", () => {
      if (!M.yieldFrame) return;
      const V7m = M.Anim === V7.Anim ? V7 : null;
      if (!V7m) return;
      let n = 0; let after = false;
      anim.run(function* (): any {
        yield V7m.drive(() => { n++; if (n >= 3) return false; });
        after = true;
      });
      anim.step(1 / 60); anim.step(1 / 60); anim.step(1 / 60); anim.step(1 / 60);
      expect(n).toBe(3);
      expect(after).toBe(true);
    });

    it("cancel-with-reason throws into gen", () => {
      if (!M.cancelWithReason) return;
      let caught: unknown;
      const d = anim.run(function* (): any {
        try { while (true) yield; }
        catch (e) { caught = e; }
      });
      anim.step(0.016);
      d("user-pressed-escape");
      expect(caught).toBe("user-pressed-escape");
    });

    it("yield [throwing, sleeping] throws + cancels siblings (model-a)", () => {
      if (!M.propagatesChildThrows) return;
      let caught: unknown;
      let siblingCancelled = false;
      anim.onError = () => {};
      function* bad(): any { yield; throw new Error("boom"); }
      function* sib(): any {
        try { yield 0.1; }
        finally { siblingCancelled = true; }
      }
      function* parent(): any {
        try { yield [bad(), sib()]; }
        catch (e) { caught = e; }
      }
      anim.run(parent);
      anim.step(0.016);
      expect((caught as Error)?.message).toBe("boom");
      expect(siblingCancelled).toBe(true);
    });
  });
}

for (const v of variants) runSuite(v);
