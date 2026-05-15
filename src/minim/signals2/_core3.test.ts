// _core3.test.ts — verify class-based engine correctness.

import { signal, computed, lens, effect, batch, follow, mirror, Signal, Computed } from "./core3";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("\n— Bare primitives");
{
  const s = signal(5);
  check("signal.value read", s.value === 5);
  s.value = 10;
  check("signal.value write", s.value === 10);
  check("signal.peek()", s.peek() === 10);
  check("instanceof Signal", s instanceof Signal);

  const c = computed(() => s.value * 2);
  check("computed.value", c.value === 20);
  check("instanceof Computed", c instanceof Computed);
  s.value = 3;
  check("computed re-eval", c.value === 6);
}

console.log("\n— Lens");
{
  const a = signal({ x: 1, y: 2 });
  const l = lens(() => a.value.x, (v) => { a.value = { ...a.value, x: v }; });
  check("lens.value read", l.value === 1);
  l.value = 99;
  check("lens setter write", a.value.x === 99 && l.value === 99);
}

console.log("\n— Effect + cleanup");
{
  const s = signal(0);
  const log: number[] = [];
  const stop = effect(() => { log.push(s.value); });
  check("effect initial", log.length === 1);
  s.value = 1;
  check("effect on write", log.length === 2 && log[1] === 1);
  stop();
  s.value = 99;
  check("effect disposed", log.length === 2);

  let cleaned = 0;
  const stop2 = effect(() => { void s.value; return () => { cleaned++; }; });
  s.value = 100;
  check("cleanup ran on re-eval", cleaned === 1);
  stop2();
  check("cleanup ran on dispose", cleaned === 2);
}

console.log("\n— Batch");
{
  const s = signal(0);
  const log: number[] = [];
  const stop = effect(() => { log.push(s.value); });
  batch(() => { s.value = 1; s.value = 2; s.value = 3; });
  check("batch coalesces", log.length === 2 && log[1] === 3);
  stop();
}

console.log("\n— Diamond glitch-freeness");
{
  const a = signal(0);
  const b = computed(() => a.value + 1);
  const c = computed(() => a.value + 2);
  const d = computed(() => b.value + c.value);
  const log: number[] = [];
  const stop = effect(() => { log.push(d.value); });
  check("diamond initial", log.length === 1 && log[0] === 3);
  a.value = 10;
  check("diamond fires once after change", log.length === 2 && log[1] === 23);
  stop();
}

console.log("\n— follow / mirror");
{
  const a = signal(1);
  const b = signal(99);
  const stop = follow(a, b);
  check("follow initial copy", a.value === 99);
  b.value = 5;
  check("follow live", a.value === 5);
  stop();

  const m1 = signal("a");
  const m2 = signal("b");
  const stop2 = mirror(m1, m2);
  check("mirror initial: m1 wins", m2.value === "a");
  m2.value = "d";
  check("mirror b→a", m1.value === "d");
  stop2();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
