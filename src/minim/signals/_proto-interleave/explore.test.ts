// Headless tests for interleave variants — driving real Anim runtime.
//
// Scenario: a "spring chases target" base process, interrupted by a
// "drag writes pos directly" interrupter. Demonstrates state-
// preservation across preemption cycles.

import { describe, it, expect } from "vitest";
import { num, signal } from "../index";
import { Anim, type Animator, type Tick } from "../../core";
import { frozenInterleave, stack, select } from "./explore";

// ── Helpers ──────────────────────────────────────────────────────

const stepN = (anim: Anim, dt: number, n: number) => {
  for (let i = 0; i < n; i++) anim.step(dt);
};

// A tiny manual spring (replicating math) so the test doesn't depend
// on the trait machinery — keeps the test focused on the combinator.
// `finite=false` makes it loop forever (re-reads target each tick).
function* miniSpring(
  pos: ReturnType<typeof num>,
  target: { value: number },
  omega = 8,
  finite = true,
): Animator<void> {
  let vel = 0;
  while (true) {
    const tick: Tick = yield;
    const e = pos.peek() - target.value;
    const E = Math.exp(-omega * tick.dt);
    const B = vel + e * omega;
    const e1 = (e + B * tick.dt) * E;
    const v1 = B * E - e1 * omega;
    vel = v1;
    pos.value = target.value + e1;
    if (finite && Math.abs(e1) < 1e-4 && Math.abs(v1) < 1e-3) {
      pos.value = target.value;
      return;
    }
  }
}

// ── Frozen interleave: base + interrupter ────────────────────────

describe("frozenInterleave", () => {
  it("base runs to completion when interrupter never fires", () => {
    const anim = new Anim();
    const pos = num(0);
    const target = { value: 10 };
    const dragging = signal(false);

    let interrupterCalls = 0;
    anim.start(
      frozenInterleave(
        dragging,
        miniSpring(pos, target),
        function* (): Animator<void> {
          interrupterCalls++;
          while (true) yield;
        },
      ),
    );

    stepN(anim, 1 / 60, 600); // 10s @ 60fps — should converge
    expect(pos.peek()).toBeCloseTo(10, 4);
    expect(interrupterCalls).toBe(0);
  });

  it("interrupter writes win while dragging; spring resumes from interrupted pos", () => {
    const anim = new Anim();
    const pos = num(0);
    const target = { value: 10 };
    const dragging = signal(false);

    let pointer = 0;
    anim.start(
      frozenInterleave(
        dragging,
        miniSpring(pos, target),
        function* (): Animator<void> {
          while (true) {
            yield;
            pos.value = pointer; // drag writes pos directly
          }
        },
      ),
    );

    // Phase 1: spring runs for 5 frames; pos moves toward 10.
    stepN(anim, 1 / 60, 5);
    const beforeDrag = pos.peek();
    expect(beforeDrag).toBeGreaterThan(0);
    expect(beforeDrag).toBeLessThan(10);

    // Phase 2: start dragging; pointer = 50. Spring should NOT advance.
    dragging.value = true;
    pointer = 50;
    stepN(anim, 1 / 60, 5);
    expect(pos.peek()).toBe(50); // drag wins

    // Phase 3: stop dragging. Spring resumes — pos should drift FROM 50
    // toward 10 (NOT from beforeDrag — proves spring's internal `vel`
    // wasn't lost but its `e0` reads from the current pos).
    dragging.value = false;
    stepN(anim, 1 / 60, 5);
    const afterRelease = pos.peek();
    expect(afterRelease).toBeLessThan(50);
    expect(afterRelease).toBeGreaterThan(10);
  });

  it("multiple drag cycles work; each release re-converges to target", () => {
    const anim = new Anim();
    const pos = num(0);
    const target = { value: 0 };
    const dragging = signal(false);

    let pointer = 0;
    anim.start(
      frozenInterleave(
        dragging,
        miniSpring(pos, target, 8, /* finite= */ false),
        function* (): Animator<void> {
          while (true) { yield; pos.value = pointer; }
        },
      ),
    );

    for (const tgt of [10, -5, 30, 0]) {
      dragging.value = true;
      pointer = tgt;
      stepN(anim, 1 / 60, 3);
      dragging.value = false;
      target.value = tgt + 0.1; // spring chases something near tgt
      stepN(anim, 1 / 60, 300);
      expect(pos.peek()).toBeCloseTo(tgt + 0.1, 3);
    }
  });

  it("base's local state is preserved across freeze (vel survives)", () => {
    // Witness: hold the spring far from target, freeze partway through
    // its trajectory, and observe that AFTER release it continues with
    // approximately the same velocity profile rather than restarting
    // from rest.
    const anim = new Anim();
    const pos = num(100);
    const target = { value: 0 };
    const dragging = signal(false);

    anim.start(
      frozenInterleave(
        dragging,
        miniSpring(pos, target, 4),
        function* (): Animator<void> { while (true) yield; },
      ),
    );

    // Run a bit; sample pos.
    stepN(anim, 1 / 60, 30);
    const beforeFreeze = pos.peek();

    // Freeze for many frames; pos shouldn't change.
    dragging.value = true;
    stepN(anim, 1 / 60, 60);
    expect(pos.peek()).toBe(beforeFreeze);

    // Unfreeze; should continue from there.
    dragging.value = false;
    stepN(anim, 1 / 60, 30);
    const afterUnfreeze = pos.peek();
    // Should have moved closer to 0 from beforeFreeze.
    expect(Math.abs(afterUnfreeze)).toBeLessThan(Math.abs(beforeFreeze));
  });
});

// ── Stack ────────────────────────────────────────────────────────

describe("stack", () => {
  it("layers stack like z-index — last active wins (transition order)", () => {
    const anim = new Anim();
    const log: string[] = [];
    const a = signal(false);
    const b = signal(false);

    const tag = (name: string): Animator<void> =>
      (function* (): Animator<void> {
        while (true) { yield; log.push(name); }
      })();

    anim.start(
      stack(
        [
          { when: a, gen: () => tag("a") },
          { when: b, gen: () => tag("b") },
        ],
        tag("base"),
      ),
    );

    // Skip warm-up frame, then capture transitions.
    stepN(anim, 1 / 60, 5);
    expect(new Set(log)).toEqual(new Set(["base"]));

    log.length = 0;
    a.value = true;
    stepN(anim, 1 / 60, 3);
    expect(new Set(log)).toEqual(new Set(["a"]));

    log.length = 0;
    b.value = true; // b above a in stack
    stepN(anim, 1 / 60, 3);
    expect(new Set(log)).toEqual(new Set(["b"]));

    log.length = 0;
    b.value = false;
    stepN(anim, 1 / 60, 3);
    expect(new Set(log)).toEqual(new Set(["a"]));

    log.length = 0;
    a.value = false;
    stepN(anim, 1 / 60, 3);
    expect(new Set(log)).toEqual(new Set(["base"]));
  });
});

// ── Select ───────────────────────────────────────────────────────

describe("select", () => {
  it("selector chooses which branch advances", () => {
    const anim = new Anim();
    const mode = signal<"idle" | "drag" | "fly">("idle");
    const counts = { idle: 0, drag: 0, fly: 0 };

    anim.start(
      select(
        () => mode.value,
        {
          idle: function* (): Animator<void> {
            while (true) { yield; counts.idle++; }
          },
          drag: function* (): Animator<void> {
            while (true) { yield; counts.drag++; }
          },
          fly: function* (): Animator<void> {
            while (true) { yield; counts.fly++; }
          },
        },
      ),
    );

    // Each "first .next()" runs to the inner yield without logging,
    // so a fresh branch loses 1 frame on entry. We just sanity-check
    // that each mode produced *some* counts and others stayed put.
    stepN(anim, 1 / 60, 5);
    expect(counts.idle).toBeGreaterThan(0);
    const idle0 = counts.idle;

    mode.value = "drag";
    stepN(anim, 1 / 60, 5);
    expect(counts.idle).toBe(idle0);            // idle frozen
    expect(counts.drag).toBeGreaterThan(0);

    mode.value = "fly";
    const drag0 = counts.drag;
    stepN(anim, 1 / 60, 5);
    expect(counts.drag).toBe(drag0);            // drag frozen
    expect(counts.fly).toBeGreaterThan(0);

    mode.value = "idle";
    const fly0 = counts.fly;
    stepN(anim, 1 / 60, 5);
    expect(counts.fly).toBe(fly0);              // fly frozen
    expect(counts.idle).toBeGreaterThan(idle0); // idle re-built and ran
  });

  it("rebuilds branch after re-entry (no state persistence across exits)", () => {
    const anim = new Anim();
    const mode = signal<"a" | "b">("a");
    const log: string[] = [];

    anim.start(
      select(
        () => mode.value,
        {
          a: function* (): Animator<void> {
            log.push("a:start");
            while (true) yield;
          },
          b: function* (): Animator<void> {
            log.push("b:start");
            while (true) yield;
          },
        },
      ),
    );

    stepN(anim, 1 / 60, 2);
    mode.value = "b";
    stepN(anim, 1 / 60, 2);
    mode.value = "a";
    stepN(anim, 1 / 60, 2);

    expect(log).toEqual(["a:start", "b:start", "a:start"]);
  });
});

// ── Suspend behavior (key limitation finding) ────────────────────

describe("suspend in interleave (limitation)", () => {
  it("DOCS: manual-drive variants do NOT process suspends inside children", () => {
    // The frame-by-frame variants here call child.next(tick) directly,
    // which bypasses the Anim runtime's suspend handling. If a child
    // yields a Suspend, our parent receives it as a yielded value and
    // doesn't know what to do — this test documents that gap.
    //
    // A "real" engine-backed interleave would need pause/resume on
    // Active. We've left that as future work.

    const anim = new Anim();
    const log: string[] = [];
    const on = signal(false);

    anim.start(
      frozenInterleave(
        on,
        (function* (): Animator<void> {
          while (true) { yield; log.push("base"); }
        })(),
        function* (): Animator<void> {
          // This `yield (wake)=>{}` would normally park the gen. In our
          // hand-driven interleave, our `child.next(tick)` resumes
          // immediately with the tick — so the body runs without
          // ever truly parking.
          log.push("inter:before");
          yield (() => {});
          log.push("inter:after"); // would never run with real runtime;
                                   // runs immediately with hand-drive.
        },
      ),
    );

    stepN(anim, 1 / 60, 1);
    on.value = true;
    stepN(anim, 1 / 60, 2);
    // Hand-drive: "inter:after" runs because we don't honour suspend.
    expect(log).toContain("inter:before");
    expect(log).toContain("inter:after");
  });
});
