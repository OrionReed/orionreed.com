// Bench runner — minimal, transparent, comparison-focused.
//
// Why not mitata: across the noisy ad-hoc runs we did earlier, mitata
// gave 12× variance for the same op between runs (IC pollution + opaque
// JIT-tier behavior). This runner trades absolute timing realism for
// repeatability:
//
//   1. Each bench is isolated in its own "phase" with re-warmup.
//   2. Each phase is run K times; we report median + MAD + min/max.
//   3. Comparison is always paired: same N iterations, same input,
//      adjacent in execution time → drift cancels.
//   4. Significance gate: a delta is only flagged when |Δmedian| exceeds
//      sum of MADs (a cheap robust analog of a 2-sigma test).
//
// This is not a substitute for proper benchmarking. It IS a sanity
// gate for "did r2 regress against minim?" — which is what the user
// asked for.

export interface Bench {
  name: string;
  /** Iterations per measurement. Tune so each measurement takes 1–10 ms. */
  iters: number;
  /** Optional one-time setup. Recreated per phase. */
  setup?: () => unknown;
  /** Inner loop body. Return value is fed to `do_not_optimize`. */
  run: (state: unknown) => unknown;
}

export interface Sample {
  /** ns per single iteration. */
  perIter: number;
}

export interface BenchResult {
  name: string;
  median: number; // ns/iter
  mad: number;    // median absolute deviation, ns/iter
  min: number;
  max: number;
  cv: number;     // mad / median, as a fraction
  samples: number[];
}

const sink: unknown[] = [];
export function do_not_optimize(v: unknown): void {
  if (sink.length < 8) sink.push(v); else sink[0] = v;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mad = (xs: number[], m: number): number =>
  median(xs.map((x) => Math.abs(x - m)));

/** Run one bench: re-create state per phase, K phases, J iters each phase. */
export function runBench(b: Bench, opts?: { phases?: number; warmupPhases?: number }): BenchResult {
  const phases = opts?.phases ?? 15;
  const warmup = opts?.warmupPhases ?? 5;
  const samples: number[] = [];

  for (let p = 0; p < warmup + phases; p++) {
    const state = b.setup ? b.setup() : undefined;
    // Warm the call site once before timing
    for (let i = 0; i < 1000; i++) do_not_optimize(b.run(state));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < b.iters; i++) do_not_optimize(b.run(state));
    const t1 = process.hrtime.bigint();
    if (p >= warmup) samples.push(Number(t1 - t0) / b.iters);
  }

  const m = median(samples);
  const d = mad(samples, m);
  return {
    name: b.name,
    median: m,
    mad: d,
    min: Math.min(...samples),
    max: Math.max(...samples),
    cv: d / m,
    samples,
  };
}

// ─── Comparison ─────────────────────────────────────────────────────

export interface ComparisonResult {
  name: string;
  a: BenchResult;
  b: BenchResult;
  /** Relative delta: (b - a) / a, signed; negative = b is faster. */
  delta: number;
  /** True iff |median_b − median_a| > (mad_a + mad_b). */
  significant: boolean;
}

export function compare(name: string, a: BenchResult, b: BenchResult): ComparisonResult {
  const diff = b.median - a.median;
  const noise = a.mad + b.mad;
  return {
    name,
    a, b,
    delta: diff / a.median,
    significant: Math.abs(diff) > noise,
  };
}

// ─── Formatters ─────────────────────────────────────────────────────

const fmtNs = (ns: number): string => {
  if (ns < 1000) return `${ns.toFixed(1)} ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} µs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
};
const fmtPct = (x: number): string =>
  `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

export function printComparison(rows: ComparisonResult[], labels: [string, string]): void {
  const [la, lb] = labels;
  const widths = {
    name: Math.max(20, ...rows.map((r) => r.name.length)),
    a: 14, b: 14, delta: 10, sig: 4,
  };
  const pad = (s: string, n: number): string => s.length >= n ? s : s + " ".repeat(n - s.length);
  const padR = (s: string, n: number): string => s.length >= n ? s : " ".repeat(n - s.length) + s;
  console.log("");
  console.log(
    pad("bench", widths.name) + "  " +
    padR(la, widths.a) + "  " +
    padR(lb, widths.b) + "  " +
    padR("Δ", widths.delta) + "  " +
    padR("sig", widths.sig),
  );
  console.log("─".repeat(widths.name + widths.a + widths.b + widths.delta + widths.sig + 8));
  for (const r of rows) {
    const sigMark = r.significant ? (r.delta > 0 ? " ↑ " : " ↓ ") : "   ";
    console.log(
      pad(r.name, widths.name) + "  " +
      padR(`${fmtNs(r.a.median)} ±${(r.a.cv * 100).toFixed(0)}%`, widths.a) + "  " +
      padR(`${fmtNs(r.b.median)} ±${(r.b.cv * 100).toFixed(0)}%`, widths.b) + "  " +
      padR(fmtPct(r.delta), widths.delta) + "  " +
      padR(sigMark, widths.sig),
    );
  }
  console.log("");
  console.log("  ± shows MAD as % of median (robust analog of CV).");
  console.log("  sig: ↑ regression / ↓ improvement (|Δmedian| > sum of MADs).");
  console.log("");
}
