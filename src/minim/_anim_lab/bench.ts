// Cross-engine micro-benchmark.
//
// Run with:
//   node --expose-gc node_modules/.bin/vite-node \
//     src/minim/_anim_lab/bench.ts

import "./raf-polyfill";
import { bench, group, run, do_not_optimize } from "mitata";
import * as current from "./engine-current";
import * as v3 from "./engine-v3";
import * as v4 from "./engine-v4";
import * as v5 from "./engine-v5";
import * as v6 from "./engine-v6";
import {
  type EngineModule,
  makeRawYieldLoop,
  makeDriveLoop,
  makeSleepChurn,
  makeSleepIdle,
  makeSpawnComplete,
  makeSpawnCancel,
  makeSuspendWake,
  makeParallel,
  makeDeepYieldStar,
  makeSpringSim,
  makeTweenPattern,
  makeLoopingChild,
  makeMixed,
} from "./scenarios";

const engines: Array<[string, EngineModule]> = [
  ["current", { Engine: current.Anim, suspend: current.suspend }],
  ["v3     ", { Engine: v3.Anim, suspend: v3.suspend }],
  ["v4     ", { Engine: v4.Anim, suspend: v4.suspend, drive: v4.drive }],
  ["v5     ", { Engine: v5.Anim, suspend: v5.suspend }],
  ["v6     ", { Engine: v6.Anim, suspend: v6.suspend, drive: v6.drive }],
];

function across(
  name: string,
  make: (mod: EngineModule) => () => unknown,
  baseline = "current",
) {
  group(name, () => {
    for (const [tag, mod] of engines) {
      const b = bench(tag, () => do_not_optimize(make(mod)()));
      if (tag.trim() === baseline) b.baseline(true);
    }
  });
}

across("raw-yield   N=1000, frames=60", (mod) => makeRawYieldLoop(mod, 1000, 60));
across("drive-loop  N=1000, frames=60", (mod) => makeDriveLoop(mod, 1000, 60));
across("spring-sim  N=1000, frames=60", (mod) => makeSpringSim(mod, 1000, 60));
across("tween       N=500,  frames=60", (mod) => makeTweenPattern(mod, 500, 60));
across("sleep-idle  N=500/100/30f", (mod) => makeSleepIdle(mod, 500, 100, 30, 0.5));
across("sleep-churn N=200,  sleeps=10", (mod) => makeSleepChurn(mod, 200, 10));
across("spawn+complete N=1000", (mod) => makeSpawnComplete(mod, 1000));
across("spawn+cancel   N=1000", (mod) => makeSpawnCancel(mod, 1000));
across("suspend+wake   N=500", (mod) => makeSuspendWake(mod, 500));
across("parallel       N=100, K=10", (mod) => makeParallel(mod, 100, 10));
across("deep yield*    N=200, depth=8", (mod) => makeDeepYieldStar(mod, 200, 8));
across("looping-child  N=100, frames=60", (mod) => makeLoopingChild(mod, 100, 60));
across("mixed          N=500, frames=120", (mod) => makeMixed(mod, 500, 120));

await run({ format: "mitata" });
