// Signal engine bench. Core ops: construct, read, write, effect re-run,
// computed dep. One file per concern; nothing here exercises the
// generator runtime (see `anim.bench.ts`) or value-type math.
//
// Run:
//   node --expose-gc node_modules/.bin/vite-node src/minim/_bench/signals.bench.ts

import { bench, group, do_not_optimize, run } from "mitata";
import {
  signal, computed, effect, batch,
  vec, num, Vec, Num,
} from "@minim/signals";

// ── Construction ────────────────────────────────────────────────────

group("construction (cost per cell)", () => {
  bench("signal(0)", () => do_not_optimize(signal(0))).baseline(true);
  bench("vec(0, 0)", () => do_not_optimize(vec(0, 0)));
  bench("num(0)", () => do_not_optimize(num(0)));
  bench("new Vec()", () => do_not_optimize(new Vec()));
  bench("new Num()", () => do_not_optimize(new Num()));
});

// ── Reads ───────────────────────────────────────────────────────────

group("untracked reads", () => {
  const s = signal(0);
  const v = vec(1, 2);
  const n = num(0);
  bench("signal.peek()", () => do_not_optimize(s.peek())).baseline(true);
  bench("vec.peek()", () => do_not_optimize(v.peek()));
  bench("vec.x.peek()", () => do_not_optimize(v.x.peek()));
  bench("num.peek()", () => do_not_optimize(n.peek()));
});

group("tracked reads (inside computed body)", () => {
  const s = signal(0);
  const c = computed(() => s.value * 2);
  bench("computed.value (cached)", () => do_not_optimize(c.value)).baseline(true);
});

// ── Writes ──────────────────────────────────────────────────────────

group("writes (no subscribers)", () => {
  const s = signal(0);
  const v = vec(0, 0);
  let i = 0;
  bench("signal.value = i", () => { s.value = ++i; }).baseline(true);
  bench("vec.value = {x,y}", () => { v.value = { x: ++i, y: i }; });
  bench("vec.x.value = i", () => { v.x.value = ++i; });
});

group("writes (with 1 effect subscriber)", () => {
  const s = signal(0);
  effect(() => { do_not_optimize(s.value); });
  let i = 0;
  bench("signal.value = i (1 effect)", () => { s.value = ++i; });
});

group("writes inside batch (10 writes/batch, 1 effect)", () => {
  const s = signal(0);
  effect(() => { do_not_optimize(s.value); });
  let i = 0;
  bench("batch × 10 writes", () => {
    batch(() => { for (let k = 0; k < 10; k++) s.value = ++i; });
  });
});

// ── Computed chains ─────────────────────────────────────────────────

group("computed chain (10-deep, dirty propagation)", () => {
  const root = signal(0);
  let chain: { value: number } = root;
  for (let i = 0; i < 10; i++) {
    const prev = chain;
    chain = computed(() => prev.value + 1);
  }
  // Warm
  do_not_optimize(chain.value);
  let i = 0;
  bench("write root, read tail (10-deep)", () => {
    root.value = ++i;
    do_not_optimize(chain.value);
  });
});

await run({ format: "mitata" });
