// animation.test.ts — synthetic-step tests for the animation surface.
// Drives the runtime by calling `anim.step(dt)` directly, no RAF.
//
// Verifies: tween, chain, parallel, detach, race, until, then, at,
// spring, toward, from, holding, driven.

import { describe, it } from "vitest";
import { check, section, approx } from "./_check";
import {
  signal,
  num, vec, transform,
  play, when, not, Tween,
  spring, toward, holding, driven, follow,
} from "@minim/signals";
import { Anim, detach, race, linear } from "@minim/core";

function tick(anim: Anim, frames: number, dt = 1 / 60): void {
  for (let i = 0; i < frames; i++) anim.step(dt);
}

describe("animation", () => {
  it("all checks", () => {
    section("Tween basics — Num.to()");
    {
      const anim = new Anim();
      const x = num(0);
      anim.start(function* () { yield* x.to(100, 1.0, linear); });
      tick(anim, 30);
      check("at 0.5s, x ≈ 50", approx(x.value, 50, 1));
      tick(anim, 30);
      check("at 1.0s, x === 100", x.value === 100);
    }

    section("Tween chain — .to(A).to(B).to(C)");
    {
      const anim = new Anim();
      const x = num(0);
      anim.start(function* () {
        yield* x.to(10, 0.1, linear).to(20, 0.1, linear).to(30, 0.1, linear);
      });
      tick(anim, 6);
      check("after seg 1: x === 10", x.value === 10);
      tick(anim, 6);
      check("after seg 2: x === 20", x.value === 20);
      tick(anim, 6);
      check("after seg 3: x === 30", x.value === 30);
    }

    section("Tween chain returns Tween<T>");
    {
      const x = num(0);
      const t1 = x.to(10, 0.1);
      check("x.to(...) returns Tween<number>", t1 instanceof Tween);
      const t2 = t1.to(20, 0.1);
      check("Tween.to(...) returns Tween<number>", t2 instanceof Tween);
    }

    section("Tween .from(start) — pose-then-tween prefix");
    {
      const anim = new Anim();
      const x = num(50);
      anim.start(function* () { yield* x.to(100, 0.1, linear).from(0); });
      tick(anim, 1);
      check("from(0) sets initial value", approx(x.value, 0, 0.01) || x.value < 30);
      tick(anim, 6);
      check(".from(0).to(100): final 100", x.value === 100);
    }

    section("Vec.to() — typed value");
    {
      const anim = new Anim();
      const v = vec(0, 0);
      anim.start(function* () { yield* v.to({ x: 100, y: 50 }, 1.0, linear); });
      tick(anim, 30);
      check("Vec halfway: x ≈ 50, y ≈ 25", approx(v.value.x, 50, 1) && approx(v.value.y, 25, 1));
      tick(anim, 30);
      check("Vec done: x === 100, y === 50", v.value.x === 100 && v.value.y === 50);
    }

    section("Tween reactive duration — Val<number>");
    {
      const anim = new Anim();
      const x = num(0);
      const dur = signal(1.0);
      anim.start(function* () { yield* x.to(100, dur, linear); });
      tick(anim, 30);
      check("at 0.5s of dur=1.0: x ≈ 50", approx(x.value, 50, 1));
      dur.value = 2.0;
      tick(anim, 121);
      check("Tween eventually completes with reactive dur", x.value === 100);
    }

    section("Parallel — yield [a, b]");
    {
      const anim = new Anim();
      const a = num(0), b = num(0);
      let done = false;
      anim.start(function* () {
        yield [a.to(100, 0.5, linear), b.to(50, 0.5, linear)];
        done = true;
      });
      tick(anim, 15);
      check("parallel midway: a ≈ 50", approx(a.value, 50, 1));
      check("parallel midway: b ≈ 25", approx(b.value, 25, 1));
      tick(anim, 16);
      check("parallel done: a === 100", a.value === 100);
      check("parallel done: b === 50", b.value === 50);
      check("parallel finishes parent gen", done);
    }

    section("detach(g) — fire-and-forget child at engine root");
    {
      const anim = new Anim();
      const fast = num(0);
      const slow = num(0);
      let parentDone = false;
      anim.start(function* () {
        yield detach(slow.to(100, 1.0, linear));
        yield* fast.to(50, 0.1, linear);
        parentDone = true;
      });
      tick(anim, 10);
      check("parent finished", parentDone);
      check("fast tween done", fast.value === 50);
      check("slow tween in progress", approx(slow.value, 16.7, 2));
      tick(anim, 50);
      check("slow tween eventually completes", slow.value === 100);
    }

    section("race() — first-completion wins");
    {
      const anim = new Anim();
      const x = num(0);
      let winnerSeen: string | undefined;
      anim.start(function* () {
        const winner = yield* race(
          (function* () { yield* x.to(100, 0.5, linear); return "tween-done"; })(),
          (function* () { yield 0.2; return "timer-fired"; })(),
        );
        winnerSeen = winner as string;
      });
      tick(anim, 13);
      check("race resolves with timer payload", winnerSeen === "timer-fired");
      check("losing tween was cancelled (x partial, < 100)", x.value < 100);
    }

    section("play().until(p) — terminate on signal-truthy");
    {
      const anim = new Anim();
      const x = num(0);
      const stop = signal(false);
      let endedEarly = false;
      anim.start(function* () {
        yield* play(x.to(100, 1.0, linear)).until(stop);
        endedEarly = true;
      });
      tick(anim, 10);
      check("midway: x progressing", x.value > 0 && x.value < 100);
      stop.value = true;
      tick(anim, 1);
      check("until() terminated parent", endedEarly);
    }

    section("play().then(next) — sequence");
    {
      const anim = new Anim();
      const x = num(0);
      const phase = signal("idle");
      anim.start(function* () {
        yield* play(x.to(50, 0.1, linear)).then(x.to(0, 0.1, linear));
        phase.value = "done";
      });
      tick(anim, 6); check("after seg 1: x === 50", x.value === 50);
      tick(anim, 6); check("after seg 2: x === 0", x.value === 0);
      check("phase done", phase.value === "done");
    }

    section("play().at(scale) — time-scale child");
    {
      const anim = new Anim();
      const x = num(0);
      anim.start(function* () { yield* play(x.to(100, 0.5, linear)).at(2); });
      tick(anim, 15);
      check(".at(2) accelerates tween: x === 100 at 0.25s", x.value === 100);
    }
    {
      const anim = new Anim();
      const x = num(0);
      anim.start(function* () { yield* play(x.to(100, 0.5, linear)).at(0.5); });
      tick(anim, 30);
      check(".at(0.5) at half-tween: x ≈ 50", approx(x.value, 50, 1));
      tick(anim, 30);
      check(".at(0.5) decelerates tween: x === 100 at 1.0s", x.value === 100);
    }

    section("spring() — settle to target");
    {
      const anim = new Anim();
      const x = num(0);
      let settled = false;
      anim.start(function* () { yield* spring(x, 100, { stiffness: 100, damping: 20 }); settled = true; });
      tick(anim, 600);
      check("spring final very close to 100", approx(x.value, 100, 0.5));
      check("spring eventually settles (or near it)", settled || approx(x.value, 100, 1));
    }

    section("spring() generic over Transform");
    {
      const anim = new Anim();
      const tr = transform();
      const target = {
        translate: { x: 100, y: 50 }, scale: { x: 2, y: 2 }, origin: { x: 0, y: 0 },
        rotate: Math.PI, opacity: 0.5,
      };
      anim.start(function* () { yield* spring(tr, target, { stiffness: 80, damping: 18 }); });
      tick(anim, 600);
      check("spring on Transform: translate.x → ~100", approx(tr.value.translate.x, 100, 1));
      check("spring on Transform: scale.x → ~2", approx(tr.value.scale.x, 2, 0.05));
      check("spring on Transform: rotate → ~π", approx(tr.value.rotate, Math.PI, 0.05));
      check("spring on Transform: opacity → ~0.5", approx(tr.value.opacity, 0.5, 0.05));
    }

    section("toward() — constant-speed approach");
    {
      const anim = new Anim();
      const x = num(0);
      let done = false;
      anim.start(function* () { yield* toward(x, 50, 100); done = true; });
      tick(anim, 31);
      check("toward done at ~0.5s", done);
      check("toward final === target", x.value === 50);
    }

    section("follow(source) — generator-scoped reactive bind");
    {
      const anim = new Anim();
      const a = num(10);
      const b = num(0);
      const stop = signal(false);
      anim.start(function* () {
        yield* race(follow(b, a), when(stop));
      });
      tick(anim, 1);
      check("b initially follows a", b.value === 10);
      a.value = 99;
      tick(anim, 1);
      check("b updates with a", b.value === 99);
      stop.value = true;
      tick(anim, 1);
      a.value = 7;
      tick(anim, 1);
      check("after stop, b no longer follows a", b.value === 99);
    }

    section("holding(v, dur) — set, wait, restore");
    {
      const anim = new Anim();
      const x = num(50);
      let done = false;
      anim.start(function* () { yield* holding(x, 99, 0.2); done = true; });
      tick(anim, 1);
      check("during hold: x === 99", x.value === 99);
      tick(anim, 12);
      tick(anim, 1);
      check("hold completes", done);
      check("after hold: x restored to 50", x.value === 50);
    }

    section("driven(stepFn) — escape hatch");
    {
      const anim = new Anim();
      const x = num(0);
      let done = false;
      anim.start(function* () {
        yield* driven(x, (dt, t, v) => t > 0.5 ? false : v + dt * 100);
        done = true;
      });
      tick(anim, 31);
      check("driven terminated when t > 0.5", done);
      check("driven accumulated value", approx(x.value, 50, 1));
    }

    section("play(() => gen) — factory thunk invoked at play boundary");
    {
      const anim = new Anim();
      const x = num(0);
      let factoryCalls = 0;
      anim.start(function* () {
        yield* play(() => { factoryCalls++; return x.to(100, 0.1, linear); });
      });
      tick(anim, 6);
      check("play(thunk): final 100", x.value === 100);
      check("play(thunk): factory invoked once", factoryCalls === 1);
    }

    section("not(sig) — reactive negation returns a Signal");
    {
      const anim = new Anim();
      const flag = signal(false);
      const neg = not(flag);
      check("not(sig) is reactive cell with peek/value", neg.peek() === true && neg.value === true);
      flag.value = true;
      check("not(sig) flips with source", neg.value === false);
      // Also: not(sig) must be acceptable as a play-trigger (instanceof Signal).
      let woke = false;
      anim.start(function* () { yield* play(not(flag)); woke = true; });
      tick(anim, 1);
      check("play(not(sig)) waits while sig truthy", !woke);
      flag.value = false;
      tick(anim, 1);
      check("play(not(sig)) wakes when sig flips false", woke);
    }

    section("pause via play(spring).at(0|1) — universal time-scale primitive");
    {
      // `play().at(reactive scale)` IS the pause primitive now. Sleep
      // and per-frame yields both honor the scale; `at(0)` freezes
      // motion AND timers. Replaces the old `unless` helper — instead
      // of cancel/restart on guard flip, we time-scale the running
      // animator continuously by the guard.
      const anim = new Anim();
      const x = num(0);
      const drag = signal(false);
      anim.start(function* () {
        yield* play(spring(x, 100, { stiffness: 200, damping: 24 }))
          .at(() => drag.value ? 0 : 1);
      });
      tick(anim, 60);
      check("at(reactive): spring runs while drag=false → x → ~100", approx(x.value, 100, 1));
      drag.value = true;
      const xPaused = x.value;
      tick(anim, 200);
      check("at(0) freezes the spring: x unchanged across many frames", x.value === xPaused);
      drag.value = false;
      tick(anim, 1);
      // After resume, spring sees x at its frozen value and continues.
      check("at(1) resumes the spring cleanly", approx(x.value, 100, 0.5));
    }

    section("Tween chain on Vec field lens");
    {
      const anim = new Anim();
      const v = vec(0, 0);
      anim.start(function* () {
        yield* v.x.to(50, 0.1, linear).to(0, 0.1, linear);
      });
      tick(anim, 6);
      check("after seg 1: v.x === 50", v.value.x === 50);
      tick(anim, 6);
      check("after seg 2: v.x === 0", v.value.x === 0);
      check("v.y unchanged", v.value.y === 0);
    }
  });
});
