// Bench Combo B against all the contenders.

import { bench, group, do_not_optimize, run } from "mitata";

// Combo B: alien-wrapped merged Reactive
import {
  signal as bSignal,
  computed as bComputed,
  effect as bEffect,
  batch as bBatch,
  derived as bDerived,
  Reactive,
} from "./reactive";

// Reference points
import {
  signal as mSignal,
  computed as mComputed,
  effect as mEffect,
  batch as mBatch,
} from "../signals/signal";
import { derived as mDerived } from "../signals/derive";
import {
  signal as rSignal,
  computed as rComputed,
  derived as rDerived,
} from "../_proto-reactive/reactive";
import {
  signal as aSignal,
  computed as aComputed,
  effect as aEffect,
  startBatch,
  endBatch,
} from "alien-signals";
import {
  signal as pSignal,
  computed as pComputed,
  effect as pEffect,
  batch as pBatch,
} from "@preact/signals-core";

import { LINEAR, type Linear } from "../signals/traits";

const vAdd = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  ({ x: a.x + b.x, y: a.y + b.y });
const vLinear: Linear<{ x: number; y: number }> = {
  add: vAdd,
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
};

// Vec for Combo B
class BVec extends Reactive<{ x: number; y: number }> {
  constructor(v: { x: number; y: number } = { x: 0, y: 0 }) { super(v); }
  get [LINEAR]() { return vLinear; }
}

// Warm
{
  const v = new BVec();
  void bDerived(BVec, () => vAdd(v.value, { x: 1, y: 1 })).value;
}

// ─── READS ────────────────────────────────────────────────────────────

{
  const m = mSignal(5); const r = rSignal(5); const b = bSignal(5);
  const a = aSignal(5); const p = pSignal(5);
  group("READ: signal.value (untracked)", () => {
    bench("alien raw (callable)", () => do_not_optimize(a())).baseline(true);
    bench("Combo B (alien-wrap + merged)", () => do_not_optimize(b.value));
    bench("preact", () => do_not_optimize(p.value));
    bench("minim-current", () => do_not_optimize(m.value));
    bench("minim-merged (own engine)", () => do_not_optimize(r.value));
  });
}

{
  const ms = mSignal(5); const mc = mComputed(() => ms.value * 2); void mc.value;
  const rs = rSignal(5); const rc = rComputed(() => rs.value * 2); void rc.value;
  const bs = bSignal(5); const bc = bComputed(() => bs.value * 2); void bc.value;
  const as = aSignal(5); const ac = aComputed(() => as() * 2); void ac();
  const ps = pSignal(5); const pc = pComputed(() => ps.value * 2); void pc.value;
  group("READ: computed cached", () => {
    bench("alien raw", () => do_not_optimize(ac())).baseline(true);
    bench("Combo B", () => do_not_optimize(bc.value));
    bench("preact", () => do_not_optimize(pc.value));
    bench("minim-current", () => do_not_optimize(mc.value));
    bench("minim-merged", () => do_not_optimize(rc.value));
  });
}

// ─── WRITES ──────────────────────────────────────────────────────────

{
  const m = mSignal(0); const r = rSignal(0); const b = bSignal(0);
  const a = aSignal(0); const p = pSignal(0);
  let i = 0;
  group("WRITE: signal (no subs)", () => {
    bench("alien raw", () => { a(++i); }).baseline(true);
    bench("Combo B", () => { b.value = ++i; });
    bench("preact", () => { p.value = ++i; });
    bench("minim-current", () => { m.value = ++i; });
    bench("minim-merged", () => { r.value = ++i; });
  });
}

{
  const ms = mSignal(0); const mc = mComputed(() => ms.value * 2);
  const rs = rSignal(0); const rc = rComputed(() => rs.value * 2);
  const bs = bSignal(0); const bc = bComputed(() => bs.value * 2);
  const as = aSignal(0); const ac = aComputed(() => as() * 2);
  const ps = pSignal(0); const pc = pComputed(() => ps.value * 2);
  let i = 0;
  group("WRITE+READ: forced re-eval", () => {
    bench("alien raw", () => { as(++i); do_not_optimize(ac()); }).baseline(true);
    bench("Combo B", () => { bs.value = ++i; do_not_optimize(bc.value); });
    bench("preact", () => { ps.value = ++i; do_not_optimize(pc.value); });
    bench("minim-current", () => { ms.value = ++i; do_not_optimize(mc.value); });
    bench("minim-merged", () => { rs.value = ++i; do_not_optimize(rc.value); });
  });
}

// ─── CHAINS ──────────────────────────────────────────────────────────

{
  // alien
  const as = aSignal(0);
  let aTail: () => number = as;
  for (let i = 0; i < 10; i++) { const p = aTail; aTail = aComputed(() => p() + 1); }
  void aTail();
  // Combo B
  const bs = bSignal(0);
  let bTail: { value: number } = bs;
  for (let i = 0; i < 10; i++) { const p = bTail; bTail = bComputed(() => p.value + 1); }
  void bTail.value;
  // preact
  const ps = pSignal(0);
  let pTail: { value: number } = ps;
  for (let i = 0; i < 10; i++) { const p = pTail; pTail = pComputed(() => p.value + 1); }
  void pTail.value;
  // minim
  const ms = mSignal(0);
  let mTail: { value: number } = ms;
  for (let i = 0; i < 10; i++) { const p = mTail; mTail = mComputed(() => p.value + 1); }
  void mTail.value;
  const rs = rSignal(0);
  let rTail: { value: number } = rs;
  for (let i = 0; i < 10; i++) { const p = rTail; rTail = rComputed(() => p.value + 1); }
  void rTail.value;

  let i = 0;
  group("CHAIN: 10-deep write + read tail", () => {
    bench("alien raw", () => { as(++i); do_not_optimize(aTail()); }).baseline(true);
    bench("Combo B", () => { bs.value = ++i; do_not_optimize(bTail.value); });
    bench("preact", () => { ps.value = ++i; do_not_optimize(pTail.value); });
    bench("minim-current", () => { ms.value = ++i; do_not_optimize(mTail.value); });
    bench("minim-merged", () => { rs.value = ++i; do_not_optimize(rTail.value); });
  });
}

// ─── EFFECT propagation ──────────────────────────────────────────────

{
  const ms = mSignal(0); const mc = mComputed(() => ms.value * 2);
  mEffect(() => { do_not_optimize(mc.value); });
  const rs = rSignal(0); const rc = rComputed(() => rs.value * 2);
  rEffect(() => { do_not_optimize(rc.value); });
  const bs = bSignal(0); const bc = bComputed(() => bs.value * 2);
  bEffect(() => { do_not_optimize(bc.value); });
  const as = aSignal(0); const ac = aComputed(() => as() * 2);
  aEffect(() => { do_not_optimize(ac()); });
  const ps = pSignal(0); const pc = pComputed(() => ps.value * 2);
  pEffect(() => { do_not_optimize(pc.value); });
  let i = 0;
  group("EFFECT: write src triggers 1 effect on computed", () => {
    bench("alien raw", () => { as(++i); }).baseline(true);
    bench("Combo B", () => { bs.value = ++i; });
    bench("preact", () => { ps.value = ++i; });
    bench("minim-current", () => { ms.value = ++i; });
    bench("minim-merged", () => { rs.value = ++i; });
  });
}

// Imports to silence
void rEffect; void mDerived; void rDerived;

import { effect as rEffect } from "../_proto-reactive/reactive";

// ─── CONSTRUCT ───────────────────────────────────────────────────────

group("CONSTRUCT: signal", () => {
  bench("alien raw", () => do_not_optimize(aSignal(0))).baseline(true);
  bench("Combo B", () => do_not_optimize(bSignal(0)));
  bench("preact", () => do_not_optimize(pSignal(0)));
  bench("minim-current", () => do_not_optimize(mSignal(0)));
  bench("minim-merged", () => do_not_optimize(rSignal(0)));
});

group("CONSTRUCT: computed", () => {
  const ms = mSignal(0); const rs = rSignal(0); const bs = bSignal(0);
  const as = aSignal(0); const ps = pSignal(0);
  bench("alien raw", () => do_not_optimize(aComputed(() => as() * 2))).baseline(true);
  bench("Combo B", () => do_not_optimize(bComputed(() => bs.value * 2)));
  bench("preact", () => do_not_optimize(pComputed(() => ps.value * 2)));
  bench("minim-current", () => do_not_optimize(mComputed(() => ms.value * 2))).baseline(false);
  bench("minim-merged", () => do_not_optimize(rComputed(() => rs.value * 2)));
});

group("CONSTRUCT: derived(Vec, fn) — value-type subclass", () => {
  const bv = new BVec({ x: 0, y: 0 });
  bench("Combo B", () => do_not_optimize(bDerived(BVec, () => vAdd(bv.value, { x: 1, y: 1 })))).baseline(true);
  // (current minim derived(Vec) ~65ns; merged ~40ns; both shown elsewhere)
});

// Reference helpers used elsewhere
void mBatch; void bBatch; void pBatch; void startBatch; void endBatch;

await run({ format: "mitata" });
