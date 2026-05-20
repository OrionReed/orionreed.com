// Bench: merged Reactive class vs current Signal+Computed split.
//
// Key question: does the `if (this.getter !== undefined)` branch in
// the value getter cost meaningful perf? V8 inline caches *should*
// optimize a monomorphic site well — the answer determines whether
// the merged design is shippable.
//
// Run:
//   node --expose-gc node_modules/.bin/vite-node \
//     src/minim/_proto-reactive/bench.ts

import { bench, group, do_not_optimize, run } from "mitata";

// NEW: merged Reactive (branch in value getter)
import {
  Reactive,
  signal as signalNew,
  computed as computedNew,
  effect as effectNew,
  derived as derivedNew,
} from "./reactive";

// NEW2: merged Reactive with per-instance value getter (no branch)
import {
  Reactive as Reactive2,
  signal as signalNew2,
  computed as computedNew2,
  effect as effectNew2,
  derived as derivedNew2,
} from "./reactive2";

// NEW3: merged Reactive, split methods (thin dispatcher inlines)
import {
  Reactive as Reactive3,
  signal as signalNew3,
  computed as computedNew3,
  effect as effectNew3,
  derived as derivedNew3,
} from "./reactive3";

void effectNew2; void effectNew3; void derivedNew3;

// OLD: split Signal + Computed
import {
  Signal,
  signal as signalOld,
  computed as computedOld,
  effect as effectOld,
} from "../signals/signal";
import { derived as derivedOld } from "../signals/derive";
import { LINEAR, type Linear } from "../signals/traits";

const vAdd = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x + b.x, y: a.y + b.y });
const vSub = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x - b.x, y: a.y - b.y });
const vScale = (a: { x: number; y: number }, k: number) =>
  ({ x: a.x * k, y: a.y * k });
const vLinear: Linear<{ x: number; y: number }> = { add: vAdd, sub: vSub, scale: vScale };

class VecOld extends Signal<{ x: number; y: number }> {
  constructor(v = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
}
class VecNew extends Reactive<{ x: number; y: number }> {
  constructor(v = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
}
class VecNew2 extends Reactive2<{ x: number; y: number }> {
  constructor(v = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
}

// Warm view-class caches
{
  const v = new VecOld({ x: 0, y: 0 });
  void derivedOld(VecOld, () => vAdd(v.value, { x: 1, y: 1 })).value;
  const vn = new VecNew({ x: 0, y: 0 });
  void derivedNew(VecNew, () => vAdd(vn.value, { x: 1, y: 1 })).value;
  const vn2 = new VecNew2({ x: 0, y: 0 });
  void derivedNew2(VecNew2, () => vAdd(vn2.value, { x: 1, y: 1 })).value;
}

// ─── HOT PATH: signal reads (the branch cost question) ──────────────

{
  const sOld = signalOld(5);
  const sNew = signalNew(5);
  const sNew2 = signalNew2(5);
  const sNew3 = signalNew3(5);
  group("HOT: signal.value (untracked)", () => {
    bench("OLD (Signal)", () => do_not_optimize(sOld.value)).baseline(true);
    bench("NEW (branch)", () => do_not_optimize(sNew.value));
    bench("NEW2 (per-inst getter)", () => do_not_optimize(sNew2.value));
    bench("NEW3 (split methods)", () => do_not_optimize(sNew3.value));
  });
}

{
  const sOld = signalOld(0);
  const sNew = signalNew(0);
  const sNew2 = signalNew2(0);
  let i = 0;
  group("HOT: signal.value = i (write)", () => {
    bench("OLD", () => { sOld.value = ++i; }).baseline(true);
    bench("NEW", () => { sNew.value = ++i; });
    bench("NEW2", () => { sNew2.value = ++i; });
  });
}

// ─── Computed reads (cached + forced) ────────────────────────────────

{
  const sOld = signalOld(5);
  const cOld = computedOld(() => sOld.value * 2);
  void cOld.value;
  const sNew = signalNew(5);
  const cNew = computedNew(() => sNew.value * 2);
  void cNew.value;
  const sNew2 = signalNew2(5);
  const cNew2 = computedNew2(() => sNew2.value * 2);
  void cNew2.value;
  const sNew3 = signalNew3(5);
  const cNew3 = computedNew3(() => sNew3.value * 2);
  void cNew3.value;
  group("HOT: computed.value (cached)", () => {
    bench("OLD", () => do_not_optimize(cOld.value)).baseline(true);
    bench("NEW", () => do_not_optimize(cNew.value));
    bench("NEW2", () => do_not_optimize(cNew2.value));
    bench("NEW3", () => do_not_optimize(cNew3.value));
  });
}

{
  const sOld = signalOld(0);
  const cOld = computedOld(() => sOld.value * 2);
  const sNew = signalNew(0);
  const cNew = computedNew(() => sNew.value * 2);
  const sNew2 = signalNew2(0);
  const cNew2 = computedNew2(() => sNew2.value * 2);
  const sNew3 = signalNew3(0);
  const cNew3 = computedNew3(() => sNew3.value * 2);
  let i = 0;
  group("HOT: write src, read computed (forced re-eval)", () => {
    bench("OLD", () => { sOld.value = ++i; do_not_optimize(cOld.value); }).baseline(true);
    bench("NEW", () => { sNew.value = ++i; do_not_optimize(cNew.value); });
    bench("NEW2", () => { sNew2.value = ++i; do_not_optimize(cNew2.value); });
    bench("NEW3", () => { sNew3.value = ++i; do_not_optimize(cNew3.value); });
  });
}

// ─── 4-deep computed chain (real-world style) ────────────────────────

{
  const sOld = signalOld(0);
  const a = computedOld(() => sOld.value + 1);
  const b = computedOld(() => a.value * 2);
  const c = computedOld(() => b.value - 3);
  const d = computedOld(() => c.value + 10);
  void d.value;
  const sNew = signalNew(0);
  const an = computedNew(() => sNew.value + 1);
  const bn = computedNew(() => an.value * 2);
  const cn = computedNew(() => bn.value - 3);
  const dn = computedNew(() => cn.value + 10);
  void dn.value;
  const sNew2 = signalNew2(0);
  const a2 = computedNew2(() => sNew2.value + 1);
  const b2 = computedNew2(() => a2.value * 2);
  const c2 = computedNew2(() => b2.value - 3);
  const d2 = computedNew2(() => c2.value + 10);
  void d2.value;
  const sNew3 = signalNew3(0);
  const a3 = computedNew3(() => sNew3.value + 1);
  const b3 = computedNew3(() => a3.value * 2);
  const c3 = computedNew3(() => b3.value - 3);
  const d3 = computedNew3(() => c3.value + 10);
  void d3.value;
  let i = 0;
  group("4-deep chain: write src, read tail", () => {
    bench("OLD", () => { sOld.value = ++i; do_not_optimize(d.value); }).baseline(true);
    bench("NEW", () => { sNew.value = ++i; do_not_optimize(dn.value); });
    bench("NEW2", () => { sNew2.value = ++i; do_not_optimize(d2.value); });
    bench("NEW3", () => { sNew3.value = ++i; do_not_optimize(d3.value); });
  });
}

// ─── derived(Vec, fn) construction ──────────────────────────────────

{
  const v = new VecOld({ x: 0, y: 0 });
  const vn = new VecNew({ x: 0, y: 0 });
  group("construct derived(Vec, fn)", () => {
    bench("OLD (viewClassFor + setPrototypeOf)", () =>
      do_not_optimize(derivedOld(VecOld, () => vAdd(v.value, { x: 1, y: 1 })))).baseline(true);
    bench("NEW (just `new Vec(); set getter`)", () =>
      do_not_optimize(derivedNew(VecNew, () => vAdd(vn.value, { x: 1, y: 1 }))));
  });
}

// ─── derived(Vec, fn).value (cached) ────────────────────────────────

{
  const v = new VecOld({ x: 0, y: 0 });
  const d = derivedOld(VecOld, () => vAdd(v.value, { x: 1, y: 1 }));
  void d.value;
  const vn = new VecNew({ x: 0, y: 0 });
  const dn = derivedNew(VecNew, () => vAdd(vn.value, { x: 1, y: 1 }));
  void dn.value;
  group("derived(Vec).value (cached)", () => {
    bench("OLD", () => do_not_optimize(d.value)).baseline(true);
    bench("NEW", () => do_not_optimize(dn.value));
  });
}

// ─── instanceof Vec on derived ──────────────────────────────────────

{
  const v = new VecOld({ x: 0, y: 0 });
  const d = derivedOld(VecOld, () => vAdd(v.value, { x: 1, y: 1 }));
  const vn = new VecNew({ x: 0, y: 0 });
  const dn = derivedNew(VecNew, () => vAdd(vn.value, { x: 1, y: 1 }));
  group("instanceof Vec on derived", () => {
    bench("OLD", () => do_not_optimize(d instanceof VecOld)).baseline(true);
    bench("NEW", () => do_not_optimize(dn instanceof VecNew));
  });
}

// ─── Effect propagation ─────────────────────────────────────────────

{
  const sOld = signalOld(0);
  const cOld = computedOld(() => sOld.value * 2);
  effectOld(() => { do_not_optimize(cOld.value); });
  const sNew = signalNew(0);
  const cNew = computedNew(() => sNew.value * 2);
  effectNew(() => { do_not_optimize(cNew.value); });
  let i = 0;
  group("write src with effect on computed", () => {
    bench("OLD", () => { sOld.value = ++i; }).baseline(true);
    bench("NEW", () => { sNew.value = ++i; });
  });
}

// ─── Construction cost ─────────────────────────────────────────────

group("construct signal()", () => {
  bench("OLD signal(0)", () => do_not_optimize(signalOld(0))).baseline(true);
  bench("NEW signal(0)", () => do_not_optimize(signalNew(0)));
});

group("construct computed()", () => {
  const sOld = signalOld(0);
  const sNew = signalNew(0);
  bench("OLD", () => do_not_optimize(computedOld(() => sOld.value * 2))).baseline(true);
  bench("NEW", () => do_not_optimize(computedNew(() => sNew.value * 2)));
});

await run({ format: "mitata" });
