// lifecycle.test.ts — unique-to-our-impl lifecycle tests.
//
// RFTS covers effect cleanup, basic disposal, no-op writes, peek inside
// effect, conditional dep tracking. THIS file tests:
//
//   - follow() teardown (no leak)
//   - dispose-fn idempotence
//   - equals trait suppression on writes
//   - many-bindings cleanup (subs list correctness at scale)

import { signal, effect, Signal } from "../signal";
import { vec } from "../values";

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n── ${name}`); }

// ════════════════════════════════════════════════════════════════════
section("follow(): dispose severs the binding");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(0);
  const t = signal(0);
  const stop = t.bind(src);
  check("src has subs from follow", src.subs !== undefined);
  stop();
  check("src.subs cleared after dispose", src.subs === undefined);
}

// ════════════════════════════════════════════════════════════════════
section("Effect after follow disposed: no propagation");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(0);
  const t = signal(0);
  const stop = t.bind(src);
  let observed = -1;
  const stopE = effect(() => { observed = t.value; });
  src.value = 10;
  check("effect observes through binding", observed === 10);
  stop();
  src.value = 20;
  check("after dispose, no propagation", observed === 10);
  stopE();
}

// ════════════════════════════════════════════════════════════════════
section("Dispose fn is idempotent");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(0);
  const t = signal(0);
  const stop = t.bind(src);
  stop();
  let threw = false;
  try { stop(); } catch { threw = true; }
  check("safe to call stop twice", !threw);
}

// ════════════════════════════════════════════════════════════════════
section("equals trait: structural equality skips writes");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(1, 2);
  let fires = 0;
  const stop = effect(() => { void v.value; fires++; });
  v.value = { x: 1, y: 2 };  // structurally same
  check("equals skips no-op write", fires === 1);
  v.value = { x: 1, y: 3 };
  check("real change fires", fires === 2);
  stop();
}

// ════════════════════════════════════════════════════════════════════
section("100 follows on one source: clean unwatch leaves no subs");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(0);
  const stops: Array<() => void> = [];
  for (let i = 0; i < 100; i++) stops.push(signal(0).bind(src));
  let count = 0;
  for (let link = src.subs; link; link = link.nextSub) count++;
  check("src has 100 subs", count === 100);
  for (const s of stops) s();
  count = 0;
  for (let link = src.subs; link; link = link.nextSub) count++;
  check("after disposing all: 0 subs", count === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
