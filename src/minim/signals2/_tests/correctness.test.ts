// correctness.test.ts — guards against the four bugs surfaced by review:
//
//   1.1  Computed swallows getter errors → must rethrow + retry on next read
//   1.2  Computed re-eval ignores `equals` trait → derived chains over-fire
//   1.3  Cyclic Computed silently returns undefined → must throw
//   4.2  vec(reactiveX, reactiveY) glitches when bindings aren't batched
//
// Plus the Symbol.toPrimitive footgun guard.

import { signal, computed, effect, batch } from "../signal";
import { vec, num, type VecValue } from "../values";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, info?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${info ? ` — ${info}` : ""}`); }
}
function section(name: string): void { console.log(`\n── ${name}`); }

// ════════════════════════════════════════════════════════════════════
section("1.1  Computed rethrows getter errors + retries");
// ════════════════════════════════════════════════════════════════════
{
  const a = signal(0);
  let shouldThrow = true;
  const c = computed(() => {
    if (shouldThrow) throw new Error("boom");
    return a.value * 2;
  });

  let caught: unknown;
  try { void c.value; } catch (e) { caught = e; }
  check("first read rethrows", (caught as Error).message === "boom");

  // Next read should RETRY the getter (not return cached `undefined`):
  let caught2: unknown;
  try { void c.value; } catch (e) { caught2 = e; }
  check("second read retries (rethrows again)", (caught2 as Error).message === "boom");

  // Once the cause is fixed, the next read succeeds:
  shouldThrow = false;
  a.value = 5;
  check("recovers when cause goes away", c.value === 10);
}

// ════════════════════════════════════════════════════════════════════
section("1.2  Computed honors `equals` trait — no spurious downstream fires");
// ════════════════════════════════════════════════════════════════════
{
  // Vec.traits.equals does structural compare. Two equal Vec values
  // from a chained derive should NOT re-fire downstream.
  const v = vec(1, 2);
  const doubled = v.scale(2);          // derived Vec
  const tripled = doubled.scale(1);    // derived Vec, same shape as doubled

  let runs = 0;
  effect(() => { void tripled.value; runs++; });
  const initial = runs;
  check("initial run", initial === 1);

  // Write a value with same SHAPE → both `doubled` and `tripled` should
  // see structurally-equal results and dedupe downstream.
  v.value = { x: 1, y: 2 };
  check("structurally-equal write does not re-fire downstream", runs === initial);

  // Actually changing the value DOES fire:
  v.value = { x: 5, y: 5 };
  check("real change fires", runs === initial + 1);
}

// per-instance equals via SignalOptions
{
  const s = signal(0, { equals: (a, b) => Math.abs(a - b) < 0.01 });
  let runs = 0;
  effect(() => { void s.value; runs++; });
  check("baseline run", runs === 1);
  s.value = 0.005;
  check("epsilon-equal write skipped", runs === 1);
  s.value = 0.5;
  check("real change fires", runs === 2);
}

// ════════════════════════════════════════════════════════════════════
section("1.3  Cyclic computed throws RangeError");
// ════════════════════════════════════════════════════════════════════
{
  // Direct cycle:  c reads itself
  // eslint-disable-next-line prefer-const
  let c: { value: number };
  c = computed(() => c.value + 1) as never;
  let threw: unknown;
  try { void c.value; } catch (e) { threw = e; }
  check("direct cycle throws", threw instanceof RangeError);
  check("error message mentions cycle", /[Cc]yclic/.test((threw as Error).message));

  // Transitive cycle:  a → b → a
  // eslint-disable-next-line prefer-const
  let a: { value: number }, b: { value: number };
  a = computed(() => b.value + 1) as never;
  b = computed(() => a.value + 1) as never;
  let threw2: unknown;
  try { void a.value; } catch (e) { threw2 = e; }
  check("transitive cycle throws", threw2 instanceof RangeError);
}

// ════════════════════════════════════════════════════════════════════
section("4.2  vec(reactiveX, reactiveY) glitch-free under batch");
// ════════════════════════════════════════════════════════════════════
{
  const rx = signal(10);
  const ry = signal(20);
  const v = vec(rx, ry);

  const seen: VecValue[] = [];
  effect(() => { seen.push({ ...v.value }); });
  check("initial value", v.value.x === 10 && v.value.y === 20);

  seen.length = 0;
  batch(() => {
    rx.value = 100;
    ry.value = 200;
  });
  check("batched update yields one final value", seen.length === 1);
  check("final value is consistent", seen[0]?.x === 100 && seen[0]?.y === 200);
}

// ════════════════════════════════════════════════════════════════════
section("Symbol.toPrimitive footgun guard");
// ════════════════════════════════════════════════════════════════════
{
  const n = num(5);
  let threw: unknown;
  try { const _ = `value is ${n}`; void _; } catch (e) { threw = e; }
  check("template string throws", threw instanceof TypeError);
  check("error mentions .value",
    /\.value/.test((threw as Error).message));

  // Identity comparison still works (Symbol.toPrimitive isn't called):
  const m = num(5);
  check("=== identity works", n === n);
  check("!== different identity works", n !== m);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
