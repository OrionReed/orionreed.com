// Real-world perf: measure runtime cost in absolute units (ns / µs)
// at realistic scales. Goal: answer "how much does the runtime cost
// in a real animation frame, vs SVG/DOM work or signal computation?"
//
// Reference points:
//   60fps frame budget         16.67 ms
//   Typical layout / paint     1-5  ms  (dominant)
//   SVG transform update       1-50 µs per element
//   Signal recompute / push    0.1-5 µs per node
//
// Scales we test:
//   N=10    typical UI animation count (1 modal + a few buttons + spinner)
//   N=100   busy app (carousel, chart with animations, transitions)
//   N=1000  particle sim / instanced animation (rare upper bound)
//
// We run 60 frames so totals divide cleanly into "ns per active per frame".

import "../_test/setup";
import { bench, group, run, do_not_optimize } from "mitata";

import * as V4 from "../core/_anim_proto/v4_protocol";
import * as V8 from "./v8";
import * as V9 from "./v9_lean";
import * as V10 from "./v10_min";
import * as V11 from "./v11_ticker";
import * as V12 from "./v12_unified";

const variants = {
  v4:  { Anim: V4.Anim,  drive: V4.drive,  start: (a: any, g: any) => a.run(g) },
  v8:  { Anim: V8.Anim,  drive: V8.drive,  start: (a: any, g: any) => a.run(g) },
  v11: { Anim: V11.Anim, drive: V11.drive, start: (a: any, g: any) => a.start(g) },
  v12: { Anim: V12.Anim, drive: V12.drive, start: (a: any, g: any) => a.start(g) },
  v9:  { Anim: V9.Anim,  drive: V9.drive,  start: (a: any, g: any) => a.start(g) },
  v10: { Anim: V10.Anim, drive: V10.drive, start: (a: any, g: any) => a.start(g) },
} as const;

function makeRawYield(M: any, N: number, F: number) {
  return () => {
    const a = new M.Anim();
    let acc = 0;
    function* w(): any { while (true) { const dt = yield; acc += dt; } }
    for (let i = 0; i < N; i++) M.start(a, w);
    for (let f = 0; f < F; f++) a.step(1 / 60);
    a.stop();
    return acc;
  };
}

function makeSpring(M: any, N: number, F: number) {
  return () => {
    const a = new M.Anim();
    const xs = new Float64Array(N), vs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const idx = i;
      M.start(a, function* () {
        yield* M.drive((dt: number) => {
          const f = (1 - xs[idx]) * 170, dr = -26 * vs[idx];
          vs[idx] += (f + dr) * dt; xs[idx] += vs[idx] * dt;
        });
      });
    }
    for (let f = 0; f < F; f++) a.step(1 / 60);
    a.stop();
    return xs[0];
  };
}

function makeSpawnComplete(M: any, N: number) {
  return () => {
    const a = new M.Anim();
    function* w(): any {}
    for (let i = 0; i < N; i++) M.start(a, w);
    a.step(0); a.stop();
  };
}

/** N actives all sleeping for >> simulation duration. Tests engine-sleep
 *  fast path: zero gen.next per frame is the goal. */
function makeIdleSleepers(M: any, N: number, F: number) {
  return () => {
    const a = new M.Anim();
    function* w(): any { yield 1000; }  // sleep way past the test
    for (let i = 0; i < N; i++) M.start(a, w);
    for (let f = 0; f < F; f++) a.step(1 / 60);
    a.stop();
  };
}

function makeSpawnCancel(M: any, N: number) {
  return () => {
    const a = new M.Anim();
    function* w(): any { yield; }
    const ds: any[] = [];
    for (let i = 0; i < N; i++) ds.push(M.start(a, w));
    for (const d of ds) d();
    a.stop();
  };
}

function reg(name: string, fn: () => unknown): void {
  for (let i = 0; i < 200; i++) do_not_optimize(fn());
  bench(name, () => do_not_optimize(fn()));
}

// ─── realistic UI scale ────────────────────────────────────────────────
group("N=10 actives × 60 frames (UI-typical)", () => {
  for (const [name, M] of Object.entries(variants)) {
    reg(`${name}:raw-yield`, makeRawYield(M, 10, 60));
    reg(`${name}:spring   `, makeSpring(M, 10, 60));
  }
});

// ─── busy app ─────────────────────────────────────────────────────────
group("N=100 actives × 60 frames (busy app)", () => {
  for (const [name, M] of Object.entries(variants)) {
    reg(`${name}:raw-yield`, makeRawYield(M, 100, 60));
    reg(`${name}:spring   `, makeSpring(M, 100, 60));
  }
});

// ─── particle sim ─────────────────────────────────────────────────────
group("N=1000 actives × 60 frames (particle sim)", () => {
  for (const [name, M] of Object.entries(variants)) {
    reg(`${name}:raw-yield`, makeRawYield(M, 1000, 60));
    reg(`${name}:spring   `, makeSpring(M, 1000, 60));
  }
});

// ─── idle sleepers (engine-sleep zero-work test) ──────────────────────
group("N=1000 idle sleepers × 60 frames", () => {
  for (const [name, M] of Object.entries(variants)) {
    if (name === "v10") continue; // v10 has no engine sleep
    reg(`${name}:idle-sleep`, makeIdleSleepers(M, 1000, 60));
  }
});

// ─── spawn / cancel rates ─────────────────────────────────────────────
group("spawn+complete (one-shot N actives)", () => {
  for (const [name, M] of Object.entries(variants)) {
    reg(`${name}:N=10  `, makeSpawnComplete(M, 10));
    reg(`${name}:N=100 `, makeSpawnComplete(M, 100));
    reg(`${name}:N=1000`, makeSpawnComplete(M, 1000));
  }
});

group("spawn+cancel (allocate then cancel)", () => {
  for (const [name, M] of Object.entries(variants)) {
    reg(`${name}:N=10  `, makeSpawnCancel(M, 10));
    reg(`${name}:N=100 `, makeSpawnCancel(M, 100));
    reg(`${name}:N=1000`, makeSpawnCancel(M, 1000));
  }
});

await run({ format: "mitata" });
