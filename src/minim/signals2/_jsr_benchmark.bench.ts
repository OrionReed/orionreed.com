// _jsr_benchmark.bench.ts — adapted scenarios from milomg/js-reactivity-benchmark.
//
// Tests OUR signals.ts (class-based + struct) against:
//   - preact-signals (vendored at signals/signal.ts)
//   - bare alien-signals (callable)
//
// Scenarios:
//   1. molBench — wide computed fan-out, hard fib-16 computation
//   2. sBench — many signals + computed layer
//   3. dynamicBench — flip-flop dep switching
//
// Uses min-of-N timing (like js-reactivity-benchmark's fastestTest).

import { signal as oSig, computed as oComp, effect as oEff, batch as oBatch } from "./signals";
import { signal as pSig, computed as pComp, effect as pEff, batch as pBatch } from "../signals/signal";
import { signal as aSig, computed as aComp, effect as aEff, startBatch, endBatch } from "./engine";
import { signal as sSig, computed as sComp, effect as sEff, batch as sBatch } from "./_alien_starter";
const aBatch = <R>(fn: () => R): R => { startBatch(); try { return fn(); } finally { endBatch(); } };

function fib(n: number): number {
  if (n < 2) return 1;
  return fib(n - 1) + fib(n - 2);
}
const HARD = (n: number) => n + fib(16);
const nums = Array.from({ length: 5 }, (_, i) => i);

// min-of-N timing — runs `body` `trials` times, returns min ms.
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

function row(name: string, ms: number, ref?: number): void {
  const rel = ref ? `  (${(ref / ms).toFixed(2)}x of ours)` : "";
  console.log(`  ${name.padEnd(40)} ${ms.toFixed(2).padStart(8)} ms${rel}`);
}

// ──────────────────────────────────────────────────────────────────
// molBench
// ──────────────────────────────────────────────────────────────────

function molBenchOurs(): () => void {
  const res: number[] = [];
  const A = oSig(0), B = oSig(0);
  const C = oComp(() => (A.value % 2) + (B.value % 2));
  const D = oComp(() => nums.map(i => ({ x: i + (A.value % 2) - (B.value % 2) })));
  const E = oComp(() => HARD(C.value + A.value + D.value[0].x));
  const F = oComp(() => HARD(D.value[2].x || B.value));
  const G = oComp(() => C.value + (C.value || E.value % 2) + D.value[4].x + F.value);
  oEff(() => { res.push(HARD(G.value)); });
  oEff(() => { res.push(G.value); });
  oEff(() => { res.push(HARD(F.value)); });
  return (i: number) => {
    res.length = 0;
    oBatch(() => { B.value = 1; A.value = 1 + i * 2; });
    oBatch(() => { A.value = 2 + i * 2; B.value = 2; });
  };
}

function molBenchPreact(): () => void {
  const res: number[] = [];
  const A = pSig(0), B = pSig(0);
  const C = pComp(() => (A.value % 2) + (B.value % 2));
  const D = pComp(() => nums.map(i => ({ x: i + (A.value % 2) - (B.value % 2) })));
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
  const A = aSig(0) as any, B = aSig(0) as any;
  const C = aComp(() => (A() % 2) + (B() % 2));
  const D = aComp(() => nums.map(i => ({ x: i + (A() % 2) - (B() % 2) })));
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

function molBenchStarter(): () => void {
  const res: number[] = [];
  const A = sSig(0), B = sSig(0);
  const C = sComp(() => (A.get() % 2) + (B.get() % 2));
  const D = sComp(() => nums.map(i => ({ x: i + (A.get() % 2) - (B.get() % 2) })));
  const E = sComp(() => HARD(C.get() + A.get() + D.get()[0].x));
  const F = sComp(() => HARD(D.get()[2].x || B.get()));
  const G = sComp(() => C.get() + (C.get() || E.get() % 2) + D.get()[4].x + F.get());
  sEff(() => { res.push(HARD(G.get())); });
  sEff(() => { res.push(G.get()); });
  sEff(() => { res.push(HARD(F.get())); });
  return (i: number) => {
    res.length = 0;
    sBatch(() => { B.set(1); A.set(1 + i * 2); });
    sBatch(() => { A.set(2 + i * 2); B.set(2); });
  };
}

console.log("\n══════ molBench (1e4 iter, fan-out + fib16) ══════\n");
{
  const ITERS = 1e4;
  const o = molBenchOurs(); o(1);
  const tO = fastest(5, () => { for (let i = 0; i < ITERS; i++) o(i); });
  row("ours    (class-based + struct)", tO);

  const p = molBenchPreact(); p(1);
  const tP = fastest(5, () => { for (let i = 0; i < ITERS; i++) p(i); });
  row("preact-signals", tP, tO);

  const a = molBenchAlien(); a(1);
  const tA = fastest(5, () => { for (let i = 0; i < ITERS; i++) a(i); });
  row("alien-signals (bare callable)", tA, tO);

  const s = molBenchStarter(); s(1);
  const tS = fastest(5, () => { for (let i = 0; i < ITERS; i++) s(i); });
  row("alien-signals-starter (class .get/.set)", tS, tO);
}

// ──────────────────────────────────────────────────────────────────
// sBench — many signals, many computeds, read all
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ sBench (1e4 signals * 1e4 computeds) ══════\n");
{
  const N = 1e4;

  const tO = fastest(5, () => {
    const sources = new Array(N), computeds = new Array(N);
    for (let i = 0; i < N; i++) sources[i] = oSig(i);
    for (let i = 0; i < N; i++) {
      const j = i;
      computeds[i] = oComp(() => sources[j].value * 2);
    }
    let total = 0;
    for (let i = 0; i < N; i++) total += computeds[i].value;
    for (let i = 0; i < N; i++) sources[i].value = i + 1;
    for (let i = 0; i < N; i++) total += computeds[i].value;
  });
  row("ours", tO);

  const tP = fastest(5, () => {
    const sources = new Array(N), computeds = new Array(N);
    for (let i = 0; i < N; i++) sources[i] = pSig(i);
    for (let i = 0; i < N; i++) {
      const j = i;
      computeds[i] = pComp(() => sources[j].value * 2);
    }
    let total = 0;
    for (let i = 0; i < N; i++) total += computeds[i].value;
    for (let i = 0; i < N; i++) sources[i].value = i + 1;
    for (let i = 0; i < N; i++) total += computeds[i].value;
  });
  row("preact-signals", tP, tO);

  const tA = fastest(5, () => {
    const sources = new Array(N), computeds = new Array(N);
    for (let i = 0; i < N; i++) sources[i] = aSig(i);
    for (let i = 0; i < N; i++) {
      const j = i;
      computeds[i] = aComp(() => (sources[j] as any)() * 2);
    }
    let total = 0;
    for (let i = 0; i < N; i++) total += (computeds[i] as any)();
    for (let i = 0; i < N; i++) (sources[i] as any)(i + 1);
    for (let i = 0; i < N; i++) total += (computeds[i] as any)();
  });
  row("alien-signals", tA, tO);

  const tS = fastest(5, () => {
    const sources = new Array(N), computeds = new Array(N);
    for (let i = 0; i < N; i++) sources[i] = sSig(i);
    for (let i = 0; i < N; i++) {
      const j = i;
      computeds[i] = sComp(() => sources[j].get() * 2);
    }
    let total = 0;
    for (let i = 0; i < N; i++) total += computeds[i].get();
    for (let i = 0; i < N; i++) sources[i].set(i + 1);
    for (let i = 0; i < N; i++) total += computeds[i].get();
  });
  row("alien-signals-starter", tS, tO);
}

// ──────────────────────────────────────────────────────────────────
// dynamicBench — flip-flop deps
// ──────────────────────────────────────────────────────────────────

console.log("\n══════ dynamicBench (1k flip-flop * 1k outer) ══════\n");
{
  const tO = fastest(5, () => {
    for (let outer = 0; outer < 1000; outer++) {
      const which = oSig(true), a = oSig(1), b = oSig(10);
      let v = 0;
      const stop = oEff(() => { v = which.value ? a.value : b.value; });
      for (let i = 0; i < 100; i++) {
        a.value = i;
        b.value = i * 2;
        if (i % 5 === 0) which.value = !which.value;
      }
      stop();
      if (v < 0) throw new Error();
    }
  });
  row("ours", tO);

  const tP = fastest(5, () => {
    for (let outer = 0; outer < 1000; outer++) {
      const which = pSig(true), a = pSig(1), b = pSig(10);
      let v = 0;
      const stop = pEff(() => { v = which.value ? a.value : b.value; });
      for (let i = 0; i < 100; i++) {
        a.value = i;
        b.value = i * 2;
        if (i % 5 === 0) which.value = !which.value;
      }
      stop();
      if (v < 0) throw new Error();
    }
  });
  row("preact-signals", tP, tO);

  const tA = fastest(5, () => {
    for (let outer = 0; outer < 1000; outer++) {
      const which = aSig(true) as any, a = aSig(1) as any, b = aSig(10) as any;
      let v = 0;
      const stop = aEff(() => { v = which() ? a() : b(); });
      for (let i = 0; i < 100; i++) {
        a(i);
        b(i * 2);
        if (i % 5 === 0) which(!which());
      }
      stop();
      if (v < 0) throw new Error();
    }
  });
  row("alien-signals", tA, tO);

  const tS = fastest(5, () => {
    for (let outer = 0; outer < 1000; outer++) {
      const which = sSig(true), a = sSig(1), b = sSig(10);
      let v = 0;
      const e = sEff(() => { v = which.get() ? a.get() : b.get(); });
      for (let i = 0; i < 100; i++) {
        a.set(i);
        b.set(i * 2);
        if (i % 5 === 0) which.set(!which.get());
      }
      e.stop();
      if (v < 0) throw new Error();
    }
  });
  row("alien-signals-starter", tS, tO);
}
