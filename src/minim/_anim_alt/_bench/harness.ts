// Disciplined bench harness — replaces mitata for cross-engine
// comparison where we need stable, comparable numbers.
//
// Strategy:
//   1. Warmup phase: run each scenario W times to heat the JIT.
//   2. Forced GC between scenarios (requires --expose-gc).
//   3. Measurement phase: collect M samples; compute p25/p50/p75.
//   4. Multiple rounds (R), interleaved across engines to defeat
//      JIT specialisation drift between sequential benches.
//   5. Output is sorted by p50 with relative speedup column.

import "../../_anim_lab/raf-polyfill";

export interface BenchResult {
  scenario: string;
  engine: string;
  samples: number[]; // seconds per iter
}

export interface Stat {
  scenario: string;
  engine: string;
  n: number;
  p25: number;
  p50: number;
  p75: number;
  iqr: number; // p75-p25 / p50  → variance %
}

export interface Engine {
  name: string;
  build: () => unknown;
}

export interface Scenario {
  name: string;
  /** Build a closure for this engine. The returned fn is the workload. */
  for: (engine: Engine) => () => unknown;
}

const W_WARMUP = 25;
const M_MEASURE = 60;
const R_ROUNDS = 3;

function gc() {
  const g = globalThis as any;
  if (typeof g.gc === "function") g.gc();
}

/** Run one closure once and return wall-time in seconds. */
function timeOnce(fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  return (t1 - t0) / 1000;
}

/** Warmup for `n` iterations, discarding timings. */
function warmup(fn: () => unknown, n: number): void {
  for (let i = 0; i < n; i++) fn();
}

/** One round: for each (engine, scenario) pair, warm + measure M times. */
function round(engines: Engine[], scenarios: Scenario[]): BenchResult[] {
  const out: BenchResult[] = [];
  for (const sc of scenarios) {
    for (const e of engines) {
      const fn = sc.for(e);
      gc();
      warmup(fn, W_WARMUP);
      gc();
      const samples: number[] = new Array(M_MEASURE);
      for (let i = 0; i < M_MEASURE; i++) samples[i] = timeOnce(fn);
      out.push({ scenario: sc.name, engine: e.name, samples });
    }
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function aggregate(results: BenchResult[]): Stat[] {
  // Group by (scenario, engine), pool samples across rounds.
  const map = new Map<string, number[]>();
  for (const r of results) {
    const k = `${r.scenario}|||${r.engine}`;
    const arr = map.get(k) ?? [];
    for (const s of r.samples) arr.push(s);
    map.set(k, arr);
  }
  const stats: Stat[] = [];
  for (const [k, arr] of map) {
    const [scenario, engine] = k.split("|||");
    arr.sort((a, b) => a - b);
    const p25 = percentile(arr, 0.25);
    const p50 = percentile(arr, 0.50);
    const p75 = percentile(arr, 0.75);
    const iqr = (p75 - p25) / p50;
    stats.push({ scenario, engine, n: arr.length, p25, p50, p75, iqr });
  }
  return stats;
}

function fmt(s: number): string {
  if (s < 1e-6) return `${(s * 1e9).toFixed(0)} ns`;
  if (s < 1e-3) return `${(s * 1e6).toFixed(2)} µs`;
  if (s < 1) return `${(s * 1e3).toFixed(2)} ms`;
  return `${s.toFixed(3)} s`;
}

function printTable(stats: Stat[]): void {
  // Group by scenario; within each group, sort by p50 ascending.
  const byScenario = new Map<string, Stat[]>();
  for (const s of stats) {
    const arr = byScenario.get(s.scenario) ?? [];
    arr.push(s);
    byScenario.set(s.scenario, arr);
  }
  for (const [sc, list] of byScenario) {
    list.sort((a, b) => a.p50 - b.p50);
    const fastest = list[0].p50;
    console.log(`\n• ${sc}`);
    console.log("  engine    p50          p25-p75                iqr%   vs best");
    console.log("  --------  -----------  --------------------   -----  -------");
    for (const s of list) {
      const tag = s.engine.padEnd(8);
      const p50 = fmt(s.p50).padStart(11);
      const range = `${fmt(s.p25)} – ${fmt(s.p75)}`.padEnd(20);
      const iqrPct = `${(s.iqr * 100).toFixed(1)}%`.padStart(5);
      const rel = (s.p50 / fastest).toFixed(2) + "×";
      console.log(`  ${tag}  ${p50}  ${range}   ${iqrPct}  ${rel}`);
    }
  }
}

export function benchAll(engines: Engine[], scenarios: Scenario[]): void {
  console.log(`\nDisciplined bench: ${engines.length} engines × ${scenarios.length} scenarios`);
  console.log(`  warmup=${W_WARMUP}/scenario  measure=${M_MEASURE}/round  rounds=${R_ROUNDS}`);
  console.log(`  total samples per cell: ${M_MEASURE * R_ROUNDS}`);
  console.log(`  GC available: ${typeof (globalThis as any).gc === "function"}`);

  const allResults: BenchResult[] = [];
  for (let r = 0; r < R_ROUNDS; r++) {
    process.stdout.write(`\nround ${r + 1}/${R_ROUNDS} `);
    const t0 = performance.now();
    allResults.push(...round(engines, scenarios));
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`(${elapsed}s)`);
  }
  console.log();
  printTable(aggregate(allResults));
}
