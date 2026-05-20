// Bench: alien-wrapped class (.value API) vs other approaches.
// The hypothesis: .value getter caps us regardless of engine.

import { bench, group, do_not_optimize, run } from "mitata";
import {
  signal as wSignal,
  computed as wComputed,
} from "./signal";
import {
  signal as mSignal,
  computed as mComputed,
} from "../signals/signal";
import {
  signal as rSignal,
  computed as rComputed,
} from "../_proto-reactive/reactive";
import {
  signal as aSignal,
  computed as aComputed,
} from "alien-signals";

{
  const w = wSignal(5);
  const m = mSignal(5);
  const r = rSignal(5);
  const a = aSignal(5);
  group("READ: signal.value (untracked)", () => {
    bench("alien raw (callable)", () => do_not_optimize(a())).baseline(true);
    bench("alien-wrapped .value", () => do_not_optimize(w.value));
    bench("minim-current .value", () => do_not_optimize(m.value));
    bench("minim-merged .value", () => do_not_optimize(r.value));
  });
}

{
  const w = wSignal(0);
  const m = mSignal(0);
  const r = rSignal(0);
  const a = aSignal(0);
  let i = 0;
  group("WRITE: signal (no subs)", () => {
    bench("alien raw", () => { a(++i); }).baseline(true);
    bench("alien-wrapped .value=", () => { w.value = ++i; });
    bench("minim-current .value=", () => { m.value = ++i; });
    bench("minim-merged .value=", () => { r.value = ++i; });
  });
}

{
  const ws = wSignal(0);
  const wc = wComputed(() => ws.value * 2);
  void wc.value;
  const ms = mSignal(0);
  const mc = mComputed(() => ms.value * 2);
  void mc.value;
  const rs = rSignal(0);
  const rc = rComputed(() => rs.value * 2);
  void rc.value;
  const as = aSignal(0);
  const ac = aComputed(() => as() * 2);
  void ac();
  let i = 0;
  group("WRITE+READ: forced re-eval of 1-deep computed", () => {
    bench("alien raw", () => { as(++i); do_not_optimize(ac()); }).baseline(true);
    bench("alien-wrapped", () => { ws.value = ++i; do_not_optimize(wc.value); });
    bench("minim-current", () => { ms.value = ++i; do_not_optimize(mc.value); });
    bench("minim-merged", () => { rs.value = ++i; do_not_optimize(rc.value); });
  });
}

group("CONSTRUCT: signal", () => {
  bench("alien raw", () => do_not_optimize(aSignal(0))).baseline(true);
  bench("alien-wrapped", () => do_not_optimize(wSignal(0)));
  bench("minim-current", () => do_not_optimize(mSignal(0)));
  bench("minim-merged", () => do_not_optimize(rSignal(0)));
});

group("CONSTRUCT: computed", () => {
  const as = aSignal(0); const ws = wSignal(0); const ms = mSignal(0); const rs = rSignal(0);
  bench("alien raw", () => do_not_optimize(aComputed(() => as() * 2))).baseline(true);
  bench("alien-wrapped", () => do_not_optimize(wComputed(() => ws.value * 2)));
  bench("minim-current", () => do_not_optimize(mComputed(() => ms.value * 2)));
  bench("minim-merged", () => do_not_optimize(rComputed(() => rs.value * 2)));
});

await run({ format: "mitata" });
