// Perf comparison: invertible chain prototype vs. current value-type
// implementation. The chain adds a small per-call overhead from
// allocating step records and the `via()` fwd/bwd compilation; we want
// to size it against actual usage patterns.
//
// Run:
//   node --expose-gc node_modules/.bin/vite-node src/minim/_proto-iso/bench.ts

import { bench, group, do_not_optimize, run } from "mitata";

// Current (production) imports
import {
  num as numOld,
  vec as vecOld,
  mean as meanOld,
} from "../signals/values";
import { signal, effect } from "../signals/signal";

// Prototype imports
import { num as numNew } from "./num";
import { vec as vecNew } from "./vec";
import { mean as meanNew } from "./joint";

// ── Construction of writable views ─────────────────────────────────

group("construct .add lens (writable view)", () => {
  const nOld = numOld(5);
  const nNew = numNew(5);
  bench("old: numOld.add(3)", () => do_not_optimize(nOld.add(3))).baseline(true);
  bench("new: numNew.add(3)", () => do_not_optimize(nNew.add(3)));
});

group("construct chain (3 steps)", () => {
  const nOld = numOld(5);
  const nNew = numNew(5);
  bench("old: derive(c => c.add(1).scale(2).sub(3))", () => {
    do_not_optimize(nOld.derive((c) => c.add(1).scale(2).sub(3)));
  }).baseline(true);
  bench("new: derive(c => c.add(1).scale(2).sub(3))", () => {
    do_not_optimize(nNew.derive((c) => c.add(1).scale(2).sub(3)));
  });
});

// ── Read perf (cached / fresh) ─────────────────────────────────────

group("read .add(3).value (cached)", () => {
  const nOld = numOld(5);
  const aOld = nOld.add(3);
  void aOld.value; // warm cache

  const nNew = numNew(5);
  const aNew = nNew.add(3);
  void aNew.value;

  bench("old", () => do_not_optimize(aOld.value)).baseline(true);
  bench("new", () => do_not_optimize(aNew.value));
});

group("read .add(3).value (forced re-eval each iter)", () => {
  const nOld = numOld(5);
  const aOld = nOld.add(3);
  const nNew = numNew(5);
  const aNew = nNew.add(3);
  let i = 0;
  bench("old", () => { nOld.value = ++i; do_not_optimize(aOld.value); }).baseline(true);
  bench("new", () => { nNew.value = ++i; do_not_optimize(aNew.value); });
});

// ── Write perf ──────────────────────────────────────────────────────

group("write .add(3).value (1 step, no subs)", () => {
  // New: invertible chain writes by routing through bwd. Old: read-only,
  // so writes throw. We benchmark new vs. a hand-rolled equivalent in
  // the old API (direct source-write equivalent).
  const nNew = numNew(0);
  const aNew = nNew.add(3);
  let i = 0;
  bench("new: a.value = i (routes via bwd)", () => { aNew.value = ++i; }).baseline(true);

  // Hand-rolled equivalent in current API: do the subtraction at the
  // call site and write the source directly.
  const nOld = numOld(0);
  bench("old equivalent: nOld.value = i - 3", () => { nOld.value = ++i - 3; });
});

group("write through 3-step chain (.add(1).scale(2).sub(3))", () => {
  const nNew = numNew(0);
  const aNew = nNew.derive((c) => c.add(1).scale(2).sub(3));
  let i = 0;
  bench("new: a.value = i (3-step bwd)", () => { aNew.value = ++i; }).baseline(true);

  // Hand-rolled equivalent: invert at the call site.
  // Forward: ((n+1)*2 - 3). Inverse: (v + 3)/2 - 1.
  const nOld = numOld(0);
  bench("old equivalent: nOld.value = (i + 3)/2 - 1", () => {
    nOld.value = (++i + 3) / 2 - 1;
  });
});

// ── Vec arithmetic ─────────────────────────────────────────────────

group("vec.add({x,y}) construct (writable view)", () => {
  const vOld = vecOld(1, 2);
  const vNew = vecNew(1, 2);
  bench("old", () => do_not_optimize(vOld.add({ x: 10, y: 20 }))).baseline(true);
  bench("new", () => do_not_optimize(vNew.add({ x: 10, y: 20 })));
});

group("vec.add({x,y}).value (cached read)", () => {
  const vOld = vecOld(1, 2);
  const aOld = vOld.add({ x: 10, y: 20 });
  void aOld.value;
  const vNew = vecNew(1, 2);
  const aNew = vNew.add({ x: 10, y: 20 });
  void aNew.value;
  bench("old", () => do_not_optimize(aOld.value)).baseline(true);
  bench("new", () => do_not_optimize(aNew.value));
});

group("vec.right(10).down(20) → cached read (2-step Vec)", () => {
  const vOld = vecOld(0, 0);
  const aOld = vOld.right(10).down(20);
  void aOld.value;
  const vNew = vecNew(0, 0);
  const aNew = vNew.right(10).down(20);
  void aNew.value;
  bench("old (2 Computeds)", () => do_not_optimize(aOld.value)).baseline(true);
  bench("new (1 Computed, 2-step chain)", () => do_not_optimize(aNew.value));
});

// ── Effect propagation through chains ─────────────────────────────

group("effect re-runs on source change (through .add lens)", () => {
  // Both: write source, ensure subscriber sees new value.
  const setupOld = () => {
    const n = numOld(0);
    const a = n.add(3);
    effect(() => { do_not_optimize(a.value); });
    let i = 0;
    return () => { n.value = ++i; };
  };
  const setupNew = () => {
    const n = numNew(0);
    const a = n.add(3);
    effect(() => { do_not_optimize(a.value); });
    let i = 0;
    return () => { n.value = ++i; };
  };
  const stepOld = setupOld();
  const stepNew = setupNew();
  bench("old", stepOld).baseline(true);
  bench("new", stepNew);
});

// ── mean / Joint ───────────────────────────────────────────────────

group("mean(a, b, c) construct", () => {
  bench("old", () => {
    const a = numOld(1), b = numOld(2), c = numOld(3);
    do_not_optimize(meanOld(a, b, c));
  }).baseline(true);
  bench("new", () => {
    const a = numNew(1), b = numNew(2), c = numNew(3);
    do_not_optimize(meanNew(a, b, c));
  });
});

group("mean(a, b, c).value (cached read)", () => {
  const aOld = numOld(1), bOld = numOld(2), cOld = numOld(3);
  const mOld = meanOld(aOld, bOld, cOld);
  void mOld.value;
  const aNew = numNew(1), bNew = numNew(2), cNew = numNew(3);
  const mNew = meanNew(aNew, bNew, cNew);
  void mNew.value;
  bench("old", () => do_not_optimize(mOld.value)).baseline(true);
  bench("new", () => do_not_optimize(mNew.value));
});

group("mean(a, b, c).value = next (write, distribute delta)", () => {
  const aOld = numOld(1), bOld = numOld(2), cOld = numOld(3);
  const mOld = meanOld(aOld, bOld, cOld);
  const aNew = numNew(1), bNew = numNew(2), cNew = numNew(3);
  const mNew = meanNew(aNew, bNew, cNew);
  let i = 0;
  // Old type is a Signal-like; cast away.
  bench("old", () => { (mOld as unknown as { value: number }).value = ++i; }).baseline(true);
  bench("new", () => { mNew.value = ++i; });
});

// ── Construction cost of a writable derived value ─────────────────

group("construct: writable derived(Num, fn, set) hand-rolled vs chain", () => {
  // Old: explicit derived + setter (cf md-layout-demo.ts:48 pattern).
  const nOld = numOld(5);
  bench("old: hand-rolled derived(Num, fn, set)", () => {
    do_not_optimize(nOld.derive((c) => c.add(3)));
  }).baseline(true);

  const nNew = numNew(5);
  bench("new: nNew.add(3) (single-step chain)", () => {
    do_not_optimize(nNew.add(3));
  });
  bench("new: nNew.derive(c => c.add(3))", () => {
    do_not_optimize(nNew.derive((c) => c.add(3)));
  });
});

await run({ format: "mitata" });
