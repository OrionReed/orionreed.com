// Comprehensive prototype bench. Compares:
//
//   • current minim (preact engine, current defineStruct Vec/Transform)
//   • unified prototype on preact engine
//   • unified prototype on alien engine
//   • bare preact-signals as a floor
//   • bare alien-signals  as a floor
//
// Across:
//
//   1. Construction (Vec, Transform, bare cell)
//   2. Reads (.value, .peek, deep axis)
//   3. Writes (whole, per-axis)
//   4. Chaining (.add().scale().distance())
//   5. Graph depth (chain N computeds)
//   6. Subscription/effect cost
//   7. Memory per-cell (rough — heap delta around 100k constructions)
//
// Run with:
//   node --expose-gc node_modules/.bin/vite-node \
//     src/minim/_bench/proto/bench.ts

import { signal as pSig, computed as pComp, effect as pEff } from "@minim/signals";
import { signal as aSig, computed as aComp, effect as aEff } from "alien-signals";
import { Vec as LIB_VEC, Transform as LIB_TR } from "@minim/values";
import { bench, group, run, do_not_optimize } from "mitata";

import { preactEngine } from "./engine-preact";
import { alienEngine } from "./engine-alien";
import { makeCellFactory } from "./unified";
import { cell as cellCallable } from "./unified-callable";
import { VecT, TransformT, NumT } from "./values";

const cellPreact = makeCellFactory(preactEngine);
const cellAlien = makeCellFactory(alienEngine);

// ── 1. Construction ─────────────────────────────────────────────────

group("construction — Vec ({x,y})", () => {
  bench("baseline preact: pSig({x:1,y:2})", () =>
    do_not_optimize(pSig({ x: 1, y: 2 })),
  ).baseline(true);
  bench("baseline alien:  aSig({x:1,y:2})", () =>
    do_not_optimize(aSig({ x: 1, y: 2 })),
  );
  bench("current lib:     LIB_VEC.signal({x,y})", () =>
    do_not_optimize(LIB_VEC.signal({ x: 1, y: 2 })),
  );
  bench("unified+preact:  cellPreact({x,y}, VecT)", () =>
    do_not_optimize(cellPreact({ x: 1, y: 2 }, VecT)),
  );
  bench("unified+alien:   cellAlien({x,y}, VecT)", () =>
    do_not_optimize(cellAlien({ x: 1, y: 2 }, VecT)),
  );
  bench("callable+alien:  cellCallable({x,y}, VecT) — no wrapper", () =>
    do_not_optimize(cellCallable({ x: 1, y: 2 }, VecT)),
  );
  bench("unified+preact:  cellPreact(0) — bare", () =>
    do_not_optimize(cellPreact(0)),
  );
  bench("unified+alien:   cellAlien(0) — bare", () =>
    do_not_optimize(cellAlien(0)),
  );
});

group("construction — Transform (5 fields, SoA)", () => {
  const TR_DEF = {
    translate: { x: 0, y: 0 },
    rotate: 0,
    scale: { x: 1, y: 1 },
    origin: { x: 0, y: 0 },
    opacity: 1,
  };
  bench("baseline preact: pSig(TR_DEF)", () =>
    do_not_optimize(pSig(TR_DEF)),
  ).baseline(true);
  bench("current lib:     LIB_TR.signal(TR_DEF)", () =>
    do_not_optimize(LIB_TR.signal(TR_DEF)),
  );
  bench("unified+preact:  cellPreact(TR_DEF, TransformT)", () =>
    do_not_optimize(cellPreact(TR_DEF, TransformT)),
  );
  bench("unified+alien:   cellAlien(TR_DEF, TransformT)", () =>
    do_not_optimize(cellAlien(TR_DEF, TransformT)),
  );
});

// ── 2. Reads ────────────────────────────────────────────────────────

group("read .value (Vec)", () => {
  const a = pSig({ x: 5, y: 10 });
  const b = aSig({ x: 5, y: 10 });
  const c = LIB_VEC.signal({ x: 5, y: 10 });
  const d = cellPreact({ x: 5, y: 10 }, VecT);
  const e = cellAlien({ x: 5, y: 10 }, VecT);
  const f = cellCallable({ x: 5, y: 10 }, VecT);
  bench("baseline preact: a.value", () => do_not_optimize(a.value)).baseline(true);
  bench("baseline alien:  b()", () => do_not_optimize(b()));
  bench("current lib:     c.value", () => do_not_optimize(c.value));
  bench("unified+preact:  d.value", () => do_not_optimize(d.value));
  bench("unified+alien:   e.value", () => do_not_optimize(e.value));
  bench("callable+alien:  f.value (sugar over f())", () => do_not_optimize(f.value));
  bench("callable+alien:  f() — direct call", () => do_not_optimize((f as any)()));
});

group("read .peek() (Vec)", () => {
  const a = pSig({ x: 5, y: 10 });
  const c = LIB_VEC.signal({ x: 5, y: 10 });
  const d = cellPreact({ x: 5, y: 10 }, VecT);
  const e = cellAlien({ x: 5, y: 10 }, VecT);
  bench("baseline preact: a.peek()", () => do_not_optimize(a.peek())).baseline(true);
  bench("current lib:     c.peek()", () => do_not_optimize(c.peek()));
  bench("unified+preact:  d.peek()", () => do_not_optimize(d.peek()));
  bench("unified+alien:   e.peek()", () => do_not_optimize(e.peek()));
});

group("read axis .x.value (Vec)", () => {
  const c: any = LIB_VEC.signal({ x: 5, y: 10 });
  const d: any = cellPreact({ x: 5, y: 10 }, VecT);
  const e: any = cellAlien({ x: 5, y: 10 }, VecT);
  void c.x; void d.x; void e.x; // warm
  bench("current lib:     c.x.value", () => do_not_optimize(c.x.value)).baseline(true);
  bench("unified+preact:  d.x.value", () => do_not_optimize(d.x.value));
  bench("unified+alien:   e.x.value", () => do_not_optimize(e.x.value));
});

group("read deep axis tr.translate.x.value", () => {
  const TR_DEF = {
    translate: { x: 0, y: 0 }, rotate: 0,
    scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
  };
  const c: any = LIB_TR.signal(TR_DEF);
  const d: any = cellPreact(TR_DEF, TransformT);
  const e: any = cellAlien(TR_DEF, TransformT);
  void c.translate.x; void d.translate.x; void e.translate.x;
  bench("current lib:     c.translate.x.value", () =>
    do_not_optimize(c.translate.x.value),
  ).baseline(true);
  bench("unified+preact:  d.translate.x.value", () =>
    do_not_optimize(d.translate.x.value),
  );
  bench("unified+alien:   e.translate.x.value", () =>
    do_not_optimize(e.translate.x.value),
  );
});

// ── 3. Writes ───────────────────────────────────────────────────────

group("write whole .value (Vec)", () => {
  const a = pSig({ x: 0, y: 0 });
  const c: any = LIB_VEC.signal({ x: 0, y: 0 });
  const d: any = cellPreact({ x: 0, y: 0 }, VecT);
  const e: any = cellAlien({ x: 0, y: 0 }, VecT);
  const f: any = cellCallable({ x: 0, y: 0 }, VecT);
  let i = 0;
  bench("baseline preact: a.value={x,y}", () => { a.value = { x: ++i, y: i }; }).baseline(true);
  bench("current lib:     c.value={x,y}", () => { c.value = { x: ++i, y: i }; });
  bench("unified+preact:  d.value={x,y}", () => { d.value = { x: ++i, y: i }; });
  bench("unified+alien:   e.value={x,y}", () => { e.value = { x: ++i, y: i }; });
  bench("callable+alien:  f.value={x,y}", () => { f.value = { x: ++i, y: i }; });
  bench("callable+alien:  f({x,y}) direct", () => { f({ x: ++i, y: i }); });
});

group("write per-axis .x.value=i (Vec)", () => {
  const c: any = LIB_VEC.signal({ x: 0, y: 0 });
  const d: any = cellPreact({ x: 0, y: 0 }, VecT);
  const e: any = cellAlien({ x: 0, y: 0 }, VecT);
  const f: any = cellCallable({ x: 0, y: 0 }, VecT);
  void c.x; void d.x; void e.x; void f.x;
  let i = 0;
  bench("current lib (SoA)", () => { c.x.value = ++i; }).baseline(true);
  bench("unified+preact (AoS lens)", () => { d.x.value = ++i; });
  bench("unified+alien (AoS lens)", () => { e.x.value = ++i; });
  bench("callable+alien (AoS lens)", () => { f.x.value = ++i; });
  bench("callable+alien (direct: f.x(++i))", () => { f.x(++i); });
});

group("write deep axis tr.translate.x.value=i (Transform SoA)", () => {
  const TR_DEF = {
    translate: { x: 0, y: 0 }, rotate: 0,
    scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 1,
  };
  const c: any = LIB_TR.signal(TR_DEF);
  const d: any = cellPreact(TR_DEF, TransformT);
  const e: any = cellAlien(TR_DEF, TransformT);
  void c.translate.x; void d.translate.x; void e.translate.x;
  let i = 0;
  bench("current lib", () => { c.translate.x.value = ++i; }).baseline(true);
  bench("unified+preact", () => { d.translate.x.value = ++i; });
  bench("unified+alien", () => { e.translate.x.value = ++i; });
});

// ── 4. Chaining ─────────────────────────────────────────────────────

group("chain: v.add(b).scale(2).distance(zero) — build once + 100 reads", () => {
  const cZero: any = LIB_VEC.signal({ x: 0, y: 0 });
  const cA: any = LIB_VEC.signal({ x: 3, y: 4 });
  const cB: any = LIB_VEC.signal({ x: 1, y: 1 });
  const dZero: any = cellPreact({ x: 0, y: 0 }, VecT);
  const dA: any = cellPreact({ x: 3, y: 4 }, VecT);
  const dB: any = cellPreact({ x: 1, y: 1 }, VecT);
  const eZero: any = cellAlien({ x: 0, y: 0 }, VecT);
  const eA: any = cellAlien({ x: 3, y: 4 }, VecT);
  const eB: any = cellAlien({ x: 1, y: 1 }, VecT);
  bench("current lib", () => {
    const m = cA.add(cB).scale(2).distance(cZero);
    let s = 0;
    for (let i = 0; i < 100; i++) s += m.value;
    return s;
  }).baseline(true);
  bench("unified+preact", () => {
    const m = dA.add(dB).scale(2).distance(dZero);
    let s = 0;
    for (let i = 0; i < 100; i++) s += m.value;
    return s;
  });
  bench("unified+alien", () => {
    const m = eA.add(eB).scale(2).distance(eZero);
    let s = 0;
    for (let i = 0; i < 100; i++) s += m.value;
    return s;
  });
});

// ── 5. Graph depth (N-deep computed chain) ──────────────────────────
//
// Write the root → read the leaf. Cost = propagation through N computeds.

function setupChain(
  signalFn: () => any,
  computedFn: (fn: () => any) => any,
  depth: number,
) {
  const root = signalFn();
  let prev: any = root;
  for (let i = 0; i < depth; i++) {
    const p = prev;
    prev = computedFn(() => (typeof p === "function" ? p() : p.value) + 1);
  }
  return { root, leaf: prev };
}

group("graph depth = 20 (write root, read leaf)", () => {
  {
    const { root, leaf } = setupChain(() => pSig(0), pComp, 20);
    let i = 0;
    bench("baseline preact", () => {
      root.value = ++i;
      return leaf.value;
    }).baseline(true);
  }
  {
    const { root, leaf } = setupChain(() => aSig(0), aComp, 20);
    let i = 0;
    bench("baseline alien", () => {
      root(++i);
      return leaf();
    });
  }
});

group("graph depth = 100 (write root, read leaf)", () => {
  {
    const { root, leaf } = setupChain(() => pSig(0), pComp, 100);
    let i = 0;
    bench("baseline preact", () => {
      root.value = ++i;
      return leaf.value;
    }).baseline(true);
  }
  {
    const { root, leaf } = setupChain(() => aSig(0), aComp, 100);
    let i = 0;
    bench("baseline alien", () => {
      root(++i);
      return leaf();
    });
  }
});

// ── 6. Subscription/effect dispatch ─────────────────────────────────

group("effect fires on write (1 effect, 1 signal)", () => {
  {
    const s = pSig(0);
    let acc = 0;
    pEff(() => { acc += s.value; });
    let i = 0;
    bench("baseline preact", () => {
      s.value = ++i;
      return acc;
    }).baseline(true);
  }
  {
    const s = aSig(0);
    let acc = 0;
    aEff(() => { acc += s(); });
    let i = 0;
    bench("baseline alien", () => {
      s(++i);
      return acc;
    });
  }
});

group("effect: 10 subscribers on one signal", () => {
  const N = 10;
  {
    const s = pSig(0);
    let acc = 0;
    for (let i = 0; i < N; i++) pEff(() => { acc += s.value; });
    let i = 0;
    bench("baseline preact", () => {
      s.value = ++i;
      return acc;
    }).baseline(true);
  }
  {
    const s = aSig(0);
    let acc = 0;
    for (let i = 0; i < N; i++) aEff(() => { acc += s(); });
    let i = 0;
    bench("baseline alien", () => {
      s(++i);
      return acc;
    });
  }
});

// ── 7. Memory ───────────────────────────────────────────────────────
//
// Construct K instances, measure heap delta. Imperfect (GC noise) but
// directional. Force GC between, run twice, take min.

declare const globalThis: { gc?: () => void };

async function memBench(label: string, K: number, build: () => unknown) {
  // Allocate and pin to prevent intermediate GC.
  const pin: unknown[] = new Array(K);
  if (typeof globalThis.gc !== "function") {
    console.log(`  ${label}: --expose-gc not available, skipping`);
    return;
  }
  globalThis.gc();
  await new Promise((r) => setTimeout(r, 5));
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < K; i++) pin[i] = build();
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  const perCell = (after - before) / K;
  console.log(`  ${label}: ~${perCell.toFixed(0)} b/cell  (${K} cells, Δheap ${((after - before) / 1024).toFixed(1)} KiB)`);
  // Touch pin so it can't be DCE'd.
  if (pin.length === 0) console.log("?");
}

await run({ format: "mitata" });

console.log("\n── Memory per cell (100k constructions, post-GC) ─────────");
const K = 100_000;
await memBench("baseline preact pSig({x,y})        ", K, () => pSig({ x: 1, y: 2 }));
await memBench("baseline alien  aSig({x,y})        ", K, () => aSig({ x: 1, y: 2 }));
await memBench("current lib    LIB_VEC.signal({x,y})", K, () => LIB_VEC.signal({ x: 1, y: 2 }));
await memBench("unified+preact cellPreact({x,y},VecT)", K, () => cellPreact({ x: 1, y: 2 }, VecT));
await memBench("unified+alien  cellAlien({x,y},VecT)", K, () => cellAlien({ x: 1, y: 2 }, VecT));

// ── 8. Compositional capability — does it actually work? ────────────
//
// Transform has NO algebra/lerp/metric in TransformT. The lifter
// should derive them from VecT/NumT through `nested`.

console.log("\n── Compositional capability check (Transform has no own algebra/lerp/metric) ──");
import { typeFor as _typeFor } from "./unified";
const trType = _typeFor(TransformT);
console.log("  Transform.lerpFn defined: ", !!trType.lerpFn);
console.log("  Transform.algebraFn defined:", !!trType.algebraFn);
console.log("  Transform.metricFn defined: ", !!trType.metricFn);

const trA = {
  translate: { x: 0, y: 0 }, rotate: 0,
  scale: { x: 1, y: 1 }, origin: { x: 0, y: 0 }, opacity: 0,
};
const trB = {
  translate: { x: 100, y: 50 }, rotate: 1.5,
  scale: { x: 2, y: 2 }, origin: { x: 0, y: 0 }, opacity: 1,
};
console.log("  Transform.lerpFn(A, B, 0.5):", JSON.stringify(trType.lerpFn?.(trA, trB, 0.5)));
console.log("  Transform.algebraFn.add(A, B):", JSON.stringify(trType.algebraFn?.add(trA, trB)));
console.log("  Transform.metricFn(A, B):    ", trType.metricFn?.(trA, trB).toFixed(4));

// ── 9. Surface check: chain still works on derived results ──────────

console.log("\n── Surface check ─────────────────────────────");
const v: any = cellPreact({ x: 3, y: 4 }, VecT);
const z: any = cellPreact({ x: 0, y: 0 }, VecT);
console.log("  v.value:", v.value);
console.log("  v.x.value:", v.x.value);
console.log("  v.length.value:", v.length.value);
console.log("  v.distance(z).value:", v.distance(z).value);
console.log("  v.add(v).scale(0.5).value:", v.add(v).scale(0.5).value);
console.log("  v.lerp(z, 0.5).value:", v.lerp(z, 0.5).value);
// Math without cells
console.log("  VecT.lerp({0,0}, {10,0}, 0.5):", JSON.stringify(VecT.lerp!({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5)));

console.log("\n── LOC ──────────────────────────────────────");
console.log("  current signals/struct.ts:           986 LOC");
console.log("  prototype unified.ts core:           ~440 LOC");
console.log("  prototype values.ts (Vec+Num+Tr):     ~75 LOC  (Tr has 0 lines of algebra/lerp/metric!)");
console.log("  current values/transform.ts:         130 LOC  (~70 lines of cut-paste algebra/lerp/metric)");
