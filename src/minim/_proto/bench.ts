// Honest scaling bench: candidate engine vs production at the 10K/125fps
// target. Two workloads, four depths.
//
// Run: npx tsx src/minim/_proto/bench.ts

import { Anim as Proto, type Animator as ProtoAnim, type Yieldable as ProtoYield } from "./engine";
import { scaled as protoScaled } from "./userland";
import { Anim as Prod } from "../core/anim";
import { withScale as prodScaled } from "../core/combinators";
import type { Animator as ProdAnim } from "../core";

const FRAMES = 125;     // 1s at 125fps target
const FRAME_BUDGET_MS = 8;

function* parkerP(): ProtoAnim { while (true) yield; }
function* parkerR(): ProdAnim { while (true) yield; }

// Spring-like math per frame — closer to real animation workload.
function* tweenP(): ProtoAnim {
  let x = 0, v = 0;
  while (true) {
    const t = yield;
    const f = (1 - x) * 170;
    v += (f - 26 * v) * t.dt;
    x += v * t.dt;
  }
}
function* tweenR(): ProdAnim {
  let x = 0, v = 0;
  while (true) {
    const t = yield;
    const f = (1 - x) * 170;
    v += (f - 26 * v) * t.dt;
    x += v * t.dt;
  }
}

function runProto(make: () => ProtoAnim, N: number, depth: number): number {
  const a = new Proto();
  for (let i = 0; i < N; i++) {
    let target: any = make();
    for (let d = 0; d < depth; d++) target = protoScaled(() => 0.5, target);
    a.start(depth === 0 ? () => target : function* () { yield target as ProtoYield; });
  }
  a.step(0);
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) a.step(1 / 125);
  const t = performance.now() - t0;
  a.stop();
  return t;
}

function runProd(make: () => ProdAnim, N: number, depth: number): number {
  const a = new Prod();
  for (let i = 0; i < N; i++) {
    function makeChain(): ProdAnim {
      let g: ProdAnim = make();
      for (let d = 0; d < depth; d++) {
        const inner = g;
        g = (function* (): ProdAnim { yield* prodScaled(() => 0.5, inner); })();
      }
      return g;
    }
    a.start(makeChain);
  }
  a.step(0);
  const t0 = performance.now();
  for (let f = 0; f < FRAMES; f++) a.step(1 / 125);
  const t = performance.now() - t0;
  a.stop();
  return t;
}

function median(s: number[]): number { return [...s].sort((a, b) => a - b)[Math.floor(s.length / 2)]; }
function sample(fn: () => number, n = 5): number { return median(Array.from({ length: n }, fn)); }

// warmup
for (let i = 0; i < 5; i++) {
  runProto(parkerP, 1000, 1);
  runProd(parkerR, 1000, 1);
}

console.log(`\nTarget: 10K animations at 125fps (8ms frame budget)`);
console.log(`Measuring: total CPU time over ${FRAMES} frames (1s of wall time)`);
console.log(`%budget = ms-elapsed / (${FRAMES} × ${FRAME_BUDGET_MS} ms) — 100% = fully saturated\n`);

for (const { name, mP, mR } of [
  { name: "parker (yield only)", mP: parkerP, mR: parkerR },
  { name: "tween (spring math)", mP: tweenP, mR: tweenR },
]) {
  console.log(`=== ${name} ===`);
  console.log(`N        depth   proto ms   prod ms   proto %   prod %   proto/prod`);
  for (const N of [100, 1000, 10000]) {
    for (const depth of [0, 1, 2]) {
      const p = sample(() => runProto(mP as any, N, depth));
      const r = sample(() => runProd(mR as any, N, depth));
      const pPct = (p / (FRAMES * FRAME_BUDGET_MS)) * 100;
      const rPct = (r / (FRAMES * FRAME_BUDGET_MS)) * 100;
      console.log(
        `${String(N).padStart(5)}      ${depth}    ${p.toFixed(1).padStart(7)}    ${r.toFixed(1).padStart(6)}    ${pPct.toFixed(2).padStart(5)}%   ${rPct.toFixed(2).padStart(5)}%   ${(p / r).toFixed(2)}×`,
      );
    }
  }
  console.log();
}
