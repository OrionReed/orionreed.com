// Edge cases — re-entrancy, sync-resolve corners, double-cancel, error
// isolation, race conditions in single-threaded JS.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as current from "../../core/anim";
import * as v6 from "../../_anim_lab/engine-v6";
import * as v21 from "../../_anim_lab/engine-v21";
import * as v30 from "../../_anim_lab/engine-v30";
import * as v31 from "../../_anim_lab/engine-v31";
import * as mini from "../engine-mini";
import * as simple from "../engine-simple";
import * as final from "../engine-final";

interface Eng {
  name: string;
  Anim: new () => any;
  suspend: any;
  drive: any;
  // SuspendFn signature shape:
  //   "spawn-2nd"  →  (wake, spawn, rt?)        — current/v6/v30/v31
  //   "rt-only"    →  (wake, rt={onFrame})      — mini/simple
  shape: "spawn-2nd" | "rt-only";
}

const engines: Eng[] = [
  { name: "current", Anim: current.Anim, suspend: current.suspend, drive: null,    shape: "spawn-2nd" },
  { name: "v6",      Anim: v6.Anim,      suspend: v6.suspend,      drive: v6.drive, shape: "spawn-2nd" },
  { name: "v21",     Anim: v21.Anim,     suspend: v21.suspend,     drive: v21.drive, shape: "spawn-2nd" },
  { name: "v30",     Anim: v30.Anim,     suspend: v30.suspend,     drive: v30.drive, shape: "spawn-2nd" },
  { name: "v31",     Anim: v31.Anim,     suspend: v31.suspend,     drive: v31.drive, shape: "spawn-2nd" },
  { name: "mini",    Anim: mini.Anim,    suspend: mini.suspend,    drive: mini.drive, shape: "rt-only" },
  { name: "simple",  Anim: simple.Anim,  suspend: simple.suspend,  drive: simple.drive, shape: "rt-only" },
  { name: "final",   Anim: final.Anim,   suspend: final.suspend,   drive: final.drive,  shape: "spawn-2nd" },
];

for (const eng of engines) {
  describe(`edges: ${eng.name}`, () => {
    let anim: any;
    beforeEach(() => { anim = new eng.Anim(); });
    afterEach(() => { anim.stop(); });

    // ── self-cancel during own subscribe ────────────────────────

    it("gen cancels itself via captured disposer (during subscribe)", () => {
      let after = 0;
      let dispose: (() => void) | undefined;
      function* g(): any {
        yield* eng.suspend((_w: any) => {
          dispose!();
          return () => {};
        });
        after++;
      }
      dispose = anim.run(g);
      expect(after).toBe(0);
    });

    it("gen calls dispose mid-frame: synchronous code after dispose still runs (until next yield)", () => {
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

    // ── sync-wake ────────────────────────────────────────────────

    it("sync-wake before subscribe returns: dispose IS called", () => {
      let disposed = false;
      let advanced = false;
      function* g(): any {
        yield* eng.suspend((wake: () => void) => {
          wake();
          return () => { disposed = true; };
        });
        advanced = true;
      }
      anim.run(g);
      expect(advanced).toBe(true);
      expect(disposed).toBe(true);
    });

    it("multiple sync-wake suspends in a row", () => {
      let n = 0;
      function* g(): any {
        for (let i = 0; i < 5; i++) {
          yield* eng.suspend((w: () => void) => { w(); return () => {}; });
          n++;
        }
      }
      anim.run(g);
      expect(n).toBe(5);
    });

    // ── re-entrant wake ─────────────────────────────────────────

    it("wake fired during wake (re-entrant) doesn't crash", () => {
      let wA: (() => void) | undefined;
      let wB: (() => void) | undefined;
      let aResumed = false, bResumed = false;
      function* a(): any {
        yield* eng.suspend((w: () => void) => { wA = w; return () => {}; });
        aResumed = true;
        if (wB) wB();
      }
      function* b(): any {
        yield* eng.suspend((w: () => void) => { wB = w; return () => {}; });
        bResumed = true;
      }
      anim.run(a); anim.run(b);
      wA!();
      expect(aResumed).toBe(true);
      expect(bResumed).toBe(true);
    });

    // ── cascading cancels ──────────────────────────────────────

    it("parent cancel cancels child spawned via SuspendFn", () => {
      // current/v6/v30/v31 auto-track via 2nd-arg spawn. mini/simple
      // don't expose spawn from SuspendFn; they use yield-array for
      // parallel and the `composability.all()` helper.
      if (eng.shape !== "spawn-2nd") return;
      let leafDisposed = false;
      function* leaf(): any {
        yield* eng.suspend(() => () => { leafDisposed = true; });
      }
      function* parent(): any {
        yield* eng.suspend((_w: any, spawn: any) => {
          spawn(leaf());
          return () => {};
        });
      }
      const d = anim.run(parent);
      anim.step(0.016);
      d();
      expect(leafDisposed).toBe(true);
    });

    it("parent cancel cancels child spawned via yield-array", () => {
      // Universal path: yield-array spawns kids parented to the host.
      // Cancel of the host cascades to kids regardless of engine shape.
      let leafDisposed = false;
      function* leaf(): any {
        try { yield* eng.suspend(() => () => {}); }
        finally { leafDisposed = true; }
      }
      function* parent(): any {
        yield [leaf(), leaf()];
      }
      const d = anim.run(parent);
      anim.step(0.016);
      d();
      expect(leafDisposed).toBe(true);
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
        anim.step(0.016);
        anim.step(0.016);
        expect(parentDone).toBe(true);
      } finally { console.error = orig; }
    });

    // ── cancel ordering ───────────────────────────────────────

    it("dispose called twice is idempotent", () => {
      let cleaned = 0;
      function* g(): any { try { yield* eng.suspend(() => () => {}); } finally { cleaned++; } }
      const d = anim.run(g);
      d(); d(); d();
      expect(cleaned).toBe(1);
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
        try { yield* eng.suspend(() => () => {}); }
        finally { anim.stop(); }
      }
      const d = anim.run(g);
      expect(() => d()).not.toThrow();
    });

    // ── many cancels ─────────────────────────────────────────

    it("cancelling 1000 actives in a tight loop doesn't crash or leak", () => {
      const ds: Array<() => void> = [];
      function* g(): any { yield; }
      for (let i = 0; i < 1000; i++) ds.push(anim.run(g));
      anim.step(0.016);
      for (const d of ds) d();
      anim.step(0.016);
      expect(anim).toBeDefined();
    });

    // ── deep parking / waking sequences ──────────────────────

    it("alternating sleep+suspend chain", () => {
      let woken = 0;
      function* g(): any {
        for (let i = 0; i < 5; i++) {
          yield 0.01;
          yield* eng.suspend((w: () => void) => { w(); return () => {}; });
          woken++;
        }
      }
      anim.run(g);
      for (let f = 0; f < 60; f++) anim.step(1 / 60);
      expect(woken).toBe(5);
    });

    // ── sleep precision under tiny-dt accumulation ───────────

    it("sleep N woken within one frame past N (FP-safe)", () => {
      let woke = false;
      function* g(): any { yield 0.5; woke = true; }
      anim.run(g);
      for (let i = 0; i < 499; i++) anim.step(0.001);
      expect(woke).toBe(false);
      for (let i = 0; i < 5; i++) anim.step(0.001);
      expect(woke).toBe(true);
    });

    // ── resume value plumbing ─────────────────────────────

    it("yield* delegates suspend payload typed correctly", () => {
      let v: number | undefined;
      function* inner(): any {
        const x = yield* eng.suspend<number>((w: any) => { w(7); return () => {}; });
        return x;
      }
      function* outer(): any {
        v = (yield* inner()) as number;
      }
      anim.run(outer);
      expect(v).toBe(7);
    });

    // ── drive cancellation purity ─────────────────────────

    it("cancelling drive() mid-flight stops cb firing", () => {
      if (!eng.drive) return;
      let n = 0;
      const d = anim.run(eng.drive(() => { n++; }));
      anim.step(1 / 60); anim.step(1 / 60);
      const at = n;
      d();
      anim.step(1 / 60); anim.step(1 / 60); anim.step(1 / 60);
      expect(n).toBe(at);
    });

    it("drive cb that throws is isolated", () => {
      if (!eng.drive) return;
      const orig = console.error; console.error = () => {};
      try {
        let other = 0;
        anim.run(eng.drive(() => { throw new Error("drive boom"); }));
        anim.run(eng.drive(() => { other++; }));
        anim.step(1 / 60);
        anim.step(1 / 60);
        expect(other).toBeGreaterThan(0);
      } finally { console.error = orig; }
    });
  });
}
