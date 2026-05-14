// Focused, stable bench: only `current` vs `v6` (the candidate),
// with realistic scenarios. Run multiple times to defeat GC noise.

import "./raf-polyfill";
import { bench, group, run, do_not_optimize } from "mitata";
import * as current from "./engine-current";
import * as v6 from "./engine-v6";
import * as v7 from "./engine-v7";
import * as v8 from "./engine-v8";
import * as v9 from "./engine-v9";
import * as v10 from "./engine-v10";
import * as v11 from "./engine-v11";
import * as v12 from "./engine-v12";
import {
  type EngineModule,
  makeRawYieldLoop,
  makeDriveLoop,
  makeSleepIdle,
  makeSleepChurn,
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
  ["v6     ", { Engine: v6.Anim, suspend: v6.suspend, drive: v6.drive }],
  ["v12    ", { Engine: v12.Anim, suspend: v12.suspend, drive: v12.drive }],
];

function across(name: string, make: (mod: EngineModule) => () => unknown) {
  group(name, () => {
    for (const [tag, mod] of engines) {
      const b = bench(tag, () => do_not_optimize(make(mod)()));
      if (tag.trim() === "current") b.baseline(true);
    }
  });
}

across("raw-yield   N=1000 60f", (mod) => makeRawYieldLoop(mod, 1000, 60));
across("drive-loop  N=1000 60f", (mod) => makeDriveLoop(mod, 1000, 60));
across("spring-sim  N=1000 60f", (mod) => makeSpringSim(mod, 1000, 60));
across("tween       N=500  60f", (mod) => makeTweenPattern(mod, 500, 60));
across("sleep-idle  500/100/30f", (mod) => makeSleepIdle(mod, 500, 100, 30, 0.5));
across("sleep-churn N=200 sleeps=10", (mod) => makeSleepChurn(mod, 200, 10));
across("spawn+complete N=1000", (mod) => makeSpawnComplete(mod, 1000));
across("spawn+cancel   N=1000", (mod) => makeSpawnCancel(mod, 1000));
across("suspend+wake   N=500", (mod) => makeSuspendWake(mod, 500));
across("parallel       N=100 K=10", (mod) => makeParallel(mod, 100, 10));
across("deep yield*    N=200 d=8", (mod) => makeDeepYieldStar(mod, 200, 8));
across("looping-child  N=100 60f", (mod) => makeLoopingChild(mod, 100, 60));
across("mixed          N=500 120f", (mod) => makeMixed(mod, 500, 120));

await run({ format: "mitata" });
