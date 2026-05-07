// Runtime correctness tests for `Anim`. Each test creates a fresh `Anim`
// and drives it via `step(dt)` — fully synchronous and deterministic, no
// RAF dependency. Re-runs every few seconds so a regression shows up live.
//
// What's covered:
//   yield-contract:  number sleeps, undefined frames, parallel arrays,
//                    yield* delegation, yield gen delegation, tail-call (≤0).
//   cancellation:    stop()-from-within-gen runs finally; restart works;
//                    stop() cascades to scopes.
//   isolation:       one throwing gen doesn't kill siblings.
//   event bus:       emit / on / pulse.

import {
  Anim,
  Diagram,
  Scene,
  align,
  circle,
  css,
  forEach,
  label,
  pt,
  rect,
  signal,
  type Animator,
  type Signal,
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
      a.step(0.020);
      assert(dts.length === 2, `dts.length=${dts.length}, expected 2`);
      assert(dts[0] === 0.016, `dts[0]=${dts[0]}, expected 0.016`);
      assert(dts[1] === 0.020, `dts[1]=${dts[1]}, expected 0.020`);
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
          (function* (): Animator { yield 0.2; })(),
          (function* (): Animator { yield 0.5; })(),
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
        yield [0.2, undefined, (function* (): Animator { yield 0.3; })()];
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
      a.run(function* () { runs++; yield 0.5; runs++; });
      a.step(0);
      a.stop();
      a.run(function* () { runs++; yield 0.5; runs++; });
      a.step(0);
      assert(runs === 2, `runs was ${runs}; expected 2 starts`);
      a.stop();
    },
  },
  {
    name: "scope.stop() is independent of parent",
    run: (assert) => {
      const a = new Anim();
      const child = a.scope();
      let parentRan = 0;
      let childRan = 0;
      a.run(function* () { parentRan++; yield 1; parentRan++; });
      child.run(function* () { childRan++; yield 1; childRan++; });
      a.step(0);
      assert(parentRan === 1 && childRan === 1, `both started`);
      child.stop();
      a.step(0.5);
      assert(childRan === 1, `child shouldn't have advanced after stop`);
      a.step(0.6);
      assert(parentRan === 2, `parent should still complete`);
      a.stop();
    },
  },
  {
    name: "parent stop() cascades to scopes",
    run: (assert) => {
      const a = new Anim();
      const child = a.scope();
      let childRan = 0;
      child.run(function* () { childRan++; yield 1; childRan++; });
      a.step(0);
      a.stop();
      child.step(2);
      assert(childRan === 1, `child shouldn't advance after parent stop`);
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
      console.error = () => { /* expected */ };
      try {
        a.run(function* () {
          yield* (function* (): Animator {
            throw new Error("boom");
          })();
        });
        a.run(function* () { goodRan++; yield 0.1; goodRan++; });
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
      console.error = () => { /* expected */ };
      try {
        a.run(function* () {
          yield 0.05;
          throw new Error("boom");
        });
        a.run(function* () { goodRan++; yield 0.1; goodRan++; });
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
      // parent's `childrenLeft` decrements and the parent eventually wakes.
      const a = new Anim();
      let parentDone = false;
      const origError = console.error;
      console.error = () => { /* expected */ };
      try {
        a.run(function* () {
          yield [
            (function* (): Animator { throw new Error("boom"); })(),
            (function* (): Animator { yield 0.1; })(),
          ];
          parentDone = true;
        });
        a.step(0.15);
        assert(parentDone, `parent should resume after throwing child completes`);
      } finally {
        console.error = origError;
        a.stop();
      }
    },
  },
  {
    name: "event bus: emit / on",
    run: (assert) => {
      const a = new Anim();
      let count = 0;
      let lastData: unknown = null;
      const off = a.on("hi", (d) => { count++; lastData = d; });
      a.emit("hi", { x: 1 });
      a.emit("hi", { x: 2 });
      assert(count === 2, `count was ${count}; expected 2`);
      assert((lastData as { x: number }).x === 2, `data didn't propagate`);
      off();
      a.emit("hi");
      assert(count === 2, `handler still firing after disposer`);
      a.stop();
    },
  },
  {
    name: "event bus: until generator wakes on emit",
    run: (assert) => {
      const a = new Anim();
      let woken = false;
      a.run(function* () {
        yield* a.until("go");
        woken = true;
      });
      a.step(0); a.step(0.1); a.step(0.1);
      assert(!woken, `should still be waiting`);
      a.emit("go");
      a.step(0);
      assert(woken, `should have woken after emit`);
      a.stop();
    },
  },
  {
    name: "pulse signal increments",
    run: (assert) => {
      const a = new Anim();
      const p = a.pulse(0.1);
      assert(p.value === 0, `starts at 0`);
      a.step(0); a.step(0.15);
      assert(p.value >= 1, `expected >= 1, got ${p.value}`);
      a.stop();
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
        fill: statuses[i].map((st) => COLOR[st]),
      });
      const name = label(pt(PAD_X + 22, y), t.name, {
        size: 12,
        align: align.left,
        opacity: statuses[i].map((st) => (st === "pending" ? 0.5 : 1)),
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

      summary.value = failed === 0
        ? `${passed} / ${TESTS.length} pass`
        : `${passed} / ${TESTS.length} pass · ${failed} fail`;
      yield 5;
    });
  }
}
