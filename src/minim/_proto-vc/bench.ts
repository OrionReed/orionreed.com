// Bench: setPrototypeOf hack vs Symbol.hasInstance approach.
//
// Hypothesis: the new approach is at least as fast for everything,
// and may be FASTER for property access on derived instances (since
// setPrototypeOf is known to deopt V8 hidden classes).
//
// Run:
//   node --expose-gc node_modules/.bin/vite-node \
//     src/minim/_proto-vc/bench.ts

import { bench, group, do_not_optimize, run } from "mitata";
import { Signal, effect } from "../signals/signal";
import { LINEAR, type Linear } from "../signals/traits";
import { derived as derivedV1 } from "./derive-vc";   // Symbol.hasInstance
import { derived as derivedV2 } from "./derive-vc2";  // Inverted inheritance
import { derived as derivedOld } from "../signals/derive";

const derivedNew = derivedV2;  // bench v2 by default
void derivedV1;

const vAdd = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: { x: number; y: number }, k: number) =>
  ({ x: a.x * k, y: a.y * k });
const vLinear: Linear<{ x: number; y: number }> = { add: vAdd, sub: vSub, scale: vScale };

class Vec extends Signal<{ x: number; y: number }> {
  constructor(v = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
  add(b: { x: number; y: number }): Vec {
    return derivedOld(Vec, () => vAdd(this.value, b));
  }
}
class VecB extends Signal<{ x: number; y: number }> {
  constructor(v = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
  add(b: { x: number; y: number }): VecB {
    return derivedNew(VecB, () => vAdd(this.value, b));
  }
}

// Force both view classes to be synthesized once before benching.
{
  const v = new Vec({ x: 0, y: 0 });
  const d = derivedOld(Vec, () => vAdd(v.value, { x: 1, y: 1 }));
  do_not_optimize(d.value);
  const vb = new VecB({ x: 0, y: 0 });
  const db = derivedNew(VecB, () => vAdd(vb.value, { x: 1, y: 1 }));
  do_not_optimize(db.value);
}

// ─── instanceof check perf ────────────────────────────────────────────

{
  const v = new Vec({ x: 1, y: 2 });
  const d = derivedOld(Vec, () => vAdd(v.value, { x: 1, y: 1 }));
  const vb = new VecB({ x: 1, y: 2 });
  const db = derivedNew(VecB, () => vAdd(vb.value, { x: 1, y: 1 }));

  group("instanceof Vec", () => {
    bench("OLD (setPrototypeOf): literal", () => do_not_optimize(v instanceof Vec)).baseline(true);
    bench("OLD (setPrototypeOf): derived", () => do_not_optimize(d instanceof Vec));
    bench("V2 (extends Cls): literal", () => do_not_optimize(vb instanceof VecB));
    bench("V2 (extends Cls): derived", () => do_not_optimize(db instanceof VecB));
  });
}

// ─── Construction: derived view ──────────────────────────────────────

{
  const v = new Vec({ x: 1, y: 2 });
  const vb = new VecB({ x: 1, y: 2 });
  group("construct derived(Vec, fn)", () => {
    bench("OLD", () => do_not_optimize(derivedOld(Vec, () => vAdd(v.value, { x: 1, y: 1 })))).baseline(true);
    bench("V2", () => do_not_optimize(derivedNew(VecB, () => vAdd(vb.value, { x: 1, y: 1 }))));
  });
}

// ─── Read perf — cached .value ───────────────────────────────────────

{
  const v = new Vec({ x: 1, y: 2 });
  const d = derivedOld(Vec, () => vAdd(v.value, { x: 1, y: 1 }));
  void d.value;  // warm cache
  const vb = new VecB({ x: 1, y: 2 });
  const db = derivedNew(VecB, () => vAdd(vb.value, { x: 1, y: 1 }));
  void db.value;
  group("read cached derived.value", () => {
    bench("OLD", () => do_not_optimize(d.value)).baseline(true);
    bench("V2", () => do_not_optimize(db.value));
  });
}

// ─── Read perf — forced re-eval (write-then-read) ────────────────────

{
  const v = new Vec({ x: 1, y: 2 });
  const d = derivedOld(Vec, () => vAdd(v.value, { x: 1, y: 1 }));
  const vb = new VecB({ x: 1, y: 2 });
  const db = derivedNew(VecB, () => vAdd(vb.value, { x: 1, y: 1 }));
  let i = 0;
  group("forced re-eval: write source, read derived", () => {
    bench("OLD", () => { v.value = { x: ++i, y: i }; do_not_optimize(d.value); }).baseline(true);
    bench("V2", () => { vb.value = { x: ++i, y: i }; do_not_optimize(db.value); });
  });
}

// ─── Trait slot access on derived ────────────────────────────────────

{
  const v = new Vec({ x: 1, y: 2 });
  const d = derivedOld(Vec, () => vAdd(v.value, { x: 1, y: 1 }));
  const vb = new VecB({ x: 1, y: 2 });
  const db = derivedNew(VecB, () => vAdd(vb.value, { x: 1, y: 1 }));
  group("derived[LINEAR] access (prototype walk)", () => {
    bench("OLD", () => do_not_optimize(d[LINEAR])).baseline(true);
    bench("V2", () => do_not_optimize(db[LINEAR]));
  });
}

// ─── Method call on derived (chained) ────────────────────────────────

{
  const v = new Vec({ x: 1, y: 2 });
  const d = derivedOld(Vec, () => vAdd(v.value, { x: 1, y: 1 }));
  const vb = new VecB({ x: 1, y: 2 });
  const db = derivedNew(VecB, () => vAdd(vb.value, { x: 1, y: 1 }));
  group("derived.add() (method dispatch + construct)", () => {
    bench("OLD", () => do_not_optimize(d.add({ x: 1, y: 0 }))).baseline(true);
    bench("V2", () => do_not_optimize(db.add({ x: 1, y: 0 })));
  });
}

// ─── Effect propagation through derived ──────────────────────────────

{
  const v = new Vec({ x: 1, y: 2 });
  const d = derivedOld(Vec, () => vAdd(v.value, { x: 1, y: 1 }));
  effect(() => { do_not_optimize(d.value); });
  const vb = new VecB({ x: 1, y: 2 });
  const db = derivedNew(VecB, () => vAdd(vb.value, { x: 1, y: 1 }));
  effect(() => { do_not_optimize(db.value); });
  let i = 0;
  group("write source with 1 effect on derived", () => {
    bench("OLD", () => { v.value = { x: ++i, y: i }; }).baseline(true);
    bench("V2", () => { vb.value = { x: ++i, y: i }; });
  });
}

await run({ format: "mitata" });
