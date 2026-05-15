// _real_world.bench.ts — realistic workload patterns.
//
// 1. Animation tween (60-frame Vec interpolation with subscriber).
// 2. Drag handler (mouse signal → field write, tight loop).
// 3. Scene update (N cells, partial invalidation).
// 4. Composite tween (Transform fields interpolated independently).
// 5. Steady-state read (cached, frequent .value access).

import { bench, printRow, measureMemory } from "./_bench_utils";

// Comparison: struct3 (class) vs core (callable bind).
import { struct as struct3, signal as s3, effect as e3 } from "./struct3";
import { struct as struct1, signal as s1, effect as e1 } from "./core";

interface V { x: number; y: number }
const vAdd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const vLerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

const V3 = struct3({
  tag: "Vec", value: { x: 0, y: 0 } as V,
  methods: { add: vAdd, sub: vSub, scale: vScale, lerp: vLerp },
});
const V1 = struct1({
  tag: "Vec", value: { x: 0, y: 0 } as V,
  methods: { add: vAdd, sub: vSub, scale: vScale, lerp: vLerp },
});

// ─── 1. Animation tween: 60-frame Vec interpolation w/ subscriber ──

console.log("\n── Workload: 60-frame tween Vec (with effect subscriber) ──");
printRow(bench("core   tween+effect (60 frames)", () => {
  const v = V1({ x: 0, y: 0 });
  const target: V = { x: 100, y: 100 };
  let log = 0;
  const stop = e1(() => { log += (v as any)().x; });
  for (let i = 1; i <= 60; i++) {
    const t = i / 60;
    (v as any)({ x: target.x * t, y: target.y * t });
  }
  stop();
  return log;
}, { iters: 50_000 }));

printRow(bench("struct3 tween+effect (60 frames)", () => {
  const v = V3({ x: 0, y: 0 });
  const target: V = { x: 100, y: 100 };
  let log = 0;
  const stop = e3(() => { log += v.value.x; });
  for (let i = 1; i <= 60; i++) {
    const t = i / 60;
    v.value = { x: target.x * t, y: target.y * t };
  }
  stop();
  return log;
}, { iters: 50_000 }));

// ─── 2. Drag handler: tight field-write loop ──────────────────────

console.log("\n── Workload: drag-handler simulation (100 field writes) ──");
printRow(bench("core   drag (100 v.x writes)", () => {
  const v: any = V1({ x: 0, y: 0 });
  void v.x;
  for (let i = 0; i < 100; i++) v.x(i);
  return v();
}, { iters: 100_000 }));

printRow(bench("struct3 drag (100 v.x writes)", () => {
  const v = V3({ x: 0, y: 0 });
  for (let i = 0; i < 100; i++) v.x.value = i;
  return v.value;
}, { iters: 100_000 }));

// ─── 3. Scene update: 100 cells, write one, only one effect fires ─

console.log("\n── Workload: 100-cell scene, write one ──");
printRow(bench("core   100 cells, write one", () => {
  const cells = Array.from({ length: 100 }, () => V1({ x: 0, y: 0 }));
  const fires = new Array(100).fill(0);
  const disposers = cells.map((c, i) => e1(() => { (c as any)(); fires[i]++; }));
  (cells[50] as any)({ x: 99, y: 99 });
  disposers.forEach(d => d());
  return fires[50];
}, { iters: 5_000 }));

printRow(bench("struct3 100 cells, write one", () => {
  const cells = Array.from({ length: 100 }, () => V3({ x: 0, y: 0 }));
  const fires = new Array(100).fill(0);
  const disposers = cells.map((c, i) => e3(() => { void c.value; fires[i]++; }));
  cells[50].value = { x: 99, y: 99 };
  disposers.forEach(d => d());
  return fires[50];
}, { iters: 5_000 }));

// ─── 4. Composite tween: Transform with 4 fields ────────────────

console.log("\n── Workload: composite Transform tween ──");
interface Tr { translate: V; scale: V; rotate: number; opacity: number }
const trAdd = (a: Tr, b: Tr): Tr => ({
  translate: vAdd(a.translate, b.translate),
  scale: vAdd(a.scale, b.scale),
  rotate: a.rotate + b.rotate,
  opacity: a.opacity + b.opacity,
});
const T3 = struct3({
  tag: "Transform",
  value: { translate: V3, scale: V3.with({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  methods: { add: trAdd },
});
const T1 = struct1({
  tag: "Transform",
  value: { translate: V1 as any, scale: (V1 as any).with({ x: 1, y: 1 }), rotate: 0, opacity: 1 },
  methods: { add: trAdd },
});

printRow(bench("core   Transform tween (60 frames)", () => {
  const tr: any = T1();
  let log = 0;
  const stop = e1(() => { log += tr().opacity; });
  for (let i = 1; i <= 60; i++) tr({ ...tr(), opacity: i / 60 });
  stop();
  return log;
}, { iters: 20_000 }));

printRow(bench("struct3 Transform tween (60 frames)", () => {
  const tr = T3();
  let log = 0;
  const stop = e3(() => { log += tr.value.opacity; });
  for (let i = 1; i <= 60; i++) tr.value = { ...tr.value, opacity: i / 60 };
  stop();
  return log;
}, { iters: 20_000 }));

// ─── 5. Steady-state cached read ──────────────────────────────────

console.log("\n── Steady-state: cached .value access in hot loop ──");
{
  const v1: any = V1({ x: 5, y: 10 });
  const v3 = V3({ x: 5, y: 10 });
  printRow(bench("core   v.x() cached read", () => v1.x(), { iters: 20_000_000 }));
  printRow(bench("struct3 v.x.value cached read", () => v3.x.value, { iters: 20_000_000 }));
}

// ─── 6. Memory: 1000-cell scene ─────────────────────────────────

console.log("\n── Memory: full scene ──");
measureMemory("core   1k Vec cells", () => V1({ x: 1, y: 2 }), 1000);
measureMemory("struct3 1k Vec cells", () => V3({ x: 1, y: 2 }), 1000);
measureMemory("core   1k Transform cells", () => T1({} as any), 1000);
measureMemory("struct3 1k Transform cells", () => T3(), 1000);
