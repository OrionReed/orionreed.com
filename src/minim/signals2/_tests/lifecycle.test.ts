// lifecycle.test.ts — unique-to-our-impl lifecycle tests.
//
// RFTS covers effect-cleanup, basic disposal, no-op writes, peek inside
// effect, conditional dep tracking, etc. THIS file tests:
//
//   - Bound signal teardown (unbind + dispose, leak detection)
//   - equals trait suppression on writes
//   - 100-binding cleanup (subs list correctness at scale)

import { signal, effect, Signal } from "../engine";
import { vec } from "../values";

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n── ${name}`); }

// ════════════════════════════════════════════════════════════════════
section("Bound signal: unbind doesn't leak");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(0);
  const s = new Signal(src);
  check("src has subs from binding", src.subs !== undefined);
  s.unbind();
  check("src.subs cleared after unbind", src.subs === undefined);
}

// ════════════════════════════════════════════════════════════════════
section("Bound signal: dispose() severs binding");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(0);
  const s = new Signal(src);
  let observed = -1;
  const stop = effect(() => { observed = s.value; });
  src.value = 10;
  check("effect observes through binding", observed === 10);
  s.unbind();
  src.value = 20;
  check("after dispose, no update propagates", observed === 10);
  stop();
}

// ════════════════════════════════════════════════════════════════════
section("dispose() is idempotent");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(0);
  const s = new Signal(src);
  s.unbind();
  let threw = false;
  try { s.unbind(); } catch { threw = true; }
  check("safe to call dispose twice", !threw);
}

// ════════════════════════════════════════════════════════════════════
section("equals trait: structural equality skips writes");
// ════════════════════════════════════════════════════════════════════
{
  const v = vec(1, 2);
  let fires = 0;
  const stop = effect(() => { void v.value; fires++; });
  v.value = { x: 1, y: 2 };  // structurally same, different reference
  check("equals skips no-op write", fires === 1);
  v.value = { x: 1, y: 3 };  // actually different
  check("real change fires", fires === 2);
  stop();
}

// ════════════════════════════════════════════════════════════════════
section("100 bindings: clean unwatch leaves no subs");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(0);
  const cells: Signal<number>[] = [];
  for (let i = 0; i < 100; i++) cells.push(new Signal(src));
  let count = 0;
  for (let link = src.subs; link; link = link.nextSub) count++;
  check("src has 100 subs", count === 100);
  for (const c of cells) c.unbind();
  count = 0;
  for (let link = src.subs; link; link = link.nextSub) count++;
  check("after unbind all: 0 subs", count === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
