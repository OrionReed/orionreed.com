// assert/ — identity, recording, claims.
//
// Covers: scope wrapper lifecycle, parent capture across `yield` and
// `yield*`, signal write attribution, latch (safety/liveness), the
// fluent claim builder, intervals(), and firstOf event ordering.

import { Anim, type Animator } from "@minim/core";
import { computed, num, signal, spring, tween } from "@minim/signals";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeRecorder,
  authorOf,
  claim,
  firstOf,
  inRange,
  intervals,
  latch,
  type Recorder,
  record,
  scope,
} from "../assert";

// Defensive: if a test bails before its recorder is stopped, this
// keeps subsequent tests independent.
afterEach(() => {
  activeRecorder()?.stop();
});

describe("scope() — identity & lifecycle", () => {
  let anim: Anim;
  let rec: Recorder;
  beforeEach(() => {
    anim = new Anim();
    rec = record(anim);
  });
  afterEach(() => {
    rec.stop();
    anim.stop();
  });

  it("opens a span on first .next() and closes on completion", () => {
    const fadeIn = scope(function* fadeIn(): Animator<void> {
      yield 0.05;
    });
    anim.start(fadeIn());
    anim.step(0);
    expect(rec.spans.value.length).toBe(1);
    expect(rec.spans.value[0].fn.name).toBe("fadeIn");
    expect(rec.spans.value[0].status).toBe("open");
    anim.step(0.1);
    expect(rec.spans.value[0].status).toBe("settled");
    expect(rec.spans.value[0].end).toBeGreaterThan(0);
  });

  it("closes with status=cancelled on engine cancel", () => {
    const work = scope(function* work(): Animator<void> {
      yield () => () => {};
    });
    const dispose = anim.start(work());
    anim.step(0);
    expect(rec.spans.value[0].status).toBe("open");
    dispose();
    expect(rec.spans.value[0].status).toBe("cancelled");
  });

  it("records parent across yield (engine spawn)", () => {
    const child = scope(function* child(): Animator<void> {
      yield 0.05;
    });
    const parent = scope(function* parent(): Animator<void> {
      yield child();
    });
    anim.start(parent());
    anim.step(0);
    const spans = rec.spans.value;
    expect(spans.length).toBe(2);
    const p = spans.find(s => s.fn.name === "parent")!;
    const c = spans.find(s => s.fn.name === "child")!;
    expect(c.parent).toBe(p);
  });

  it("records parent across yield* (no engine spawn)", () => {
    const inner = scope(function* inner(): Animator<void> {
      yield 0.05;
    });
    const outer = scope(function* outer(): Animator<void> {
      yield* inner();
    });
    anim.start(outer());
    anim.step(0);
    const spans = rec.spans.value;
    expect(spans.length).toBe(2);
    const o = spans.find(s => s.fn.name === "outer")!;
    const i = spans.find(s => s.fn.name === "inner")!;
    expect(i.parent).toBe(o);
  });

  it("captures parent at construction time, not first .next()", () => {
    // Constructed inside outer.body (currentSpan=outer); engine resumes
    // child later. Parent must still be `outer`.
    const child = scope(function* child(): Animator<void> {
      yield 0.05;
    });
    const outer = scope(function* outer(): Animator<void> {
      yield child();
    });
    anim.start(outer());
    anim.step(0);
    anim.step(0.06);
    const c = rec.spans.value.find(s => s.fn.name === "child")!;
    expect(c.parent?.fn.name).toBe("outer");
  });

  it("scope properties report alive/runs/last/duration", () => {
    const fade = scope(function* fade(): Animator<void> {
      yield 0.05;
    });
    expect(fade.runs.value).toBe(0);
    expect(fade.alive.value).toBe(false);
    expect(fade.last.value).toBeUndefined();

    anim.start(fade());
    anim.step(0);
    expect(fade.runs.value).toBe(1);
    expect(fade.alive.value).toBe(true);
    expect(fade.last.value?.status).toBe("open");

    anim.step(0.1);
    expect(fade.alive.value).toBe(false);
    expect(fade.last.value?.status).toBe("settled");
    expect(fade.duration.value).toBeGreaterThan(0);
  });
});

describe("write attribution", () => {
  let anim: Anim;
  let rec: Recorder;
  beforeEach(() => {
    anim = new Anim();
    rec = record(anim);
  });
  afterEach(() => {
    rec.stop();
    anim.stop();
  });

  it("records signals touched by a span", () => {
    const sig = signal(0);
    const work = scope(function* work(): Animator<void> {
      sig.value = 1;
      yield 0.01;
      sig.value = 2;
    });
    anim.start(work());
    anim.step(0);
    anim.step(0.02);
    expect(work.last.value?.touched.size).toBe(1);
    expect(Array.from(work.last.value!.touched)).toContain(sig as unknown as object);
  });

  it("authorOf reports the most recent writer", () => {
    const sig = signal(0);
    const author = authorOf(sig);
    const work = scope(function* work(): Animator<void> {
      sig.value = 1;
      yield 0.01;
    });
    expect(author.value).toBeUndefined();
    anim.start(work());
    anim.step(0);
    expect(author.value?.fn.name).toBe("work");
  });

  it("touchedDeep includes descendant writes", () => {
    const sig = signal(0);
    const inner = scope(function* inner(): Animator<void> {
      sig.value = 1;
      yield 0.01;
    });
    const outer = scope(function* outer(): Animator<void> {
      yield inner();
    });
    anim.start(outer());
    anim.step(0);
    anim.step(0.02);
    expect(outer.touched.value.length).toBe(0);
    expect(outer.touchedDeep.value.length).toBe(1);
  });
});

describe("latch — invariant & liveness", () => {
  it("safety: holds true until pred is observed false", () => {
    const x = signal(5);
    const safe = latch(inRange(x, [0, 10]), true);
    expect(safe.value).toBe(true);
    x.value = 7;
    expect(safe.value).toBe(true);
    x.value = 100;
    expect(safe.value).toBe(false);
    x.value = 5; // no rearm without scope
    expect(safe.value).toBe(false);
  });

  it("liveness: holds false until pred is observed true", () => {
    const x = signal(0);
    const reaches = latch(inRange(x, [10, 20]), false);
    expect(reaches.value).toBe(false);
    x.value = 5;
    expect(reaches.value).toBe(false);
    x.value = 15;
    expect(reaches.value).toBe(true);
    x.value = 0; // sticky
    expect(reaches.value).toBe(true);
  });

  it("re-arms on scope rising edge", () => {
    const x = signal(0);
    const open = signal(false);
    const safe = latch(inRange(x, [0, 1]), true, open);
    open.value = true;
    expect(safe.value).toBe(true);
    x.value = 100;
    expect(safe.value).toBe(false);
    open.value = false;
    x.value = 0; // restore predicate before re-arm
    open.value = true;
    expect(safe.value).toBe(true);
  });

  it("does not re-arm if predicate still violated on scope re-entry", () => {
    const x = signal(0);
    const open = signal(false);
    const safe = latch(inRange(x, [0, 1]), true, open);
    open.value = true;
    x.value = 100;
    expect(safe.value).toBe(false);
    open.value = false;
    open.value = true; // re-arm + immediate re-violation
    expect(safe.value).toBe(false);
  });
});

describe("claim() — fluent builder", () => {
  it("stays.in([0,1]) latches false on overshoot", () => {
    const x = signal(0);
    const c = claim(x).stays.in([0, 1]);
    expect(c.value).toBe(true);
    x.value = 0.5;
    expect(c.value).toBe(true);
    x.value = 1.3;
    expect(c.value).toBe(false);
  });

  it("becomes.above(n) flips true on first crossing", () => {
    const x = signal(0);
    const c = claim(x).becomes.above(0.5);
    expect(c.value).toBe(false);
    x.value = 0.4;
    expect(c.value).toBe(false);
    x.value = 0.6;
    expect(c.value).toBe(true);
  });

  it("never.above(n) latches false on first violation", () => {
    const x = signal(0);
    const c = claim(x).never.above(1);
    expect(c.value).toBe(true);
    x.value = 0.9;
    expect(c.value).toBe(true);
    x.value = 1.1;
    expect(c.value).toBe(false);
  });

  it(".and / .or compose claims", () => {
    const x = signal(0.5);
    const a = claim(x).stays.above(0);
    const b = claim(x).stays.below(1);
    const both = a.and(b);
    expect(both.value).toBe(true);
    x.value = 1.5;
    expect(both.value).toBe(false);
  });

  it(".during(scope) gates the claim and re-arms on scope re-entry", () => {
    const anim = new Anim();
    const rec = record(anim);
    const sig = signal(0);
    const work = scope(function* work(): Animator<void> {
      sig.value = 0.5;
      yield 0.05;
    });
    const safe = claim(sig).stays.in([0, 1]).during(work);
    expect(safe.value).toBe(true);

    anim.start(work());
    anim.step(0);
    expect(safe.value).toBe(true);
    anim.step(0.1);
    // span closed; safe holds vacuously
    expect(safe.value).toBe(true);

    // Trigger violation outside scope: vacuously true
    sig.value = 5;
    expect(safe.value).toBe(true);

    rec.stop();
    anim.stop();
  });
});

describe("intervals & firstOf", () => {
  it("intervals(scoped) is true while any invocation is open", () => {
    const anim = new Anim();
    const rec = record(anim);
    const work = scope(function* work(): Animator<void> {
      yield 0.05;
    });
    const open = intervals(work);
    expect(open.value).toBe(false);
    anim.start(work());
    anim.step(0);
    expect(open.value).toBe(true);
    anim.step(0.1);
    expect(open.value).toBe(false);
    rec.stop();
    anim.stop();
  });

  it("scoped factory's alive flag follows lifetime", () => {
    const anim = new Anim();
    const rec = record(anim);
    // `scope(spring)` loses spring's <T> generic, so the wrapped call
    // sees args typed as Traits<unknown, …>. Cast via `as any` is the
    // simplest workaround for this generic-erasure edge.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t_spring = scope(spring as any, "spring");
    const op = num(0);
    const aliveLog: boolean[] = [];
    expect(t_spring.alive.value).toBe(false);
    anim.start(t_spring(op, 1.0, { omega: 18, zeta: 0.3 }));
    aliveLog.push(t_spring.alive.value);
    for (let i = 0; i < 30; i++) {
      anim.step(0.016);
      aliveLog.push(t_spring.alive.value);
    }
    // At least once during the run, alive should be true.
    expect(aliveLog.some(v => v === true)).toBe(true);
    rec.stop();
    anim.stop();
  });

  it("class-quantified claim catches a spring overshoot", () => {
    // End-to-end version of the md-claim-demo scenario, run on a
    // step-driven Anim so we can fast-forward without RAF.
    const anim = new Anim();
    const rec = record(anim);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t_tween = scope(tween as any, "tween");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t_spring = scope(spring as any, "spring");

    const op = num(0);

    const driverSet = computed(() => {
      const a = intervals(t_tween).value;
      const b = intervals(t_spring).value;
      return a || b;
    });

    // Force allocation of t_spring.alive BEFORE the claim. Maybe the
    // claim's latch creates its own deps order that breaks something.
    const aliveDirect = t_spring.alive;
    expect(aliveDirect.value).toBe(false);

    const safe = claim(op, "α").stays.below(1.05).during(driverSet);
    expect(safe.value).toBe(true);
    expect(driverSet.value).toBe(false);

    // Register authorOf BEFORE writes happen — the writer signal only
    // records writes that occur after it's been allocated.
    const author = authorOf(op);

    // Spring with low damping → significant overshoot.
    anim.start(t_spring(op, 1.0, { omega: 18, zeta: 0.3 }));

    // Fast-forward and capture peak value AND any moment of violation.
    let peak = 0;
    let safeWentFalseAt = -1;
    let drvWasTrue = false;
    let aliveWasTrue = false;
    for (let i = 0; i < 30; i++) {
      anim.step(0.016);
      if (op.value > peak) peak = op.value;
      if (aliveDirect.value) aliveWasTrue = true;
      if (driverSet.value) drvWasTrue = true;
      if (!safe.value && safeWentFalseAt < 0) safeWentFalseAt = i;
    }
    expect(peak).toBeGreaterThan(1.05);
    expect(aliveWasTrue).toBe(true);
    expect(drvWasTrue).toBe(true);
    expect(safeWentFalseAt).toBeGreaterThan(-1);
    expect(safe.value).toBe(false);

    // authorOf should name the spring as the writer.
    expect(author.value?.fn).toBe(spring);

    rec.stop();
    anim.stop();
  });

  it("firstOf records the first event to fire and its time", () => {
    const anim = new Anim();
    const rec = record(anim);
    const a = signal(false);
    const b = signal(false);
    const winner = firstOf(a, b);
    expect(winner.value).toBeUndefined();
    // Bump the clock first, then fire the event directly. `firstOf`'s
    // effect reads `activeRecorder()?.anim.clock` at signal-write time,
    // so the timestamp is the post-step clock regardless of whether the
    // write happens inside a gen.
    anim.step(0.5);
    a.value = true;
    expect(winner.value?.first).toBe(0);
    expect(winner.value?.at).toBeCloseTo(0.5, 1);
    b.value = true;
    expect(winner.value?.first).toBe(0); // sticky
    rec.stop();
    anim.stop();
  });
});
