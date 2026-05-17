// _jsr_benchmark.bench.ts — JS Reactivity Benchmark scenarios for PoC.
// Compare PoC engine vs preact-signals vs bare alien-signals.

import { signal as povSig, computed as povComp, effect as povEff, batch as povBatch } from "../signal";
import { signal as pSig, computed as pComp, effect as pEff, batch as pBatch } from "../../signals/signal";
import { signal as aSig, computed as aComp, effect as aEff, startBatch as bsA, endBatch as beA } from "alien-signals";
const aBatch = <R>(fn: () => R): R => { bsA(); try { return fn(); } finally { beA(); } };

function fib(n: number): number { if (n < 2) return 1; return fib(n - 1) + fib(n - 2); }
const HARD = (n: number) => n + fib(16);
const nums = Array.from({ length: 5 }, (_, i) => i);

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
  console.log(`  ${name.padEnd(42)} ${ms.toFixed(2).padStart(8)} ms${rel}`);
}

// ─── molBench
function molPoV(): () => void {
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
  return (i) => {
    res.length = 0;
    povBatch(() => { B.value = 1; A.value = 1 + i * 2; });
    povBatch(() => { A.value = 2 + i * 2; B.value = 2; });
  };
}
function molPreact(): () => void {
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
  return (i) => {
    res.length = 0;
    pBatch(() => { B.value = 1; A.value = 1 + i * 2; });
    pBatch(() => { A.value = 2 + i * 2; B.value = 2; });
  };
}
function molAlien(): () => void {
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
  return (i) => {
    res.length = 0;
    aBatch(() => { B(1); A(1 + i * 2); });
    aBatch(() => { A(2 + i * 2); B(2); });
  };
}

console.log("\n══ molBench (1e4 iter) ══");
{
  const ITERS = 1e4;
  const p = molPoV(); p(1);
  const tP = fastest(5, () => { for (let i = 0; i < ITERS; i++) p(i); });
  row("PoC", tP);
  const pr = molPreact(); pr(1);
  const tPr = fastest(5, () => { for (let i = 0; i < ITERS; i++) pr(i); });
  row("preact-signals", tPr, tP);
  const a = molAlien(); a(1);
  const tA = fastest(5, () => { for (let i = 0; i < ITERS; i++) a(i); });
  row("alien-signals (bare callable)", tA, tP);
}

// ─── sBench: 1e4 signals * 1e4 computeds
console.log("\n══ sBench (1e4 * 1e4) ══");
{
  const N = 1e4;
  const tP = fastest(5, () => {
    const s = new Array(N), c = new Array(N);
    for (let i = 0; i < N; i++) s[i] = povSig(i);
    for (let i = 0; i < N; i++) { const j = i; c[i] = povComp(() => s[j].value * 2); }
    let total = 0;
    for (let i = 0; i < N; i++) total += c[i].value;
    for (let i = 0; i < N; i++) s[i].value = i + 1;
    for (let i = 0; i < N; i++) total += c[i].value;
  });
  row("PoC", tP);
  const tPr = fastest(5, () => {
    const s = new Array(N), c = new Array(N);
    for (let i = 0; i < N; i++) s[i] = pSig(i);
    for (let i = 0; i < N; i++) { const j = i; c[i] = pComp(() => s[j].value * 2); }
    let total = 0;
    for (let i = 0; i < N; i++) total += c[i].value;
    for (let i = 0; i < N; i++) s[i].value = i + 1;
    for (let i = 0; i < N; i++) total += c[i].value;
  });
  row("preact-signals", tPr, tP);
}

// ─── dynamicBench: flip-flop deps
console.log("\n══ dynamicBench (1k * 100) ══");
{
  const tP = fastest(5, () => {
    for (let o = 0; o < 1000; o++) {
      const which = povSig(true), a = povSig(1), b = povSig(10);
      let v = 0;
      const stop = povEff(() => { v = which.value ? a.value : b.value; });
      for (let i = 0; i < 100; i++) {
        a.value = i; b.value = i * 2;
        if (i % 5 === 0) which.value = !which.value;
      }
      stop();
      if (v < 0) throw new Error();
    }
  });
  row("PoC", tP);
  const tPr = fastest(5, () => {
    for (let o = 0; o < 1000; o++) {
      const which = pSig(true), a = pSig(1), b = pSig(10);
      let v = 0;
      const stop = pEff(() => { v = which.value ? a.value : b.value; });
      for (let i = 0; i < 100; i++) {
        a.value = i; b.value = i * 2;
        if (i % 5 === 0) which.value = !which.value;
      }
      stop();
      if (v < 0) throw new Error();
    }
  });
  row("preact-signals", tPr, tP);
}
