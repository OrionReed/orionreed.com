// Bench all Anim prototypes side-by-side against the canonical
// scenario set from `_bench/anim.bench.ts`. Each variant is its own
// mitata group; mitata's per-bench warmup runs inside each, plus we
// pre-warm 200 iters before the timed phase.
//
//   node --expose-gc node_modules/.bin/vite-node \
//        src/minim/core/_anim_proto/_anim.bench.ts

import "../../_test/setup";
import { bench, group, run, do_not_optimize } from "mitata";

import * as V0 from "./v0_baseline";
import * as V1 from "./v1_constants";
import * as V2 from "./v2_settlement";
import * as V3 from "./v3_minimal";
import * as V4 from "./v4_protocol";
import * as V4b from "./v4b_oneonly";
import * as V4c from "./v4c_shared";
import * as V5 from "./v5_promise";
import * as V6 from "./v6_propagate";
import * as V7 from "./v7_simpler";
import * as V7b from "./v7b_classes";

type Mod = {
  name: string;
  Anim: new () => any;
  suspend: typeof V0.suspend;
  drive: typeof V0.drive;
};

// Kept to the meaningful endpoints; v1/v3/v4/v4b dropped from bench
// because they're either no-op renames or superseded variants.
const variants: Mod[] = [
  { name: "v0",  Anim: V0.Anim,  suspend: V0.suspend,  drive: V0.drive  },
  { name: "v2",  Anim: V2.Anim,  suspend: V2.suspend,  drive: V2.drive  },
  { name: "v4c", Anim: V4c.Anim, suspend: V4c.suspend, drive: V4c.drive },
  { name: "v5",  Anim: V5.Anim,  suspend: V5.suspend,  drive: V5.drive  },
  { name: "v6",  Anim: V6.Anim,  suspend: V6.suspend,  drive: V6.drive  },
  // v7's `drive` returns a FrameSpec (yieldable). Wrap so the bench
  // body — written for the older "drive returns an Animator" shape —
  // keeps working.
  { name: "v7",  Anim: V7.Anim,  suspend: V7.suspend,
    drive: ((cb: any) => (function* (): any { yield V7.drive(cb); })()) as any },
  { name: "v7b", Anim: V7b.Anim, suspend: V7b.suspend,
    drive: ((cb: any) => (function* (): any { yield V7b.drive(cb); })()) as any },
];
void V1; void V3; void V4; void V4b;

function makeScenarios(M: Mod) {
  const { Anim, suspend, drive } = M;

  function* sleeper(): any { yield 0.5; }
  function* driver(): any { while (true) yield; }

  const rawYield = (N: number, frames: number) => () => {
    const a = new Anim();
    let acc = 0;
    function* w(): any { while (true) { const dt: number = yield; acc += dt; } }
    for (let i = 0; i < N; i++) a.run(w);
    for (let f = 0; f < frames; f++) a.step(1 / 60);
    a.stop();
    return acc;
  };
  const driveLoop = (N: number, frames: number) => () => {
    const a = new Anim();
    let acc = 0;
    for (let i = 0; i < N; i++) a.run(drive((dt) => { acc += dt; }));
    for (let f = 0; f < frames; f++) a.step(1 / 60);
    a.stop();
    return acc;
  };
  const springSim = (N: number, frames: number) => () => {
    const a = new Anim();
    const xs = new Float64Array(N), vs = new Float64Array(N);
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
  const sleepIdle = (N: number, K: number, frames: number) => () => {
    const a = new Anim();
    for (let i = 0; i < N; i++) a.run(sleeper);
    for (let i = 0; i < K; i++) a.run(driver);
    for (let f = 0; f < frames; f++) a.step(1 / 60);
    a.stop();
  };
  const spawnComplete = (N: number) => () => {
    const a = new Anim();
    function* w(): any {}
    for (let i = 0; i < N; i++) a.run(w);
    a.step(0);
    a.stop();
  };
  const spawnCancel = (N: number) => () => {
    const a = new Anim();
    function* w(): any { yield; }
    const ds: (() => void)[] = [];
    for (let i = 0; i < N; i++) ds.push(a.run(w));
    for (const d of ds) d();
    a.stop();
  };
  const suspendWake = (N: number) => () => {
    const a = new Anim();
    const wakes: Array<() => void> = [];
    function* w(): any {
      yield* suspend((wake) => { wakes.push(wake as any); return () => {}; });
    }
    for (let i = 0; i < N; i++) a.run(w);
    a.step(1 / 60);
    for (const wf of wakes) wf();
    a.step(1 / 60);
    a.stop();
  };
  const parallel = (N: number, K: number) => () => {
    const a = new Anim();
    function* child(): any { yield; }
    function* w(): any {
      const kids = Array.from({ length: K }, () => child());
      yield kids;
    }
    for (let i = 0; i < N; i++) a.run(w);
    a.step(1 / 60); a.step(1 / 60); a.step(1 / 60);
    a.stop();
  };
  const deepYieldStar = (N: number, depth: number) => () => {
    const a = new Anim();
    function* leaf(): any { yield; }
    function makeChain(d: number): () => any {
      let cur: () => any = leaf;
      for (let i = 0; i < d; i++) {
        const inner = cur;
        cur = function* (): any { yield* inner(); };
      }
      return cur;
    }
    const f = makeChain(depth);
    for (let i = 0; i < N; i++) a.run(f);
    a.step(1 / 60); a.step(1 / 60);
    a.stop();
  };
  const mixed = (frames: number) => () => {
    const a = new Anim();
    let dummy = 0;
    const Ndrive = 150, Nsleep = 150, Nsuspend = 100, Nshort = 100;
    for (let i = 0; i < Ndrive; i++) a.run(drive((dt) => { dummy += dt; }));
    for (let i = 0; i < Nsleep; i++) a.run(sleeper);
    const wakes: Array<() => void> = [];
    function* susp(): any {
      yield* suspend((w) => { wakes.push(w as any); return () => {}; });
    }
    for (let i = 0; i < Nsuspend; i++) a.run(susp);
    function* shortLived(): any { yield; yield; }
    for (let i = 0; i < Nshort; i++) a.run(shortLived);
    for (let f = 0; f < frames; f++) {
      a.step(1 / 60);
      if (f % 10 === 0 && wakes.length > 0) wakes.pop()!();
    }
    a.stop();
    return dummy;
  };
  const uiButtons = (N: number, frames: number) => () => {
    const a = new Anim();
    let acc = 0;
    const wakes: Array<() => void> = [];
    function* clickWait(): any {
      yield* suspend((w) => { wakes.push(w as any); return () => {}; });
    }
    function* button(): any {
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

  return {
    "raw-yield     N=1000 60f":  rawYield(1000, 60),
    "drive-loop    N=1000 60f":  driveLoop(1000, 60),
    "spring-sim    N=1000 60f":  springSim(1000, 60),
    "sleep-idle    500/100/30f": sleepIdle(500, 100, 30),
    "spawn+complete N=1000":     spawnComplete(1000),
    "spawn+cancel  N=1000":      spawnCancel(1000),
    "suspend+wake  N=500":       suspendWake(500),
    "parallel      N=100 K=10":  parallel(100, 10),
    "deep yield*   N=200 d=8":   deepYieldStar(200, 8),
    "mixed         N=500 120f":  mixed(120),
    "ui-buttons    N=100 200f":  uiButtons(100, 200),
  } as const;
}

function reg(name: string, fn: () => unknown): void {
  for (let i = 0; i < 200; i++) do_not_optimize(fn());
  if ((globalThis as any).gc) (globalThis as any).gc();
  bench(name, () => do_not_optimize(fn()));
}

// Outer grouping: one group per scenario, with one bench per variant.
// Makes the mitata table read "scenario × variant" which is what we want.
const seed = makeScenarios(variants[0]);
const scenarioNames = Object.keys(seed) as (keyof typeof seed)[];

for (const sc of scenarioNames) {
  group(sc as string, () => {
    for (const M of variants) {
      const fns = makeScenarios(M);
      reg(M.name, fns[sc]);
    }
  });
}

await run({ format: "mitata" });
