// Writer-claim tests — checking that "claim-based scheduling" handles
// the drag-vs-spring scenario cleanly without process-level control flow.

import { describe, expect, it } from "vitest";
import { num } from "../index";
import { claim, priorityClaim } from "./claims";

describe("Claim<T>", () => {
  it("exclusive writes — only the holder writes; non-holder no-ops", () => {
    const sig = num(0);
    const c = claim(sig);

    const w1 = c.acquire()!;
    expect(w1).not.toBeNull();
    expect(c.held.value).toBe(true);

    const w2 = c.acquire();
    expect(w2).toBeNull(); // can't double-acquire

    w1.write(5);
    expect(sig.peek()).toBe(5);

    w1.release();
    expect(c.held.value).toBe(false);

    const w3 = c.acquire()!;
    w3.write(9);
    expect(sig.peek()).toBe(9);
  });
});

describe("PriorityClaim<T>", () => {
  it("higher-priority claim preempts; lower's writes silently no-op", () => {
    const sig = num(0);
    const pc = priorityClaim(sig);

    const lowWriter = pc.acquire(0);
    lowWriter.write(10);
    expect(sig.peek()).toBe(10);

    const highWriter = pc.acquire(10);
    expect(pc.activePriority.value).toBe(10);
    lowWriter.write(20); // no-op
    expect(sig.peek()).toBe(10);

    highWriter.write(30);
    expect(sig.peek()).toBe(30);

    highWriter.release();
    expect(pc.activePriority.value).toBe(0);
    lowWriter.write(40);
    expect(sig.peek()).toBe(40);
  });

  it("preempt/resume notifications fire on transitions", () => {
    const sig = num(0);
    const pc = priorityClaim(sig);
    const log: string[] = [];

    const low = pc.acquire(0, {
      onPreempt: () => log.push("low:preempt"),
      onResume: () => log.push("low:resume"),
    });
    expect(log).toEqual(["low:resume"]); // initial activation

    const high = pc.acquire(5, {
      onPreempt: () => log.push("high:preempt"),
      onResume: () => log.push("high:resume"),
    });
    expect(log).toEqual(["low:resume", "low:preempt", "high:resume"]);

    high.release();
    expect(log).toEqual(["low:resume", "low:preempt", "high:resume", "low:resume"]);

    low.release();
    expect(pc.activePriority.value).toBeNull();
  });

  it("drag-vs-spring scenario expressed purely as claims", () => {
    const pos = num(0);
    const pc = priorityClaim(pos);

    // Spring holds a continuous low-priority claim and writes each "tick."
    const spring = pc.acquire(0);
    const tick = (target: number): void => {
      // crude pull-toward
      const cur = pos.peek();
      spring.write(cur + (target - cur) * 0.5);
    };

    tick(10);
    expect(pos.peek()).toBe(5);
    tick(10);
    expect(pos.peek()).toBe(7.5);

    // Drag takes over — high priority.
    const drag = pc.acquire(10);
    drag.write(100);
    expect(pos.peek()).toBe(100);
    tick(10); // spring no-ops
    expect(pos.peek()).toBe(100);

    // Release drag; spring takes over and pulls from 100 toward 10.
    drag.release();
    tick(10);
    expect(pos.peek()).toBe(55);
    tick(10);
    expect(pos.peek()).toBe(32.5);
  });
});
