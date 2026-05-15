// _broader.bench.ts — situate cell5/core in the broader reactivity space.
//
// Comparisons:
//   • bare alien (engine.ts)          — minimal reactive primitive
//   • preact-signals (vendored)       — the production minim uses this
//   • plain JS class Point            — non-reactive baseline
//   • plain object literal            — non-reactive baseline
//   • our core (cell5 merged)         — typed reactive struct
//
// Operations:
//   • Construct
//   • Read whole / field
//   • Write whole / field
//   • Method call (where applicable)
//   • Per-field subscription correctness
//   • Memory per cell
//
// Run: node --expose-gc --import tsx src/minim/signals2/_broader.bench.ts

import { bench, group, run, do_not_optimize } from "mitata";
import { signal as aSig } from "./engine";
import { signal as preactSignal, computed as preactComputed } from "../signals/signal";
import { signal as cSig, struct, type Cell, computed as cComp } from "./core";

interface V { x: number; y: number }

// ─── Our Vec (cell5/core) ───────────────────────────────────────────
const vAdd = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });

const Vec = struct({
  tag: "Vec",
  value: { x: 0, y: 0 } as V,
  methods: { add: vAdd, sub: vSub, scale: vScale },
  traits: { linear: { add: vAdd, sub: vSub, scale: vScale } },
});

// ─── Plain JS class equivalent ──────────────────────────────────────
class PointClass {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  add(b: V): PointClass { return new PointClass(this.x + b.x, this.y + b.y); }
  scale(k: number): PointClass { return new PointClass(this.x * k, this.y * k); }
}

// ─── Plain object literal (zero abstraction) ────────────────────────
function pointObj(x: number, y: number): V { return { x, y }; }
function pointObjAdd(a: V, b: V): V { return { x: a.x + b.x, y: a.y + b.y }; }

// ─── Preact-signals equivalent ──────────────────────────────────────
const preactVec = preactSignal({ x: 0, y: 0 });
// Preact doesn't have built-in per-field signals; users build them
// with computed: const x = computed(() => p.value.x).

// ═══════════════════════════════════════════════════════════════════
// BENCHES
// ═══════════════════════════════════════════════════════════════════

group("Construct", () => {
  bench("plain object   { x, y }", () => do_not_optimize(pointObj(1, 2))).baseline(true);
  bench("class          new PointClass()", () => do_not_optimize(new PointClass(1, 2)));
  bench("alien          aSig({x,y})", () => do_not_optimize(aSig({ x: 1, y: 2 })));
  bench("preact-signal  signal({x,y})", () => do_not_optimize(preactSignal({ x: 1, y: 2 })));
  bench("core           cSig({x,y})", () => do_not_optimize(cSig({ x: 1, y: 2 })));
  bench("core           Vec({x,y})", () => do_not_optimize(Vec({ x: 1, y: 2 })));
});

group("Read whole value", () => {
  const obj = pointObj(1, 2);
  const cls = new PointClass(1, 2);
  const aS = aSig({ x: 1, y: 2 });
  const pS = preactSignal({ x: 1, y: 2 });
  const cS = cSig({ x: 1, y: 2 });
  const v = Vec({ x: 1, y: 2 });
  bench("plain object   obj", () => do_not_optimize(obj)).baseline(true);
  bench("class          cls", () => do_not_optimize(cls));
  bench("alien          aS()", () => do_not_optimize(aS()));
  bench("preact-signal  pS.value", () => do_not_optimize(pS.value));
  bench("core           cS()", () => do_not_optimize(cS()));
  bench("core           v()", () => do_not_optimize(v()));
});

group("Read field x", () => {
  const obj = pointObj(1, 2);
  const cls = new PointClass(1, 2);
  const aS = aSig({ x: 1, y: 2 });
  const pS = preactSignal({ x: 1, y: 2 });
  // Preact-signal: build computed projection
  const pX = preactComputed(() => pS.value.x);
  // Our core: build computed projection bare
  const cS = cSig({ x: 1, y: 2 });
  const cX = cComp(() => cS().x);
  // Our struct (Vec field-lens)
  const v = Vec({ x: 1, y: 2 });
  void v.x;
  bench("plain object   obj.x", () => do_not_optimize(obj.x)).baseline(true);
  bench("class          cls.x", () => do_not_optimize(cls.x));
  bench("alien          aS().x", () => do_not_optimize(aS().x));
  bench("preact         pX.value (computed proj)", () => do_not_optimize(pX.value));
  bench("core           cX() (computed proj)", () => do_not_optimize(cX()));
  bench("core           v.x() (Vec field-lens)", () => do_not_optimize(v.x()));
});

group("Write field x (subscribers fire)", () => {
  const aS = aSig({ x: 1, y: 2 });
  const pS = preactSignal({ x: 1, y: 2 });
  const cS = cSig({ x: 1, y: 2 });
  const v = Vec({ x: 1, y: 2 });
  void v.x;
  let n = 0;
  bench("alien          aS({x:n, y:cur.y})", () => { const cur = aS(); aS({ x: ++n, y: cur.y }); }).baseline(true);
  bench("preact         pS.value = {x:n, y:cur.y}", () => { const cur = pS.value; pS.value = { x: ++n, y: cur.y }; });
  bench("core           cS({x:n, y:cur.y})", () => { const cur = cS(); cS({ x: ++n, y: cur.y }); });
  bench("core           v.x(n) (lens write)", () => v.x(++n));
});

group("Method call: cls.add(b)", () => {
  const cls = new PointClass(1, 2);
  const b: V = { x: 3, y: 4 };
  const v = Vec({ x: 1, y: 2 });
  bench("class          cls.add(b)", () => do_not_optimize(cls.add(b))).baseline(true);
  bench("plain          vAdd(obj, b)", () => do_not_optimize(vAdd({ x: 1, y: 2 }, b)));
  bench("core           Vec.add(a, b) (static)", () => do_not_optimize(Vec.add({ x: 1, y: 2 }, b)));
  bench("core           v.add(b) (reactive)", () => do_not_optimize(v.add(b)));
  bench("core           v.raw().add(b).value", () => do_not_optimize(v.raw().add(b).value));
  bench("core           Vec.chain(a).add(b).value", () => do_not_optimize(Vec.chain({ x: 1, y: 2 }).add(b).value));
});

// ─── Memory ────────────────────────────────────────────────────────

function memDelta(label: string, factory: () => any): void {
  const N = 10_000;
  const gc = (globalThis as any).gc;
  if (typeof gc !== "function") { console.log(`  ${label.padEnd(50)}  (need --expose-gc)`); return; }
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const arr = new Array(N);
  for (let i = 0; i < N; i++) arr[i] = factory();
  gc();
  const after = process.memoryUsage().heapUsed;
  if (arr.length === 0) console.log("never");
  console.log(`  ${label.padEnd(50)} ${((after - before) / N).toFixed(0).padStart(5)} B/cell`);
}

console.log("\n— Memory: 10,000 instances each —\n");
memDelta("plain object  { x, y }", () => pointObj(1, 2));
memDelta("class         new PointClass()", () => new PointClass(1, 2));
memDelta("alien         aSig({x,y})", () => aSig({ x: 1, y: 2 }));
memDelta("preact-signal signal({x,y})", () => preactSignal({ x: 1, y: 2 }));
memDelta("core          cSig({x,y})", () => cSig({ x: 1, y: 2 }));
memDelta("core          Vec({x,y})", () => Vec({ x: 1, y: 2 }));

void preactVec;

await run();
