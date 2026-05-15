// _core2_vs_core.bench.ts — head-to-head bind-based vs closure-based.

import { bench, printRow, measureMemory } from "./_bench_utils";
import { signal as s1, computed as c1, effect as e1, struct as struct1 } from "./core";
import { signal as s2, computed as c2, effect as e2, struct as struct2 } from "./core2";

interface V { x: number; y: number }
const vAdd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });

const V1 = struct1({ tag: "Vec", value: { x: 0, y: 0 } as V, methods: { add: vAdd } });
const V2 = struct2({ tag: "Vec", value: { x: 0, y: 0 } as V, methods: { add: vAdd } });

// ─── Construction ──────────────────────────────────────────────────

console.log("\n── Bare signal construction ──");
printRow(bench("core  (bind-based)   signal(0)", () => s1(0), { iters: 1_000_000 }));
printRow(bench("core2 (closure-based) signal(0)", () => s2(0), { iters: 5_000_000 }));

console.log("\n── Bare computed construction ──");
printRow(bench("core  computed(() => 1)", () => c1(() => 1), { iters: 1_000_000 }));
printRow(bench("core2 computed(() => 1)", () => c2(() => 1), { iters: 2_000_000 }));

console.log("\n── Vec construction (struct cell) ──");
printRow(bench("core  Vec({x,y})", () => V1({ x: 1, y: 2 })));
printRow(bench("core2 Vec({x,y})", () => V2({ x: 1, y: 2 })));

// ─── Reads ────────────────────────────────────────────────────────

console.log("\n── Signal read ──");
{
  const a1 = s1({ x: 1, y: 2 });
  const a2 = s2({ x: 1, y: 2 });
  printRow(bench("core  a()", () => a1(), { iters: 10_000_000 }));
  printRow(bench("core2 a()", () => a2(), { iters: 10_000_000 }));
}

console.log("\n── Computed read (cached) ──");
{
  const a1 = s1({ x: 1, y: 2 });
  const p1 = c1(() => a1().x);
  const a2 = s2({ x: 1, y: 2 });
  const p2 = c2(() => a2().x);
  printRow(bench("core  p()", () => p1(), { iters: 10_000_000 }));
  printRow(bench("core2 p()", () => p2(), { iters: 10_000_000 }));
}

console.log("\n── Vec field read (lens) ──");
{
  const v1: any = V1({ x: 1, y: 2 });
  const v2: any = V2({ x: 1, y: 2 });
  void v1.x; void v2.x;
  printRow(bench("core  v.x()", () => v1.x()));
  printRow(bench("core2 v.x()", () => v2.x()));
}

console.log("\n── Vec field write ──");
{
  const v1: any = V1({ x: 1, y: 2 });
  const v2: any = V2({ x: 1, y: 2 });
  void v1.x; void v2.x;
  let n = 0;
  printRow(bench("core  v.x(n)", () => v1.x(++n)));
  printRow(bench("core2 v.x(n)", () => v2.x(++n)));
}

// ─── Effect setup + write ────────────────────────────────────────

console.log("\n── Effect: setup + 60 writes + dispose ──");
{
  printRow(bench("core  effect+60 writes", () => {
    const sig = s1(0);
    let s = 0;
    const stop = e1(() => { s += sig(); });
    for (let i = 0; i < 60; i++) sig(i);
    stop();
    return s;
  }, { iters: 100_000 }));
  printRow(bench("core2 effect+60 writes", () => {
    const sig = s2(0);
    let s = 0;
    const stop = e2(() => { s += sig(); });
    for (let i = 0; i < 60; i++) sig(i);
    stop();
    return s;
  }, { iters: 100_000 }));
}

// ─── Memory ──────────────────────────────────────────────────────

console.log("\n── Memory ──");
measureMemory("core  signal(0)", () => s1(0));
measureMemory("core2 signal(0)", () => s2(0));
measureMemory("core  Vec({x,y})", () => V1({ x: 1, y: 2 }));
measureMemory("core2 Vec({x,y})", () => V2({ x: 1, y: 2 }));
