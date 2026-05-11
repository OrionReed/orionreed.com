// Runtime correctness tests for `Anim`. Each test creates a fresh `Anim`
// and drives it via `step(dt)` — fully synchronous and deterministic, no
// RAF dependency. Re-runs every few seconds so a regression shows up live.
//
// What's covered:
//   yield-contract:  number sleeps, undefined frames, parallel arrays,
//                    yield* delegation, yield gen delegation, tail-call (≤0).
//   cancellation:    stop()-from-within-gen runs finally; restart works;
//                    stop() cascades to scopes; run() disposer cancels.
//   isolation:       one throwing gen doesn't kill siblings.
//   awaitable:       sync wake, async wake, disposer fires on cancel,
//                    nested awaitables, ctx.spawn host-parented children,
//                    spawn-after-setup throws.
//   race:            first-completion wakes parent; losers are cancelled;
//                    children's full yield protocol is honoured; mixed
//                    Yieldable args (numbers, awaitables, generators).
//   until:           cancel-on-trigger pattern; sequel runs after.
//   observe:         spawn/complete/cancel events fire with correct ids;
//                    no overhead when no observer; cancel after disposer.
//   event bus:       emit / on; until is zero-latency (wakes inside emit).
//   signals:         equals option suppresses no-op writes.
//   lens:            read/write through; sub-field memoization;
//                    independent axes don't cross-fire.
//   point:           writable Point + axis lenses; derived Points
//                    (Bounds.center, math methods) are read-only.

import {
  Anim,
  DerivedPoint,
  Diagram,
  EventBus,
  Point,
  Scene,
  align,
  assemble,
  attract,
  centroid,
  circle,
  css,
  drift,
  forEach,
  fromPromise,
  label,
  lens,
  meanNum,
  meanRotation,
  meanScale,
  meanVec,
  oscillate,
  pt,
  pulse,
  race,
  signal,
  splay,
  spring,
  swap,
  until,
  untilChange,
  type Animator,
} from "../../minim";

type Status = "pending" | "running" | "pass" | "fail";

const COLOR: Record<Status, string> = {
  pending: "#999",
  running: "#f5a623",
  pass: "#2ecc71",
  fail: "#e74c3c",
};

interface TestCase {
  name: string;
  run: (assert: AssertFn) => void;
}

type AssertFn = (cond: boolean, msg?: string) => void;

const TESTS: TestCase[] = [
  {
    name: "sleep accumulates across ticks",
    run: (assert) => {
      const a = new Anim();
      let done = false;
      a.run(function* () {
        yield 0.5;
        done = true;
      });
      a.step(0.1);
      assert(!done, `done after 0.1s; should be false`);
      a.step(0.3);
      assert(!done, `done after 0.4s; should be false`);
      a.step(0.2);
      assert(done, `done after 0.6s; should be true`);
      a.stop();
    },
  },
  {
    name: "frame yield receives dt on resume",
    run: (assert) => {
      // The bootstrap `gen.next(0)` happens inside `spawn()` — by the time
      // user code calls `step`, the gen is already suspended at its first
      // `yield`. Each subsequent `step(dt)` resumes the gen and the dt
      // reaches the gen as the value of the yield expression.
      const a = new Anim();
      const dts: number[] = [];
      a.run(function* () {
        dts.push(yield);
        dts.push(yield);
      });
      a.step(0.016);
      a.step(0.02);
      assert(dts.length === 2, `dts.length=${dts.length}, expected 2`);
      assert(dts[0] === 0.016, `dts[0]=${dts[0]}, expected 0.016`);
      assert(dts[1] === 0.02, `dts[1]=${dts[1]}, expected 0.020`);
      a.stop();
    },
  },
  {
    name: "tail-call (yield 0) is synchronous",
    run: (assert) => {
      const a = new Anim();
      let n = 0;
      a.run(function* () {
        n = 1;
        yield 0;
        n = 2;
      });
      a.step(0);
      assert(n === 2, `n was ${n}; expected 2 in a single step`);
      a.stop();
    },
  },
  {
    name: "yield* delegates",
    run: (assert) => {
      const a = new Anim();
      let n = 0;
      function* inner(): Animator {
        n = 1;
        yield 0.1;
        n = 2;
      }
      a.run(function* () {
        yield* inner();
        n = 3;
      });
      a.step(0);
      assert(n === 1, `n was ${n} after start; expected 1`);
      a.step(0.15);
      assert(n === 3, `n was ${n} after inner done; expected 3`);
      a.stop();
    },
  },
  {
    name: "yield gen waits for child",
    run: (assert) => {
      const a = new Anim();
      let done = false;
      a.run(function* () {
        yield (function* (): Animator {
          yield 0.3;
        })();
        done = true;
      });
      a.step(0.15);
      assert(!done, `parent finished early`);
      a.step(0.2);
      assert(done, `parent should have resumed`);
      a.stop();
    },
  },
  {
    name: "parallel waits for all children",
    run: (assert) => {
      const a = new Anim();
      let done = false;
      a.run(function* () {
        yield [
          (function* (): Animator {
            yield 0.2;
          })(),
          (function* (): Animator {
            yield 0.5;
          })(),
        ];
        done = true;
      });
      a.step(0.3);
      assert(!done, `parent finished early`);
      a.step(0.3);
      assert(done, `parent should have resumed after slowest child`);
      a.stop();
    },
  },
  {
    name: "synchronous child completion cascades",
    run: (assert) => {
      const a = new Anim();
      let done = false;
      a.run(function* () {
        yield [
          (function* (): Animator {})(),
          (function* (): Animator {})(),
          (function* (): Animator {})(),
        ];
        done = true;
      });
      a.step(0);
      assert(done, `parent should resume in same step (all children sync)`);
      a.stop();
    },
  },
  {
    name: "primitives in parallel arrays",
    run: (assert) => {
      const a = new Anim();
      let done = false;
      a.run(function* () {
        yield [
          0.2,
          undefined,
          (function* (): Animator {
            yield 0.3;
          })(),
        ];
        done = true;
      });
      a.step(0.1);
      assert(!done, `done too early`);
      a.step(0.25);
      assert(done, `done after 0.35s`);
      a.stop();
    },
  },
  {
    name: "stop() from within gen runs finally",
    run: (assert) => {
      const a = new Anim();
      let aftermath = false;
      let finallyRan = false;
      a.run(function* () {
        try {
          a.stop();
          yield 1;
          aftermath = true;
        } finally {
          finallyRan = true;
        }
      });
      a.step(0);
      assert(!aftermath, `code after stop ran`);
      assert(finallyRan, `finally block did not run`);
    },
  },
  {
    name: "Anim is reusable after stop()",
    run: (assert) => {
      const a = new Anim();
      let runs = 0;
      a.run(function* () {
        runs++;
        yield 0.5;
        runs++;
      });
      a.step(0);
      a.stop();
      a.run(function* () {
        runs++;
        yield 0.5;
        runs++;
      });
      a.step(0);
      assert(runs === 2, `runs was ${runs}; expected 2 starts`);
      a.stop();
    },
  },
  {
    name: "throw at spawn time is isolated",
    run: (assert) => {
      // The bad gen throws on its first .next, which lands inside `spawn`
      // via `advance`. Isolation in `advance`'s catch keeps siblings alive.
      const a = new Anim();
      let goodRan = 0;
      const origError = console.error;
      console.error = () => {
        /* expected */
      };
      try {
        a.run(function* () {
          yield* (function* (): Animator {
            throw new Error("boom");
          })();
        });
        a.run(function* () {
          goodRan++;
          yield 0.1;
          goodRan++;
        });
        a.step(0.15);
        assert(goodRan === 2, `good gen ran ${goodRan}/2 phases`);
      } finally {
        console.error = origError;
        a.stop();
      }
    },
  },
  {
    name: "throw during step is isolated",
    run: (assert) => {
      // Bad gen suspends at first yield, then throws on resume during a
      // later step. Isolation must work for the in-loop throw path too.
      const a = new Anim();
      let goodRan = 0;
      const origError = console.error;
      console.error = () => {
        /* expected */
      };
      try {
        a.run(function* () {
          yield 0.05;
          throw new Error("boom");
        });
        a.run(function* () {
          goodRan++;
          yield 0.1;
          goodRan++;
        });
        a.step(0.06);
        a.step(0.06);
        assert(goodRan === 2, `good gen ran ${goodRan}/2 phases`);
      } finally {
        console.error = origError;
        a.stop();
      }
    },
  },
  {
    name: "child throw doesn't hang parent",
    run: (assert) => {
      // A throwing child must notify its parent (via `complete`) so the
      // parent's child counter decrements and the parent eventually wakes.
      const a = new Anim();
      let parentDone = false;
      const origError = console.error;
      console.error = () => {
        /* expected */
      };
      try {
        a.run(function* () {
          yield [
            (function* (): Animator {
              throw new Error("boom");
            })(),
            (function* (): Animator {
              yield 0.1;
            })(),
          ];
          parentDone = true;
        });
        a.step(0.15);
        assert(
          parentDone,
          `parent should resume after throwing child completes`,
        );
      } finally {
        console.error = origError;
        a.stop();
      }
    },
  },
  {
    name: "event bus: emit / on",
    run: (assert) => {
      const bus = new EventBus();
      let count = 0;
      let lastData: unknown = null;
      const off = bus.on("hi", (d) => {
        count++;
        lastData = d;
      });
      bus.emit("hi", { x: 1 });
      bus.emit("hi", { x: 2 });
      assert(count === 2, `count was ${count}; expected 2`);
      assert((lastData as { x: number }).x === 2, `data didn't propagate`);
      off();
      bus.emit("hi");
      assert(count === 2, `handler still firing after disposer`);
    },
  },
  {
    name: "event bus: until wakes synchronously inside emit",
    run: (assert) => {
      // Awaitable contract: when emit fires, the waiting generator
      // resumes in the same tick — no extra step required.
      const a = new Anim();
      const bus = new EventBus();
      let woken = false;
      a.run(function* () {
        yield bus.until("go");
        woken = true;
      });
      a.step(0);
      a.step(0.1);
      assert(!woken, `should still be waiting`);
      bus.emit("go");
      assert(woken, `should have woken inside the emit() call`);
      a.stop();
    },
  },
  {
    name: "Awaitable: out-of-band wake advances the gen",
    run: (assert) => {
      const a = new Anim();
      let captured: (() => void) | undefined;
      let woken = false;
      a.run(function* () {
        yield (wake) => {
          captured = wake;
          return () => {};
        };
        woken = true;
      });
      a.step(0);
      assert(!woken, `should be suspended on Awaitable`);
      assert(captured !== undefined, `subscribe should have run`);
      captured!();
      assert(woken, `wake should advance the gen synchronously`);
      a.stop();
    },
  },
  {
    name: "Awaitable: synchronous resolve advances immediately",
    run: (assert) => {
      // Subscribe calls wake before returning — gen advances re-entrantly,
      // and the outer advance bails without overwriting awaitDispose.
      const a = new Anim();
      let phase = 0;
      a.run(function* () {
        phase = 1;
        yield (wake) => {
          wake();
          return () => {};
        };
        phase = 2;
      });
      a.step(0);
      assert(phase === 2, `phase=${phase}, expected 2 (sync resolve)`);
      a.stop();
    },
  },
  {
    name: "Awaitable: disposer fires when cancelled before wake",
    run: (assert) => {
      const a = new Anim();
      let disposed = false;
      const handle = a.run(function* () {
        yield (_wake) => () => {
          disposed = true;
        };
      });
      a.step(0);
      assert(!disposed, `still suspended; disposer should not have run`);
      handle();
      assert(disposed, `cancel should have called the disposer`);
    },
  },
  {
    name: "run() disposer cancels and runs finally",
    run: (assert) => {
      const a = new Anim();
      let finallyRan = false;
      const handle = a.run(function* () {
        try {
          yield 5;
        } finally {
          finallyRan = true;
        }
      });
      a.step(0);
      handle();
      assert(finallyRan, `finally should have run on disposer call`);
      a.stop();
    },
  },
  {
    name: "race: first child wins, others are cancelled",
    run: (assert) => {
      const a = new Anim();
      let aFinally = 0;
      let bFinally = 0;
      let parentDone = false;
      a.run(function* () {
        yield race(
          (function* (): Animator {
            try {
              yield 0.1;
            } finally {
              aFinally++;
            }
          })(),
          (function* (): Animator {
            try {
              yield 0.5;
            } finally {
              bFinally++;
            }
          })(),
        );
        parentDone = true;
      });
      a.step(0);
      a.step(0.15);
      assert(parentDone, `parent should have resumed after first finished`);
      assert(aFinally === 1, `winner's finally should run (got ${aFinally})`);
      assert(bFinally === 1, `loser's finally should run (got ${bFinally})`);
      a.stop();
    },
  },
  {
    name: "cancel cascades to children",
    run: (assert) => {
      // When a parent active is cancelled, its spawned children (via
      // `yield gen` or `yield array`) get cancelled too — their finally
      // blocks run and they don't keep advancing as orphans.
      const a = new Anim();
      let childFinally = 0;
      const handle = a.run(function* () {
        yield [
          (function* (): Animator {
            try {
              yield 5;
            } finally {
              childFinally++;
            }
          })(),
          (function* (): Animator {
            try {
              yield 5;
            } finally {
              childFinally++;
            }
          })(),
        ];
      });
      a.step(0);
      handle();
      assert(childFinally === 2, `expected both children's finallys (got ${childFinally})`);
      a.stop();
    },
  },
  {
    name: "race: child yield protocol works (sub-gen, sleep, parallel)",
    run: (assert) => {
      // Children use the full yield contract. Slow child uses a parallel
      // array; fast child uses yield* delegation; both legal inside race.
      const a = new Anim();
      let parentDone = false;
      a.run(function* () {
        yield race(
          (function* (): Animator {
            yield* (function* (): Animator {
              yield 0.05;
            })();
          })(),
          (function* (): Animator {
            yield [
              (function* (): Animator {
                yield 1;
              })(),
              (function* (): Animator {
                yield 1;
              })(),
            ];
          })(),
        );
        parentDone = true;
      });
      a.step(0);
      a.step(0.06);
      assert(parentDone, `parent should resume on the fast child`);
      a.stop();
    },
  },
  {
    name: "race: accepts mixed Yieldable args (number, awaitable, gen)",
    run: (assert) => {
      // `race(...)` lifts non-generator Yieldables. A number means
      // "sleep for N seconds"; an awaitable subscribes directly.
      const a = new Anim();
      const bus = new EventBus();
      let winner = "";
      a.run(function* () {
        yield race(
          0.5,
          bus.until("go"),
          (function* (): Animator {
            yield 0.1;
            winner = "gen";
          })(),
        );
      });
      a.step(0);
      a.step(0.12);
      // The 0.1s gen wins; sets winner before resuming parent.
      assert(winner === "gen", `winner=${winner}, expected "gen"`);
      a.stop();
    },
  },
  {
    name: "race: number arg wins on time",
    run: (assert) => {
      const a = new Anim();
      let resumed = false;
      a.run(function* () {
        yield race(
          0.1,
          (function* (): Animator {
            yield 5;
          })(),
        );
        resumed = true;
      });
      a.step(0);
      a.step(0.12);
      assert(resumed, `parent should resume after the 0.1s sleep wins`);
      a.stop();
    },
  },
  {
    name: "until: cancels work on trigger, sequel runs",
    run: (assert) => {
      // The graceful-exit pattern: work runs until trigger fires; the
      // next `yield*` is the exit. Both run in the same generator.
      const a = new Anim();
      const stop = signal(false);
      let phase = 0;
      a.run(function* () {
        yield until(
          untilChange(stop),
          (function* (): Animator {
            phase = 1;
            while (true) yield;
          })(),
        );
        phase = 2;
        yield 0.1;
        phase = 3;
      });
      a.step(0);
      assert(phase === 1, `phase=${phase}, expected 1 (work running)`);
      stop.value = true;
      assert(phase === 2, `phase=${phase}, expected 2 after trigger`);
      a.step(0.11);
      assert(phase === 3, `phase=${phase}, expected 3 after sequel`);
      a.stop();
    },
  },
  {
    name: "ctx.spawn parents children to the suspended host",
    run: (assert) => {
      // An awaitable that uses ctx.spawn produces children whose
      // cancel-cascade walks through the host. Killing the host kills
      // the children (their finallys fire) without manual plumbing.
      const a = new Anim();
      let childFinally = 0;
      const handle = a.run(function* () {
        yield (_wake, spawn) => {
          spawn!(
            (function* (): Animator {
              try {
                yield 5;
              } finally {
                childFinally++;
              }
            })(),
          );
          spawn!(
            (function* (): Animator {
              try {
                yield 5;
              } finally {
                childFinally++;
              }
            })(),
          );
          return () => {};
        };
      });
      a.step(0);
      handle();
      assert(
        childFinally === 2,
        `cascade should run both children's finallys (got ${childFinally})`,
      );
      a.stop();
    },
  },
  {
    name: "ctx.spawn after setup throws",
    run: (assert) => {
      const a = new Anim();
      let captured: ((g: Animator) => () => void) | undefined;
      a.run(function* () {
        yield (_wake, spawn) => {
          captured = spawn!;
          return () => {};
        };
      });
      a.step(0);
      let threw = false;
      try {
        captured!(
          (function* (): Animator {
            yield;
          })(),
        );
      } catch {
        threw = true;
      }
      assert(threw, `spawn outside setup window should throw`);
      a.stop();
    },
  },
  {
    name: "ctx.spawn onComplete fires on natural completion",
    run: (assert) => {
      // The `onComplete` hook is how `race`/`all`/`single` learn that a
      // spawned child finished. It must NOT fire on cancel.
      const a = new Anim();
      let completes = 0;
      let cancels = 0;
      a.run(function* () {
        yield (_wake, spawn) => {
          spawn!(
            (function* (): Animator {
              yield 0.05;
            })(),
            () => completes++,
          );
          const cancelChild = spawn!(
            (function* (): Animator {
              try {
                yield 5;
              } finally {
                cancels++;
              }
            })(),
            () => completes++, // SHOULD NOT fire — we cancel this one
          );
          // Cancel the second child immediately.
          cancelChild();
          return () => {};
        };
      });
      a.step(0);
      a.step(0.06);
      assert(completes === 1, `expected 1 onComplete (got ${completes})`);
      assert(cancels === 1, `cancelled child's finally should run`);
      a.stop();
    },
  },
  {
    name: "observe: emits spawn / complete / cancel events",
    run: (assert) => {
      const a = new Anim();
      type Ev = { type: "spawn" | "complete" | "cancel"; id: number };
      const events: Ev[] = [];
      const stop = a.observe({
        spawn: (id) => events.push({ type: "spawn", id }),
        complete: (id) => events.push({ type: "complete", id }),
        cancel: (id) => events.push({ type: "cancel", id }),
      });
      const handle = a.run(function* () {
        yield 0.1;
      });
      a.step(0);
      assert(events.length === 1 && events[0].type === "spawn", `spawn`);
      const id = events[0].id;
      handle();
      const cancelled = events.find((e) => e.type === "cancel");
      assert(cancelled?.id === id, `cancel event should reference same id`);
      stop();
      a.stop();
    },
  },
  {
    name: "observe: zero events fire after disposer",
    run: (assert) => {
      const a = new Anim();
      let count = 0;
      const stop = a.observe({
        spawn: () => count++,
      });
      a.run(function* () {
        yield;
      });
      a.step(0);
      assert(count === 1, `pre-stop spawn should be observed`);
      stop();
      a.run(function* () {
        yield;
      });
      a.step(0);
      assert(count === 1, `no events after disposer (got ${count})`);
      a.stop();
    },
  },
  {
    name: "signal equals option suppresses no-op writes",
    run: (assert) => {
      const s = signal(
        { x: 1, y: 2 },
        { equals: (a, b) => a.x === b.x && a.y === b.y },
      );
      let fires = 0;
      s.subscribe(() => fires++);
      // Initial subscribe call.
      assert(fires === 1, `initial fire count was ${fires}, expected 1`);
      // Same-value write (different object): suppressed.
      s.value = { x: 1, y: 2 };
      assert(fires === 1, `same-value write fired (${fires})`);
      // Different value: fires.
      s.value = { x: 1, y: 3 };
      assert(fires === 2, `changed write didn't fire (${fires})`);
    },
  },
  {
    name: "lens reads through and writes back",
    run: (assert) => {
      const parent = signal({ a: 1, b: 2 });
      const lensA = lens(
        () => parent.value.a,
        (n) => {
          parent.value = { ...parent.peek(), a: n };
        },
      );
      assert(lensA.value === 1, `read mismatch: ${lensA.value}`);
      lensA.value = 10;
      assert(parent.peek().a === 10, `write didn't propagate: ${parent.peek().a}`);
      assert(parent.peek().b === 2, `unrelated field changed: ${parent.peek().b}`);
      assert(lensA.value === 10, `lens didn't see its own write`);
    },
  },
  {
    name: "lens aggregates multiple parents (centroid-style)",
    run: (assert) => {
      // The general `lens(read, write)` form: read averages two
      // signals (tracked, so changes invalidate the lens), write
      // distributes a delta back to both.
      const a = signal(0);
      const b = signal(10);
      const avg = lens(
        () => (a.value + b.value) / 2,
        (n) => {
          const delta = n - (a.peek() + b.peek()) / 2;
          a.value = a.peek() + delta;
          b.value = b.peek() + delta;
        },
      );
      assert(avg.value === 5, `initial avg: ${avg.value}`);
      avg.value = 20;
      assert(a.peek() === 15, `a after write: ${a.peek()}`);
      assert(b.peek() === 25, `b after write: ${b.peek()}`);
      assert(avg.value === 20, `avg after write: ${avg.value}`);
    },
  },
  {
    name: "lens: independent axes don't cross-fire",
    run: (assert) => {
      const p = pt(1, 2);
      let xFires = 0;
      let yFires = 0;
      p.x.subscribe(() => xFires++);
      p.y.subscribe(() => yFires++);
      // Initial subscribe-call fires.
      assert(xFires === 1 && yFires === 1, `initial fires off`);
      p.x.value = 99;
      assert(xFires === 2, `x didn't fire on x-write (${xFires})`);
      assert(yFires === 1, `y fired on x-write (${yFires})`);
      p.y.value = 88;
      assert(xFires === 2, `x fired on y-write (${xFires})`);
      assert(yFires === 2, `y didn't fire on y-write (${yFires})`);
    },
  },
  {
    name: "point: parent write reaches lenses",
    run: (assert) => {
      const p = pt(1, 2);
      assert(p.x.value === 1 && p.y.value === 2, `read mismatch`);
      p.value = { x: 10, y: 20 };
      assert(p.x.value === 10, `lens x didn't update: ${p.x.value}`);
      assert(p.y.value === 20, `lens y didn't update: ${p.y.value}`);
    },
  },
  {
    name: "point: per-axis tween + parallel composition",
    run: (assert) => {
      const a = new Anim();
      const p = pt(0, 0);
      a.run(function* () {
        yield [p.x.to(10, 0.1), p.y.to(20, 0.1)];
      });
      a.step(0);
      a.step(0.05);
      // Mid-tween: both axes have advanced.
      assert(p.x.value > 0 && p.x.value < 10, `x mid: ${p.x.value}`);
      assert(p.y.value > 0 && p.y.value < 20, `y mid: ${p.y.value}`);
      a.step(0.06);
      assert(p.x.value === 10, `x final: ${p.x.value}`);
      assert(p.y.value === 20, `y final: ${p.y.value}`);
      a.stop();
    },
  },
  {
    name: "pt(literal) → Point; pt(signal) → DerivedPoint",
    run: (assert) => {
      const lit = pt(1, 2);
      assert(lit instanceof Point, `pt(num,num) should be Point`);
      const s = signal(5);
      const der = pt(s, 10);
      assert(der instanceof DerivedPoint, `pt(sig,num) should be DerivedPoint`);
      assert(der.x.value === 5 && der.y.value === 10, `derived read off`);
      s.value = 99;
      assert(der.x.value === 99, `derived didn't follow source: ${der.x.value}`);
    },
  },
  {
    name: "point math returns DerivedPoint",
    run: (assert) => {
      const a = pt(1, 2);
      const b = pt(3, 4);
      const sum = a.add(b);
      assert(sum instanceof DerivedPoint, `add result not DerivedPoint`);
      assert(sum.value.x === 4 && sum.value.y === 6, `sum value off`);
      // Reactive: changing a updates sum.
      a.value = { x: 10, y: 20 };
      assert(sum.value.x === 13 && sum.value.y === 24, `sum didn't react`);
    },
  },
  {
    name: "centroid: read averages, write distributes delta",
    run: (assert) => {
      // Two stand-in shapes: anything with a writable Point at .translate.
      const a = { translate: pt(0, 0) };
      const b = { translate: pt(100, 50) };
      const c = centroid(a, b);
      assert(c instanceof Point, `centroid should be a Point`);
      assert(c.value.x === 50 && c.value.y === 25, `initial avg off`);
      // Write the whole Vec — both shapes shift by the delta.
      c.value = { x: 60, y: 35 };
      assert(a.translate.peek().x === 10, `a.x after write: ${a.translate.peek().x}`);
      assert(b.translate.peek().x === 110, `b.x after write: ${b.translate.peek().x}`);
      assert(a.translate.peek().y === 10, `a.y after write: ${a.translate.peek().y}`);
      assert(b.translate.peek().y === 60, `b.y after write: ${b.translate.peek().y}`);
      // Per-axis write — only x distributes.
      c.x.value = 100;  // delta dx = 100 - 60 = 40
      assert(a.translate.peek().x === 50, `a.x after axis: ${a.translate.peek().x}`);
      assert(b.translate.peek().x === 150, `b.x after axis: ${b.translate.peek().x}`);
      assert(a.translate.peek().y === 10, `a.y after axis (unchanged): ${a.translate.peek().y}`);
    },
  },
  {
    name: "meanNum: read avg, write distributes",
    run: (assert) => {
      const a = signal(0);
      const b = signal(10);
      const c = signal(20);
      const m = meanNum(a, b, c);
      assert(m.value === 10, `initial mean: ${m.value}`);
      m.value = 13;  // delta = 3 → each += 3
      assert(a.peek() === 3, `a after: ${a.peek()}`);
      assert(b.peek() === 13, `b after: ${b.peek()}`);
      assert(c.peek() === 23, `c after: ${c.peek()}`);
      assert(m.value === 13, `mean after: ${m.value}`);
    },
  },
  {
    name: "meanVec: drop-in centroid for raw signals",
    run: (assert) => {
      const a = signal({ x: 0, y: 0 });
      const b = signal({ x: 100, y: 50 });
      const m = meanVec(a, b);
      assert(m instanceof Point, `meanVec should return a Point`);
      assert(m.value.x === 50 && m.value.y === 25, `initial mean off`);
      m.value = { x: 60, y: 35 };  // delta (10, 10)
      assert(a.peek().x === 10 && a.peek().y === 10, `a not shifted: ${JSON.stringify(a.peek())}`);
      assert(b.peek().x === 110 && b.peek().y === 60, `b not shifted: ${JSON.stringify(b.peek())}`);
    },
  },
  {
    name: "swap: tweens exchange translates",
    run: (assert) => {
      const a = new Anim();
      const sh1 = { translate: pt(0, 0) };
      const sh2 = { translate: pt(100, 50) };
      a.run(function* () {
        yield* swap(sh1, sh2, 0.1);
      });
      a.step(0);
      a.step(0.11);
      // After full tween, positions are exchanged.
      assert(sh1.translate.peek().x === 100, `sh1.x: ${sh1.translate.peek().x}`);
      assert(sh1.translate.peek().y === 50, `sh1.y: ${sh1.translate.peek().y}`);
      assert(sh2.translate.peek().x === 0, `sh2.x: ${sh2.translate.peek().x}`);
      assert(sh2.translate.peek().y === 0, `sh2.y: ${sh2.translate.peek().y}`);
      a.stop();
    },
  },
  {
    name: "splay: distributes radially around centre",
    run: (assert) => {
      const a = new Anim();
      const centre = pt(100, 100);
      const shapes = [
        { translate: pt(0, 0) },
        { translate: pt(0, 0) },
        { translate: pt(0, 0) },
        { translate: pt(0, 0) },
      ];
      a.run(function* () {
        yield* splay(centre, 50, shapes, 0.1);
      });
      a.step(0);
      a.step(0.11);
      // All four shapes are at distance 50 from centre.
      for (let i = 0; i < shapes.length; i++) {
        const v = shapes[i].translate.peek();
        const d = Math.hypot(v.x - 100, v.y - 100);
        assert(Math.abs(d - 50) < 0.001, `shape ${i} dist: ${d}`);
      }
      a.stop();
    },
  },
  {
    name: "assemble: pairs each shape to its target",
    run: (assert) => {
      const a = new Anim();
      const shapes = [
        { translate: pt(0, 0) },
        { translate: pt(0, 0) },
      ];
      const targets = [
        { x: 100, y: 0 },
        { x: 0, y: 100 },
      ];
      a.run(function* () {
        yield* assemble(shapes, targets, 0.1);
      });
      a.step(0);
      a.step(0.11);
      assert(shapes[0].translate.peek().x === 100, `s0.x: ${shapes[0].translate.peek().x}`);
      assert(shapes[1].translate.peek().y === 100, `s1.y: ${shapes[1].translate.peek().y}`);
      a.stop();
    },
  },
  {
    name: "pulse signal increments",
    run: (assert) => {
      const a = new Anim();
      const p = pulse(a, 0.1);
      assert(p.value === 0, `starts at 0`);
      a.step(0);
      a.step(0.15);
      assert(p.value >= 1, `expected >= 1, got ${p.value}`);
      a.stop();
    },
  },
  {
    name: "spring: settles at target with precision",
    run: (assert) => {
      const a = new Anim();
      const sig = signal(0);
      let done = false;
      a.run(function* () {
        yield* spring(sig, 100, { precision: 0.01 });
        done = true;
      });
      // Step long enough for a critically-damped spring to settle
      // (~6 / sqrt(stiffness) seconds at default stiffness=170).
      for (let i = 0; i < 200; i++) a.step(0.016);
      assert(done, `spring should have settled`);
      assert(sig.value === 100, `should snap to target; got ${sig.value}`);
      a.stop();
    },
  },
  {
    name: "oscillate: returns to base across one period",
    run: (assert) => {
      const a = new Anim();
      const sig = signal(50);
      a.run(() => oscillate(sig, 10, 1)); // amp=10, freq=1Hz
      a.step(0);
      a.step(0.25); // quarter period — should be near base + amp
      assert(Math.abs(sig.value - 60) < 0.5, `quarter: ${sig.value}`);
      a.step(0.75); // full period — back near base
      assert(Math.abs(sig.value - 50) < 0.5, `period: ${sig.value}`);
      a.stop();
    },
  },
  {
    name: "drift: integrates velocity over time",
    run: (assert) => {
      const a = new Anim();
      const sig = signal(0);
      a.run(() => drift(sig, 100));
      a.step(0);
      a.step(0.5);
      assert(Math.abs(sig.value - 50) < 0.001, `at t=0.5: ${sig.value}`);
      a.stop();
    },
  },
  {
    name: "attract: exponential pull toward target",
    run: (assert) => {
      const a = new Anim();
      const sig = signal(0);
      a.run(() => attract(sig, 100, 1));
      a.step(0);
      // Many small steps approximate continuous: 1 - e^-1 ≈ 0.632
      for (let i = 0; i < 100; i++) a.step(0.01);
      assert(
        Math.abs(sig.value - 63.2) < 1,
        `after t=1: ${sig.value} (expected ~63.2)`,
      );
      a.stop();
    },
  },
  {
    name: "untilChange: wakes on next signal change",
    run: (assert) => {
      const a = new Anim();
      const sig = signal(0);
      let woke = false;
      a.run(function* () {
        yield untilChange(sig);
        woke = true;
      });
      a.step(0);
      assert(!woke, `should not wake before change`);
      sig.value = 1;
      assert(woke, `should wake on change`);
      a.stop();
    },
  },
  {
    name: "untilChange: ignores baseline read",
    run: (assert) => {
      const a = new Anim();
      const sig = signal(42);
      let woke = false;
      a.run(function* () {
        yield untilChange(sig);
        woke = true;
      });
      // The first effect run reads the current value and must not wake.
      a.step(0);
      a.step(0.1);
      assert(!woke, `baseline read should not wake`);
      a.stop();
    },
  },
  {
    name: "fromPromise: disposer suppresses wake after cancel",
    run: (assert) => {
      const a = new Anim();
      let resolve!: () => void;
      const p = new Promise<void>((r) => {
        resolve = r;
      });
      let woke = false;
      const dispose = a.run(function* () {
        yield fromPromise(p);
        woke = true;
      });
      a.step(0);
      assert(!woke, `not before settlement`);
      // Cancel the active before the promise settles. The disposer
      // sets a "cancelled" flag — even when the microtask fires later,
      // wake is suppressed.
      dispose();
      resolve();
      a.step(0);
      assert(!woke, `wake suppressed after dispose`);
      a.stop();
    },
  },
  {
    name: "meanRotation: distributes delta across shapes",
    run: (assert) => {
      const sh1 = { rotate: signal(0) };
      const sh2 = { rotate: signal(Math.PI / 2) };
      const m = meanRotation(sh1, sh2);
      assert(
        Math.abs(m.value - Math.PI / 4) < 1e-9,
        `mean: ${m.value}`,
      );
      // Write distributes the delta rigidly.
      m.value = Math.PI / 2;
      assert(
        Math.abs(sh1.rotate.value - Math.PI / 4) < 1e-9,
        `sh1: ${sh1.rotate.value}`,
      );
      assert(
        Math.abs(sh2.rotate.value - (3 * Math.PI) / 4) < 1e-9,
        `sh2: ${sh2.rotate.value}`,
      );
    },
  },
  {
    name: "meanScale: writable Point over scale fields",
    run: (assert) => {
      const sh1 = { scale: pt(1, 1) };
      const sh2 = { scale: pt(2, 2) };
      const m = meanScale(sh1, sh2);
      assert(m.value.x === 1.5, `mean.x: ${m.value.x}`);
      m.value = { x: 3, y: 3 }; // delta = +1.5 each
      assert(sh1.scale.peek().x === 2.5, `sh1.x: ${sh1.scale.peek().x}`);
      assert(sh2.scale.peek().x === 3.5, `sh2.x: ${sh2.scale.peek().x}`);
    },
  },
];

const ROW_H = 22;
const HEADER_H = 36;
const PAD_X = 16;

export class MdRuntimeTests extends Diagram {
  static styles = css`
    :host {
      --scene-max-width: 640px;
    }
  `;

  protected scene(s: Scene): void {
    const W = 600;
    const H = HEADER_H + TESTS.length * ROW_H + 36;
    s.view(0, 0, W, H);

    const statuses = TESTS.map(() => signal<Status>("pending"));
    const messages = TESTS.map(() => signal<string>(""));
    const summary = signal<string>("");

    s(
      label(pt(PAD_X, 18), "minim runtime tests", {
        size: 14,
        bold: true,
        align: align.left,
      }),
    );
    s(
      label(pt(W - PAD_X, 18), summary, {
        size: 12,
        align: align.right,
        opacity: 0.8,
      }),
    );

    forEach(s.root, TESTS, (t, i) => {
      const y = HEADER_H + i * ROW_H + ROW_H / 2;
      const dot = circle(pt(PAD_X + 6, y), 5, {
        fill: statuses[i].derive((st) => COLOR[st]),
      });
      const name = label(pt(PAD_X + 22, y), t.name, {
        size: 12,
        align: align.left,
        opacity: statuses[i].derive((st) => (st === "pending" ? 0.5 : 1)),
      });
      const msg = label(pt(W - PAD_X, y), messages[i], {
        size: 11,
        align: align.right,
        opacity: 0.65,
      });
      return [dot, name, msg];
    });

    // Footer hint.
    s(
      label(
        pt(W / 2, H - 12),
        "all tests run on a fresh Anim driven by step(dt)",
        { size: 10, align: align.center, opacity: 0.5 },
      ),
    );

    // Test driver — runs each test then holds, looping.
    this.anim.loop(function* () {
      // Reset.
      for (let i = 0; i < TESTS.length; i++) {
        statuses[i].value = "pending";
        messages[i].value = "";
      }
      summary.value = "";
      yield 0.3;

      let passed = 0;
      let failed = 0;

      for (let i = 0; i < TESTS.length; i++) {
        const t = TESTS[i];
        statuses[i].value = "running";
        let didFail = false;
        const assert: AssertFn = (cond, msg) => {
          if (!cond && !didFail) {
            didFail = true;
            statuses[i].value = "fail";
            messages[i].value = msg ?? "assertion failed";
          }
        };
        try {
          t.run(assert);
          if (!didFail) {
            statuses[i].value = "pass";
            messages[i].value = "ok";
          }
        } catch (e) {
          statuses[i].value = "fail";
          messages[i].value = e instanceof Error ? e.message : String(e);
          didFail = true;
        }
        if (didFail) failed++;
        else passed++;
        summary.value = `${passed} pass · ${failed} fail · ${TESTS.length - passed - failed} pending`;
        yield 0.04;
      }

      summary.value =
        failed === 0
          ? `${passed} / ${TESTS.length} pass`
          : `${passed} / ${TESTS.length} pass · ${failed} fail`;
      yield 5;
    });
  }
}
