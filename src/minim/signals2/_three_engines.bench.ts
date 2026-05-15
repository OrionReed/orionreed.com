// _three_engines.bench.ts — class-based core3 vs bind-based core vs preact.
//
// Run: node --expose-gc --import tsx src/minim/signals2/_three_engines.bench.ts

import { bench, printRow, measureMemory } from "./_bench_utils";

// Bind-based (current production candidate)
import { signal as s1, computed as c1, effect as e1, batch as b1 } from "./core";

// Class-based (new prototype)
import { signal as s3, computed as c3, effect as e3, batch as b3 } from "./core3";

// Preact-signals (vendored — production prior art)
import { signal as sP, computed as cP, effect as eP, batch as bP } from "../signals/signal";

// Bare alien (the underlying engine — no proto, no methods)
import { signal as aS } from "./engine";

// ─── Construction ──────────────────────────────────────────────────

console.log("\n── Construction ──");
printRow(bench("alien aSig(0)              ", () => aS(0), { iters: 1_000_000 }));
printRow(bench("preact signal(0)           ", () => sP(0), { iters: 2_000_000 }));
printRow(bench("core   (bind) signal(0)    ", () => s1(0), { iters: 1_000_000 }));
printRow(bench("core3  (class) signal(0)   ", () => s3(0), { iters: 5_000_000 }));

console.log("\n── Computed construction ──");
printRow(bench("preact computed(() => 1)   ", () => cP(() => 1), { iters: 1_000_000 }));
printRow(bench("core   computed(() => 1)   ", () => c1(() => 1), { iters: 1_000_000 }));
printRow(bench("core3  computed(() => 1)   ", () => c3(() => 1), { iters: 2_000_000 }));

// ─── Reads ────────────────────────────────────────────────────────

console.log("\n── Read whole signal ──");
{
  const a = aS({ x: 1, y: 2 });
  const sp = sP({ x: 1, y: 2 });
  const s1v = s1({ x: 1, y: 2 });
  const s3v = s3({ x: 1, y: 2 });
  printRow(bench("alien a()                 ", () => a(), { iters: 10_000_000 }));
  printRow(bench("preact sp.value           ", () => sp.value, { iters: 10_000_000 }));
  printRow(bench("core   s1()               ", () => s1v(), { iters: 10_000_000 }));
  printRow(bench("core3  s3.value           ", () => s3v.value, { iters: 10_000_000 }));
}

console.log("\n── Read computed (cached) ──");
{
  const a = aS({ x: 1, y: 2 });
  const sp = sP({ x: 1, y: 2 });
  const s1v = s1({ x: 1, y: 2 });
  const s3v = s3({ x: 1, y: 2 });
  const cpv = cP(() => sp.value.x);
  const c1v = c1(() => s1v().x);
  const c3v = c3(() => s3v.value.x);
  // Warm
  for (let i = 0; i < 200_000; i++) { cpv.value; c1v(); c3v.value; }
  printRow(bench("preact cpv.value          ", () => cpv.value, { iters: 5_000_000 }));
  printRow(bench("core   c1v()              ", () => c1v(), { iters: 5_000_000 }));
  printRow(bench("core3  c3v.value          ", () => c3v.value, { iters: 5_000_000 }));
}

console.log("\n── Write signal ──");
{
  const sp = sP({ x: 0, y: 0 });
  const s1v = s1({ x: 0, y: 0 });
  const s3v = s3({ x: 0, y: 0 });
  let n = 0;
  printRow(bench("preact sp.value = ...     ", () => { sp.value = { x: ++n, y: n }; }, { iters: 5_000_000 }));
  printRow(bench("core   s1({x,y})          ", () => s1v({ x: ++n, y: n }), { iters: 5_000_000 }));
  printRow(bench("core3  s3.value = ...     ", () => { s3v.value = { x: ++n, y: n }; }, { iters: 5_000_000 }));
}

// ─── Effect workload ─────────────────────────────────────────────

console.log("\n── Workload: signal + effect + 60 writes ──");
printRow(bench("preact (signal + 60 writes)", () => {
  const s = sP(0);
  let sum = 0;
  const stop = eP(() => { sum += s.value; });
  for (let i = 0; i < 60; i++) s.value = i;
  stop();
  return sum;
}, { iters: 100_000 }));

printRow(bench("core   (signal + 60 writes)", () => {
  const s = s1(0);
  let sum = 0;
  const stop = e1(() => { sum += s(); });
  for (let i = 0; i < 60; i++) s(i);
  stop();
  return sum;
}, { iters: 100_000 }));

printRow(bench("core3  (signal + 60 writes)", () => {
  const s = s3(0);
  let sum = 0;
  const stop = e3(() => { sum += s.value; });
  for (let i = 0; i < 60; i++) s.value = i;
  stop();
  return sum;
}, { iters: 100_000 }));

// Use batches to bench the batch path
console.log("\n── Workload: batch ──");
printRow(bench("preact batch+writes        ", () => {
  const s = sP(0);
  bP(() => { for (let i = 0; i < 10; i++) s.value = i; });
  return s.value;
}, { iters: 500_000 }));

printRow(bench("core3  batch+writes        ", () => {
  const s = s3(0);
  b3(() => { for (let i = 0; i < 10; i++) s.value = i; });
  return s.value;
}, { iters: 500_000 }));

// ─── Memory ──────────────────────────────────────────────────────

console.log("\n── Memory: 10k cells each ──");
measureMemory("alien aSig(0)             ", () => aS(0));
measureMemory("preact signal(0)          ", () => sP(0));
measureMemory("core   (bind) signal(0)   ", () => s1(0));
measureMemory("core3  (class) signal(0)  ", () => s3(0));
measureMemory("preact signal({x,y})      ", () => sP({ x: 1, y: 2 }));
measureMemory("core3  signal({x,y})      ", () => s3({ x: 1, y: 2 }));
