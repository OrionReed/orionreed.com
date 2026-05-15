// _cell5.bench.ts — bench cell5 vs bare alien (the real baseline)
// + cell4 for cross-reference.
// Run: node --expose-gc --import tsx src/minim/signals2/_cell5.bench.ts

import { bench, group, run, do_not_optimize } from "mitata";

// Bare alien — the baseline.
import { signal as aSig, computed as aComp, effect as aEff } from "./engine";

// cell4
import { signal as s4 } from "./cell4";
import { Vec as Vec4, Transform as Transform4 } from "./values4";

// cell5 (this round — bare signal = bare alien)
import { signal as s5 } from "./cell5";
import { Vec as Vec5, Transform as Transform5 } from "./values5";

// Probe: bare cell5 vs bare alien (should now be ~identical)

const TR_NEW = { translate:{x:0,y:0}, rotate:0, scale:{x:1,y:1}, opacity:1 };

// ─── Bare-alien EQUIVALENT for Vec: alien signal + free-function math.
const vAdd = (a: any, b: any) => ({ x: a.x + b.x, y: a.y + b.y });
const vScale = (a: any, k: number) => ({ x: a.x * k, y: a.y * k });

// ─── Construction ────────────────────────────────────────────────

group("Construct — bare", () => {
  bench("alien aSig(0)", () => do_not_optimize(aSig(0))).baseline(true);
  bench("cell4 signal(0)", () => do_not_optimize(s4(0)));
  bench("cell5 signal(0)", () => do_not_optimize(s5(0)));
});

group("Construct — Vec", () => {
  bench("alien aSig({x,y})", () => do_not_optimize(aSig({ x: 1, y: 2 }))).baseline(true);
  bench("cell4 Vec",  () => do_not_optimize(Vec4({ x: 1, y: 2 })));
  bench("cell5 Vec",  () => do_not_optimize(Vec5({ x: 1, y: 2 })));
});

group("Construct — Transform", () => {
  bench("alien aSig(tr)", () => do_not_optimize(aSig(TR_NEW))).baseline(true);
  bench("cell4 Transform", () => do_not_optimize(Transform4(TR_NEW)));
  bench("cell5 Transform", () => do_not_optimize(Transform5(TR_NEW)));
});

// ─── Reads ───────────────────────────────────────────────────────

group("Read whole — Vec", () => {
  const a = aSig({ x: 1, y: 2 });
  const v4 = Vec4({ x: 1, y: 2 });
  const v5 = Vec5({ x: 1, y: 2 });
  bench("alien a()", () => do_not_optimize(a())).baseline(true);
  bench("cell4 v4()", () => do_not_optimize(v4()));
  bench("cell5 v5()", () => do_not_optimize(v5()));
});

group("Read field — Vec.x", () => {
  // Bare alien equivalent: computed projection.
  const a = aSig({ x: 1, y: 2 });
  const aX = aComp(() => a().x);
  const v4 = Vec4({ x: 1, y: 2 });
  const v5 = Vec5({ x: 1, y: 2 });
  void v4.x; void v5.x;
  bench("alien aComp(()=>a().x)", () => do_not_optimize(aX())).baseline(true);
  bench("cell4 v4.x()", () => do_not_optimize(v4.x()));
  bench("cell5 v5.x()", () => do_not_optimize(v5.x()));
});

// ─── Writes ──────────────────────────────────────────────────────

group("Write whole — Vec", () => {
  const a = aSig({ x: 1, y: 2 });
  const v4 = Vec4({ x: 1, y: 2 });
  const v5 = Vec5({ x: 1, y: 2 });
  let n = 0;
  bench("alien a({})", () => a({ x: ++n, y: n })).baseline(true);
  bench("cell4 v4({})", () => v4({ x: ++n, y: n }));
  bench("cell5 v5({})", () => v5({ x: ++n, y: n }));
});

group("Write field — Vec.x", () => {
  // Bare alien equivalent: read whole, spread, write whole.
  const a = aSig({ x: 1, y: 2 });
  const v4 = Vec4({ x: 1, y: 2 });
  const v5 = Vec5({ x: 1, y: 2 });
  void v4.x; void v5.x;
  let n = 0;
  bench("alien manual field write", () => { const cur = a(); a({ x: ++n, y: cur.y }); }).baseline(true);
  bench("cell4 v4.x(n)", () => v4.x(++n));
  bench("cell5 v5.x(n)", () => v5.x(++n));
});

// ─── Math ────────────────────────────────────────────────────────

group("Math — pure function vs reactive method", () => {
  const v5 = Vec5({ x: 1, y: 2 });
  bench("free fn vAdd(a, b)", () => do_not_optimize(vAdd({ x: 1, y: 2 }, { x: 3, y: 4 }))).baseline(true);
  bench("cell5 Vec.add(a, b) (static)", () => do_not_optimize(Vec5.add({ x: 1, y: 2 }, { x: 3, y: 4 })));
  bench("cell5 v.add(b) (reactive)", () => do_not_optimize(v5.add({ x: 1, y: 2 })));
});

// ─── Workloads ───────────────────────────────────────────────────

group("Workload — 60-frame tween Vec (whole writes)", () => {
  bench("alien (signal + free fn)", () => {
    const v = aSig({ x: 0, y: 0 });
    let log = 0;
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      v(vScale({ x: 100, y: 100 }, t));
      log += v().x;
    }
    do_not_optimize(log);
  }).baseline(true);
  bench("cell5 Vec", () => {
    const v = Vec5({ x: 0, y: 0 });
    let log = 0;
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      v(Vec5.scale({ x: 100, y: 100 }, t));
      log += v().x;
    }
    do_not_optimize(log);
  });
});

group("Workload — effect on field (10 writes, fresh setup)", () => {
  bench("alien (signal + computed projection + effect)", () => {
    const v = aSig({ x: 0, y: 0 });
    const vx = aComp(() => v().x);
    let s = 0;
    const stop = aEff(() => { s += vx(); });
    for (let i = 0; i < 10; i++) { const cur = v(); v({ x: i, y: cur.y }); }
    stop();
    do_not_optimize(s);
  }).baseline(true);
  bench("cell5 Vec", () => {
    const v = Vec5({ x: 0, y: 0 });
    let s = 0;
    // The first v.x access materializes the lens.
    const stop = aEff(() => { s += v.x(); });
    for (let i = 0; i < 10; i++) v.x(i);
    stop();
    do_not_optimize(s);
  });
});

// ─── Memory ──────────────────────────────────────────────────────

function memDelta(label: string, factory: () => any): void {
  const N = 10_000;
  const gc = (globalThis as any).gc;
  if (typeof gc !== "function") {
    console.log(`  ${label.padEnd(40)}    (need --expose-gc)`);
    return;
  }
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const arr = new Array(N);
  for (let i = 0; i < N; i++) arr[i] = factory();
  gc();
  const after = process.memoryUsage().heapUsed;
  if (arr.length === 0) console.log("never");
  console.log(`  ${label.padEnd(40)} ${((after - before) / 1024).toFixed(1).padStart(8)} KB  /  ${((after - before) / N).toFixed(0).padStart(5)} B/cell`);
}

console.log("\n— Memory: 10,000 cells —");
memDelta("alien aSig(0)", () => aSig(0));
memDelta("cell4 signal(0)", () => s4(0));
memDelta("cell5 signal(0)", () => s5(0));
memDelta("alien aSig(Vec-init)", () => aSig({ x: 1, y: 2 }));
memDelta("cell4 Vec", () => Vec4({ x: 1, y: 2 }));
memDelta("cell5 Vec", () => Vec5({ x: 1, y: 2 }));
memDelta("alien aSig(Tr-init)", () => aSig(TR_NEW));
memDelta("cell4 Transform", () => Transform4(TR_NEW));
memDelta("cell5 Transform", () => Transform5(TR_NEW));

await run();
