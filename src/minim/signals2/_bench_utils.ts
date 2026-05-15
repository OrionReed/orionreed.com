// _bench_utils.ts — reliable bench primitives, used in lieu of mitata
// for absolute per-op timing.
//
// Lessons learned: mitata's cross-group IC pollution makes its `mean`
// wildly inflated. The `median` is closer but still affected by GC
// pauses. For real perf measurement we need:
//
//   • Long warmup (>500k iters or >500ms) so V8 stabilizes.
//   • Multiple trials taking the minimum (or median of trial-minima).
//     Min is closest to "true cost" — variance is always noise UPward.
//   • Manual gc between trials (kills GC pauses mid-measurement).
//   • Hand-written tight loops (no closure-per-iter overhead).
//   • Optionally: run each bench in a fresh subprocess for full IC
//     isolation. Slow but bulletproof.

const gc = (globalThis as any).gc;
const hasGc = typeof gc === "function";

export interface BenchResult {
  label: string;
  nsPerOp: number;          // minimum trial = best estimate of true cost
  median: number;           // median of trial means
  mean: number;             // mean across all trials
  iters: number;
  trials: number;
}

export interface BenchOpts {
  /** Iterations per trial. Default 1_000_000. */
  iters?: number;
  /** Trials to run. Returns min. Default 5. */
  trials?: number;
  /** Warmup iters before first trial. Default 500_000. */
  warmup?: number;
}

/** Bench a fn. Returns the MINIMUM ns/op across trials — that's the
 *  cleanest signal because variance is always noise upward (GC, IC
 *  pollution, scheduler jitter). The "true cost" is the floor. */
export function bench(label: string, fn: () => any, opts: BenchOpts = {}): BenchResult {
  const iters = opts.iters ?? 1_000_000;
  const trials = opts.trials ?? 5;
  const warmup = opts.warmup ?? 500_000;

  // Warmup
  for (let i = 0; i < warmup; i++) fn();
  if (hasGc) gc();

  const results: number[] = [];
  for (let t = 0; t < trials; t++) {
    if (hasGc) gc();
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn();
    const dt = performance.now() - t0;
    results.push(dt * 1e6 / iters);
  }
  results.sort((a, b) => a - b);
  const nsPerOp = results[0];
  const median = results[Math.floor(results.length / 2)];
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  return { label, nsPerOp, median, mean, iters, trials };
}

/** Print a row in a consistent table format. */
export function printRow(r: BenchResult): void {
  console.log(
    `  ${r.label.padEnd(50)} ${r.nsPerOp.toFixed(2).padStart(8)} ns  (min) ` +
    `[median ${r.median.toFixed(2)}, mean ${r.mean.toFixed(2)}]`,
  );
}

/** Measure heap bytes per allocation. Requires --expose-gc. */
export function measureMemory(label: string, factory: () => any, n = 10_000): void {
  if (!hasGc) { console.log(`  ${label.padEnd(50)}    (run with --expose-gc)`); return; }
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const arr = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = factory();
  gc();
  const after = process.memoryUsage().heapUsed;
  const bytes = (after - before) / n;
  if (arr.length === 0) console.log("never");
  console.log(`  ${label.padEnd(50)} ${bytes.toFixed(0).padStart(5)} B/cell`);
}
