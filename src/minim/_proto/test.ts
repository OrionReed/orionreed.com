// Comprehensive test suite for the engine. Ports the load-bearing tests
// from `_test/anim.test.ts` plus prototype-specific coverage:
//   - reactive pause/resume mid-sleep
//   - descendants inherit transducer via spawn-chain (no onChild hook)
//   - deep stacking (N=100) doesn't crash
//   - userland detach, pauseWhen, slowmoWhen, trace
//   - yield 0 = park (no tail-call special case)
//
// Hand-rolled runner (no vitest dep) so we can run as a script.

import { Anim, cut, transduce, type Animator, type Yieldable } from "./engine";
import { scaled, detach, pauseWhen, slowmoWhen, trace } from "./userland";

let passed = 0;
let failed = 0;

function suite(name: string, fn: () => void) {
  console.log(`\n— ${name}`);
  fn();
}

function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n     ${(e as Error).message}`);
    const stack = (e as Error).stack?.split("\n").slice(1, 4).join("\n     ");
    if (stack) console.log(`     ${stack}`);
  }
}

function eq<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}${msg ? " — " + msg : ""}`);
}
function close(a: number, b: number, eps = 1e-9, msg?: string) {
  if (Math.abs(a - b) > eps) throw new Error(`expected ~${b}, got ${a}${msg ? " — " + msg : ""}`);
}
function truthy(a: unknown, msg?: string) {
  if (!a) throw new Error(`expected truthy${msg ? " — " + msg : ""}`);
}

// ────────────────────────── Yield contract ────────────────────────────

suite("yield contract", () => {
  it("yield; parks one frame", () => {
    const anim = new Anim();
    let log = "";
    function* g(): any { log += "a"; yield; log += "b"; }
    anim.start(g);
    eq(log, "a");
    anim.step(0.016);
    eq(log, "ab");
  });

  it("Tick payload on resume", () => {
    const anim = new Anim();
    let saw: any;
    function* g(): any { saw = yield; }
    anim.start(g);
    anim.step(0.025);
    close(saw.dt, 0.025);
    close(saw.elapsed, 0.025);
  });

  it("yield N sleeps ~N seconds", () => {
    const anim = new Anim();
    let woke = false;
    function* g(): any { yield 0.1; woke = true; }
    anim.start(g);
    anim.step(0.05);
    eq(woke, false);
    anim.step(0.06);
    anim.step(0.001);
    eq(woke, true);
  });

  it("sub-frame dt on wake", () => {
    const anim = new Anim();
    let saw: any;
    function* g(): any { saw = yield 0.05; }
    anim.start(g);
    anim.step(0.04);
    eq(saw, undefined);
    anim.step(0.02);
    close(saw.dt, 0.01);
    close(saw.elapsed, 0.06);
  });

  it("yield 0 = park (no tail-call special case)", () => {
    const anim = new Anim();
    let order = "";
    function* g(): any { order += "a"; yield 0; order += "b"; }
    anim.start(g);
    eq(order, "a");           // parks; NOT synchronous-resume
    anim.step(0.016);
    eq(order, "ab");
  });

  it("yield N < 0 = park (same as yield 0)", () => {
    const anim = new Anim();
    let order = "";
    function* g(): any { order += "a"; yield -1; order += "b"; }
    anim.start(g);
    eq(order, "a");
    anim.step(0.016);
    eq(order, "ab");
  });

  it("yield* sequences and propagates returns", () => {
    const anim = new Anim();
    let v: number | undefined;
    function* child(): any { yield; return 42; }
    function* parent(): any { v = yield* child(); }
    anim.start(parent);
    anim.step(0.016);
    anim.step(0.016);
    eq(v, 42);
  });

  it("yield [a, b] runs in parallel", () => {
    const anim = new Anim();
    let done = false;
    function* a(): any { yield; }
    function* b(): any { yield; yield; }
    function* g(): any { yield [a(), b()]; done = true; }
    anim.start(g);
    anim.step(0.016);
    eq(done, false);
    anim.step(0.016);
    eq(done, true);
  });

  it("yield gen waits for child completion", () => {
    const anim = new Anim();
    let after = false;
    function* child(): any { yield; yield; }
    function* g(): any { yield child(); after = true; }
    anim.start(g);
    anim.step(0.016);
    eq(after, false);
    anim.step(0.016);
    eq(after, true);
  });
});

// ────────────────────────── Cut sentinel ──────────────────────────────

suite("cut sentinel", () => {
  it("cut(v) settles enclosing concurrent group with v", () => {
    const anim = new Anim();
    let result: unknown;
    function* a(): any { yield; return cut("winner"); }
    function* b(): any { yield; yield; return "loser"; }
    function* g(): any { result = yield [a(), b()]; }
    anim.start(g);
    anim.step(0.016);
    anim.step(0.016);
    eq(result, "winner");
  });

  it("error in concurrent kid cancels siblings and propagates", () => {
    const anim = new Anim();
    let cleanedSibling = false;
    function* bad(): any { yield; throw new Error("boom"); }
    function* sib(): any {
      try { while (true) yield; }
      finally { cleanedSibling = true; }
    }
    let caught: unknown;
    function* g(): any {
      try { yield [bad(), sib()]; }
      catch (e) { caught = e; }
    }
    anim.start(g);
    anim.step(0.016);
    anim.step(0.016);
    eq((caught as Error)?.message, "boom");
    eq(cleanedSibling, true);
  });
});

// ────────────────────────── Suspend ───────────────────────────────────

suite("suspend", () => {
  it("delivers payload via wake", () => {
    const anim = new Anim();
    let received: number | undefined;
    let storedWake: any;
    function* g(): any {
      const v = yield ((wake: any) => { storedWake = wake; return () => {}; });
      received = v;
    }
    anim.start(g);
    storedWake(7);
    eq(received, 7);
  });

  it("sync wake during subscribe advances immediately", () => {
    const anim = new Anim();
    let after = false;
    function* g(): any {
      yield ((wake: any) => { wake(); return () => {}; });
      after = true;
    }
    anim.start(g);
    eq(after, true);
  });

  it("dispose cancels and runs Suspend dispose", () => {
    const anim = new Anim();
    let disposed = false;
    function* g(): any { yield (() => () => { disposed = true; }); }
    const d = anim.start(g);
    anim.step(0.016);
    d();
    eq(disposed, true);
  });
});

// ────────────────────────── Cancel cascade ────────────────────────────

suite("cancel", () => {
  it("runs try/finally", () => {
    const anim = new Anim();
    let cleaned = false;
    function* g(): any { try { yield (() => () => {}); } finally { cleaned = true; } }
    const d = anim.start(g);
    d();
    eq(cleaned, true);
  });

  it("cascades through concurrent kids", () => {
    const anim = new Anim();
    let leaf = false;
    function* kid(): any {
      try { yield (() => () => {}); } finally { leaf = true; }
    }
    function* parent(): any { yield [kid(), kid()]; }
    const d = anim.start(parent);
    anim.step(0.016);
    d();
    eq(leaf, true);
  });
});

// ────────────────────────── Userland: scaled ──────────────────────────

suite("scaled (userland transducer)", () => {
  it("scaled(0.5) halves dt seen by g", () => {
    const anim = new Anim();
    const dts: number[] = [];
    function* g(): any { while (true) dts.push((yield).dt); }
    anim.start(function* () { yield scaled(() => 0.5, g()) as Yieldable; });
    anim.step(0.1);
    anim.step(0.1);
    close(dts[0], 0.05);
    close(dts[1], 0.05);
  });

  it("scaled(0) freezes numeric sleeps", () => {
    const anim = new Anim();
    let done = false;
    function* g(): any { yield 1.0; done = true; }
    anim.start(function* () { yield scaled(() => 0, g()) as Yieldable; });
    for (let i = 0; i < 200; i++) anim.step(0.016);
    eq(done, false);
  });

  it("scaled(0) freezes parking", () => {
    const anim = new Anim();
    let ticks = 0;
    function* g(): any { while (true) { yield; ticks++; } }
    anim.start(function* () { yield scaled(() => 0, g()) as Yieldable; });
    for (let i = 0; i < 20; i++) anim.step(0.016);
    eq(ticks, 0);
  });

  it("scaled(2) doubles speed", () => {
    const anim = new Anim();
    let done = false;
    function* g(): any { yield 0.5; done = true; }
    anim.start(function* () { yield scaled(() => 2, g()) as Yieldable; });
    for (let i = 0; i < 14; i++) anim.step(1 / 60);
    eq(done, false);
    for (let i = 0; i < 3; i++) anim.step(1 / 60);
    eq(done, true);
  });

  it("reactive scale: pause → resume continues sleep", () => {
    const anim = new Anim();
    let done = false;
    let scale = 1;
    function* g(): any { yield 1.0; done = true; }
    anim.start(function* () { yield scaled(() => scale, g()) as Yieldable; });
    for (let i = 0; i < 30; i++) anim.step(1 / 60);
    eq(done, false);
    scale = 0;
    for (let i = 0; i < 1000; i++) anim.step(1 / 60);
    eq(done, false);
    scale = 1;
    for (let i = 0; i < 40; i++) anim.step(1 / 60);
    eq(done, true);
  });

  it("descendants inherit scale via spawn-chain (concurrent kids)", () => {
    const anim = new Anim();
    let ticks = 0;
    function* child(): any { while (true) { yield; ticks++; } }
    function* parent(): any { yield [child(), child()]; }
    anim.start(function* () { yield scaled(() => 0, parent()) as Yieldable; });
    for (let i = 0; i < 10; i++) anim.step(0.016);
    eq(ticks, 0);
  });

  it("nested scale compounds (0.5 inside 0.5 = 0.25)", () => {
    const anim = new Anim();
    const dts: number[] = [];
    function* g(): any { while (true) dts.push((yield).dt); }
    function* inner(): any { yield scaled(() => 0.5, g()) as Yieldable; }
    anim.start(function* () { yield scaled(() => 0.5, inner()) as Yieldable; });
    anim.step(1.0);
    close(dts[0], 0.25, 1e-3);
  });

  it("deep stacking N=100 doesn't crash and compounds correctly", () => {
    const anim = new Anim();
    let dt0 = 0;
    function* g(): any { dt0 = (yield).dt; }
    let target: any = g();
    for (let i = 0; i < 100; i++) target = scaled(() => 0.5, target);
    anim.start(function* () { yield target as Yieldable; });
    anim.step(1.0);
    close(dt0, Math.pow(0.5, 100), 1e-30);
  });
});

// ────────────────────────── Userland: detach ──────────────────────────

suite("detach (userland Suspend.ctx coordinator)", () => {
  it("resumes parent immediately", () => {
    const anim = new Anim();
    let log = "";
    function* sub(): any { yield 999; }
    function* parent(): any {
      log += "before ";
      yield* detach(sub());
      log += "after";
    }
    anim.start(parent);
    eq(log, "before after");
  });

  it("survives parent cancel", () => {
    const anim = new Anim();
    let subTicks = 0;
    function* sub(): any { while (true) { yield; subTicks++; } }
    function* parent(): any { yield* detach(sub()); yield 999; }
    const stop = anim.start(parent);
    anim.step(0.016);
    eq(subTicks, 1);
    stop();
    anim.step(0.016);
    eq(subTicks, 2);
  });

  it("dies on engine.stop()", () => {
    const anim = new Anim();
    let subTicks = 0;
    function* sub(): any { while (true) { yield; subTicks++; } }
    anim.start(function* () { yield* detach(sub()); });
    anim.step(0.016);
    eq(subTicks, 1);
    anim.stop();
    anim.step(0.016);
    eq(subTicks, 1);
  });
});

// ────────────────────────── Userland: extras ──────────────────────────

suite("pauseWhen / slowmoWhen / trace", () => {
  it("pauseWhen freezes via predicate", () => {
    const anim = new Anim();
    let ticks = 0;
    let paused = false;
    function* g(): any { while (true) { yield; ticks++; } }
    anim.start(function* () { yield pauseWhen(() => paused, g()) as Yieldable; });
    for (let i = 0; i < 5; i++) anim.step(0.016);
    eq(ticks, 5);
    paused = true;
    for (let i = 0; i < 100; i++) anim.step(0.016);
    eq(ticks, 5);
    paused = false;
    for (let i = 0; i < 3; i++) anim.step(0.016);
    eq(ticks, 8);
  });

  it("slowmoWhen halves speed conditionally", () => {
    const anim = new Anim();
    let done = false;
    let slow = false;
    function* g(): any { yield 1.0; done = true; }
    anim.start(function* () {
      yield slowmoWhen(() => slow, 0.5, g()) as Yieldable;
    });
    for (let i = 0; i < 30; i++) anim.step(1 / 60); // 0.5s real / 0.5s subj
    eq(done, false);
    slow = true;
    for (let i = 0; i < 30; i++) anim.step(1 / 60); // 0.5s real / 0.25s subj
    eq(done, false);
    for (let i = 0; i < 90; i++) anim.step(1 / 60); // catch up
    eq(done, true);
  });

  it("trace logs yields and resumes", () => {
    const anim = new Anim();
    const logs: string[] = [];
    function* g(): any { yield; yield 0.1; }
    anim.start(function* () {
      yield trace("t", g(), (m) => logs.push(m)) as Yieldable;
    });
    anim.step(0.05);
    truthy(logs.some((l) => l.includes("yield")), "should have yield log");
    truthy(logs.some((l) => l.includes("resume")), "should have resume log");
  });

  it("scaled + pauseWhen compose freely (stacked transducers)", () => {
    const anim = new Anim();
    let done = false;
    let paused = false;
    function* g(): any { yield 1.0; done = true; }
    anim.start(function* () {
      yield pauseWhen(() => paused, scaled(() => 0.5, g())) as Yieldable;
    });
    for (let i = 0; i < 30; i++) anim.step(1 / 60);  // 0.25 subj
    eq(done, false);
    paused = true;
    for (let i = 0; i < 1000; i++) anim.step(1 / 60);
    eq(done, false);
    paused = false;
    for (let i = 0; i < 100; i++) anim.step(1 / 60);
    eq(done, true);
  });
});

// ────────────────────────── Lifecycle ─────────────────────────────────

suite("lifecycle", () => {
  it("zero-dt step still ticks parked actives", () => {
    const anim = new Anim();
    let n = 0;
    function* g(): any { while (true) { yield; n++; } }
    anim.start(g);
    anim.step(0); anim.step(0); anim.step(0);
    eq(n, 3);
  });

  it("anim is reusable after stop()", () => {
    const anim = new Anim();
    let n = 0;
    function* g(): any { yield; n++; }
    anim.start(g); anim.step(0.016);
    anim.stop();
    eq(n, 1);
    anim.start(g); anim.step(0.016);
    eq(n, 2);
  });

  it("1000 cancels in tight loop", () => {
    const anim = new Anim();
    const ds: Array<() => void> = [];
    function* g(): any { yield; }
    for (let i = 0; i < 1000; i++) ds.push(anim.start(g));
    anim.step(0.016);
    for (const d of ds) d();
    anim.step(0.016);
    truthy(typeof anim.step === "function");
  });
});

// ────────────────────────── Transducer zero-dt ────────────────────────

suite("transducer cadence", () => {
  it("onTick fires on zero-dt steps (for observation transducers)", () => {
    const anim = new Anim();
    const ticks: number[] = [];
    function* g(): any { while (true) yield; }
    anim.start(function* () {
      yield transduce({ onTick: (dt) => { ticks.push(dt); return dt; } }, g()) as Yieldable;
    });
    anim.step(0);
    anim.step(0);
    anim.step(0.016);
    eq(ticks.length, 3);
    eq(ticks[0], 0);
    eq(ticks[1], 0);
    close(ticks[2], 0.016);
  });

  it("zero-dt step doesn't trigger transducer-freeze on parked actives", () => {
    const anim = new Anim();
    let n = 0;
    function* g(): any { while (true) { yield; n++; } }
    // scaled(0) — onTick returns 0 always. A zero-dt step should still
    // wake the READY active because the freeze condition `dt > 0 && subjDt === 0`
    // is false (dt is 0).
    anim.start(function* () { yield scaled(() => 0, g()) as Yieldable; });
    anim.step(0); anim.step(0); anim.step(0);
    eq(n, 3);
  });

  it("scaled(0) freeze still works for dt > 0 steps", () => {
    const anim = new Anim();
    let n = 0;
    function* g(): any { while (true) { yield; n++; } }
    anim.start(function* () { yield scaled(() => 0, g()) as Yieldable; });
    for (let i = 0; i < 20; i++) anim.step(0.016);
    eq(n, 0); // frozen
  });
});

// ────────────────────────── Re-entry ──────────────────────────────────

suite("re-entry", () => {
  it("anim.start() inside a gen body adds active for next frame", () => {
    const anim = new Anim();
    let childRan = false;
    function* child(): any { yield; childRan = true; }
    function* parent(): any {
      anim.start(child);
      yield;
    }
    anim.start(parent);
    eq(childRan, false);
    anim.step(0.016);
    // parent fires its yield resume; child's first advance ran during start()
    // → it parked; needs one more frame.
    anim.step(0.016);
    eq(childRan, true);
  });

  it("anim.stop() inside a gen finally cascades cleanly", () => {
    const anim = new Anim();
    let leafFinally = false;
    let outerFinally = false;
    function* leaf(): any {
      try { yield (() => () => {}); }
      finally { leafFinally = true; }
    }
    function* outer(): any {
      try { yield leaf(); }
      finally {
        outerFinally = true;
        anim.stop();
      }
    }
    const d = anim.start(outer);
    anim.step(0.016);
    d(); // cancel → triggers outer's finally → triggers anim.stop()
    eq(outerFinally, true);
    eq(leafFinally, true);
  });

  it("anim.step() inside a transducer onTick — does NOT cause double-tick of same active", () => {
    const anim = new Anim();
    let yields = 0;
    let didStep = false;
    function* g(): any { while (true) { yield; yields++; } }
    anim.start(function* () {
      yield transduce({
        onTick: (dt) => {
          if (!didStep) {
            didStep = true;
            // re-enter mid-iteration
            try { anim.step(0.016); } catch (_) { /* swallow */ }
          }
          return dt;
        },
      }, g()) as Yieldable;
    });
    anim.step(0.016);
    // Without a guard, the outer step's iteration will wake the same
    // active a second time after the inner step already advanced it.
    // Yields per outer step should be 1, NOT 2.
    eq(yields, 1);
  });

  it("anim.step() during a step throws/no-ops cleanly (re-entry guard)", () => {
    const anim = new Anim();
    let innerError: unknown = null;
    function* outer(): any {
      yield;
      // Inside advance() called from step's loop, try to step the engine again:
      try { anim.step(0.016); }
      catch (e) { innerError = e; }
    }
    anim.start(outer);
    anim.step(0.016); // wakes outer; outer tries re-entry
    truthy(innerError !== null, "expected an error from re-entrant step()");
    truthy(
      /re-?entrant|in.?progress|step/.test(String(innerError)),
      `error should mention re-entry, got: ${innerError}`,
    );
  });

  it("cancel handle called from inside its own gen body works", () => {
    const anim = new Anim();
    let cleanedUp = false;
    let dispose: (() => void) | undefined;
    function* g(): any {
      try {
        yield;
        dispose!();          // cancel ourselves while NOT busy
        yield;               // should never reach here
      } finally {
        cleanedUp = true;
      }
    }
    dispose = anim.start(g);
    anim.step(0.016);        // resumes g; g calls dispose mid-advance
    eq(cleanedUp, true);
  });

  it("cancel called during sibling advance doesn't lose siblings", () => {
    const anim = new Anim();
    const log: string[] = [];
    let dA: (() => void) | undefined;
    function* a(): any {
      log.push("a-start");
      yield;
      log.push("a-resumed");
      dB!();                 // cancel B from inside A
      yield;
      log.push("a-second");
    }
    let dB: (() => void) | undefined;
    function* b(): any {
      try {
        log.push("b-start");
        yield;
        log.push("b-resumed-should-not-happen");
      } finally {
        log.push("b-cleaned");
      }
    }
    dA = anim.start(a);
    dB = anim.start(b);
    anim.step(0.016);
    anim.step(0.016);
    // A should complete its second yield; B should have been cancelled cleanly.
    truthy(log.includes("a-resumed"), `expected a-resumed in ${log.join(",")}`);
    truthy(log.includes("b-cleaned"), `expected b-cleaned in ${log.join(",")}`);
    truthy(!log.includes("b-resumed-should-not-happen"), `B should not have resumed`);
  });

  it("anim.start() inside a wake-callback (post-stop) doesn't create zombies", () => {
    const anim = new Anim();
    let storedWake: any;
    let zombieRan = false;
    function* zombie(): any { yield; zombieRan = true; }
    function* g(): any {
      yield ((wake: any) => { storedWake = wake; return () => {}; });
    }
    anim.start(g);
    anim.stop();
    // External fires the wake after stop:
    storedWake?.();
    // If anything spawns here it would be a zombie. We're testing that
    // post-stop wake doesn't accidentally restart anything.
    anim.step(0.016);
    eq(zombieRan, false);
  });
});

// ────────────────────────── Type-level checks ────────────────────────
//
// Compile-time only: confirms `Resume<Transduced<R>>` recovers R, and
// scaled/pauseWhen/etc. preserve the wrapped gen's return type through
// composition. These don't have runtime assertions — if they compile,
// they pass. If you delete/rename something below and types break,
// either you broke the parameterization or the test expectation needs
// updating.

import type { Resume, Transduced } from "./engine";

function _typeChecks() {
  function* numGen(): Animator<number> { yield; return 42; }
  function* strGen(): Animator<string> { yield; return "ok"; }

  // scaled preserves R
  const sNum: Transduced<number> = scaled(() => 0.5, numGen());
  const sStr: Transduced<string> = scaled(() => 0.5, strGen());

  // Stacking preserves R
  const stacked: Transduced<number> = pauseWhen(() => false, scaled(() => 0.5, numGen()));

  // Resume<Transduced<R>> = R
  type R1 = Resume<typeof sNum>; // number
  type R2 = Resume<typeof sStr>; // string
  type R3 = Resume<typeof stacked>; // number

  // These all need to be assignable to themselves; if Resume<> returned
  // unknown (as it did before parameterization), these would fail.
  const _r1: R1 = 42;
  const _r2: R2 = "ok";
  const _r3: R3 = 42;

  // Wrong R should be rejected at compile time:
  // @ts-expect-error — number is not string
  const _bad: R2 = 42;

  return [sNum, sStr, stacked, _r1, _r2, _r3, _bad];
}

// ────────────────────────── Summary ──────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
