// 4-way bench: minim-current (Signal+Computed split) vs minim-merged
// (Reactive prototype) vs alien-signals (function-bound) vs preact-signals
// (class-based with .value).
//
// Same workloads across all four. Helps calibrate where minim sits in
// the real signal-library landscape.
//
// Run:
//   node --expose-gc node_modules/.bin/vite-node \
//     src/minim/_proto-reactive/bench-4way.ts

import { bench, group, do_not_optimize, run } from "mitata";

// CURRENT minim (split)
import {
  signal as mSignal,
  computed as mComputed,
  effect as mEffect,
  batch as mBatch,
} from "../signals/signal";

// MERGED reactive prototype
import {
  signal as rSignal,
  computed as rComputed,
  effect as rEffect,
  batch as rBatch,
} from "./reactive";

// alien-signals (function-bound API)
import {
  signal as aSignal,
  computed as aComputed,
  effect as aEffect,
  startBatch as aStartBatch,
  endBatch as aEndBatch,
} from "alien-signals";

// preact-signals (class-based, .value)
import {
  signal as pSignal,
  computed as pComputed,
  effect as pEffect,
  batch as pBatch,
} from "@preact/signals-core";

// ─── Construction ────────────────────────────────────────────────────

group("CONSTRUCT: signal()", () => {
  bench("minim-current", () => do_not_optimize(mSignal(0))).baseline(true);
  bench("minim-merged", () => do_not_optimize(rSignal(0)));
  bench("alien-signals", () => do_not_optimize(aSignal(0)));
  bench("preact-signals", () => do_not_optimize(pSignal(0)));
});

group("CONSTRUCT: computed()", () => {
  const ms = mSignal(0);
  const rs = rSignal(0);
  const as = aSignal(0);
  const ps = pSignal(0);
  bench("minim-current", () => do_not_optimize(mComputed(() => ms.value * 2))).baseline(true);
  bench("minim-merged", () => do_not_optimize(rComputed(() => rs.value * 2)));
  bench("alien-signals", () => do_not_optimize(aComputed(() => as() * 2)));
  bench("preact-signals", () => do_not_optimize(pComputed(() => ps.value * 2)));
});

// ─── Read (untracked) ───────────────────────────────────────────────

{
  const ms = mSignal(5);
  const rs = rSignal(5);
  const as = aSignal(5);
  const ps = pSignal(5);
  group("READ: signal value (untracked, outside effect)", () => {
    bench("minim-current", () => do_not_optimize(ms.value)).baseline(true);
    bench("minim-merged", () => do_not_optimize(rs.value));
    bench("alien-signals", () => do_not_optimize(as()));
    bench("preact-signals", () => do_not_optimize(ps.value));
  });
}

// ─── Read (cached computed) ─────────────────────────────────────────

{
  const ms = mSignal(5);
  const mc = mComputed(() => ms.value * 2);
  void mc.value;

  const rs = rSignal(5);
  const rc = rComputed(() => rs.value * 2);
  void rc.value;

  const as = aSignal(5);
  const ac = aComputed(() => as() * 2);
  void ac();

  const ps = pSignal(5);
  const pc = pComputed(() => ps.value * 2);
  void pc.value;

  group("READ: computed cached", () => {
    bench("minim-current", () => do_not_optimize(mc.value)).baseline(true);
    bench("minim-merged", () => do_not_optimize(rc.value));
    bench("alien-signals", () => do_not_optimize(ac()));
    bench("preact-signals", () => do_not_optimize(pc.value));
  });
}

// ─── Write (no subs) ────────────────────────────────────────────────

{
  const ms = mSignal(0);
  const rs = rSignal(0);
  const as = aSignal(0);
  const ps = pSignal(0);
  let i = 0;
  group("WRITE: signal (no subscribers)", () => {
    bench("minim-current", () => { ms.value = ++i; }).baseline(true);
    bench("minim-merged", () => { rs.value = ++i; });
    bench("alien-signals", () => { as(++i); });
    bench("preact-signals", () => { ps.value = ++i; });
  });
}

// ─── Write + forced re-eval ─────────────────────────────────────────

{
  const ms = mSignal(0);
  const mc = mComputed(() => ms.value * 2);
  const rs = rSignal(0);
  const rc = rComputed(() => rs.value * 2);
  const as = aSignal(0);
  const ac = aComputed(() => as() * 2);
  const ps = pSignal(0);
  const pc = pComputed(() => ps.value * 2);
  let i = 0;
  group("WRITE+READ: forced re-eval of 1-deep computed", () => {
    bench("minim-current", () => { ms.value = ++i; do_not_optimize(mc.value); }).baseline(true);
    bench("minim-merged", () => { rs.value = ++i; do_not_optimize(rc.value); });
    bench("alien-signals", () => { as(++i); do_not_optimize(ac()); });
    bench("preact-signals", () => { ps.value = ++i; do_not_optimize(pc.value); });
  });
}

// ─── 10-deep computed chain ─────────────────────────────────────────

{
  const ms = mSignal(0);
  let mTail: { value: number } = ms;
  for (let i = 0; i < 10; i++) { const p = mTail; mTail = mComputed(() => p.value + 1); }
  void mTail.value;

  const rs = rSignal(0);
  let rTail: { value: number } = rs;
  for (let i = 0; i < 10; i++) { const p = rTail; rTail = rComputed(() => p.value + 1); }
  void rTail.value;

  const as = aSignal(0);
  let aTail: () => number = as;
  for (let i = 0; i < 10; i++) { const p = aTail; aTail = aComputed(() => p() + 1); }
  void aTail();

  const ps = pSignal(0);
  let pTail: { value: number } = ps;
  for (let i = 0; i < 10; i++) { const p = pTail; pTail = pComputed(() => p.value + 1); }
  void pTail.value;

  let i = 0;
  group("CHAIN: 10-deep write + read tail", () => {
    bench("minim-current", () => { ms.value = ++i; do_not_optimize(mTail.value); }).baseline(true);
    bench("minim-merged", () => { rs.value = ++i; do_not_optimize(rTail.value); });
    bench("alien-signals", () => { as(++i); do_not_optimize(aTail()); });
    bench("preact-signals", () => { ps.value = ++i; do_not_optimize(pTail.value); });
  });
}

// ─── Effect propagation ─────────────────────────────────────────────

{
  const ms = mSignal(0);
  const mc = mComputed(() => ms.value * 2);
  mEffect(() => { do_not_optimize(mc.value); });

  const rs = rSignal(0);
  const rc = rComputed(() => rs.value * 2);
  rEffect(() => { do_not_optimize(rc.value); });

  const as = aSignal(0);
  const ac = aComputed(() => as() * 2);
  aEffect(() => { do_not_optimize(ac()); });

  const ps = pSignal(0);
  const pc = pComputed(() => ps.value * 2);
  pEffect(() => { do_not_optimize(pc.value); });

  let i = 0;
  group("EFFECT: write src triggers 1 effect on computed", () => {
    bench("minim-current", () => { ms.value = ++i; }).baseline(true);
    bench("minim-merged", () => { rs.value = ++i; });
    bench("alien-signals", () => { as(++i); });
    bench("preact-signals", () => { ps.value = ++i; });
  });
}

// ─── Batched writes (10 writes, 1 effect) ───────────────────────────

{
  const ms = mSignal(0);
  mEffect(() => { do_not_optimize(ms.value); });
  const rs = rSignal(0);
  rEffect(() => { do_not_optimize(rs.value); });
  const as = aSignal(0);
  aEffect(() => { do_not_optimize(as()); });
  const ps = pSignal(0);
  pEffect(() => { do_not_optimize(ps.value); });
  let i = 0;
  group("BATCH: 10 writes inside batch, 1 effect", () => {
    bench("minim-current", () => {
      mBatch(() => { for (let k = 0; k < 10; k++) ms.value = ++i; });
    }).baseline(true);
    bench("minim-merged", () => {
      rBatch(() => { for (let k = 0; k < 10; k++) rs.value = ++i; });
    });
    bench("alien-signals", () => {
      aStartBatch();
      for (let k = 0; k < 10; k++) as(++i);
      aEndBatch();
    });
    bench("preact-signals", () => {
      pBatch(() => { for (let k = 0; k < 10; k++) ps.value = ++i; });
    });
  });
}

// ─── Diamond: 2 computeds reading same source, both subscribed ──────

{
  const ms = mSignal(0);
  const ma = mComputed(() => ms.value + 1);
  const mb = mComputed(() => ms.value * 2);
  mEffect(() => { do_not_optimize(ma.value + mb.value); });

  const rs = rSignal(0);
  const ra = rComputed(() => rs.value + 1);
  const rb = rComputed(() => rs.value * 2);
  rEffect(() => { do_not_optimize(ra.value + rb.value); });

  const as = aSignal(0);
  const aa = aComputed(() => as() + 1);
  const ab = aComputed(() => as() * 2);
  aEffect(() => { do_not_optimize(aa() + ab()); });

  const ps = pSignal(0);
  const pa = pComputed(() => ps.value + 1);
  const pb = pComputed(() => ps.value * 2);
  pEffect(() => { do_not_optimize(pa.value + pb.value); });

  let i = 0;
  group("DIAMOND: write src, 2 computeds + 1 effect", () => {
    bench("minim-current", () => { ms.value = ++i; }).baseline(true);
    bench("minim-merged", () => { rs.value = ++i; });
    bench("alien-signals", () => { as(++i); });
    bench("preact-signals", () => { ps.value = ++i; });
  });
}

await run({ format: "mitata" });
