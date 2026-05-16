// Bench: pull-iterator runtime vs push v4 runtime vs push_plus.
//
//   node --expose-gc node_modules/.bin/vite-node \
//        src/minim/_iter_proto/_bench.bench.ts
//
// Scenarios picked to stress the model differences:
//   • spring-sim: simulation-heavy. drive(cb) (push) bypasses gen.next
//     each frame; pull pays one gen.next per frame. Hypothesis: push
//     wins by a constant.
//   • lerp-tween: idiomatic shape for each model. drive(closure-state)
//     vs Frame<number>. Same per-frame work modulo gen.next.
//   • raw-yield: pure gen.next loop. Push has Yieldable union dispatch
//     overhead per frame; pull just consumes the yielded value.
//   • spawn-complete: one-shot generators. Tests Active alloc + dispose.

import "../_test/setup";
import { bench, group, run, do_not_optimize } from "mitata";

import * as V4 from "../core/_anim_proto/v4_protocol";
import * as PP from "./push_plus";
import { Pull, lerp, spring as pullSpring } from "./pull";
import * as EF from "./effect";
import * as EF2 from "./effect2";
import * as V7 from "./v7_lean";
import * as V8 from "./v8";

function pre(fn: () => unknown): void {
  for (let i = 0; i < 200; i++) do_not_optimize(fn());
  if ((globalThis as any).gc) (globalThis as any).gc();
  bench(`x`, () => do_not_optimize(fn()));
}

// ───────────────────────────── scenarios ─────────────────────────────

const N_RAW = 1000, F_RAW = 60;
const N_SPRING = 1000, F_SPRING = 60;
const N_TWEEN = 1000, F_TWEEN = 60;
const N_SPAWN = 1000;

function makeRawYield<M extends { Anim: any }>(M: M) {
  return () => {
    const a = new M.Anim();
    let acc = 0;
    function* w(): any { while (true) { const dt: number = yield; acc += dt; } }
    for (let i = 0; i < N_RAW; i++) a.run(w);
    for (let f = 0; f < F_RAW; f++) a.step(1 / 60);
    a.stop();
    return acc;
  };
}

function rawYieldEffect(): () => number {
  return () => {
    const a = new EF.Anim();
    let acc = 0;
    function* w(): any { while (true) { const dt: number = yield EF.frame; acc += dt; } }
    for (let i = 0; i < N_RAW; i++) a.run(w);
    for (let f = 0; f < F_RAW; f++) a.step(1 / 60);
    a.stop();
    return acc;
  };
}

function rawYieldEffect2(): () => number {
  return () => {
    const a = new EF2.Anim();
    let acc = 0;
    function* w(): any { while (true) { const dt: number = yield; acc += dt; } }
    for (let i = 0; i < N_RAW; i++) a.run(w);
    for (let f = 0; f < F_RAW; f++) a.step(1 / 60);
    a.stop();
    return acc;
  };
}

function makeSpringPush<M extends { Anim: any; drive: any }>(M: M) {
  return () => {
    const a = new M.Anim();
    const xs = new Float64Array(N_SPRING), vs = new Float64Array(N_SPRING);
    for (let i = 0; i < N_SPRING; i++) {
      const idx = i;
      a.run(M.drive((dt: number) => {
        const f = (1 - xs[idx]) * 170, dr = -26 * vs[idx];
        vs[idx] += (f + dr) * dt;
        xs[idx] += vs[idx] * dt;
      }));
    }
    for (let f = 0; f < F_SPRING; f++) a.step(1 / 60);
    a.stop();
    return xs[0];
  };
}

function springEffect(): () => number {
  return () => {
    const a = new EF.Anim();
    const xs = new Float64Array(N_SPRING), vs = new Float64Array(N_SPRING);
    for (let i = 0; i < N_SPRING; i++) {
      const idx = i;
      a.run(function* () {
        yield EF.drive((dt) => {
          const f = (1 - xs[idx]) * 170, dr = -26 * vs[idx];
          vs[idx] += (f + dr) * dt;
          xs[idx] += vs[idx] * dt;
        });
      });
    }
    for (let f = 0; f < F_SPRING; f++) a.step(1 / 60);
    a.stop();
    return xs[0];
  };
}

function springEffect2(): () => number {
  return () => {
    const a = new EF2.Anim();
    const xs = new Float64Array(N_SPRING), vs = new Float64Array(N_SPRING);
    for (let i = 0; i < N_SPRING; i++) {
      const idx = i;
      a.run(function* () {
        yield EF2.drive((dt) => {
          const f = (1 - xs[idx]) * 170, dr = -26 * vs[idx];
          vs[idx] += (f + dr) * dt;
          xs[idx] += vs[idx] * dt;
        });
      });
    }
    for (let f = 0; f < F_SPRING; f++) a.step(1 / 60);
    a.stop();
    return xs[0];
  };
}

function springPullScenario(): () => number {
  return () => {
    const p = new Pull<number>();
    const xs = new Float64Array(N_SPRING);
    for (let i = 0; i < N_SPRING; i++) {
      const idx = i;
      p.run(pullSpring(1.0), (v) => { xs[idx] = v; });
    }
    for (let f = 0; f < F_SPRING; f++) p.step(1 / 60);
    p.stop();
    return xs[0];
  };
}

function makeTweenPush<M extends { Anim: any; drive: any }>(M: M) {
  return () => {
    const a = new M.Anim();
    const xs = new Float64Array(N_TWEEN);
    for (let i = 0; i < N_TWEEN; i++) {
      const idx = i;
      let t = 0;
      a.run(M.drive((dt: number) => {
        t += dt;
        if (t >= 1.0) { xs[idx] = 1; return false; }
        xs[idx] = t;
      }));
    }
    for (let f = 0; f < F_TWEEN; f++) a.step(1 / 60);
    a.stop();
    return xs[0];
  };
}

function tweenEffect(): () => number {
  return () => {
    const a = new EF.Anim();
    const xs = new Float64Array(N_TWEEN);
    for (let i = 0; i < N_TWEEN; i++) {
      const idx = i;
      let t = 0;
      a.run(function* () {
        yield EF.drive((dt) => {
          t += dt;
          if (t >= 1.0) { xs[idx] = 1; return false; }
          xs[idx] = t;
        });
      });
    }
    for (let f = 0; f < F_TWEEN; f++) a.step(1 / 60);
    a.stop();
    return xs[0];
  };
}

function tweenEffect2(): () => number {
  return () => {
    const a = new EF2.Anim();
    const xs = new Float64Array(N_TWEEN);
    for (let i = 0; i < N_TWEEN; i++) {
      const idx = i;
      let t = 0;
      a.run(function* () {
        yield EF2.drive((dt) => {
          t += dt;
          if (t >= 1.0) { xs[idx] = 1; return false; }
          xs[idx] = t;
        });
      });
    }
    for (let f = 0; f < F_TWEEN; f++) a.step(1 / 60);
    a.stop();
    return xs[0];
  };
}

function tweenPullScenario(): () => number {
  return () => {
    const p = new Pull<number>();
    const xs = new Float64Array(N_TWEEN);
    for (let i = 0; i < N_TWEEN; i++) {
      const idx = i;
      p.run(lerp(0, 1, 1.0), (v) => { xs[idx] = v; });
    }
    for (let f = 0; f < F_TWEEN; f++) p.step(1 / 60);
    p.stop();
    return xs[0];
  };
}

function makeSpawnComplete<M extends { Anim: any }>(M: M) {
  return () => {
    const a = new M.Anim();
    function* w(): any {}
    for (let i = 0; i < N_SPAWN; i++) a.run(w);
    a.step(0); a.stop();
  };
}

function spawnCompleteEffect(): () => void {
  return () => {
    const a = new EF.Anim();
    function* w(): any {}
    for (let i = 0; i < N_SPAWN; i++) a.run(w);
    a.step(0); a.stop();
  };
}

function spawnCompleteEffect2(): () => void {
  return () => {
    const a = new EF2.Anim();
    function* w(): any {}
    for (let i = 0; i < N_SPAWN; i++) a.run(w);
    a.step(0); a.stop();
  };
}

function spawnCompletePull(): () => void {
  return () => {
    const p = new Pull<number>();
    function* w(): any {}
    for (let i = 0; i < N_SPAWN; i++) p.run(w() as any, () => {});
    p.step(0); p.stop();
  };
}

// ──────────────────────────── registration ────────────────────────────

const variants = {
  v4:        { Anim: V4.Anim, drive: V4.drive },
  push_plus: { Anim: PP.Anim, drive: PP.drive },
  v7_lean:   { Anim: V7.Anim, drive: V7.drive },
  v8:        { Anim: V8.Anim, drive: V8.drive },
};

function regWarmed(name: string, fn: () => unknown): void {
  for (let i = 0; i < 200; i++) do_not_optimize(fn());
  bench(name, () => do_not_optimize(fn()));
}

group("raw-yield  N=1000 60f", () => {
  for (const [name, M] of Object.entries(variants)) regWarmed(name, makeRawYield(M as any));
  regWarmed("effect",  rawYieldEffect());
  regWarmed("effect2", rawYieldEffect2());
});

group("spring-sim N=1000 60f", () => {
  for (const [name, M] of Object.entries(variants)) regWarmed(name, makeSpringPush(M as any));
  regWarmed("pull",    springPullScenario());
  regWarmed("effect",  springEffect());
  regWarmed("effect2", springEffect2());
});

group("lerp-tween N=1000 60f", () => {
  for (const [name, M] of Object.entries(variants)) regWarmed(name, makeTweenPush(M as any));
  regWarmed("pull",    tweenPullScenario());
  regWarmed("effect",  tweenEffect());
  regWarmed("effect2", tweenEffect2());
});

group("spawn+complete N=1000", () => {
  for (const [name, M] of Object.entries(variants)) regWarmed(name, makeSpawnComplete(M as any));
  regWarmed("pull",    spawnCompletePull());
  regWarmed("effect",  spawnCompleteEffect());
  regWarmed("effect2", spawnCompleteEffect2());
});

await run({ format: "mitata" });
