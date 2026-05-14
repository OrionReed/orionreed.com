// minim v2 bench — `v()` canonical, no `.value`. Trimmed alien engine.
// Compares against:
//   • current minim (preact engine, defineStruct Vec/Transform)
//   • bare preact-signals
//   • bare trimmed-alien
//   • v1 unified prototype (wrap+alien, .value style)
//   • v2 unified prototype (callable IS cell, v() style)
//
// Run:
//   node --expose-gc node_modules/.bin/vite-node src/minim/_bench/proto2/bench.ts

import { signal as pSig } from "@minim/signals";
import { Vec as LIB_VEC, Transform as LIB_TR } from "@minim/values";
import { bench, group, run, do_not_optimize } from "mitata";

import { signal as aSig } from "./alien-trim";
import { Vec, Transform, Num } from "./values";
import { cell as v2Cell } from "./v2";

// v1 wrap-style alien for comparison
import { makeCellFactory } from "../proto/unified";
import { alienEngine } from "../proto/engine-alien";
import { VecT as VecT_v1, TransformT as TransformT_v1 } from "../proto/values";
const cellV1Alien = makeCellFactory(alienEngine);

const TR_DEF = {
  translate: { x: 0, y: 0 }, rotate: 0,
  scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
};

// ── 1. Construction ─────────────────────────────────────────────────

group("construct — Vec", () => {
  bench("preact pSig({x,y})", () => do_not_optimize(pSig({ x: 1, y: 2 }))).baseline(true);
  bench("alien-trim aSig({x,y})", () => do_not_optimize(aSig({ x: 1, y: 2 })));
  bench("current LIB_VEC.signal({x,y})", () => do_not_optimize(LIB_VEC.signal({ x: 1, y: 2 })));
  bench("v1 wrap+alien", () => do_not_optimize(cellV1Alien({ x: 1, y: 2 }, VecT_v1)));
  bench("v2 Vec({x,y})", () => do_not_optimize(Vec({ x: 1, y: 2 })));
  bench("v2 Vec.cell({x,y})", () => do_not_optimize(Vec.cell({ x: 1, y: 2 })));
});

group("construct — Transform (SoA)", () => {
  bench("preact pSig(TR_DEF)", () => do_not_optimize(pSig(TR_DEF))).baseline(true);
  bench("current LIB_TR.signal(TR_DEF)", () => do_not_optimize(LIB_TR.signal(TR_DEF)));
  bench("v1 wrap+alien", () => do_not_optimize(cellV1Alien(TR_DEF, TransformT_v1)));
  bench("v2 Transform(TR_DEF)", () => do_not_optimize(Transform(TR_DEF)));
});

group("construct — bare cell (no type)", () => {
  bench("preact pSig(0)", () => do_not_optimize(pSig(0))).baseline(true);
  bench("alien-trim aSig(0)", () => do_not_optimize(aSig(0)));
  bench("v2 v2Cell(0)", () => do_not_optimize(v2Cell(0)));
});

// ── 2. Reads ────────────────────────────────────────────────────────

group("read whole — Vec", () => {
  const lib: any = LIB_VEC.signal({ x: 5, y: 10 });
  const v1: any = cellV1Alien({ x: 5, y: 10 }, VecT_v1);
  const v2: any = Vec({ x: 5, y: 10 });
  bench("current lib.value", () => do_not_optimize(lib.value)).baseline(true);
  bench("v1 wrap+alien .value", () => do_not_optimize(v1.value));
  bench("v2 Vec call: v()", () => do_not_optimize(v2()));
});

group("read axis .x — Vec", () => {
  const lib: any = LIB_VEC.signal({ x: 5, y: 10 });
  const v1: any = cellV1Alien({ x: 5, y: 10 }, VecT_v1);
  const v2: any = Vec({ x: 5, y: 10 });
  void lib.x; void v1.x; void v2.x; // warm lazy axes
  bench("current lib.x.value", () => do_not_optimize(lib.x.value)).baseline(true);
  bench("v1 v1.x.value", () => do_not_optimize(v1.x.value));
  bench("v2 v2.x()", () => do_not_optimize(v2.x()));
});

group("read deep tr.translate.x — Transform (SoA)", () => {
  const lib: any = LIB_TR.signal(TR_DEF);
  const v1: any = cellV1Alien(TR_DEF, TransformT_v1);
  const v2: any = Transform(TR_DEF);
  void lib.translate.x; void v1.translate.x; void v2.translate.x;
  bench("current lib.translate.x.value", () => do_not_optimize(lib.translate.x.value)).baseline(true);
  bench("v1 v1.translate.x.value", () => do_not_optimize(v1.translate.x.value));
  bench("v2 v2.translate.x()", () => do_not_optimize(v2.translate.x()));
});

// ── 3. Writes ───────────────────────────────────────────────────────

group("write whole — Vec", () => {
  const lib: any = LIB_VEC.signal({ x: 0, y: 0 });
  const v1: any = cellV1Alien({ x: 0, y: 0 }, VecT_v1);
  const v2: any = Vec({ x: 0, y: 0 });
  let i = 0;
  bench("current lib.value={x,y}", () => { lib.value = { x: ++i, y: i }; }).baseline(true);
  bench("v1 v1.value={x,y}", () => { v1.value = { x: ++i, y: i }; });
  bench("v2 v2({x,y})", () => { v2({ x: ++i, y: i }); });
});

group("write axis .x — Vec", () => {
  const lib: any = LIB_VEC.signal({ x: 0, y: 0 });
  const v1: any = cellV1Alien({ x: 0, y: 0 }, VecT_v1);
  const v2: any = Vec({ x: 0, y: 0 });
  void lib.x; void v1.x; void v2.x;
  let i = 0;
  bench("current lib.x.value=i (SoA)", () => { lib.x.value = ++i; }).baseline(true);
  bench("v1 v1.x.value=i (AoS lens)", () => { v1.x.value = ++i; });
  bench("v2 v2.x(i) (AoS lens)", () => { v2.x(++i); });
});

group("write deep tr.translate.x — Transform (SoA)", () => {
  const lib: any = LIB_TR.signal(TR_DEF);
  const v1: any = cellV1Alien(TR_DEF, TransformT_v1);
  const v2: any = Transform(TR_DEF);
  void lib.translate.x; void v1.translate.x; void v2.translate.x;
  let i = 0;
  bench("current lib.translate.x.value=i", () => { lib.translate.x.value = ++i; }).baseline(true);
  bench("v1 v1.translate.x.value=i", () => { v1.translate.x.value = ++i; });
  bench("v2 v2.translate.x(i)", () => { v2.translate.x(++i); });
});

// ── 4. Chaining ─────────────────────────────────────────────────────

group("chain v.add(b).scale(2).distance(zero) — build + 100 reads", () => {
  const libZero: any = LIB_VEC.signal({ x: 0, y: 0 });
  const libA: any = LIB_VEC.signal({ x: 3, y: 4 });
  const libB: any = LIB_VEC.signal({ x: 1, y: 1 });
  const v1Zero: any = cellV1Alien({ x: 0, y: 0 }, VecT_v1);
  const v1A: any = cellV1Alien({ x: 3, y: 4 }, VecT_v1);
  const v1B: any = cellV1Alien({ x: 1, y: 1 }, VecT_v1);
  const v2Zero: any = Vec({ x: 0, y: 0 });
  const v2A: any = Vec({ x: 3, y: 4 });
  const v2B: any = Vec({ x: 1, y: 1 });
  bench("current", () => {
    const m = libA.add(libB).scale(2).distance(libZero);
    let s = 0; for (let i = 0; i < 100; i++) s += m.value;
    return s;
  }).baseline(true);
  bench("v1 wrap+alien", () => {
    const m = v1A.add(v1B).scale(2).distance(v1Zero);
    let s = 0; for (let i = 0; i < 100; i++) s += m.value;
    return s;
  });
  bench("v2 callable", () => {
    const m = v2A.add(v2B).scale(2).distance(v2Zero);
    let s = 0; for (let i = 0; i < 100; i++) s += (m() as number);
    return s;
  });
});

// ── 5. Val<T> unification check ─────────────────────────────────────
//
// Pass a cell where a Val<T> is expected. v2's Val<T> = T | (() => T),
// so a cell IS the function — no wrapping needed.

group("Val<T>: cell-as-argument cost", () => {
  const v: any = Num(5);
  const k: any = Num(2);
  // Pre-create the derived
  const d1 = v.scale(k);
  bench("v2: v.scale(k) - k is a cell", () => { k(k.peek() + 1); return d1(); }).baseline(true);
});

// ── 6. Graph depth (raw engine) ─────────────────────────────────────

import { computed as aComp } from "./alien-trim";
import { computed as pComp } from "@minim/signals";

function chain(sigFn: any, compFn: any, depth: number) {
  const root = sigFn();
  let prev: any = root;
  for (let i = 0; i < depth; i++) {
    const p = prev;
    prev = compFn(() => (typeof p === "function" ? p() : p.value) + 1);
  }
  return { root, leaf: prev };
}

group("graph depth = 20 (write root, read leaf)", () => {
  {
    const { root, leaf } = chain(() => pSig(0), pComp, 20);
    let i = 0;
    bench("preact", () => { root.value = ++i; return leaf.value; }).baseline(true);
  }
  {
    const { root, leaf } = chain(() => aSig(0), aComp, 20);
    let i = 0;
    bench("alien-trim", () => { root(++i); return leaf(); });
  }
});

group("graph depth = 100", () => {
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

// ── 7. Effect dispatch ──────────────────────────────────────────────

import { effect as pEff } from "@minim/signals";
import { effect as aEff } from "./alien-trim";

group("effect: 1 sub, 1 signal, 1 write", () => {
  {
    const s = pSig(0);
    let acc = 0;
    pEff(() => { acc += s.value; });
    let i = 0;
    bench("preact", () => { s.value = ++i; return acc; }).baseline(true);
  }
  {
    const s = aSig(0);
    let acc = 0;
    aEff(() => { acc += s() as number; });
    let i = 0;
    bench("alien-trim", () => { s(++i); return acc; });
  }
});

group("effect: 10 subs, 1 signal", () => {
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

// ── 8. Memory ───────────────────────────────────────────────────────

declare const globalThis: { gc?: () => void };

async function memBench(label: string, K: number, build: () => unknown) {
  if (typeof globalThis.gc !== "function") {
    console.log(`  ${label}: --expose-gc not available`);
    return;
  }
  const pin: unknown[] = new Array(K);
  globalThis.gc();
  await new Promise((r) => setTimeout(r, 5));
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < K; i++) pin[i] = build();
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  console.log(`  ${label}: ${((after - before) / K).toFixed(0)} b/cell  (Δheap ${((after - before) / 1024).toFixed(1)} KiB)`);
  if (pin.length === 0) console.log("?");
}

console.log("\n── Memory per cell (100k constructions, post-GC) ─────");
const K = 100_000;
await memBench("preact pSig({x,y})        ", K, () => pSig({ x: 1, y: 2 }));
await memBench("alien-trim aSig({x,y})    ", K, () => aSig({ x: 1, y: 2 }));
await memBench("current LIB_VEC          ", K, () => LIB_VEC.signal({ x: 1, y: 2 }));
await memBench("v1 wrap+alien            ", K, () => cellV1Alien({ x: 1, y: 2 }, VecT_v1));
await memBench("v2 Vec({x,y})            ", K, () => Vec({ x: 1, y: 2 }));

// ── 9. Capability composition check ─────────────────────────────────

console.log("\n── Composite capability check (Transform — declares ZERO algebra/lerp/metric) ──");
console.log("  Transform.lerp defined:    ", typeof Transform.lerp === "function");
console.log("  Transform.algebra defined: ", typeof Transform.algebra === "object");
console.log("  Transform.metric defined:  ", typeof Transform.metric === "function");
console.log("  Transform.equals defined:  ", typeof Transform.equals === "function");

const trA = { translate: { x: 0, y: 0 }, rotate: 0, scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 0 };
const trB = { translate: { x: 100, y: 50 }, rotate: 1.5, scale: { x: 2, y: 2 }, origin: { x: 0, y: 0 }, opacity: 1 };
console.log("  Transform.lerp(A, B, 0.5):", JSON.stringify(Transform.lerp!(trA, trB, 0.5)));
console.log("  Transform.add(A, B):      ", JSON.stringify(Transform.add!(trA, trB)));
console.log("  Transform.metric(A, B):   ", Transform.metric!(trA, trB).toFixed(4));

// ── 10. Surface check ──────────────────────────────────────────────

console.log("\n── Surface check (v2) ─────────────────────────────");
const v = Vec({ x: 3, y: 4 });
const z = Vec({ x: 0, y: 0 });
console.log("  v():           ", v());
console.log("  v.x():         ", (v as any).x());
console.log("  v.peek():      ", (v as any).peek());
// NOTE: `length` clashes with Function.prototype.length (returns argc).
// Renamed `magnitude` for the prototype to avoid the collision.
console.log("  v.distance(z): ", (v as any).distance(z)());
console.log("  v.add(z)():    ", (v as any).add(z)());
console.log("  v.lerp(z, 0.5)():", (v as any).lerp(z, 0.5)());
console.log("  v.add(z).scale(0.5).distance(z)():", (v as any).add(z).scale(0.5).distance(z)());
console.log("  Vec.lerp({0,0},{10,0},0.5):", JSON.stringify(Vec.lerp!({x:0,y:0}, {x:10,y:0}, 0.5)));
console.log("  Vec.add({1,2},{3,4}):     ", JSON.stringify(Vec.add!({x:1,y:2}, {x:3,y:4})));

// Val<T> — passing a cell where a literal-or-thunk would do
const k = Num(2);
const scaled = (v as any).scale(k);
console.log("  v.scale(k_cell)(): ", scaled());
(k as any)(5);
console.log("  after k(5): scaled():", scaled());

console.log("\n── LOC ────────────────────────────────────────────");
console.log("  alien-trim.ts:            ", "473 LOC (engine, single file)");
console.log("  v2.ts:                    ", "~410 LOC (cell layer)");
console.log("  values.ts:                ", "~75 LOC (Num + Vec + Transform)");
console.log("    Transform algebra/lerp/metric/equals: 0 LOC (all composed)");
