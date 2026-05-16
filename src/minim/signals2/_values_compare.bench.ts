// _values_compare.bench.ts — animation-workload comparison between the
// legacy callable `values.ts` and the new class-based `values_new.ts`.
//
// Workloads chosen to match real usage patterns in this codebase:
//   1. Vec create — bulk construction (e.g. when shapes are instantiated)
//   2. Vec read/write — 60 fps tight loops (drag handler, spring step)
//   3. Tween 60 frames — Transform animation with subscriber
//   4. Composite read — tr.translate.x in hot loop (renders)
//   5. mean of N — generic op over heterogenous cell types
//   6. Memory — 1k Vec / 1k Transform footprint

import { bench, printRow, measureMemory } from "./_bench_utils";

// Legacy
import { Vec as VOLD, Transform as TOLD, vec as vecOld } from "./values";

// New
import { Vec as VNEW, Transform as TNEW, vec as vecNew, mean as meanNew } from "./values_new";
import { effect as effectNew } from "./signals";

// Legacy effect
import { effect as effectOld } from "./engine";

// ──────────────────────────────────────────────────────────────────
// 1. Vec construction
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ 1. Vec construction (single) ══════\n");
printRow(bench("old  vec(x, y) callable", () => vecOld(1, 2), { iters: 1_000_000, warmup: 200_000 }));
printRow(bench("new  vec(x, y) class    ", () => vecNew(1, 2), { iters: 1_000_000, warmup: 200_000 }));

// ──────────────────────────────────────────────────────────────────
// 2. Read/write hot loop (60fps drag handler pattern)
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ 2. Single field read+write (per op) ══════\n");
{
  const vOld = vecOld(0, 0);
  printRow(bench("old  v.x() read then v.x(n) write", () => {
    const cur = (vOld as any).x();
    (vOld as any).x(cur + 1);
  }, { iters: 1_000_000, warmup: 200_000 }));
}
{
  const vNew = vecNew(0, 0);
  printRow(bench("new  v.x.value read+write", () => {
    const cur = (vNew as any).x.value;
    (vNew as any).x.value = cur + 1;
  }, { iters: 1_000_000, warmup: 200_000 }));
}

// ──────────────────────────────────────────────────────────────────
// 3. Tween 60 frames — Transform with subscriber
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ 3. Tween: 60 frame Transform animation w/ effect ══════\n");
{
  let log = 0;
  printRow(bench("old  Transform 60-frame tween", () => {
    const tr: any = TOLD();
    const stop = effectOld(() => { log += tr().opacity; });
    for (let i = 0; i < 60; i++) {
      const t = i / 59;
      tr({
        translate: { x: t * 100, y: 0 },
        scale: { x: 1, y: 1 },
        origin: { x: 0, y: 0 },
        rotate: t * Math.PI,
        opacity: t,
      });
    }
    stop();
  }, { iters: 1000, warmup: 100 }));

  printRow(bench("new  Transform 60-frame tween", () => {
    const tr: any = TNEW();
    const stop = effectNew(() => { log += tr.value.opacity; });
    for (let i = 0; i < 60; i++) {
      const t = i / 59;
      tr.value = {
        translate: { x: t * 100, y: 0 },
        scale: { x: 1, y: 1 },
        origin: { x: 0, y: 0 },
        rotate: t * Math.PI,
        opacity: t,
      };
    }
    stop();
  }, { iters: 1000, warmup: 100 }));
  void log;
}

// ──────────────────────────────────────────────────────────────────
// 4. Composite field read — tr.translate.x in hot loop
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ 4. Composite field read: tr.translate.x (steady) ══════\n");
{
  const trOld: any = TOLD();
  void trOld.translate.x;
  printRow(bench("old  tr.translate.x()", () => trOld.translate.x(), { iters: 2_000_000, warmup: 200_000 }));
}
{
  const trNew: any = TNEW();
  void trNew.translate.x;
  printRow(bench("new  tr.translate.x.value", () => trNew.translate.x.value, { iters: 2_000_000, warmup: 200_000 }));
}

// ──────────────────────────────────────────────────────────────────
// 5. mean of 5 Vecs
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ 5. mean(...5 Vecs): reactive avg ══════\n");
{
  const cs: any[] = [];
  for (let i = 0; i < 5; i++) cs.push(vecOld(i, i));
  // Legacy mean isn't exported from values; skip (it's in generics.ts)
  void cs;
}
{
  const cs: any[] = [];
  for (let i = 0; i < 5; i++) cs.push(vecNew(i, i));
  const m = meanNew(...cs);
  printRow(bench("new  mean(5 Vecs) read", () => m.value.x, { iters: 2_000_000, warmup: 200_000 }));
  printRow(bench("new  mean recompute after write", () => {
    cs[0].value = { x: cs[0].peek().x + 1, y: cs[0].peek().y };
    return m.value;
  }, { iters: 200_000, warmup: 50_000 }));
}

// ──────────────────────────────────────────────────────────────────
// 6. Memory
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ 6. Memory ══════\n");
measureMemory("old  Vec()", () => vecOld(0, 0));
measureMemory("new  Vec()", () => vecNew(0, 0));
measureMemory("old  Transform()", () => TOLD());
measureMemory("new  Transform()", () => TNEW());
