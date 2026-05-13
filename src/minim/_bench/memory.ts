// Per-instance memory measurement via heap-delta.
//
// mitata measures per-iteration heap delta during its bench loop, but
// for a "how much does ONE Vec actually cost?" question we want a
// fixed-population study: allocate N instances, GC, take delta,
// divide. That's what this helper does. Run with `node --expose-gc`
// for stable numbers; without it, the measurement is rougher.

export interface MemoryRow {
  name: string;
  count: number;
  bytesPerInstance: number;
}

const rows: MemoryRow[] = [];

export function memory(
  name: string,
  alloc: (i: number) => unknown,
  count = 100_000,
): void {
  // @ts-ignore
  const gc = (typeof global !== "undefined" && (global as any).gc) as (() => void) | undefined;
  if (gc) gc();
  const before = process.memoryUsage().heapUsed;

  const arr: unknown[] = new Array(count);
  for (let i = 0; i < count; i++) arr[i] = alloc(i);

  if (gc) gc();
  const after = process.memoryUsage().heapUsed;
  const bytesPerInstance = (after - before) / count;

  // Keep alive past measurement — otherwise V8 may eagerly free
  // during/after the post-GC and the delta drops to ~0.
  // @ts-ignore
  const sinkArr = ((global as any).__benchMemSink ??= [] as unknown[]);
  sinkArr.push(arr);

  rows.push({ name, count, bytesPerInstance });
}

export function printMemoryRows(): void {
  if (rows.length === 0) return;
  console.log("\n── memory per instance (heap-delta, --expose-gc recommended) ───────");
  const baseline = rows[0];
  const namePad = Math.max(...rows.map((r) => r.name.length), "name".length) + 2;
  console.log(
    "  " +
      "name".padEnd(namePad) +
      "B/inst".padStart(10) +
      "rel".padStart(8) +
      "count".padStart(13),
  );
  for (const r of rows) {
    const rel = r.bytesPerInstance / baseline.bytesPerInstance;
    console.log(
      "  " +
        r.name.padEnd(namePad) +
        r.bytesPerInstance.toFixed(1).padStart(10) +
        rel.toFixed(2).padStart(7) +
        "x" +
        r.count.toLocaleString().padStart(13),
    );
  }
  // @ts-ignore
  if (!(typeof global !== "undefined" && (global as any).gc)) {
    console.log("  (no --expose-gc: numbers are approximate)");
  }
}
