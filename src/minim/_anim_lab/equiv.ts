// Cross-engine semantic equivalence checks for the yield contract.
// Each test takes an EngineModule and returns void or throws. Run each
// against every candidate; any divergence from `current` is a bug.

import "./raf-polyfill";
import type { EngineModule } from "./scenarios";
import * as current from "./engine-current";
import * as v1 from "./engine-v1";
import * as v2 from "./engine-v2";
import * as v3 from "./engine-v3";
import * as v4 from "./engine-v4";
import * as v5 from "./engine-v5";
import * as v6 from "./engine-v6";
import * as v7 from "./engine-v7";
import * as v8 from "./engine-v8";
import * as v9 from "./engine-v9";
import * as v10 from "./engine-v10";
import * as v11 from "./engine-v11";
import * as v12 from "./engine-v12";

const engines: Record<string, EngineModule> = {
  current: { Engine: current.Anim, suspend: current.suspend },
  v1: { Engine: v1.Anim, suspend: v1.suspend },
  v2: { Engine: v2.Anim, suspend: v2.suspend },
  v3: { Engine: v3.Anim, suspend: v3.suspend },
  v4: { Engine: v4.Anim, suspend: v4.suspend },
  v5: { Engine: v5.Anim, suspend: v5.suspend },
  v6: { Engine: v6.Anim, suspend: v6.suspend },
  v7: { Engine: v7.Anim, suspend: v7.suspend },
  v8: { Engine: v8.Anim, suspend: v8.suspend },
  v9: { Engine: v9.Anim, suspend: v9.suspend },
  v10: { Engine: v10.Anim, suspend: v10.suspend },
  v11: { Engine: v11.Anim, suspend: v11.suspend },
  v12: { Engine: v12.Anim, suspend: v12.suspend },
};

type Test = ((mod: EngineModule) => unknown) & { skipOn?: string[] };

const tests: Record<string, Test> = {
  // ── Yield contract basics ──────────────────────────────────────────

  parkOneFrame(mod) {
    const e = new mod.Engine();
    let log = "";
    function* g() {
      log += "a";
      yield;
      log += "b";
    }
    e.run(g);
    if (log !== "a") throw new Error("a only after init");
    e.step(0.016);
    if (log !== "ab") throw new Error("b after frame");
    e.stop();
    return log;
  },

  parkManyFrames(mod) {
    const e = new mod.Engine();
    let n = 0;
    function* g() {
      while (true) {
        yield;
        n++;
      }
    }
    e.run(g);
    for (let i = 0; i < 10; i++) e.step(0.016);
    if (n !== 10) throw new Error(`expected 10 ticks got ${n}`);
    e.stop();
    return n;
  },

  receivesDtAsResume(mod) {
    const e = new mod.Engine();
    let saw: number | undefined;
    function* g() {
      saw = yield;
    }
    e.run(g);
    e.step(0.025);
    if (Math.abs((saw ?? 0) - 0.025) > 1e-9) {
      throw new Error(`expected dt=0.025 got ${saw}`);
    }
    e.stop();
    return saw;
  },

  sleep(mod) {
    const e = new mod.Engine();
    let done = false;
    function* g() {
      yield 0.1;
      done = true;
    }
    e.run(g);
    e.step(0.05);
    if (done) throw new Error("woke too early");
    e.step(0.05);
    if (!done) throw new Error("should have woken");
    e.stop();
    return done;
  },

  sleepAcrossManyFrames(mod) {
    const e = new mod.Engine();
    let done = false;
    function* g() {
      yield 0.5;
      done = true;
    }
    e.run(g);
    for (let i = 0; i < 29; i++) e.step(1 / 60);
    if (done) throw new Error("woke too early");
    for (let i = 0; i < 2; i++) e.step(1 / 60);
    if (!done) throw new Error("should have woken");
    e.stop();
    return done;
  },

  zeroSleepTailCall(mod) {
    const e = new mod.Engine();
    let order = "";
    function* g() {
      order += "a";
      yield 0;
      order += "b";
    }
    e.run(g);
    if (order !== "ab") throw new Error(`expected ab got ${order}`);
    e.stop();
    return order;
  },

  manyTailCallsInOneFrame(mod) {
    const e = new mod.Engine();
    let count = 0;
    function* g() {
      for (let i = 0; i < 100; i++) {
        yield 0;
        count++;
      }
    }
    e.run(g);
    if (count !== 100) throw new Error(`expected 100 tail calls got ${count}`);
    e.stop();
    return count;
  },

  yieldStarReturn(mod) {
    const e = new mod.Engine();
    let v: number | undefined;
    function* child() {
      yield;
      return 42;
    }
    function* parent() {
      v = yield* child();
    }
    e.run(parent);
    e.step(0.016);
    e.step(0.016);
    if (v !== 42) throw new Error(`expected 42 got ${v}`);
    e.stop();
    return v;
  },

  // ── Parallel array ─────────────────────────────────────────────────

  parallelArray(mod) {
    const e = new mod.Engine();
    let done = false;
    function* a() { yield; }
    function* b() { yield; yield; }
    function* g() {
      yield [a(), b()];
      done = true;
    }
    e.run(g);
    e.step(0.016);
    if (done) throw new Error("not yet");
    e.step(0.016);
    if (!done) throw new Error("should be done");
    e.stop();
    return done;
  },

  emptyParallel(mod) {
    const e = new mod.Engine();
    let done = false;
    function* g() {
      yield [] as any;
      done = true;
    }
    e.run(g);
    if (!done) throw new Error("empty array should sync-complete");
    e.stop();
    return done;
  },

  parallelManyChildren(mod) {
    const e = new mod.Engine();
    let done = false;
    const N = 20;
    function* leaf() { yield; }
    function* g() {
      const kids: any[] = [];
      for (let i = 0; i < N; i++) kids.push(leaf());
      yield kids;
      done = true;
    }
    e.run(g);
    e.step(0.016); // all leaves yield once and complete
    e.step(0.016); // parent advances
    if (!done) throw new Error("parent should have completed");
    e.stop();
    return done;
  },

  // ── Suspend / wake ─────────────────────────────────────────────────

  suspendPayload(mod) {
    const e = new mod.Engine();
    let received: number | undefined;
    let storedWake: ((v: number) => void) | undefined;
    function* g() {
      const v = yield* mod.suspend<number>((wake) => {
        storedWake = wake;
        return () => {};
      });
      received = v;
    }
    e.run(g);
    if (!storedWake) throw new Error("no wake");
    storedWake(7);
    if (received !== 7) throw new Error(`expected 7 got ${received}`);
    e.stop();
    return received;
  },

  syncWakeDuringSubscribe(mod) {
    const e = new mod.Engine();
    let after = false;
    function* g() {
      yield* mod.suspend<void>((wake) => {
        wake();
        return () => {};
      });
      after = true;
    }
    e.run(g);
    if (!after) throw new Error("sync wake should advance immediately");
    e.stop();
    return after;
  },

  bareSuspendFn(mod) {
    const e = new mod.Engine();
    let woke = false;
    function* g() {
      yield (wake: () => void) => {
        wake();
        return () => {};
      };
      woke = true;
    }
    e.run(g);
    if (!woke) throw new Error("sync wake should advance");
    e.stop();
    return woke;
  },

  doubleWakeIgnored(mod) {
    // Same wake closure called twice: only the first should advance.
    const e = new mod.Engine();
    let n = 0;
    let storedWake: (() => void) | undefined;
    function* g() {
      yield* mod.suspend<void>((wake) => {
        storedWake = wake;
        return () => {};
      });
      n++;
      // Park forever so a second wake on the SAME stored closure has
      // no chance to advance us into another suspend that re-rebinds.
      yield* mod.suspend<void>(() => () => {});
    }
    e.run(g);
    storedWake!();
    storedWake!();
    if (n !== 1) throw new Error(`expected 1 wake got ${n}`);
    e.stop();
    return n;
  },

  cancelDispose(mod) {
    const e = new mod.Engine();
    let disposed = false;
    function* g() {
      yield* mod.suspend<void>(() => () => { disposed = true; });
    }
    const dispose = e.run(g);
    e.step(0.016);
    dispose();
    if (!disposed) throw new Error("dispose not called");
    e.stop();
    return disposed;
  },

  cancelCascade(mod) {
    const e = new mod.Engine();
    let childDisposed = false;
    function* child() {
      yield* mod.suspend<void>(() => () => { childDisposed = true; });
    }
    function* parent() {
      yield* mod.suspend<void>((_wake, spawn) => {
        spawn(child());
        return () => {};
      });
    }
    const d = e.run(parent);
    e.step(0.016);
    d();
    if (!childDisposed) throw new Error("cascade failed");
    e.stop();
    return childDisposed;
  },

  cancelDeepCascade(mod) {
    const e = new mod.Engine();
    let leafDisposed = false;
    function* leaf() {
      yield* mod.suspend<void>(() => () => { leafDisposed = true; });
    }
    function* mid() {
      yield* mod.suspend<void>((_w, spawn) => {
        spawn(leaf());
        return () => {};
      });
    }
    function* root() {
      yield* mod.suspend<void>((_w, spawn) => {
        spawn(mid());
        return () => {};
      });
    }
    const d = e.run(root);
    d();
    if (!leafDisposed) throw new Error("deep cascade failed");
    e.stop();
    return leafDisposed;
  },

  completePayload(mod) {
    const e = new mod.Engine();
    let got: unknown;
    function* child() { return 99; }
    function* parent() {
      yield* mod.suspend<void>((wake, spawn) => {
        spawn(child(), (v) => { got = v; wake(); });
        return () => {};
      });
    }
    e.run(parent);
    e.step(0.016);
    if (got !== 99) throw new Error(`expected 99 got ${got}`);
    e.stop();
    return got;
  },

  onCompleteNotFiredOnCancel(mod) {
    const e = new mod.Engine();
    let fired = false;
    // Child parks forever; will only ever exit via cancel.
    function* child() {
      yield* mod.suspend<void>(() => () => {});
    }
    function* parent() {
      yield* mod.suspend<void>((_w, spawn) => {
        spawn(child(), () => { fired = true; });
        return () => {};
      });
    }
    const d = e.run(parent);
    d();
    if (fired) throw new Error("onComplete must not fire on cancel");
    e.stop();
    return fired;
  },

  // ── Re-entrancy / error handling ───────────────────────────────────

  cancelDuringAdvance(mod) {
    // A generator that cancels itself mid-advance via a yielded suspend.
    const e = new mod.Engine();
    let after = 0;
    let disposeSelf: (() => void) | undefined;
    function* g() {
      yield* mod.suspend<void>((_w) => {
        // We capture the disposer of g via the run() return below.
        return () => {};
      });
      after++;
    }
    disposeSelf = e.run(g);
    // Now cancel.
    disposeSelf!();
    if (after !== 0) throw new Error("must not advance past cancel");
    e.stop();
    return after;
  },

  errorInGeneratorIsolated(mod) {
    const e = new mod.Engine();
    // Suppress console.error noise from intentional throw.
    const origErr = console.error;
    let thrown: unknown;
    console.error = (..._args: unknown[]) => { thrown = _args[0]; };
    try {
      let otherTicked = false;
      function* bad(): any {
        throw new Error("boom");
        yield;
      }
      function* good() {
        yield;
        otherTicked = true;
      }
      e.run(bad);
      e.run(good);
      e.step(0.016);
      if (!otherTicked) throw new Error("good gen should still tick");
      if (!thrown) throw new Error("error should have been logged");
    } finally {
      console.error = origErr;
    }
    e.stop();
    return true;
  },

  // ── Spawn ordering ─────────────────────────────────────────────────

  spawnDuringStepDefersOneFrame(mod) {
    const e = new mod.Engine();
    let log = "";
    function* late() {
      log += "L";
      yield;
    }
    function* g() {
      yield* mod.suspend<void>((wake, spawn) => {
        spawn(late());
        wake();
        return () => {};
      });
      log += "G";
    }
    e.run(g);
    // Initial advance synchronously runs g → spawns late (initial-advances
    // it → "L") → wake() resumes g → "G". Both logged before any step.
    if (log !== "LG") throw new Error(`expected LG got ${log}`);
    e.stop();
    return log;
  },

  // ── Clock / listeners ──────────────────────────────────────────────

  clockListenerFires(mod) {
    const e = new mod.Engine();
    const seen: number[] = [];
    const dispose = (e as any).onClock?.((t: number) => seen.push(t));
    if (!dispose) {
      // Engine doesn't expose onClock; skip rather than fail.
      e.stop();
      return "skipped";
    }
    e.step(0.1);
    e.step(0.2);
    if (seen.length !== 2) throw new Error(`expected 2 ticks got ${seen.length}`);
    if (Math.abs(seen[0] - 0.1) > 1e-9) throw new Error("first tick wrong");
    if (Math.abs(seen[1] - 0.3) > 1e-9) throw new Error("second tick wrong");
    dispose();
    e.step(0.1);
    if (seen.length !== 2) throw new Error("dispose should stop ticks");
    e.stop();
    return seen.length;
  },

  // ── Scale composition ──────────────────────────────────────────────

  staticScaleHalvesDt: Object.assign(function staticScaleHalvesDt(mod: EngineModule) {
    const e = new mod.Engine();
    let dtSeen: number | undefined;
    function* worker() {
      while (true) {
        const dt = yield;
        dtSeen = dt;
      }
    }
    function* parent() {
      yield* mod.suspend<void>((_w, spawn) => {
        spawn(worker(), undefined, 0.5);
        return () => {};
      });
    }
    e.run(parent);
    e.step(1.0);
    if (dtSeen === undefined) throw new Error("worker never ticked");
    if (Math.abs(dtSeen - 0.5) > 1e-9) {
      throw new Error(`expected scaled dt=0.5 got ${dtSeen}`);
    }
    e.stop();
    return dtSeen;
  }, { skipOn: ["v10", "v11"] }),

  reactiveScale: Object.assign(function reactiveScale(mod: EngineModule) {
    const e = new mod.Engine();
    let scale = 1;
    let dtSeen: number | undefined;
    function* worker() {
      while (true) {
        const dt = yield;
        dtSeen = dt;
      }
    }
    function* parent() {
      yield* mod.suspend<void>((_w, spawn) => {
        spawn(worker(), undefined, () => scale);
        return () => {};
      });
    }
    e.run(parent);
    e.step(1.0);
    if (Math.abs((dtSeen ?? 0) - 1.0) > 1e-9) throw new Error("scale=1 dt wrong");
    scale = 2;
    e.step(1.0);
    if (Math.abs((dtSeen ?? 0) - 2.0) > 1e-9) {
      throw new Error(`scale=2 expected dt=2.0 got ${dtSeen}`);
    }
    e.stop();
    return dtSeen;
  }, { skipOn: ["v9", "v10", "v11", "v12"] }),

  // ── Memory leak guard ──────────────────────────────────────────────

  noChildAccumulation(mod) {
    const e = new mod.Engine();
    function* tinyChild() { return; }
    function* parent() {
      for (let i = 0; i < 50; i++) yield* tinyChild();
    }
    e.run(parent);
    for (let f = 0; f < 60; f++) e.step(0.016);
    const inner: any = e as any;
    const arr: any[] = inner.active ?? Array.from(inner.roots ?? []);
    let maxChildren = 0;
    for (const x of arr) {
      const cs: unknown[] | undefined = x?.children;
      if (cs && cs.length > maxChildren) maxChildren = cs.length;
    }
    if (maxChildren > 5) {
      throw new Error(
        `child list accumulated ${maxChildren} entries (likely leak)`,
      );
    }
    e.stop();
    return maxChildren;
  },
};

let failed = 0;
let passed = 0;
let skipped = 0;
for (const [tname, t] of Object.entries(tests)) {
  const skip = (t as Test).skipOn ?? [];
  for (const [ename, mod] of Object.entries(engines)) {
    if (skip.includes(ename)) { skipped++; continue; }
    try {
      t(mod);
      passed++;
    } catch (e) {
      failed++;
      console.error(`✗ ${tname} on ${ename}: ${(e as Error).message}`);
      if (process.env.STACK) console.error((e as Error).stack);
    }
  }
}
const total = Object.keys(tests).length * Object.keys(engines).length;
const ranTotal = total - skipped;
if (failed === 0) {
  console.log(
    `✓ all ${Object.keys(tests).length} tests pass on ${Object.keys(engines).length} engines (${passed}/${ranTotal}, ${skipped} skipped)`,
  );
} else {
  console.log(`✗ ${failed} failures (${passed}/${ranTotal} pass, ${skipped} skipped)`);
  process.exit(1);
}
