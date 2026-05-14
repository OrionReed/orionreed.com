// Correctness tests for the vendored alien — verify glitch-freeness
// under all the topologies the upstream test suite covers. If any of
// these fail, the engine is broken and nothing built on top can be
// trusted.
//
// Run:
//   node node_modules/.bin/vite-node src/minim/_bench/proto2/_correctness.ts
//
// Each test prints PASS/FAIL and the assertion that fired.

import {
  signal, computed, effect, effectScope, trigger,
  startBatch, endBatch,
  isSignal, isComputed, isEffect, isEffectScope,
} from "./engine";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else {
    failed++;
    const msg = `  ✗ ${label}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ""}`;
    failures.push(msg);
    console.log(msg);
  }
}

function section(label: string): void {
  console.log(`\n── ${label} ──────────────────────────────────`);
}

// ── 1. Basic signal read/write ───────────────────────────────────────

section("1. Basic signal");
{
  const s = signal(1);
  check("initial read", s() === 1);
  s(2);
  check("after write", s() === 2);
}

// ── 2. Computed: lazy + cached ───────────────────────────────────────

section("2. Computed lazy + cached");
{
  const a = signal(2);
  let count = 0;
  const b = computed(() => { count++; return a() * 3; });
  check("not run until first read", count === 0);
  check("first read = 6", b() === 6);
  check("first read incr count", count === 1);
  check("second read cached", b() === 6 && count === 1);
  a(5);
  check("write doesn't run computed (no subs)", count === 1);
  check("next read = 15", b() === 15);
  check("read incr count", count === 2);
}

// ── 3. Diamond (no glitch) ───────────────────────────────────────────
//
//      root
//      /  \
//     a    b
//      \  /
//       d
//
// Writing root should yield ONE recompute of d, not two. d should
// always see consistent a and b derived from the SAME root version.

section("3. Diamond — d depends on a and b which both depend on root");
{
  const root = signal(1);
  const a = computed(() => root() * 2);
  const b = computed(() => root() * 3);
  let dRuns = 0;
  let seenA: number[] = [];
  let seenB: number[] = [];
  const d = computed(() => {
    dRuns++;
    const av = a();
    const bv = b();
    seenA.push(av); seenB.push(bv);
    return av + bv;
  });
  // Subscribe so propagation actually fires.
  let observed = 0;
  effect(() => { observed = d(); });
  check("initial d", observed === 5); // 2 + 3
  check("initial dRuns = 1", dRuns === 1);
  root(10);
  check("after root(10): d = 50", observed === 50); // 20 + 30
  check("d ran exactly once more", dRuns === 2);
  check("d saw consistent a/b", seenA[1] === 20 && seenB[1] === 30,
    { seenA, seenB });
}

// ── 4. Diamond with effect at bottom ─────────────────────────────────

section("4. Diamond — effect at bottom (one fire per write)");
{
  const root = signal(0);
  const a = computed(() => root() + 1);
  const b = computed(() => root() + 2);
  let effectRuns = 0;
  effect(() => { void a(); void b(); effectRuns++; });
  check("initial effect run", effectRuns === 1);
  root(5);
  check("effect ran exactly once more", effectRuns === 2);
  root(10);
  check("effect ran exactly once more", effectRuns === 3);
}

// ── 5. Write-during-effect (dirty propagation) ───────────────────────

section("5. Write inside effect — observed downstream");
{
  const a = signal(0);
  const b = signal(0);
  let log: string[] = [];
  effect(() => { log.push(`a=${a()}`); });
  effect(() => { log.push(`b=${b()}`); });
  log.length = 0;
  // Effect writes b — should fire the b effect after.
  effect(() => {
    log.push(`writer:a=${a()}`);
    b(a() * 10);
  });
  log.length = 0;
  a(3);
  // Order is roughly: writer fires → b updated → b's effect fires.
  // Exact ordering depends on scheduler; we just check both fired
  // and saw the right values.
  check("writer effect saw a=3", log.includes("writer:a=3"));
  check("a effect saw a=3", log.includes("a=3"));
  check("b effect saw b=30", log.includes("b=30"));
}

// ── 6. Conditional dependency tracking ───────────────────────────────

section("6. Conditional deps — only tracked when read");
{
  const cond = signal(true);
  const a = signal(1);
  const b = signal(100);
  let runs = 0;
  let observed = 0;
  effect(() => { runs++; observed = cond() ? a() : b(); });
  check("initial: cond=true, observed=1", observed === 1 && runs === 1);
  b(999);
  check("b changed but cond=true: no rerun", runs === 1);
  a(2);
  check("a changed: rerun", runs === 2 && observed === 2);
  cond(false);
  check("cond flipped: rerun, observed=999", runs === 3 && observed === 999);
  a(100);
  check("a changed but cond=false: no rerun", runs === 3);
  b(500);
  check("b changed: rerun, observed=500", runs === 4 && observed === 500);
}

// ── 7. Batching ──────────────────────────────────────────────────────

section("7. Batch — coalesces writes, fires effects once");
{
  const a = signal(0);
  const b = signal(0);
  let runs = 0;
  effect(() => { runs++; void a(); void b(); });
  runs = 0;
  startBatch();
  a(1);
  b(2);
  a(3);
  b(4);
  check("no effect runs inside batch", runs === 0);
  endBatch();
  check("one effect run after batch", runs === 1);
}

// ── 8. Triangle (transitive) ─────────────────────────────────────────
//
//   a → b → c
//
// Standard upstream propagation. c sees a's updates through b.

section("8. Triangle — transitive propagation");
{
  const a = signal(1);
  const b = computed(() => a() * 10);
  let cRuns = 0;
  const c = computed(() => { cRuns++; return b() + 1; });
  let observed = 0;
  effect(() => { observed = c(); });
  check("initial c = 11", observed === 11);
  a(5);
  check("after a(5): c = 51", observed === 51);
  check("c ran twice total", cRuns === 2);
}

// ── 9. Nested effect — child effects auto-disposed on parent re-run ─

section("9. Nested effects — child auto-cleanup on parent re-run");
{
  const trigger = signal(0);
  let childRuns = 0;
  effect(() => {
    void trigger();
    effect(() => { childRuns++; });
  });
  // After initial: parent ran once, child ran once.
  check("initial childRuns = 1", childRuns === 1);
  trigger(1);
  // Parent re-runs; spawns a new child. The OLD child should be
  // disposed. The new child runs once.
  check("after rerun: child ran exactly once more", childRuns === 2);
  trigger(2);
  check("after rerun 2: child ran exactly once more", childRuns === 3);
}

// ── 10. effectScope — disposes all effects within ────────────────────

section("10. effectScope — disposes all child effects together");
{
  const s = signal(0);
  let runs = 0;
  const dispose = effectScope(() => {
    effect(() => { runs++; void s(); });
    effect(() => { runs++; void s(); });
    effect(() => { runs++; void s(); });
  });
  const after = runs;
  s(1);
  check("3 effects ran", runs === after + 3);
  dispose();
  s(2);
  check("after scope dispose: no more runs", runs === after + 3);
}

// ── 11. trigger() — synchronous tracked side-effect ──────────────────

section("11. trigger() — one-shot tracked");
{
  const a = signal(10);
  let read = 0;
  trigger(() => { read = a(); });
  check("trigger reads current value", read === 10);
  // trigger doesn't subscribe — subsequent writes don't refire.
  a(99);
  check("write after trigger: no refire", read === 10);
}

// ── 12. isSignal / isComputed / isEffect detection ──────────────────

section("12. is* detection");
{
  const s = signal(0);
  const c = computed(() => s());
  let cleanup = effect(() => { void s(); });
  check("isSignal(signal)", isSignal(s as () => void));
  check("isSignal(computed) = false", !isSignal(c as () => void));
  check("isComputed(computed)", isComputed(c as () => void));
  check("isComputed(signal) = false", !isComputed(s as () => void));
  check("isEffect(effect-disposer)", isEffect(cleanup));
  check("isEffect(signal) = false", !isEffect(s as () => void));
  const scopeDispose = effectScope(() => { effect(() => {}); });
  check("isEffectScope(scope-disposer)", isEffectScope(scopeDispose));
}

// ── 13. Cleanup runs in reverse order ───────────────────────────────

section("13. Cleanup on re-run");
{
  const s = signal(0);
  let cleanups = 0;
  effect(() => {
    void s();
    return () => { cleanups++; };
  });
  s(1);
  check("cleanup ran once on first re-run", cleanups === 1);
  s(2);
  check("cleanup ran again on next re-run", cleanups === 2);
}

// ── 14. Stress: deep chain (100 computed nodes) ──────────────────────

section("14. Deep chain — 100 computeds");
{
  const root = signal(0);
  let prev: () => number = root as unknown as () => number;
  for (let i = 0; i < 100; i++) {
    const p = prev;
    prev = computed(() => p() + 1);
  }
  let observed = 0;
  effect(() => { observed = prev(); });
  check("initial = 100", observed === 100);
  root(5);
  check("after root(5) = 105", observed === 105);
}

// ── 15. Stress: 50 effects subscribing to one signal ────────────────

section("15. Fan-out — 50 effects on one signal");
{
  const s = signal(0);
  let total = 0;
  for (let i = 0; i < 50; i++) effect(() => { total += s() as number; });
  total = 0;
  s(1);
  check("all 50 effects fired", total === 50);
  s(2);
  check("all 50 fired again", total === 50 + 100);
}

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed   ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}
