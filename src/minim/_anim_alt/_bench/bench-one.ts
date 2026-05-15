// Run all scenarios against ONE engine in this process. Emits one TSV
// row per scenario with min / p25 / p50 / p75 / iqr%.
//
// Used by `bench-all.ts` which spawns a fresh node process per engine
// to avoid JIT polymorphism, IC degradation, and GC cross-contamination
// between engines.
//
// Usage:
//   node --expose-gc node_modules/.bin/vite-node \
//     src/minim/_anim_alt/_bench/bench-one.ts <engineName>

import "../../_anim_lab/raf-polyfill";
import { bench, run, do_not_optimize } from "mitata";
import { scenarios as makeScenarios } from "./scenarios";

import * as current from "../../core/anim";
import * as v6 from "../../_anim_lab/engine-v6";
import * as v21 from "../../_anim_lab/engine-v21";
import * as v30 from "../../_anim_lab/engine-v30";
import * as v31 from "../../_anim_lab/engine-v31";
import * as mini from "../engine-mini";
import * as simple from "../engine-simple";
import * as final from "../engine-final";

const registry: Record<string, any> = {
  current,
  v6,
  v21,
  v30,
  v31,
  mini,
  simple,
  final,
};

const tag = process.argv[process.argv.length - 1];
const mod = registry[tag];
if (!mod) {
  console.error(`unknown engine: ${tag}; known: ${Object.keys(registry).join(", ")}`);
  process.exit(1);
}

const fakeEngine = { name: tag, build: () => mod };
const sc = makeScenarios();

// Register every scenario. Per-bench warmup is significant: 500 iters
// before mitata's own warmup, then mitata batches ~4096 inner iters per
// outer batch. This stabilises the JIT before the timing samples.
for (const s of sc) {
  const fn = s.for(fakeEngine as any);
  for (let i = 0; i < 500; i++) do_not_optimize(fn());
  if ((globalThis as any).gc) (globalThis as any).gc();
  bench(s.name, () => do_not_optimize(fn()));
}

// Suppress mitata's interactive output; we re-emit clean TSV.
const origLog = console.log;
console.log = () => {};
const summary = (await run({ silent: true } as any)) as any;
console.log = origLog;

const bs: any[] = summary?.benchmarks ?? [];
const stats: Record<string, any> = {};
for (const b of bs) {
  const name = b.alias ?? b.name;
  const r = b.runs?.[0];
  if (!r?.stats) continue;
  stats[name] = r.stats;
}

console.log(`# engine=${tag}`);
console.log(`scenario\tmin_ns\tp25_ns\tp50_ns\tp75_ns\tavg_ns`);
for (const s of sc) {
  const st = stats[s.name];
  const fmt = (v: number | undefined) => (v == null ? "NA" : Math.round(v).toString());
  if (!st) {
    console.log(`${s.name}\tNA\tNA\tNA\tNA\tNA`);
    continue;
  }
  console.log(
    `${s.name}\t${fmt(st.min)}\t${fmt(st.p25)}\t${fmt(st.p50)}\t${fmt(st.p75)}\t${fmt(st.avg)}`,
  );
}
