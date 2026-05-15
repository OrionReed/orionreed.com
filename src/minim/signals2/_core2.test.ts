// _core2.test.ts — verify closure-based core2 has same behavior as core.

import { signal, computed, effect, batch, struct, kindOf, lens, type Cell } from "./core2";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// Bare primitives
console.log("\n— Bare primitives");
{
  const s = signal(5);
  check("signal read", s() === 5);
  s(10);
  check("signal write", s() === 10);
  check("signal.peek", s.peek() === 10);
  check("kindOf signal", kindOf(s) === "signal");

  const c = computed(() => s() * 2);
  check("computed read", c() === 20);
  check("kindOf computed", kindOf(c) === "computed");
  s(3);
  check("computed re-eval", c() === 6);
}

// Lens
console.log("\n— Lens");
{
  const a = signal({ x: 1, y: 2 });
  const l = lens(() => a().x, (v) => { const c = a(); a({ x: v, y: c.y }); });
  check("lens read", l() === 1);
  check("kindOf lens", kindOf(l) === "lens");
  l(99);
  check("lens write", a().x === 99 && l() === 99);
}

// Effect
console.log("\n— Effect");
{
  const s = signal(0);
  const log: number[] = [];
  const stop = effect(() => { log.push(s()); });
  check("effect initial", log.length === 1 && log[0] === 0);
  s(1);
  check("effect runs on write", log.length === 2 && log[1] === 1);
  check("kindOf effect", kindOf(stop) === "effect");
  s(2);
  check("effect still live", log.length === 3 && log[2] === 2);
  stop();
  s(99);
  check("effect disposed", log.length === 3);
}

// Batch
console.log("\n— Batch");
{
  const s = signal(0);
  const log: number[] = [];
  const stop = effect(() => { log.push(s()); });
  batch(() => { s(1); s(2); s(3); });
  check("batch coalesces", log.length === 2 && log[1] === 3);
  stop();
}

// Cleanup
console.log("\n— Effect cleanup");
{
  const s = signal(0);
  let cleaned = 0;
  const stop = effect(() => { void s(); return () => { cleaned++; }; });
  s(1);
  check("cleanup ran on re-eval", cleaned === 1);
  stop();
  check("cleanup ran on dispose", cleaned === 2);
}

// Glitch-free (diamond)
console.log("\n— Diamond — glitch-free propagation");
{
  const a = signal(0);
  const b = computed(() => a() + 1);
  const c = computed(() => a() + 2);
  const d = computed(() => b() + c());
  const log: number[] = [];
  const stop = effect(() => { log.push(d()); });
  check("diamond initial: d = 0+1 + 0+2 = 3", log.length === 1 && log[0] === 3);
  a(10);
  check("diamond after a=10: d = 11 + 12 = 23, fires once", log.length === 2 && log[1] === 23);
  stop();
}

// Struct
console.log("\n— Struct");
{
  interface V { x: number; y: number }
  const Vec = struct({
    tag: "Vec",
    value: { x: 0, y: 0 } as V,
    methods: {
      add: (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y }),
    },
    traits: { linear: { add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }), sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), scale: (a, k) => ({ x: a.x * k, y: a.y * k }) } },
  });
  const v = Vec({ x: 3, y: 4 });
  check("Vec init", v().x === 3);
  check("v.x lens", v.x() === 3);
  v.x(99);
  check("v.x write", v().x === 99);
  const sum = v.add({ x: 1, y: 1 });
  check("v.add reactive", sum().x === 100);

  // Per-field subscription
  let xFires = 0, yFires = 0;
  const v2 = Vec({ x: 0, y: 0 });
  const sX = effect(() => { void v2.x(); xFires++; });
  const sY = effect(() => { void v2.y(); yFires++; });
  v2({ x: 5, y: 0 });
  check("only x change: y silent", yFires === 1 && xFires === 2);
  sX(); sY();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
