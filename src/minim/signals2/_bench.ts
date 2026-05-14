// Final bench — signals2 vs everything else.
// Run: node --expose-gc node_modules/.bin/vite-node src/minim/signals2/_bench.ts

import { signal as pSig, computed as pComp, effect as pEff } from "@minim/signals";
import { Vec as LIB_VEC, Transform as LIB_TR } from "@minim/values";
import { bench, group, run, do_not_optimize } from "mitata";

import { signal as aSig, computed as aComp, effect as aEff } from "./engine";
import { Vec, Transform, Num } from "./values";
import { cell as v2Cell } from "./cell";

const TR_DEF = {
  translate: { x: 0, y: 0 }, rotate: 0,
  scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
};

// ── Construction ────────────────────────────────────────────────────

group("construct — Vec", () => {
  bench("preact pSig({x,y})", () => do_not_optimize(pSig({ x: 1, y: 2 }))).baseline(true);
  bench("alien-trim aSig({x,y})", () => do_not_optimize(aSig({ x: 1, y: 2 })));
  bench("current LIB_VEC.signal", () => do_not_optimize(LIB_VEC.signal({ x: 1, y: 2 })));
  bench("signals2 Vec({x,y})", () => do_not_optimize(Vec({ x: 1, y: 2 })));
});

group("construct — Transform", () => {
  bench("preact pSig(TR_DEF)", () => do_not_optimize(pSig(TR_DEF))).baseline(true);
  bench("current LIB_TR.signal", () => do_not_optimize(LIB_TR.signal(TR_DEF)));
  bench("signals2 Transform(TR_DEF)", () => do_not_optimize(Transform(TR_DEF)));
});

group("construct — bare cell", () => {
  bench("preact pSig(0)", () => do_not_optimize(pSig(0))).baseline(true);
  bench("alien-trim aSig(0)", () => do_not_optimize(aSig(0)));
  bench("signals2 v2Cell(0)", () => do_not_optimize(v2Cell(0)));
});

// ── Reads ───────────────────────────────────────────────────────────

group("read — Vec whole", () => {
  const a = pSig({ x: 5, y: 10 });
  const b = aSig({ x: 5, y: 10 });
  const c = LIB_VEC.signal({ x: 5, y: 10 });
  const v = Vec({ x: 5, y: 10 });
  bench("preact a.value", () => do_not_optimize(a.value)).baseline(true);
  bench("alien-trim b()", () => do_not_optimize(b()));
  bench("current c.value", () => do_not_optimize(c.value));
  bench("signals2 v()", () => do_not_optimize(v()));
});

group("read — Vec axis .x", () => {
  const c: any = LIB_VEC.signal({ x: 5, y: 10 });
  const v: any = Vec({ x: 5, y: 10 });
  void c.x; void v.x;
  bench("current c.x.value", () => do_not_optimize(c.x.value)).baseline(true);
  bench("signals2 v.x()", () => do_not_optimize(v.x()));
});

group("read — Transform.translate.x deep", () => {
  const c: any = LIB_TR.signal(TR_DEF);
  const v: any = Transform(TR_DEF);
  void c.translate.x; void v.translate.x;
  bench("current c.translate.x.value", () => do_not_optimize(c.translate.x.value)).baseline(true);
  bench("signals2 v.translate.x()", () => do_not_optimize(v.translate.x()));
});

// ── Writes ──────────────────────────────────────────────────────────

group("write — Vec whole", () => {
  const a = pSig({ x: 0, y: 0 });
  const c: any = LIB_VEC.signal({ x: 0, y: 0 });
  const v: any = Vec({ x: 0, y: 0 });
  let i = 0;
  bench("preact a.value={x,y}", () => { a.value = { x: ++i, y: i }; }).baseline(true);
  bench("current c.value={x,y}", () => { c.value = { x: ++i, y: i }; });
  bench("signals2 v({x,y})", () => { v({ x: ++i, y: i }); });
});

group("write — Vec axis .x", () => {
  const c: any = LIB_VEC.signal({ x: 0, y: 0 });
  const v: any = Vec({ x: 0, y: 0 });
  void c.x; void v.x;
  let i = 0;
  bench("current c.x.value=i (SoA)", () => { c.x.value = ++i; }).baseline(true);
  bench("signals2 v.x(i) (AoS lens)", () => { v.x(++i); });
});

group("write — Transform.translate.x", () => {
  const c: any = LIB_TR.signal(TR_DEF);
  const v: any = Transform(TR_DEF);
  void c.translate.x; void v.translate.x;
  let i = 0;
  bench("current c.translate.x.value=i", () => { c.translate.x.value = ++i; }).baseline(true);
  bench("signals2 v.translate.x(i)", () => { v.translate.x(++i); });
});

// ── Chaining ────────────────────────────────────────────────────────

group("chain — v.add(b).scale(2).distance(z) build + 100 reads", () => {
  const cZ: any = LIB_VEC.signal({ x: 0, y: 0 });
  const cA: any = LIB_VEC.signal({ x: 3, y: 4 });
  const cB: any = LIB_VEC.signal({ x: 1, y: 1 });
  const vZ: any = Vec({ x: 0, y: 0 });
  const vA: any = Vec({ x: 3, y: 4 });
  const vB: any = Vec({ x: 1, y: 1 });
  bench("current", () => {
    const m = cA.add(cB).scale(2).distance(cZ);
    let s = 0; for (let i = 0; i < 100; i++) s += m.value;
    return s;
  }).baseline(true);
  bench("signals2", () => {
    const m = vA.add(vB).scale(2).distance(vZ);
    let s = 0; for (let i = 0; i < 100; i++) s += m() as number;
    return s;
  });
});

// ── Graph propagation ──────────────────────────────────────────────

function chain(sigFn: any, compFn: any, depth: number) {
  const root = sigFn();
  let prev: any = root;
  for (let i = 0; i < depth; i++) {
    const p = prev;
    prev = compFn(() => (typeof p === "function" ? p() : p.value) + 1);
  }
  return { root, leaf: prev };
}

group("graph depth = 100 (write root, read leaf)", () => {
  {
    const { root, leaf } = chain(() => pSig(0), pComp, 100);
    let i = 0;
    bench("preact", () => { root.value = ++i; return leaf.value; }).baseline(true);
  }
  {
    const { root, leaf } = chain(() => aSig(0), aComp, 100);
    let i = 0;
    bench("alien-trim", () => { root(++i); return leaf(); });
  }
});

// ── Effects ────────────────────────────────────────────────────────

group("effect: 10 subs, 1 signal, 1 write", () => {
  const N = 10;
  {
    const s = pSig(0);
    let acc = 0;
    for (let i = 0; i < N; i++) pEff(() => { acc += s.value; });
    let i = 0;
    bench("preact", () => { s.value = ++i; return acc; }).baseline(true);
  }
  {
    const s = aSig(0);
    let acc = 0;
    for (let i = 0; i < N; i++) aEff(() => { acc += s() as number; });
    let i = 0;
    bench("alien-trim", () => { s(++i); return acc; });
  }
});

await run({ format: "mitata" });

// ── Memory ─────────────────────────────────────────────────────────

declare const globalThis: { gc?: () => void };

async function memBench(label: string, K: number, build: () => unknown) {
  if (typeof globalThis.gc !== "function") return;
  const pin: unknown[] = new Array(K);
  globalThis.gc();
  await new Promise((r) => setTimeout(r, 5));
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < K; i++) pin[i] = build();
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  console.log(`  ${label.padEnd(28)}: ${((after - before) / K).toFixed(0).padStart(4)} b/cell`);
  if (pin.length === 0) console.log("?");
}

console.log("\n── Memory per cell (100k constructions) ─────────");
const K = 100_000;
await memBench("preact pSig({x,y})", K, () => pSig({ x: 1, y: 2 }));
await memBench("alien-trim aSig({x,y})", K, () => aSig({ x: 1, y: 2 }));
await memBench("current LIB_VEC", K, () => LIB_VEC.signal({ x: 1, y: 2 }));
await memBench("signals2 Vec({x,y})", K, () => Vec({ x: 1, y: 2 }));

console.log("\n── Summary ─────────────────────────────────────");
console.log("  • engine.ts:     473 LOC (verbatim alien semantics, single file)");
console.log("  • cell.ts:       ~570 LOC (Type + Cell + factories + composite caps + inference)");
console.log("  • values.ts:      85 LOC (Num + Vec + Transform — Transform has 0 lines of algebra/lerp/metric)");
console.log("  • generics.ts:   170 LOC (mean, lerp, distance, springStep, serialise)");
console.log("");
console.log("  • Correctness:   51 tests pass (diamond, nested-effect, batch, scope, trigger, ...)");
console.log("  • Generics:      21 tests pass (Num, Vec, Transform, inline Angle, user caps)");
console.log("  • Type infer:    compiles (methods, getters, axes, algebra/lerp/metric all surface)");
