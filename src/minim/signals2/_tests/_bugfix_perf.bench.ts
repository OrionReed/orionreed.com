// Quick micro-bench to confirm the bug fixes (cycle check + equals
// caching + Symbol.toPrimitive) don't regress the hot paths.
//
// Run: node --expose-gc ./node_modules/.bin/tsx src/minim/signals2/_tests/_bugfix_perf.bench.ts

import { bench, printRow } from "./bench_utils";
import { signal, computed, effect, batch } from "../signal";
import { vec, Vec } from "../values";

console.log("\n══════ Hot-path micro-bench ══════\n");

// Signal write path (touches `_equals` cache)
{
  const s = signal(0);
  let i = 0;
  printRow(bench("signal .value write (cached _equals slot)",
    () => { s.value = ++i; },
    { iters: 1_000_000, warmup: 200_000 },
  ));
}

// Computed read path (cycle check + cached eval)
{
  const a = signal(0);
  const c = computed(() => a.value * 2);
  printRow(bench("computed read (warm cache, cycle check on hot path)",
    () => c.value,
    { iters: 10_000_000, warmup: 500_000 },
  ));
}

// Computed re-eval path (the one we changed: now consults _equals trait)
{
  const a = signal(0);
  const c = computed(() => a.value * 2);
  let i = 0;
  printRow(bench("computed read with write (re-eval, equals dedup)",
    () => { a.value = ++i; void c.value; },
    { iters: 1_000_000, warmup: 200_000 },
  ));
}

// Vec.add chain (3-deep) — exercises Computed equals trait
{
  const a = vec(1, 1);
  const b = vec(2, 3);
  printRow(bench("vec.add().add().add() (3-chain, eq-aware)",
    () => { void a.add(b).add(b).add(b).value; },
    { iters: 100_000, warmup: 20_000 },
  ));
}

// Effect propagate — write triggers effect rerun
{
  const s = signal(0);
  let r = 0;
  effect(() => { r = s.value * 2; });
  void r;
  let i = 0;
  printRow(bench("effect propagate (1 dep)",
    () => { s.value = ++i; },
    { iters: 1_000_000, warmup: 200_000 },
  ));
}

// Batched writes (no per-write flush)
{
  const a = signal(0), b = signal(0);
  let r = 0;
  effect(() => { r = a.value + b.value; });
  void r;
  let i = 0;
  printRow(bench("batched 2 writes",
    () => { batch(() => { a.value = ++i; b.value = i; }); },
    { iters: 500_000, warmup: 100_000 },
  ));
}

// Equals-dedup verification: writing structurally-equal new value
// (different ref) should now skip propagation. Big speedup expected.
{
  const v = vec(1, 2);
  printRow(bench("vec write structurally-equal (eq-dedup wins)",
    () => { v.value = { x: 1, y: 2 }; },
    { iters: 1_000_000, warmup: 200_000 },
  ));
}

// Symbol.toPrimitive guard cost (only fires on coercion, NOT normal reads)
// Just verify normal reads aren't slower.
{
  const s = signal(0);
  printRow(bench("signal .value read (toPrimitive on prototype, not called)",
    () => s.value,
    { iters: 10_000_000, warmup: 500_000 },
  ));
}
