// Regression tests for `shapes/transitions`. The `eager(factory)`
// wrapper used by intros (`from`/`bounceIn`/`scaleIn`/`spinIn`/...)
// has a subtle requirement: the resume value (`dt`) of the wrapper's
// first yield must be forwarded into the inner gen's first resumed
// `yield`. Plain `yield* g` would discard it (the spec calls
// `g.next()` with no arg), so a tween's `t += dt` would produce NaN.

import { describe, it, expect } from "vitest";
import { Anim } from "@minim/core";
import { num, Vec } from "@minim/values";
import { from, fadeIn, bounceIn } from "@minim/shapes";

describe("transitions / eager wrapper forwards dt", () => {
  it("from(num, 0, 1) tweens to 1 (no NaN)", () => {
    const anim = new Anim();
    const n = num(5);
    anim.start(function* () {
      yield* from(n, 0, 1, 0.5);
    });
    for (let i = 0; i < 60; i++) anim.step(0.016);
    expect(n.value).toBeCloseTo(1, 9);
    anim.stop();
  });

  it("fadeIn(s, sec) ends at opacity=1", () => {
    const anim = new Anim();
    const s = { opacity: num(0.42) } as any;
    anim.start(function* () { yield* fadeIn(s, 0.3); });
    for (let i = 0; i < 30; i++) anim.step(0.016);
    expect(s.opacity.value).toBeCloseTo(1, 9);
    anim.stop();
  });

  it("bounceIn settles at scale={1,1}, opacity=1", () => {
    const anim = new Anim();
    const s = {
      scale: Vec.signal({ x: 1, y: 1 }),
      opacity: num(1),
    } as any;
    anim.start(function* () { yield* bounceIn(s, 0.5); });
    for (let i = 0; i < 60; i++) anim.step(0.016);
    expect(s.scale.value.x).toBeCloseTo(1, 5);
    expect(s.scale.value.y).toBeCloseTo(1, 5);
    expect(s.opacity.value).toBeCloseTo(1, 5);
    anim.stop();
  });

  it("from poses synchronously at construction (eager start-state)", () => {
    const n = num(99);
    // Constructing `from(n, 0, 1, 0.5)` should set `n.value = 0` IMMEDIATELY,
    // before any engine advance. That's what `stagger`-style schedulers depend
    // on — all start-poses applied uniformly before any tween begins.
    const _g = from(n, 0, 1, 0.5);
    expect(n.value).toBe(0);
    // (We don't drive `_g`; the test only checks the eager pose.)
    void _g;
  });
});
