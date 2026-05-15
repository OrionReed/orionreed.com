// _cell4_full.bench.ts — comprehensive bench:
//   - Per-type construction
//   - Per-type read/write
//   - Workload patterns
//   - Memory: heap-delta for N cells
//
// Run: node --expose-gc node_modules/.bin/tsx src/minim/signals2/_cell4_full.bench.ts

import { bench, group, run, do_not_optimize } from "mitata";
import { signal as aSig } from "./engine";

// cell.ts (current prod)
import { cell as cell1 } from "./cell";
import { Vec as Vec1, Transform as Transform1, Color as Color1, Box as Box1, Num as Num1 } from "./values";

// cell4
import { signal, effect } from "./cell4";
import { Vec, Transform, Color, Box, Num } from "./values4";

const TR_DEF_LEGACY = { translate:{x:0,y:0}, rotate:0, scale:{x:1,y:1}, origin:{x:0,y:0}, opacity:1 };
const TR_DEF_NEW    = { translate:{x:0,y:0}, rotate:0, scale:{x:1,y:1}, opacity:1 };

// ─── Construction perf ────────────────────────────────────────────

group("Construct — bare", () => {
  bench("alien aSig(0)", () => do_not_optimize(aSig(0))).baseline(true);
  bench("cell.ts cell1(0)", () => do_not_optimize(cell1(0)));
  bench("cell4   signal(0)", () => do_not_optimize(signal(0)));
});

group("Construct — Num", () => {
  bench("cell.ts Num", () => do_not_optimize(Num1(0))).baseline(true);
  bench("cell4   Num", () => do_not_optimize(Num(0)));
});

group("Construct — Vec", () => {
  bench("alien aSig({x,y})", () => do_not_optimize(aSig({ x: 1, y: 2 }))).baseline(true);
  bench("cell.ts Vec", () => do_not_optimize(Vec1({ x: 1, y: 2 })));
  bench("cell4   Vec", () => do_not_optimize(Vec({ x: 1, y: 2 })));
});

group("Construct — Color", () => {
  bench("cell.ts Color", () => do_not_optimize(Color1({ r: 1, g: 0, b: 0, a: 1 }))).baseline(true);
  bench("cell4   Color", () => do_not_optimize(Color({ r: 1, g: 0, b: 0, a: 1 })));
});

group("Construct — Box", () => {
  bench("cell.ts Box", () => do_not_optimize(Box1({ x: 0, y: 0, w: 100, h: 100 }))).baseline(true);
  bench("cell4   Box", () => do_not_optimize(Box({ x: 0, y: 0, w: 100, h: 100 })));
});

group("Construct — Transform", () => {
  bench("cell.ts Transform", () => do_not_optimize(Transform1(TR_DEF_LEGACY))).baseline(true);
  bench("cell4   Transform", () => do_not_optimize(Transform(TR_DEF_NEW)));
});

// ─── Reads ────────────────────────────────────────────────────────

group("Read whole — Vec", () => {
  const v1 = Vec1({ x: 1, y: 2 });
  const v4 = Vec({ x: 1, y: 2 });
  bench("cell.ts v1()", () => do_not_optimize(v1())).baseline(true);
  bench("cell4   v4()", () => do_not_optimize(v4()));
});

group("Read whole — Transform", () => {
  const t1 = Transform1(TR_DEF_LEGACY);
  const t4 = Transform(TR_DEF_NEW);
  bench("cell.ts t1()", () => do_not_optimize(t1())).baseline(true);
  bench("cell4   t4()", () => do_not_optimize(t4()));
});

group("Read field — Vec.x", () => {
  const v1: any = Vec1({ x: 1, y: 2 });
  const v4 = Vec({ x: 1, y: 2 });
  void v1.x; void v4.x;
  bench("cell.ts v1.x()", () => do_not_optimize(v1.x())).baseline(true);
  bench("cell4   v4.x()", () => do_not_optimize(v4.x()));
});

group("Read deep — Tr.translate.x", () => {
  const t1: any = Transform1({ ...TR_DEF_LEGACY, translate: { x: 5, y: 10 } });
  const t4 = Transform({ ...TR_DEF_NEW, translate: { x: 5, y: 10 } });
  void t1.translate; void t4.translate;
  bench("cell.ts t1.translate.x()", () => do_not_optimize(t1.translate.x())).baseline(true);
  bench("cell4   t4.translate.x()", () => do_not_optimize(t4.translate.x()));
});

// ─── Writes ───────────────────────────────────────────────────────

group("Write field — Vec.x", () => {
  const v1: any = Vec1({ x: 1, y: 2 });
  const v4 = Vec({ x: 1, y: 2 });
  void v1.x; void v4.x;
  let n = 0;
  bench("cell.ts v1.x(n)", () => v1.x(++n)).baseline(true);
  bench("cell4   v4.x(n)", () => v4.x(++n));
});

group("Write whole — Vec", () => {
  const v1 = Vec1({ x: 1, y: 2 });
  const v4 = Vec({ x: 1, y: 2 });
  let n = 0;
  bench("cell.ts v1({})", () => v1({ x: ++n, y: n })).baseline(true);
  bench("cell4   v4({})", () => v4({ x: ++n, y: n }));
});

// ─── Lifted method (reactive) ─────────────────────────────────────

group("Method reactive — v.add(b)", () => {
  const v1: any = Vec1({ x: 1, y: 2 });
  const v4 = Vec({ x: 1, y: 2 });
  bench("cell.ts v1.add(b)", () => do_not_optimize(v1.add({ x: 1, y: 1 }))).baseline(true);
  bench("cell4   v4.add(b)", () => do_not_optimize(v4.add({ x: 1, y: 1 })));
});

// ─── Static plain math ────────────────────────────────────────────

group("Static plain math — Vec.add(a, b)", () => {
  bench("cell.ts Vec.linear.add", () => do_not_optimize(Vec1.linear!.add({ x: 1, y: 2 }, { x: 3, y: 4 }))).baseline(true);
  bench("cell4   Vec.add", () => do_not_optimize(Vec.add({ x: 1, y: 2 }, { x: 3, y: 4 })));
});

// ─── Workload: 60-frame tween over Vec ────────────────────────────

group("Workload — 60-frame tween Vec", () => {
  bench("cell.ts tween", () => {
    const v = Vec1({ x: 0, y: 0 });
    let log = 0;
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      v({ x: 100 * t, y: 100 * t });
      log += v().x;
    }
    do_not_optimize(log);
  }).baseline(true);
  bench("cell4 tween", () => {
    const v = Vec({ x: 0, y: 0 });
    let log = 0;
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      v({ x: 100 * t, y: 100 * t });
      log += v().x;
    }
    do_not_optimize(log);
  });
});

group("Workload — effect-on-field 60 writes", () => {
  bench("cell4 effect+writes", () => {
    const v = Vec({ x: 0, y: 0 });
    let s = 0;
    const stop = effect(() => { s += v.x(); });
    for (let i = 0; i < 60; i++) v.x(i);
    stop();
    do_not_optimize(s);
  });
});

// ─── Memory ───────────────────────────────────────────────────────

function memDelta(label: string, factory: () => any): void {
  const N = 10_000;
  const gc = (globalThis as any).gc;
  if (typeof gc !== "function") {
    console.log(`  ${label.padEnd(36)}    (run with --expose-gc for memory numbers)`);
    return;
  }
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const arr = new Array(N);
  for (let i = 0; i < N; i++) arr[i] = factory();
  gc();
  const after = process.memoryUsage().heapUsed;
  const bytes = after - before;
  const per = bytes / N;
  if (arr.length === 0) console.log("never");
  console.log(`  ${label.padEnd(36)} ${(bytes / 1024).toFixed(1).padStart(8)} KB  /  ${per.toFixed(0).padStart(5)} B per cell`);
}

console.log("\n— Memory: 10,000 cells each —");
memDelta("alien aSig(0)", () => aSig(0));
memDelta("cell.ts cell1(0)", () => cell1(0));
memDelta("cell4   signal(0)", () => signal(0));
memDelta("cell.ts Num(0)", () => Num1(0));
memDelta("cell4   Num(0)", () => Num(0));
memDelta("cell.ts Vec", () => Vec1({ x: 1, y: 2 }));
memDelta("cell4   Vec", () => Vec({ x: 1, y: 2 }));
memDelta("cell.ts Color", () => Color1({ r: 1, g: 0, b: 0, a: 1 }));
memDelta("cell4   Color", () => Color({ r: 1, g: 0, b: 0, a: 1 }));
memDelta("cell.ts Transform", () => Transform1(TR_DEF_LEGACY));
memDelta("cell4   Transform", () => Transform(TR_DEF_NEW));

await run();
