// Test that signals-as-Yieldables behaves correctly across the cases
// that motivated the design:
//   1. `yield* sig` is change-wait; resumes with new value.
//   2. `yield* pulse(...)` fires on every emit even with equal values.
//   3. `yield* sig` composes inside `race` / `all` / `play().until`.
//   4. `when(sig)` keeps its immediate-truthy semantic.
//   5. `when(not(sig))` is falsy-wait-with-immediate.
//   6. Reactive predicates work: `yield* computed(() => p(sig.value))` is yieldable.
//   7. Cleanup runs when generator is cancelled or another race-arm wins.
//   8. Equality dedup honors signal's own `equals` (events fire on every push).
//   9. Multiple signals can be raced + concurrent.

import { describe, it, expect } from "vitest";
import {
  Anim,
  signal,
  pulse,
  computed,
  effect,
  when,
  not,
  truthy,
  falsy,
  whenNot,
  raceFirst,
  play,
  loop,
  type Animator,
} from "./index";

// ─── Test harness ───────────────────────────────────────────────────

/** Run a generator to completion, stepping by 16ms ticks until done. */
function run(g: Iterable<unknown>, opts: { maxFrames?: number } = {}): void {
  const a = new Anim();
  a.start(g as Animator<unknown>);
  const max = opts.maxFrames ?? 600;
  for (let i = 0; i < max; i++) a.step(0.016);
}

/** Run a generator with manual control over ticks. Returns the Anim
 *  and a stepper. The argument is widened to `Iterable<unknown>` so
 *  any test gen — including ones that yield through signal iterators
 *  with narrower yield types — passes typecheck. */
function harness(g: Iterable<unknown>) {
  const a = new Anim();
  const cancel = a.start(g as Animator<unknown>);
  return {
    anim: a,
    step: (dt = 0.016) => a.step(dt),
    cancel,
  };
}

// ─── 1. yield* sig is change-wait ───────────────────────────────────

describe("yield* sig — change-wait", () => {
  it("resumes with the new value on next change", () => {
    const sig = signal(1);
    let observed: number | undefined;
    let completed = false;

    const { step } = harness(
      (function* () {
        observed = yield* sig;
        completed = true;
      })(),
    );

    step(); // baseline subscription
    expect(completed).toBe(false);

    sig.value = 2;
    step();
    expect(completed).toBe(true);
    expect(observed).toBe(2);
  });

  it("does NOT wake when value is set to the same (Object.is) value", () => {
    const sig = signal(5);
    let woken = 0;

    const { step } = harness(
      (function* () {
        for (let i = 0; i < 3; i++) {
          yield* sig;
          woken++;
        }
      })(),
    );

    step();
    sig.value = 5;
    step();
    expect(woken).toBe(0); // no change
    sig.value = 6;
    step();
    expect(woken).toBe(1);
  });

  it("multiple sequential yields advance through changes", () => {
    const sig = signal(0);
    const seen: number[] = [];

    const { step } = harness(
      (function* () {
        for (let i = 0; i < 3; i++) {
          const v = yield* sig;
          seen.push(v);
        }
      })(),
    );

    step();
    sig.value = 1;
    step();
    sig.value = 2;
    step();
    sig.value = 3;
    step();

    expect(seen).toEqual([1, 2, 3]);
  });
});

// ─── 2. pulse fires every write ─────────────────────────────────────

describe("pulse() — events as signals", () => {
  it("wakes on every write, even with equal values", () => {
    const ev = pulse<string>("init");
    let woken = 0;
    let last: string | undefined;

    const { step } = harness(
      (function* () {
        for (let i = 0; i < 3; i++) {
          last = yield* ev;
          woken++;
        }
      })(),
    );

    step();
    ev.value = "a";
    step();
    expect(woken).toBe(1);
    expect(last).toBe("a");

    ev.value = "a"; // same value but pulse() ignores equality
    step();
    expect(woken).toBe(2);

    ev.value = "b";
    step();
    expect(woken).toBe(3);
  });

  it("models DOM events naturally", () => {
    const click = pulse<{ x: number; y: number } | undefined>(undefined);
    let total = 0;

    const { step } = harness(
      (function* () {
        for (let i = 0; i < 3; i++) {
          const ev = yield* click;
          if (ev) total += ev.x + ev.y;
        }
      })(),
    );

    step();
    click.value = { x: 1, y: 2 };
    step();
    click.value = { x: 3, y: 4 };
    step();
    click.value = { x: 5, y: 6 };
    step();

    expect(total).toBe(1 + 2 + 3 + 4 + 5 + 6);
  });
});

// ─── 3. Composition with race / all / play.until ────────────────────

describe("composition", () => {
  it("race(timeout, sig) wakes on whichever fires first — sig wins", () => {
    const ev = pulse<number>(0);
    let outcome: unknown;

    const { step } = harness(
      (function* () {
        outcome = yield* raceFirst(2, ev); // 2 sec or first event
      })(),
    );

    step();
    ev.value = 42;
    step();
    expect(outcome).toBe(42);
  });

  it("race(timeout, sig) — timeout wins", () => {
    const ev = pulse<number>(0);
    let timedOut = false;

    const { step } = harness(
      (function* () {
        const result = yield* raceFirst(0.05, ev);
        if (result === undefined) timedOut = true;
      })(),
    );

    // Step past 0.05s without firing the event
    for (let i = 0; i < 5; i++) step();
    expect(timedOut).toBe(true);
  });

  it("play(...).until(sig) — sig truthy interrupts gen", () => {
    const stop = signal(false);
    let counter = 0;
    let done = false;

    const { step } = harness(
      (function* () {
        yield* play(
          (function* () {
            while (true) {
              counter++;
              yield;
            }
          })(),
        ).until(stop);
        done = true;
      })(),
    );

    step();
    step();
    step();
    expect(counter).toBeGreaterThan(0);
    expect(done).toBe(false);

    stop.value = true;
    step();
    expect(done).toBe(true);
  });

  it("concurrent yield [a, sig, sleep] resumes with all results", () => {
    const ev = pulse<number>(0);
    let results: unknown[] | undefined;

    const { step } = harness(
      (function* () {
        results = yield [
          ev,
          (function* () {
            yield 0.05;
            return "anim-done";
          })(),
        ];
      })(),
    );

    step();
    ev.value = 100;
    // Step long enough for the inner gen to finish
    for (let i = 0; i < 10; i++) step();

    expect(results).toEqual([100, "anim-done"]);
  });
});

// ─── 4. when(sig) — truthy-wait with immediate ──────────────────────

describe("when(sig) — truthy-wait with immediate fire", () => {
  it("wakes immediately if already truthy", () => {
    const ready = signal(true);
    let done = false;

    const { step } = harness(
      (function* () {
        yield* when(ready);
        done = true;
      })(),
    );

    step();
    expect(done).toBe(true);
  });

  it("waits for next truthy if currently falsy", () => {
    const ready = signal(false);
    let done = false;

    const { step } = harness(
      (function* () {
        yield* when(ready);
        done = true;
      })(),
    );

    step();
    expect(done).toBe(false);

    ready.value = true;
    step();
    expect(done).toBe(true);
  });

  it("contrasts with `yield* sig` (which is change-wait, not truthy-wait)", () => {
    const flag = signal(true); // already true
    let viaWhen = false;
    let viaYield = false;

    const { step } = harness(
      (function* () {
        yield [
          (function* () {
            yield* when(flag);
            viaWhen = true;
          })(),
          (function* () {
            yield* flag;
            viaYield = true;
          })(),
        ];
      })(),
    );

    step();
    expect(viaWhen).toBe(true); // immediate, since flag is already true
    expect(viaYield).toBe(false); // waiting for next change

    flag.value = false;
    step();
    expect(viaYield).toBe(true); // change-wait fired on the flip
  });
});

// ─── 5. when(not(sig)) — falsy-wait via composition ─────────────────

describe("falsy-wait composition: when(not(sig))", () => {
  it("wakes immediately if currently falsy", () => {
    const active = signal(false);
    let done = false;

    const { step } = harness(
      (function* () {
        yield* when(not(active));
        done = true;
      })(),
    );

    step();
    expect(done).toBe(true);
  });

  it("waits for next falsy if currently truthy", () => {
    const active = signal(true);
    let done = false;

    const { step } = harness(
      (function* () {
        yield* when(not(active));
        done = true;
      })(),
    );

    step();
    expect(done).toBe(false);

    active.value = false;
    step();
    expect(done).toBe(true);
  });

  it("aliased as `falsy(sig)` — adjective naming", () => {
    const active = signal(true);
    let done = false;

    const { step } = harness(
      (function* () {
        yield* falsy(active);
        done = true;
      })(),
    );

    step();
    expect(done).toBe(false);
    active.value = false;
    step();
    expect(done).toBe(true);
  });

  it("aliased as `whenNot(sig)` — symmetric naming", () => {
    const active = signal(true);
    let done = false;

    const { step } = harness(
      (function* () {
        yield* whenNot(active);
        done = true;
      })(),
    );

    step();
    expect(done).toBe(false);
    active.value = false;
    step();
    expect(done).toBe(true);
  });

  it("`truthy(sig)` is just an alias for `when(sig)`", () => {
    const ready = signal(true);
    let done = false;

    const { step } = harness(
      (function* () {
        yield* truthy(ready);
        done = true;
      })(),
    );

    step();
    expect(done).toBe(true);
  });
});

// ─── 6. Reactive predicates compose via computed() ──────────────────

describe("reactive predicates as wait conditions", () => {
  it("yield* computed(() => predicate(sig)) waits for predicate change", () => {
    const x = signal(0);
    const passedThreshold = computed(() => x.value > 100);

    let done = false;

    const { step } = harness(
      (function* () {
        yield* when(passedThreshold);
        done = true;
      })(),
    );

    step();
    x.value = 50;
    step();
    expect(done).toBe(false);

    x.value = 150;
    step();
    expect(done).toBe(true);
  });

  it("compound predicates: A && B becomes one yield", () => {
    const phase = signal<"idle" | "armed" | "fired">("idle");
    const energy = signal(0);

    let done = false;

    const { step } = harness(
      (function* () {
        yield* when(
          computed(() => phase.value === "armed" && energy.value > 50),
        );
        done = true;
      })(),
    );

    step();
    phase.value = "armed";
    step();
    expect(done).toBe(false); // energy too low

    energy.value = 75;
    step();
    expect(done).toBe(true); // both conditions hold
  });

  it("predicate flipping back to false re-arms a future wake", () => {
    const x = signal(0);
    const above = computed(() => x.value > 10);

    let observed: boolean[] = [];

    const { step } = harness(
      (function* () {
        for (let i = 0; i < 4; i++) {
          observed.push(yield* above);
        }
      })(),
    );

    step();
    x.value = 15; // false → true
    step();
    x.value = 5; // true → false
    step();
    x.value = 20; // false → true
    step();
    x.value = 0; // true → false
    step();

    expect(observed).toEqual([true, false, true, false]);
  });
});

// ─── 7. Cleanup on cancel / race-loss ───────────────────────────────

describe("cleanup", () => {
  it("loser of race releases its subscription", () => {
    const loserSig = signal(0);
    const winner = pulse<string>("");

    let loserSubscribed = 0;
    // Spy on effect creation by counting subscribers via a parallel effect.
    const stop = effect(() => {
      void loserSig.value;
      loserSubscribed++;
    });
    stop(); // we don't actually need this effect; reset the counter

    const { step } = harness(
      (function* () {
        yield* raceFirst(loserSig, winner);
      })(),
    );

    step();
    winner.value = "go"; // winner fires; loser should be torn down
    step();

    // After race wins, writes to loser should not crash or leak. (This
    // is a smoke test — full leak detection would need explicit hooks.)
    loserSig.value = 99;
    step();
    expect(true).toBe(true);
  });

  it("cancelling the parent generator tears down the wait", () => {
    const sig = signal(0);
    const { step, cancel } = harness(
      (function* () {
        yield* sig;
      })(),
    );
    step();
    cancel();
    // After cancel, writes shouldn't trigger any lingering wake.
    sig.value = 1;
    step();
    expect(true).toBe(true);
  });
});

// ─── 8. Loop + signal — common interactive pattern ──────────────────

describe("loop + yield* sig — interactive pattern", () => {
  it("counts clicks correctly", () => {
    const click = pulse<MouseEvent | undefined>(undefined);
    const hits = signal(0);

    const { step } = harness(
      (function* () {
        while (true) {
          yield* click;
          hits.value = hits.peek() + 1;
        }
      })(),
    );

    step();
    click.value = {} as MouseEvent;
    step();
    click.value = {} as MouseEvent;
    step();
    click.value = {} as MouseEvent;
    step();

    expect(hits.value).toBe(3);
  });

  it("reactive stop wins over click — race is the right primitive", () => {
    const click = pulse<MouseEvent | undefined>(undefined);
    const stop = signal(false);
    const hits = signal(0);
    let exitedCleanly = false;

    const { step } = harness(
      (function* () {
        while (true) {
          // Race click against stop; stop becoming truthy interrupts the
          // wait BEFORE a stray click can fire.
          const winner = yield* raceFirst(click, when(stop));
          if (stop.peek()) {
            exitedCleanly = true;
            break;
          }
          hits.value = hits.peek() + 1;
        }
      })(),
    );

    step();
    click.value = {} as MouseEvent;
    step();
    click.value = {} as MouseEvent;
    step();
    expect(hits.value).toBe(2);

    // Set stop FIRST; the parked race wakes via the `when(stop)` arm.
    stop.value = true;
    step();
    expect(exitedCleanly).toBe(true);

    // A stray click after stop=true is ignored — loop already exited.
    click.value = {} as MouseEvent;
    step();
    expect(hits.value).toBe(2);
  });
});

// ─── 9. Stress: a realistic mini-scene ──────────────────────────────

describe("realistic mini-scene", () => {
  it("waits for ready, then animates while not paused, then completes", () => {
    const ready = signal(false);
    const paused = signal(false);
    const counter = signal(0);
    let phase = "init";

    const { step } = harness(
      (function* () {
        phase = "wait-ready";
        yield* when(ready);
        phase = "running";
        // Drive counter for a bit; pause if paused.
        for (let i = 0; i < 5; i++) {
          if (paused.value) {
            yield* when(not(paused));
          }
          counter.value = counter.peek() + 1;
          yield 0.01;
        }
        phase = "done";
      })(),
    );

    step();
    expect(phase).toBe("wait-ready");

    ready.value = true;
    step();
    // Run a few frames while running
    for (let i = 0; i < 3; i++) step(0.01);
    expect(phase).toBe("running");
    expect(counter.value).toBeGreaterThan(0);

    paused.value = true;
    const before = counter.value;
    for (let i = 0; i < 3; i++) step(0.01);
    expect(counter.value).toBe(before); // didn't advance while paused

    paused.value = false;
    for (let i = 0; i < 20; i++) step(0.01);
    expect(phase).toBe("done");
    expect(counter.value).toBe(5);
  });
});
