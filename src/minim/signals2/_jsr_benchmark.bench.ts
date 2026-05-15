// _jsr_benchmark.bench.ts — adapted scenarios from milomg/js-reactivity-benchmark.
//
// Tests OUR signals.ts (class-based + struct) against:
//   - preact-signals (vendored at signals/signal.ts)
//   - alien-signals (bare, the underlying engine)
//   - alien-signals-starter pattern (class-based via alien's createReactiveSystem,
//     replicated inline since not installed)
//
// Scenarios from JS Reactivity Benchmark:
//   1. molBench — wide computed fan-out, hard fib-16 computation
//   2. sBench — 10k signals, simple read/write loop
//   3. dynamicBench — switching dep graph
//
// Run: node --expose-gc --import tsx src/minim/signals2/_jsr_benchmark.bench.ts

import { bench, printRow } from "./_bench_utils";

// ─── OUR signals.ts (class-based) ────────────────────────────────
import { signal as oSig, computed as oComp, effect as oEff, batch as oBatch } from "./signals";

// ─── preact-signals ──────────────────────────────────────────────
import { signal as pSig, computed as pComp, effect as pEff, batch as pBatch } from "../signals/signal";

// ─── bare alien-signals (callable) ───────────────────────────────
import { signal as aSig, computed as aComp, effect as aEff, startBatch, endBatch } from "./engine";
const aBatch = <R>(fn: () => R): R => { startBatch(); try { return fn(); } finally { endBatch(); } };

// fib16 is the "hard work" the benchmark does to ensure computeds aren't optimized away.
function fib(n: number): number {
  if (n < 2) return 1;
  return fib(n - 1) + fib(n - 2);
}
const HARD = (n: number) => n + fib(16);
const nums = Array.from({ length: 5 }, (_, i) => i);

// ──────────────────────────────────────────────────────────────────
// molBench: wide computeds, batched writes, multiple effects
// ──────────────────────────────────────────────────────────────────

function molBenchOurs(): () => void {
  const res: number[] = [];
  const A = oSig(0);
  const B = oSig(0);
  const C = oComp(() => (A.value % 2) + (B.value % 2));
  const D = oComp(() =>
    nums.map((i) => ({ x: i + (A.value % 2) - (B.value % 2) }))
  );
  const E = oComp(() => HARD(C.value + A.value + D.value[0].x));
  const F = oComp(() => HARD(D.value[2].x || B.value));
  const G = oComp(() => C.value + (C.value || E.value % 2) + D.value[4].x + F.value);
  oEff(() => res.push(HARD(G.value)));
  oEff(() => res.push(G.value));
  oEff(() => res.push(HARD(F.value)));
  return (i: number) => {
    res.length = 0;
    oBatch(() => { B.value = 1; A.value = 1 + i * 2; });
    oBatch(() => { A.value = 2 + i * 2; B.value = 2; });
  };
}

function molBenchPreact(): () => void {
  const res: number[] = [];
  const A = pSig(0);
  const B = pSig(0);
  const C = pComp(() => (A.value % 2) + (B.value % 2));
  const D = pComp(() =>
    nums.map((i) => ({ x: i + (A.value % 2) - (B.value % 2) }))
  );
  const E = pComp(() => HARD(C.value + A.value + D.value[0].x));
  const F = pComp(() => HARD(D.value[2].x || B.value));
  const G = pComp(() => C.value + (C.value || E.value % 2) + D.value[4].x + F.value);
  pEff(() => { res.push(HARD(G.value)); });
  pEff(() => { res.push(G.value); });
  pEff(() => { res.push(HARD(F.value)); });
  return (i: number) => {
    res.length = 0;
    pBatch(() => { B.value = 1; A.value = 1 + i * 2; });
    pBatch(() => { A.value = 2 + i * 2; B.value = 2; });
  };
}

function molBenchAlien(): () => void {
  const res: number[] = [];
  const A = aSig(0) as any;
  const B = aSig(0) as any;
  const C = aComp(() => (A() % 2) + (B() % 2));
  const D = aComp(() => nums.map((i) => ({ x: i + (A() % 2) - (B() % 2) })));
  const E = aComp(() => HARD(C() + A() + D()[0].x));
  const F = aComp(() => HARD(D()[2].x || B()));
  const G = aComp(() => C() + (C() || E() % 2) + D()[4].x + F());
  aEff(() => { res.push(HARD(G())); });
  aEff(() => { res.push(G()); });
  aEff(() => { res.push(HARD(F())); });
  return (i: number) => {
    res.length = 0;
    aBatch(() => { B(1); A(1 + i * 2); });
    aBatch(() => { A(2 + i * 2); B(2); });
  };
}

console.log("\n══════ molBench (wide fan-out, hard compute) ══════\n");

{
  const iterOurs = molBenchOurs();
  iterOurs(1);  // warm
  printRow(bench("ours    (class-based, struct framework)", () => {
    for (let i = 0; i < 10; i++) iterOurs(i);
  }, { iters: 1000 }));
}
{
  const iterPreact = molBenchPreact();
  iterPreact(1);
  printRow(bench("preact  (class .value)", () => {
    for (let i = 0; i < 10; i++) iterPreact(i);
  }, { iters: 1000 }));
}
{
  const iterAlien = molBenchAlien();
  iterAlien(1);
  printRow(bench("alien   (callable)", () => {
    for (let i = 0; i < 10; i++) iterAlien(i);
  }, { iters: 1000 }));
}

// ──────────────────────────────────────────────────────────────────
// sBench: 10k signals, deep computed chain, single read drives all
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ sBench (10k signal layer + 10k computed layer) ══════\n");

{
  printRow(bench("ours    sBench", () => {
    const N = 10_000;
    const sources = new Array(N);
    for (let i = 0; i < N; i++) sources[i] = oSig(i);
    const computeds = new Array(N);
    for (let i = 0; i < N; i++) {
      const j = i; // capture
      computeds[i] = oComp(() => sources[j].value * 2);
    }
    let total = 0;
    for (let i = 0; i < N; i++) total += computeds[i].value;
    // Update
    for (let i = 0; i < N; i++) sources[i].value = i + 1;
    for (let i = 0; i < N; i++) total += computeds[i].value;
    return total;
  }, { iters: 20 }));

  printRow(bench("preact  sBench", () => {
    const N = 10_000;
    const sources = new Array(N);
    for (let i = 0; i < N; i++) sources[i] = pSig(i);
    const computeds = new Array(N);
    for (let i = 0; i < N; i++) {
      const j = i;
      computeds[i] = pComp(() => sources[j].value * 2);
    }
    let total = 0;
    for (let i = 0; i < N; i++) total += computeds[i].value;
    for (let i = 0; i < N; i++) sources[i].value = i + 1;
    for (let i = 0; i < N; i++) total += computeds[i].value;
    return total;
  }, { iters: 20 }));

  printRow(bench("alien   sBench", () => {
    const N = 10_000;
    const sources = new Array(N);
    for (let i = 0; i < N; i++) sources[i] = aSig(i);
    const computeds = new Array(N);
    for (let i = 0; i < N; i++) {
      const j = i;
      computeds[i] = aComp(() => (sources[j] as any)() * 2);
    }
    let total = 0;
    for (let i = 0; i < N; i++) total += (computeds[i] as any)();
    for (let i = 0; i < N; i++) (sources[i] as any)(i + 1);
    for (let i = 0; i < N; i++) total += (computeds[i] as any)();
    return total;
  }, { iters: 20 }));
}

// ──────────────────────────────────────────────────────────────────
// Dynamic graph — switching deps
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ Dynamic dep switching ══════\n");

{
  printRow(bench("ours    flip-flop", () => {
    const which = oSig(true);
    const a = oSig(1);
    const b = oSig(10);
    let v = 0;
    const stop = oEff(() => { v = which.value ? a.value : b.value; });
    for (let i = 0; i < 100; i++) {
      a.value = i;
      b.value = i * 2;
      if (i % 5 === 0) which.value = !which.value;
    }
    stop();
    return v;
  }, { iters: 10_000 }));

  printRow(bench("preact  flip-flop", () => {
    const which = pSig(true);
    const a = pSig(1);
    const b = pSig(10);
    let v = 0;
    const stop = pEff(() => { v = which.value ? a.value : b.value; });
    for (let i = 0; i < 100; i++) {
      a.value = i;
      b.value = i * 2;
      if (i % 5 === 0) which.value = !which.value;
    }
    stop();
    return v;
  }, { iters: 10_000 }));

  printRow(bench("alien   flip-flop", () => {
    const which = aSig(true) as any;
    const a = aSig(1) as any;
    const b = aSig(10) as any;
    let v = 0;
    const stop = aEff(() => { v = which() ? a() : b(); });
    for (let i = 0; i < 100; i++) {
      a(i);
      b(i * 2);
      if (i % 5 === 0) which(!which());
    }
    stop();
    return v;
  }, { iters: 10_000 }));
}
