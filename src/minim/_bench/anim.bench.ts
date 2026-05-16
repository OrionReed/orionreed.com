// Animation runtime bench. One file, twelve scenarios, run via mitata.
// Use this for regression detection — keep numbers in mind across
// releases. Per-scenario warmup happens inside mitata; we add an
// extra 200-iter pre-warm to stabilise the JIT before timing starts.
//
//   node --expose-gc node_modules/.bin/vite-node \
//        src/minim/_bench/anim.bench.ts

import "../_test/setup";
import { bench, group, run, do_not_optimize } from "mitata";
import { Anim, suspend, drive, type Animator, type SuspendFn } from "@minim/core";

function* sleeper(): Animator { yield 0.5; }
function* driver(): Animator { while (true) yield; }

function makeRawYieldLoop(N: number, frames: number) {
  return () => {
    const a = new Anim();
    let acc = 0;
    function* w(): Animator { while (true) { const dt: number = yield; acc += dt; } }
    for (let i = 0; i < N; i++) a.run(w);
    for (let f = 0; f < frames; f++) a.step(1 / 60);
    a.stop();
    return acc;
  };
}

function makeDriveLoop(N: number, frames: number) {
  return () => {
    const a = new Anim();
    let acc = 0;
    for (let i = 0; i < N; i++) a.run(drive((dt) => { acc += dt; }));
    for (let f = 0; f < frames; f++) a.step(1 / 60);
    a.stop();
    return acc;
  };
}

function makeSpringSim(N: number, frames: number) {
  return () => {
    const a = new Anim();
    const xs = new Float64Array(N);
    const vs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const idx = i;
      a.run(drive((dt) => {
        const force = (1 - xs[idx]) * 170;
        const drag = -26 * vs[idx];
        vs[idx] += (force + drag) * dt;
        xs[idx] += vs[idx] * dt;
      }));
    }
    for (let f = 0; f < frames; f++) a.step(1 / 60);
    a.stop();
    return xs[0];
  };
}

function makeTween(N: number, frames: number) {
  return () => {
    const a = new Anim();
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const idx = i;
      a.run(drive((_dt, t) => {
        if (t >= 1) { out[idx] = 1; return false; }
        out[idx] = t;
      }));
    }
    for (let f = 0; f < frames; f++) a.step(1 / 60);
    a.stop();
  };
}

function makeSleepIdle(N: number, K: number, frames: number) {
  return () => {
    const a = new Anim();
    for (let i = 0; i < N; i++) a.run(sleeper);
    for (let i = 0; i < K; i++) a.run(driver);
    for (let f = 0; f < frames; f++) a.step(1 / 60);
    a.stop();
  };
}

function makeSpawnComplete(N: number) {
  return () => {
    const a = new Anim();
    function* w(): Animator {}
    for (let i = 0; i < N; i++) a.run(w);
    a.step(0);
    a.stop();
  };
}

function makeSpawnCancel(N: number) {
  return () => {
    const a = new Anim();
    function* w(): Animator { yield; }
    const ds: (() => void)[] = [];
    for (let i = 0; i < N; i++) ds.push(a.run(w));
    for (const d of ds) d();
    a.stop();
  };
}

function makeSuspendWake(N: number) {
  return () => {
    const a = new Anim();
    const wakes: Array<() => void> = [];
    function* w(): Animator {
      yield* suspend((wake) => { wakes.push(wake); return () => {}; });
    }
    for (let i = 0; i < N; i++) a.run(w);
    a.step(1 / 60);
    for (const w of wakes) w();
    a.step(1 / 60);
    a.stop();
  };
}

function makeParallel(N: number, K: number) {
  return () => {
    const a = new Anim();
    function* child(): Animator { yield; }
    function* w(): Animator {
      const kids = Array.from({ length: K }, () => child());
      yield kids;
    }
    for (let i = 0; i < N; i++) a.run(w);
    a.step(1 / 60); a.step(1 / 60); a.step(1 / 60);
    a.stop();
  };
}

function makeDeepYieldStar(N: number, depth: number) {
  return () => {
    const a = new Anim();
    function* leaf(): Animator { yield; }
    function makeChain(d: number): () => Animator {
      let cur: () => Animator = leaf;
      for (let i = 0; i < d; i++) {
        const inner = cur;
        cur = function* (): Animator { yield* inner(); };
      }
      return cur;
    }
    const f = makeChain(depth);
    for (let i = 0; i < N; i++) a.run(f);
    a.step(1 / 60); a.step(1 / 60);
    a.stop();
  };
}

function makeMixed(_N: number, frames: number) {
  return () => {
    const a = new Anim();
    let dummy = 0;
    const Ndrive = 150, Nsleep = 150, Nsuspend = 100, Nshort = 100;
    for (let i = 0; i < Ndrive; i++) a.run(drive((dt) => { dummy += dt; }));
    for (let i = 0; i < Nsleep; i++) a.run(sleeper);
    const wakes: Array<() => void> = [];
    function* susp(): Animator {
      yield* suspend((w) => { wakes.push(w); return () => {}; });
    }
    for (let i = 0; i < Nsuspend; i++) a.run(susp);
    function* shortLived(): Animator { yield; yield; }
    for (let i = 0; i < Nshort; i++) a.run(shortLived);
    for (let f = 0; f < frames; f++) {
      a.step(1 / 60);
      if (f % 10 === 0 && wakes.length > 0) wakes.pop()!();
    }
    a.stop();
    return dummy;
  };
}

// Realistic UI: 100 buttons each running click → tween → tween → sleep.
function makeUiButtons(N: number, frames: number) {
  return () => {
    const a = new Anim();
    let acc = 0;
    const wakes: Array<() => void> = [];
    function* clickWait(): Animator {
      yield* suspend((w) => { wakes.push(w); return () => {}; });
    }
    function* button(): Animator {
      for (let i = 0; i < 5; i++) {
        yield* clickWait();
        yield* drive((_dt, t) => { if (t >= 0.1) return false; acc += 1; });
        yield* drive((_dt, t) => { if (t >= 0.2) return false; acc += 1; });
        yield 0.3;
      }
    }
    for (let i = 0; i < N; i++) a.run(button);
    for (let f = 0; f < frames; f++) {
      a.step(1 / 60);
      for (let k = 0; k < 5 && wakes.length; k++) wakes.shift()!();
    }
    a.stop();
    return acc;
  };
}

function reg(name: string, fn: () => unknown) {
  for (let i = 0; i < 200; i++) do_not_optimize(fn());
  if ((globalThis as any).gc) (globalThis as any).gc();
  bench(name, () => do_not_optimize(fn()));
}

group("anim runtime", () => {
  reg("raw-yield     N=1000 60f",  makeRawYieldLoop(1000, 60));
  reg("drive-loop    N=1000 60f",  makeDriveLoop(1000, 60));
  reg("spring-sim    N=1000 60f",  makeSpringSim(1000, 60));
  reg("tween         N=500  60f",  makeTween(500, 60));
  reg("sleep-idle    500/100/30f", makeSleepIdle(500, 100, 30));
  reg("spawn+complete N=1000",     makeSpawnComplete(1000));
  reg("spawn+cancel  N=1000",      makeSpawnCancel(1000));
  reg("suspend+wake  N=500",       makeSuspendWake(500));
  reg("parallel      N=100 K=10",  makeParallel(100, 10));
  reg("deep yield*   N=200 d=8",   makeDeepYieldStar(200, 8));
  reg("mixed         N=500 120f",  makeMixed(500, 120));
  reg("ui-buttons    N=100 200f",  makeUiButtons(100, 200));
});

await run({ format: "mitata" });
