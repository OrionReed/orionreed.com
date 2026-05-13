// Tiny benchmark harness for `signals/struct`. Auto-tunes iteration
// counts to a target time budget per bench, prints per-section tables
// with relative speed against the section's baseline (the first
// declared bench).
//
// API:
//   suite("name", () => {
//     bench("baseline", fn);
//     bench("variant", fn);
//     memory("baseline", (i) => alloc(i));
//   });
//   runAll();
//
// Run with `node --expose-gc node_modules/.bin/vite-node
// src/minim/_bench/index.ts`. Without `--expose-gc`, memory benches
// still run but report rougher numbers.

interface BenchOpts {
  iters?: number;
  warmup?: number;
  targetMs?: number;
}

interface BenchResult {
  kind: "time";
  name: string;
  iters: number;
  nsPerOp: number;
  opsPerSec: number;
}

interface MemoryResult {
  kind: "mem";
  name: string;
  count: number;
  bytesPerInst: number;
}

type Row = BenchResult | MemoryResult;

interface Section {
  name: string;
  rows: Row[];
  notes: string[];
}

let currentSection: Section | null = null;
const sections: Section[] = [];

// Sink prevents JIT from eliminating the bench body. Each iter's
// return value is XOR-folded so the side-channel touches every result.
let sink: number = 0;
const consume = (v: unknown) => {
  if (typeof v === "number") sink ^= v | 0;
  else if (v != null) sink ^= 1;
};
export const sinkVal = () => sink;

export function suite(name: string, fn: () => void): void {
  if (currentSection) throw new Error("nested suite()");
  currentSection = { name, rows: [], notes: [] };
  sections.push(currentSection);
  fn();
  currentSection = null;
}

export function note(line: string): void {
  if (!currentSection) throw new Error("note() outside suite()");
  currentSection.notes.push(line);
}

export function bench(
  name: string,
  fn: () => unknown,
  opts: BenchOpts = {},
): void {
  if (!currentSection) throw new Error("bench() outside suite()");
  currentSection.rows.push(runBench(name, fn, opts));
}

function runBench(name: string, fn: () => unknown, opts: BenchOpts): BenchResult {
  const targetMs = opts.targetMs ?? 250;
  const warmup = opts.warmup ?? 1000;

  for (let i = 0; i < warmup; i++) consume(fn());

  let iters = opts.iters;
  if (iters == null) {
    const probeStart = process.hrtime.bigint();
    const probeIters = 1000;
    for (let i = 0; i < probeIters; i++) consume(fn());
    const probeNs = Number(process.hrtime.bigint() - probeStart);
    const probeNsPerOp = probeNs / probeIters;
    iters = Math.max(
      1000,
      Math.min(50_000_000, Math.round((targetMs * 1e6) / Math.max(probeNsPerOp, 1))),
    );
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) consume(fn());
  const totalNs = Number(process.hrtime.bigint() - start);

  const nsPerOp = totalNs / iters;
  const opsPerSec = 1e9 / nsPerOp;
  return { kind: "time", name, iters, nsPerOp, opsPerSec };
}

/** Allocate `count` instances and report bytes/instance via heap-delta.
 *  Reliable only with `node --expose-gc`. The harness keeps the
 *  allocations alive (assigns to a global sink) so they're not freed
 *  before the post-measurement. */
export function memory(
  name: string,
  alloc: (i: number) => unknown,
  count = 100_000,
): void {
  if (!currentSection) throw new Error("memory() outside suite()");
  // @ts-ignore
  const gc = (typeof global !== "undefined" && (global as any).gc) as (() => void) | undefined;
  if (gc) gc();
  const before = process.memoryUsage().heapUsed;

  const arr: unknown[] = new Array(count);
  for (let i = 0; i < count; i++) arr[i] = alloc(i);

  if (gc) gc();
  const after = process.memoryUsage().heapUsed;
  const totalBytes = after - before;
  const bytesPerInst = totalBytes / count;

  // Keep alive past measurement.
  // @ts-ignore
  const sinkArr = ((global as any).__benchMemSink ??= [] as unknown[]);
  sinkArr.push(arr);

  currentSection.rows.push({ kind: "mem", name, count, bytesPerInst });
}

export function runAll(): void {
  console.log("\n=== minim/struct benchmarks ===");
  console.log(`node ${process.version}, sink=${sinkVal()}`);
  // @ts-ignore
  if (!(typeof global !== "undefined" && (global as any).gc)) {
    console.log("(memory benches: --expose-gc not enabled; numbers approximate)");
  }
  for (const sec of sections) printSection(sec);
  console.log("");
}

function printSection(sec: Section): void {
  console.log(`\n── ${sec.name} ${"─".repeat(Math.max(0, 64 - sec.name.length))}`);

  const timeRows = sec.rows.filter((r): r is BenchResult => r.kind === "time");
  const memRows = sec.rows.filter((r): r is MemoryResult => r.kind === "mem");

  if (timeRows.length > 0) {
    const baseline = timeRows[0];
    const namePad = Math.max(...timeRows.map((r) => r.name.length), "name".length) + 2;
    console.log(
      "  " +
        "name".padEnd(namePad) +
        "ns/op".padStart(11) +
        "ops/sec".padStart(13) +
        "rel".padStart(8) +
        "iters".padStart(13),
    );
    for (const r of timeRows) {
      const rel = baseline.nsPerOp / r.nsPerOp;
      console.log(
        "  " +
          r.name.padEnd(namePad) +
          formatNs(r.nsPerOp).padStart(11) +
          formatOps(r.opsPerSec).padStart(13) +
          rel.toFixed(2).padStart(7) +
          "x" +
          r.iters.toLocaleString().padStart(13),
      );
    }
  }

  if (memRows.length > 0) {
    if (timeRows.length > 0) console.log("");
    const baseline = memRows[0];
    const namePad = Math.max(...memRows.map((r) => r.name.length), "name".length) + 2;
    console.log(
      "  " +
        "[memory] name".padEnd(namePad + 2) +
        "B/inst".padStart(10) +
        "rel".padStart(8) +
        "count".padStart(13),
    );
    for (const r of memRows) {
      const rel = r.bytesPerInst / baseline.bytesPerInst;
      console.log(
        "  " +
          ("  " + r.name).padEnd(namePad + 2) +
          r.bytesPerInst.toFixed(1).padStart(10) +
          rel.toFixed(2).padStart(7) +
          "x" +
          r.count.toLocaleString().padStart(13),
      );
    }
  }

  for (const line of sec.notes) console.log(line);
}

function formatNs(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "ms";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "µs";
  if (n >= 1) return n.toFixed(2) + "ns";
  return n.toFixed(3) + "ns";
}

function formatOps(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "G/s";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M/s";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K/s";
  return n.toFixed(0) + "/s";
}
