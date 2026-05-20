// CRITICAL bench: does attaching minim's methods + traits to alien-signals'
// callable preserve alien's raw perf, or does it degrade?
//
// Compared:
//   - alien-signals raw (baseline)
//   - alien-signals + methods attached (the prototype — "callable-vec")
//   - minim-current (Signal+Computed split)
//   - minim-merged (single Reactive class)
//   - preact-signals
//
// Workloads:
//   - Raw signal read/write (where alien wins biggest)
//   - Reads via a callable that has methods attached (the QUESTION)
//   - Method dispatch (`vec.add(b)`)
//   - Trait access (`vec[LINEAR]`)
//   - Chain reads (a long-derived value)

import { bench, group, do_not_optimize, run } from "mitata";
import {
  signal as aSignal,
  computed as aComputed,
  effect as aEffect,
} from "alien-signals";
import {
  signal as mSignal,
  computed as mComputed,
} from "../signals/signal";
import {
  signal as rSignal,
  computed as rComputed,
} from "../_proto-reactive/reactive";
import {
  signal as pSignal,
  computed as pComputed,
} from "@preact/signals-core";

import { signal as cSignal } from "./signal";
import { vec as cVec, type Vec as CVec } from "./vec";
import { LINEAR } from "../signals/traits";

// ─── Group 1: signal READ ────────────────────────────────────────────

{
  const a = aSignal(5);
  const m = mSignal(5);
  const r = rSignal(5);
  const p = pSignal(5);
  // callable signal (no methods attached — pure alien)
  const c = cSignal(5);
  // callable Vec with methods+traits attached (the question)
  const vc = cVec(3, 4);
  void aEffect; // unused

  group("READ: signal (no methods attached)", () => {
    bench("alien-signals raw", () => do_not_optimize(a())).baseline(true);
    bench("callable-via-alien (no attach)", () => do_not_optimize(c()));
    bench("preact .value", () => do_not_optimize(p.value));
    bench("minim-current .value", () => do_not_optimize(m.value));
    bench("minim-merged .value", () => do_not_optimize(r.value));
  });

  group("READ: callable with attached methods (vec())", () => {
    bench("alien-signals raw", () => do_not_optimize(a())).baseline(true);
    bench("callable-vec (methods+traits attached)", () => do_not_optimize(vc()));
  });
}

// ─── Group 2: signal WRITE ───────────────────────────────────────────

{
  const a = aSignal(0);
  const m = mSignal(0);
  const r = rSignal(0);
  const p = pSignal(0);
  const c = cSignal(0);
  const vc = cVec(0, 0);
  let i = 0;

  group("WRITE: signal (no methods)", () => {
    bench("alien-signals raw", () => { a(++i); }).baseline(true);
    bench("callable-via-alien", () => { c(++i); });
    bench("preact .value=", () => { p.value = ++i; });
    bench("minim-current .value=", () => { m.value = ++i; });
    bench("minim-merged .value=", () => { r.value = ++i; });
  });

  group("WRITE: callable-vec (methods attached)", () => {
    bench("alien-signals raw", () => { a(++i); }).baseline(true);
    bench("callable-vec", () => { vc({ x: ++i, y: i }); });
  });
}

// ─── Group 3: method dispatch (vec.add(b)) ──────────────────────────

{
  const vc = cVec(1, 2);

  // For comparison: dispatch through alien-signals' bound function
  // accessed via Object property lookup. (Wraps in an object to mimic
  // having methods on the same surface.)
  const wrapper = {
    sig: aSignal(1),
    add(b: number) { return aComputed(() => this.sig() + b); },
  };

  group("METHOD: chain dispatch", () => {
    bench("vec.add({x,y}) — callable-vec", () => do_not_optimize(vc.add({ x: 1, y: 0 }))).baseline(true);
    bench("wrapper.add(1) — alien + object wrapper", () => do_not_optimize(wrapper.add(1)));
  });

  group("METHOD: trait slot access (vec[LINEAR])", () => {
    bench("vec[LINEAR]", () => do_not_optimize(vc[LINEAR]));
  });

  group("METHOD: vec.x (sub-signal lens access)", () => {
    bench("vec.x", () => do_not_optimize(vc.x));
  });
}

// ─── Group 4: 10-deep computed chain ────────────────────────────────

{
  // alien-signals raw
  const aRoot = aSignal(0);
  let aTail: () => number = aRoot;
  for (let i = 0; i < 10; i++) { const p = aTail; aTail = aComputed(() => p() + 1); }
  void aTail();
  let i = 0;

  // callable-via-alien (no methods)
  const cRoot = cSignal(0);
  let cTail: () => number = cRoot;
  for (let i = 0; i < 10; i++) { const p = cTail; cTail = aComputed(() => (p as () => number)() + 1); }
  void cTail();

  // callable-vec — but Vec values are objects, so use NUM chain
  // Build using cVec's add method (which goes through alien)
  // Just bench with cSignal + cComputed for clean comparison.

  group("CHAIN: 10-deep computed, write src + read tail", () => {
    bench("alien-signals raw", () => { aRoot(++i); do_not_optimize(aTail()); }).baseline(true);
    bench("callable-via-alien", () => { cRoot(++i); do_not_optimize(cTail()); });
  });
}

// ─── Group 5: construction ──────────────────────────────────────────

group("CONSTRUCT: signal", () => {
  bench("alien-signals raw", () => do_not_optimize(aSignal(0))).baseline(true);
  bench("callable-via-alien (alias)", () => do_not_optimize(cSignal(0)));
  bench("callable-vec (with methods+traits)", () => do_not_optimize(cVec(0, 0)));
  bench("preact", () => do_not_optimize(pSignal(0)));
  bench("minim-current", () => do_not_optimize(mSignal(0)));
  bench("minim-merged", () => do_not_optimize(rSignal(0)));
});

void mComputed; void rComputed; void pComputed; // silence unused

await run({ format: "mitata" });
