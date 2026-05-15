// _struct3_vs_struct.bench.ts — class-based struct vs callable-based.

import { bench, printRow, measureMemory } from "./_bench_utils";
import { struct as struct1, effect as e1 } from "./core";
import { struct as struct3, effect as e3 } from "./struct3";

interface V { x: number; y: number }
const vAdd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });

const V1 = struct1({ tag: "Vec", value: { x: 0, y: 0 } as V,
  methods: { add: vAdd, sub: vSub, scale: vScale } });
const V3 = struct3({ tag: "Vec", value: { x: 0, y: 0 } as V,
  methods: { add: vAdd, sub: vSub, scale: vScale } });

console.log("\n── Vec construction ──");
printRow(bench("core   Vec({x,y})", () => V1({ x: 1, y: 2 }), { iters: 1_000_000 }));
printRow(bench("struct3 Vec({x,y})", () => V3({ x: 1, y: 2 }), { iters: 5_000_000 }));

console.log("\n── Vec whole read ──");
{
  const v1: any = V1({ x: 1, y: 2 });
  const v3 = V3({ x: 1, y: 2 });
  printRow(bench("core   v1()", () => v1(), { iters: 10_000_000 }));
  printRow(bench("struct3 v3.value", () => v3.value, { iters: 10_000_000 }));
}

console.log("\n── Vec field read (lens) ──");
{
  const v1: any = V1({ x: 1, y: 2 });
  const v3 = V3({ x: 1, y: 2 });
  void v1.x; void v3.x;
  printRow(bench("core   v1.x()", () => v1.x(), { iters: 5_000_000 }));
  printRow(bench("struct3 v3.x.value", () => v3.x.value, { iters: 5_000_000 }));
}

console.log("\n── Vec field write ──");
{
  const v1: any = V1({ x: 1, y: 2 });
  const v3 = V3({ x: 1, y: 2 });
  void v1.x; void v3.x;
  let n = 0;
  printRow(bench("core   v1.x(n)", () => v1.x(++n), { iters: 2_000_000 }));
  printRow(bench("struct3 v3.x.value = n", () => { v3.x.value = ++n; }, { iters: 2_000_000 }));
}

console.log("\n── Reactive method ──");
{
  const v1: any = V1({ x: 1, y: 2 });
  const v3 = V3({ x: 1, y: 2 });
  const b: V = { x: 3, y: 4 };
  printRow(bench("core   v1.add(b)", () => v1.add(b), { iters: 500_000 }));
  printRow(bench("struct3 v3.add(b)", () => v3.add(b), { iters: 500_000 }));
}

console.log("\n── Workload: effect on Vec.x, 60 writes ──");
printRow(bench("core   effect+60 v.x writes", () => {
  const v: any = V1({ x: 0, y: 0 });
  void v.x;
  let s = 0;
  const stop = e1(() => { s += v.x(); });
  for (let i = 0; i < 60; i++) v.x(i);
  stop();
  return s;
}, { iters: 50_000 }));

printRow(bench("struct3 effect+60 v.x writes", () => {
  const v = V3({ x: 0, y: 0 });
  void v.x;
  let s = 0;
  const stop = e3(() => { s += v.x.value; });
  for (let i = 0; i < 60; i++) v.x.value = i;
  stop();
  return s;
}, { iters: 50_000 }));

console.log("\n── Memory: 10k Vec instances each ──");
measureMemory("core   Vec({x,y})", () => V1({ x: 1, y: 2 }));
measureMemory("struct3 Vec({x,y})", () => V3({ x: 1, y: 2 }));
