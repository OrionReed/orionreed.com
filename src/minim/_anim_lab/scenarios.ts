// Workloads exercised against each engine. An "engine" is anything
// shaped like the public surface we depend on:
//   - new Engine()
//   - engine.run(genOrFactory) -> dispose
//   - engine.step(dt)
//   - engine.stop()
// plus the static helper `suspend` re-imported per engine.
//
// `drive` is OPTIONAL on the module — if present, scenarios that
// benefit from a runtime-native ticker (v4) use it; otherwise they
// fall back to a generic generator-based drive that all engines
// support.

import type { Animator, SuspendFn } from "../core/anim";

export interface EngineLike {
  run(g: Animator<any> | (() => Animator<any>)): () => void;
  step(dt: number): void;
  stop(): void;
}
export interface EngineModule {
  Engine: new () => EngineLike;
  suspend: <T = void>(impl: SuspendFn<T>) => Animator<T>;
  /** Optional engine-specific implementation of drive. v4 uses this
   *  to bypass per-frame generator overhead. */
  drive?: (
    step: (dt: number, t: number) => boolean | void,
  ) => Animator<any>;
}

// Generic drive — same shape as core/drive.ts. Any engine without its
// own `drive` falls back to this.
function genericDrive(
  step: (dt: number, t: number) => boolean | void,
): Animator<any> {
  return (function* () {
    let t = 0;
    while (true) {
      const dt: number = yield;
      t += dt;
      if (step(dt, t) === false) return;
    }
  })();
}

function driveOf(mod: EngineModule) {
  return mod.drive ?? genericDrive;
}

// ── Scenario 1: drive-style hot loop (raw generator yield) ──────────
// Engine-agnostic baseline — no use of optional `drive` helper. Pure
// `while(true) { yield; }` per active.
export function makeRawYieldLoop(mod: EngineModule, N: number, M: number) {
  return () => {
    const e = new mod.Engine();
    let acc = 0;
    function* worker(): Animator {
      while (true) {
        const dt: number = yield;
        acc += dt;
      }
    }
    for (let i = 0; i < N; i++) e.run(worker);
    const dt = 1 / 60;
    for (let f = 0; f < M; f++) e.step(dt);
    e.stop();
    return acc;
  };
}

// ── Scenario 1b: drive-via-helper hot loop ──────────────────────────
// Uses the engine's `drive` (or the generic fallback). v4 short-cuts
// to an internal ticker and skips the generator state machine.
export function makeDriveLoop(mod: EngineModule, N: number, M: number) {
  const drive = driveOf(mod);
  return () => {
    const e = new mod.Engine();
    let acc = 0;
    for (let i = 0; i < N; i++) {
      e.run(drive((dt) => { acc += dt; }));
    }
    const dt = 1 / 60;
    for (let f = 0; f < M; f++) e.step(dt);
    e.stop();
    return acc;
  };
}

// ── Scenario 2: sleep churn (pathological) ──────────────────────────
export function makeSleepChurn(mod: EngineModule, N: number, sleeps: number) {
  return () => {
    const e = new mod.Engine();
    function* worker(): Animator {
      for (let i = 0; i < sleeps; i++) yield 0.001;
    }
    for (let i = 0; i < N; i++) e.run(worker);
    for (let f = 0; f < sleeps + 2; f++) e.step(0.002);
    e.stop();
  };
}

// ── Scenario 2b: realistic sleep — most actives parked ──────────────
export function makeSleepIdle(
  mod: EngineModule,
  N: number,
  K: number,
  frames: number,
  dur: number,
) {
  return () => {
    const e = new mod.Engine();
    function* sleeper(): Animator { yield dur; }
    function* driver(): Animator { while (true) yield; }
    for (let i = 0; i < N; i++) e.run(sleeper);
    for (let i = 0; i < K; i++) e.run(driver);
    const dt = 1 / 60;
    for (let f = 0; f < frames; f++) e.step(dt);
    e.stop();
  };
}

// ── Scenario 3: spawn + immediate complete ──────────────────────────
export function makeSpawnComplete(mod: EngineModule, N: number) {
  return () => {
    const e = new mod.Engine();
    function* worker(): Animator {}
    for (let i = 0; i < N; i++) e.run(worker);
    e.step(0);
    e.stop();
  };
}

// ── Scenario 4: spawn + cancel churn ────────────────────────────────
export function makeSpawnCancel(mod: EngineModule, N: number) {
  return () => {
    const e = new mod.Engine();
    function* worker(): Animator { yield; }
    const ds: (() => void)[] = [];
    for (let i = 0; i < N; i++) ds.push(e.run(worker));
    for (const d of ds) d();
    e.stop();
  };
}

// ── Scenario 5: suspend → wake ──────────────────────────────────────
export function makeSuspendWake(mod: EngineModule, N: number) {
  return () => {
    const e = new mod.Engine();
    const wakes: Array<() => void> = [];
    function* worker(): Animator {
      yield* mod.suspend<void>((wake) => {
        wakes.push(wake);
        return () => {};
      });
    }
    for (let i = 0; i < N; i++) e.run(worker);
    e.step(1 / 60);
    for (const w of wakes) w();
    e.step(1 / 60);
    e.stop();
  };
}

// ── Scenario 6: parallel children via array yield ───────────────────
export function makeParallel(mod: EngineModule, N: number, K: number) {
  return () => {
    const e = new mod.Engine();
    function* child(): Animator { yield; }
    function* worker(): Animator {
      const kids: Animator[] = new Array(K);
      for (let i = 0; i < K; i++) kids[i] = child();
      yield kids;
    }
    for (let i = 0; i < N; i++) e.run(worker);
    e.step(1 / 60);
    e.step(1 / 60);
    e.stop();
  };
}

// ── Scenario 7: deep yield* chain ───────────────────────────────────
export function makeDeepYieldStar(mod: EngineModule, N: number, depth: number) {
  return () => {
    const e = new mod.Engine();
    function* leaf(): Animator { yield; }
    function makeChain(d: number): () => Animator {
      let cur: () => Animator = leaf;
      for (let i = 0; i < d; i++) {
        const inner = cur;
        cur = function* (): Animator { yield* inner(); };
      }
      return cur;
    }
    const factory = makeChain(depth);
    for (let i = 0; i < N; i++) e.run(factory);
    e.step(1 / 60);
    e.step(1 / 60);
    e.stop();
  };
}

// ── Scenario 8: realistic spring simulation ─────────────────────────
// N independent spring-like behaviours, integrating an x/v pair over
// 60 frames. This is what minim's `spring()` and `attract()` etc. look
// like.
export function makeSpringSim(mod: EngineModule, N: number, frames: number) {
  const drive = driveOf(mod);
  return () => {
    const e = new mod.Engine();
    const xs = new Float64Array(N);
    const vs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const idx = i;
      e.run(drive((dt) => {
        const x = xs[idx];
        const target = 1.0;
        const k = 170;
        const c = 26;
        const force = (target - x) * k;
        const drag = -c * vs[idx];
        vs[idx] += (force + drag) * dt;
        xs[idx] += vs[idx] * dt;
      }));
    }
    const dt = 1 / 60;
    for (let f = 0; f < frames; f++) e.step(dt);
    e.stop();
  };
}

// ── Scenario 9: tween-pattern (drive that completes after `dur`) ────
export function makeTweenPattern(mod: EngineModule, N: number, frames: number) {
  const drive = driveOf(mod);
  return () => {
    const e = new mod.Engine();
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const dur = 1.0;
      const idx = i;
      e.run(drive((_dt, t) => {
        if (t >= dur) { out[idx] = 1; return false; }
        out[idx] = t / dur;
      }));
    }
    const dt = 1 / 60;
    for (let f = 0; f < frames; f++) e.step(dt);
    e.stop();
  };
}

// ── Scenario 10: long-running parent with sequential children ───────
// A parent that loops, repeatedly spawning a short child via yield*.
// Tests that natural-completion detach actually frees parent.children.
export function makeLoopingChild(mod: EngineModule, N: number, frames: number) {
  return () => {
    const e = new mod.Engine();
    function* leaf(): Animator { yield; }
    function* parent(): Animator {
      while (true) yield* leaf();
    }
    for (let i = 0; i < N; i++) e.run(parent);
    for (let f = 0; f < frames; f++) e.step(1 / 60);
    e.stop();
  };
}

// ── Scenario 11: mixed workload (realistic frame) ───────────────────
// 30% drive, 30% sleep, 20% suspend (one wake mid-test), 20% short-lived
// spawn-and-die.
export function makeMixed(mod: EngineModule, N: number, frames: number) {
  const drive = driveOf(mod);
  return () => {
    const e = new mod.Engine();
    let dummy = 0;
    const Ndrive = (N * 30) / 100 | 0;
    const Nsleep = (N * 30) / 100 | 0;
    const Nsuspend = (N * 20) / 100 | 0;
    const Nshort = N - Ndrive - Nsleep - Nsuspend;

    for (let i = 0; i < Ndrive; i++) {
      e.run(drive((dt) => { dummy += dt; }));
    }
    function* sleeper(): Animator { yield 0.5; }
    for (let i = 0; i < Nsleep; i++) e.run(sleeper);

    const wakes: Array<() => void> = [];
    function* susp(): Animator {
      yield* mod.suspend<void>((w) => {
        wakes.push(w);
        return () => {};
      });
    }
    for (let i = 0; i < Nsuspend; i++) e.run(susp);

    function* shortLived(): Animator { yield; yield; }
    for (let i = 0; i < Nshort; i++) e.run(shortLived);

    const dt = 1 / 60;
    for (let f = 0; f < frames; f++) {
      e.step(dt);
      // Wake one suspend per 10 frames.
      if (f % 10 === 0 && wakes.length > 0) wakes.pop()!();
    }
    e.stop();
    return dummy;
  };
}
