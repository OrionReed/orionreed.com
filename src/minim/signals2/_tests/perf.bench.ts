// _perf.bench.ts — perf comparison: PoC engine vs current signals.ts, alien, preact, plain.

import { bench, printRow, measureMemory } from "./bench_utils";

// PoC
import { signal as povSig, computed as povComp, effect as povEff, batch as povBatch, Signal as PovSignal } from "../signal";
import { vec as povVec, Vec as PovVec, num as povNum } from "../values";

// Current signals.ts
import { signal as curSig, computed as curComp, effect as curEff, batch as curBatch } from "../signals";

// alien
import { signal as aSig, computed as aComp, effect as aEff } from "../signal";

// preact
import { signal as pSig, computed as pComp, effect as pEff, batch as pBatch } from "../../signals/signal";

interface V { x: number; y: number }
const vAdd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

const fib = (n: number): number => n < 2 ? 1 : fib(n - 1) + fib(n - 2);
const HARD = (n: number) => n + fib(16);
const nums = Array.from({ length: 5 }, (_, i) => i);

// ════════════════════════════════════════════════════════════════════
// 1. Bare primitives
// ════════════════════════════════════════════════════════════════════

console.log("\n══════ 1. Bare primitive ops ══════\n");
{
  printRow(bench("PoC    signal(0) construct", () => povSig(0), { iters: 1_000_000, warmup: 200_000 }));
  printRow(bench("Cur    signal(0) construct", () => curSig(0), { iters: 1_000_000, warmup: 200_000 }));
  printRow(bench("Alien  signal(0) construct", () => aSig(0), { iters: 1_000_000, warmup: 200_000 }));
  printRow(bench("Preact signal(0) construct", () => pSig(0), { iters: 1_000_000, warmup: 200_000 }));
}
console.log();
{
  const ps = povSig(5), cs = curSig(5), as = aSig(5) as any, prs = pSig(5);
  printRow(bench("PoC    .value read", () => ps.value, { iters: 10_000_000, warmup: 500_000 }));
  printRow(bench("Cur    .value read", () => cs.value, { iters: 10_000_000, warmup: 500_000 }));
  printRow(bench("Alien  callable read", () => as(), { iters: 10_000_000, warmup: 500_000 }));
  printRow(bench("Preact .value read", () => prs.value, { iters: 10_000_000, warmup: 500_000 }));
}
console.log();
{
  const ps = povSig(0), cs = curSig(0), as = aSig(0) as any, prs = pSig(0);
  let i = 0;
  printRow(bench("PoC    .value write", () => { ps.value = ++i; }, { iters: 1_000_000, warmup: 200_000 }));
  printRow(bench("Cur    .value write", () => { cs.value = ++i; }, { iters: 1_000_000, warmup: 200_000 }));
  printRow(bench("Alien  callable write", () => as(++i), { iters: 1_000_000, warmup: 200_000 }));
  printRow(bench("Preact .value write", () => { prs.value = ++i; }, { iters: 1_000_000, warmup: 200_000 }));
}

// ════════════════════════════════════════════════════════════════════
// 2. Vec construct
// ════════════════════════════════════════════════════════════════════

console.log("\n══════ 2. Vec construct ══════\n");
{
  printRow(bench("PoC      new Vec({x,y})", () => new PovVec({ x: 1, y: 2 }), { iters: 1_000_000, warmup: 200_000 }));
  printRow(bench("PoC      vec(x, y) factory", () => povVec(1, 2), { iters: 1_000_000, warmup: 200_000 }));
}

// ════════════════════════════════════════════════════════════════════
// 3. Vec field read/write
// ════════════════════════════════════════════════════════════════════

console.log("\n══════ 3. Vec field ops ══════\n");
{
  const v = povVec(3, 4);
  const x = v.x;
  printRow(bench("PoC v.x.value read (cached)", () => x.value, { iters: 5_000_000, warmup: 500_000 }));
  let i = 0;
  printRow(bench("PoC v.x.value write", () => { x.value = ++i; }, { iters: 1_000_000, warmup: 200_000 }));
}

// ════════════════════════════════════════════════════════════════════
// 4. Reactive method + derive
// ════════════════════════════════════════════════════════════════════

console.log("\n══════ 4. Reactive method vs derive ══════\n");
{
  const v = povVec(1, 2);
  printRow(bench("v.add(b) reactive method", () => v.add({ x: 1, y: 1 }), { iters: 1_000_000, warmup: 200_000 }));
  printRow(bench("v.derive(c => c.add(b))  ", () => v.derive(c => c.add({ x: 1, y: 1 })), { iters: 1_000_000, warmup: 200_000 }));
}
console.log("\n— Chained: a.add(b).scale(2) (single Computed for derive)");
{
  const v = povVec(1, 2);
  // Reactive-method chain needs manual wrapping since .add() returns Computed
  printRow(bench("Chained method: c1=v.add(b); c2=scale", () => {
    const c1 = v.add({ x: 1, y: 1 });
    return povComp(() => vScale(c1.value, 2));
  }, { iters: 500_000, warmup: 100_000 }));
  printRow(bench("Derive chain: v.derive(c => c.add(b).scale(2))", () => {
    return v.derive(c => c.add({ x: 1, y: 1 }).scale(2));
  }, { iters: 1_000_000, warmup: 200_000 }));
}

// ════════════════════════════════════════════════════════════════════
// 5. Real animation: 60-frame tween + subscriber
// ════════════════════════════════════════════════════════════════════

console.log("\n══════ 5. 60-frame Vec tween + subscriber ══════\n");
{
  let log = 0;
  printRow(bench("PoC Vec 60-frame tween", () => {
    const v = povVec(0, 0);
    const stop = povEff(() => { log += v.value.x; });
    for (let i = 0; i < 60; i++) v.value = { x: i, y: i };
    stop();
  }, { iters: 2000, warmup: 200 }));
  printRow(bench("Alien signal<V> 60-frame", () => {
    const v: any = aSig({ x: 0, y: 0 } as V);
    const stop = aEff(() => { log += v().x; });
    for (let i = 0; i < 60; i++) v({ x: i, y: i });
    stop();
  }, { iters: 2000, warmup: 200 }));
  printRow(bench("Preact signal<V> 60-frame", () => {
    const v = pSig<V>({ x: 0, y: 0 });
    const stop = pEff(() => { log += v.value.x; });
    for (let i = 0; i < 60; i++) v.value = { x: i, y: i };
    stop();
  }, { iters: 2000, warmup: 200 }));
  void log;
}

// ════════════════════════════════════════════════════════════════════
// 6. molBench-style fan-out
// ════════════════════════════════════════════════════════════════════

console.log("\n══════ 6. molBench (fan-out + fib16) ══════\n");

function fastest(trials: number, body: () => void): number {
  let best = Infinity;
  for (let i = 0; i < trials; i++) {
    const t0 = performance.now();
    body();
    const ms = performance.now() - t0;
    if (ms < best) best = ms;
  }
  return best;
}

const ITERS = 1e4;

function molBenchPoV(): () => void {
  const res: number[] = [];
  const A = povSig(0), B = povSig(0);
  const C = povComp(() => (A.value % 2) + (B.value % 2));
  const D = povComp(() => nums.map(i => ({ x: i + (A.value % 2) - (B.value % 2) })));
  const E = povComp(() => HARD(C.value + A.value + D.value[0].x));
  const F = povComp(() => HARD(D.value[2].x || B.value));
  const G = povComp(() => C.value + (C.value || E.value % 2) + D.value[4].x + F.value);
  povEff(() => { res.push(HARD(G.value)); });
  povEff(() => { res.push(G.value); });
  povEff(() => { res.push(HARD(F.value)); });
  return (i: number) => {
    res.length = 0;
    povBatch(() => { B.value = 1; A.value = 1 + i * 2; });
    povBatch(() => { A.value = 2 + i * 2; B.value = 2; });
  };
}

function molBenchCur(): () => void {
  const res: number[] = [];
  const A = curSig(0), B = curSig(0);
  const C = curComp(() => (A.value % 2) + (B.value % 2));
  const D = curComp(() => nums.map(i => ({ x: i + (A.value % 2) - (B.value % 2) })));
  const E = curComp(() => HARD(C.value + A.value + D.value[0].x));
  const F = curComp(() => HARD(D.value[2].x || B.value));
  const G = curComp(() => C.value + (C.value || E.value % 2) + D.value[4].x + F.value);
  curEff(() => { res.push(HARD(G.value)); });
  curEff(() => { res.push(G.value); });
  curEff(() => { res.push(HARD(F.value)); });
  return (i: number) => {
    res.length = 0;
    curBatch(() => { B.value = 1; A.value = 1 + i * 2; });
    curBatch(() => { A.value = 2 + i * 2; B.value = 2; });
  };
}

{
  const p = molBenchPoV(); p(1);
  const tP = fastest(5, () => { for (let i = 0; i < ITERS; i++) p(i); });
  console.log(`  PoC  molBench:     ${tP.toFixed(2)} ms`);

  const c = molBenchCur(); c(1);
  const tC = fastest(5, () => { for (let i = 0; i < ITERS; i++) c(i); });
  console.log(`  Cur  molBench:     ${tC.toFixed(2)} ms`);
}

// ════════════════════════════════════════════════════════════════════
// 7. Memory
// ════════════════════════════════════════════════════════════════════

console.log("\n══════ 7. Memory ══════\n");
measureMemory("PoC signal(0)", () => povSig(0));
measureMemory("PoC Vec()", () => povVec(0, 0));
measureMemory("PoC Vec() + .x materialized", () => { const v = povVec(0, 0); void v.x; return v; });
console.log();
measureMemory("Cur signal(0)", () => curSig(0));
measureMemory("Preact signal(0)", () => pSig(0));
measureMemory("Alien signal(0)", () => aSig(0));
