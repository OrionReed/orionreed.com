// engine.test.ts — unique-to-our-impl engine tests.
//
// RFTS (conformance.test.ts) covers the algorithm-level correctness:
// glitch-free propagation, lazy eval, conditional deps, etc.
// THIS file tests our specific additions:
//
//   - peek() honors Dirty (a bug fix relative to other impls)
//   - Val<T> at construction (signal binding to thunks/cells)
//   - Val<T> at write (rebind via reactive write)
//   - isSignal brand check (Symbol-stamped prototypes)
//   - follow() one-way binding
//   - method args treated as Val<T> reactively

import { signal, computed, effect, lens, follow, value, isSignal, Signal } from "../engine";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, info?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${info ? ` — ${info}` : ""}`); }
}
function section(name: string): void { console.log(`\n── ${name}`); }

// ════════════════════════════════════════════════════════════════════
section("peek() honors Dirty flag");
// ════════════════════════════════════════════════════════════════════
// Production preact-signals and even our v1 PoC had peek() returning
// stale currentValue when there was a pending write. Verify the fix.
{
  const s = signal(0);
  let effectVal = -1;
  const stop = effect(() => { effectVal = s.value; });
  s.value = 42;
  check("peek after write returns new value", s.peek() === 42);
  check("effect saw new value", effectVal === 42);
  stop();
}

// ════════════════════════════════════════════════════════════════════
section("Val<T> at construction: static");
// ════════════════════════════════════════════════════════════════════
{
  const s = new Signal(7);
  check("plain init", s.value === 7);
  check("not bound", !s.isBound);
}

// ════════════════════════════════════════════════════════════════════
section("Val<T> at construction: thunk → auto-binds");
// ════════════════════════════════════════════════════════════════════
{
  const a = signal(2);
  const s = new Signal(() => a.value * 10);
  check("thunk init reads source", s.value === 20);
  check("isBound = true", s.isBound);
  a.value = 5;
  check("auto-updates on src change", s.value === 50);
  s.unbind();
}

// ════════════════════════════════════════════════════════════════════
section("Val<T> at construction: cell → auto-binds");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(100);
  const s = new Signal(src);
  check("cell init copies value", s.value === 100);
  check("isBound", s.isBound);
  src.value = 200;
  check("auto-updates", s.value === 200);
  s.unbind();
  src.value = 999;
  check("after unbind, no update", s.value === 200);
  check("isBound false after unbind", !s.isBound);
}

// ════════════════════════════════════════════════════════════════════
section("Val<T> via bind() — explicit re-bind");
// ════════════════════════════════════════════════════════════════════
// .value = X is now ALWAYS plain write. Re-binding requires .bind().
{
  const s = signal(0);
  const src = signal(50);
  s.bind(src);
  check("after bind: tracks src value", s.value === 50);
  check("isBound", s.isBound);
  src.value = 75;
  check("tracks new src", s.value === 75);

  // Plain write to s while bound: the binding will overwrite on next src change
  s.value = 999;
  check("plain write takes effect", s.value === 999);
  src.value = 100;
  check("next src change overrides plain write", s.value === 100);

  s.unbind();
  src.value = 200;
  check("after unbind: no track", s.value === 100);
}

// ════════════════════════════════════════════════════════════════════
section("isSignal brand: branded prototypes, not structural .value");
// ════════════════════════════════════════════════════════════════════
{
  check("isSignal(signal)", isSignal(signal(0)));
  check("isSignal(computed)", isSignal(computed(() => 0)));
  check("isSignal(lens)", isSignal(lens(() => 0, () => {})));
  check("isSignal(plain {value: 5})", !isSignal({ value: 5 }));
  check("isSignal(plain {value: 5, name: 'a'})", !isSignal({ value: 5, name: "a" }));
  check("isSignal(number)", !isSignal(5));
  check("isSignal(fn)", !isSignal(() => 5));
  check("isSignal(null)", !isSignal(null));
}

// ════════════════════════════════════════════════════════════════════
section("value() unwraps via brand, not structural shape");
// ════════════════════════════════════════════════════════════════════
{
  check("value(5)", value(5) === 5);
  check("value(() => 10)", value(() => 10) === 10);
  check("value(signal(15))", value(signal(15)) === 15);

  // Crucial: plain T with `.value` field is NOT unwrapped.
  const plainT = { value: 5, name: "alice" };
  check("plain T with .value is preserved", value(plainT as any) === plainT);
}

// ════════════════════════════════════════════════════════════════════
section("follow(target, source: Val<T>) — universal binding");
// ════════════════════════════════════════════════════════════════════
{
  const t = signal(0);
  const s = signal(5);
  const stop = follow(t, s);
  check("initial sync", t.value === 5);
  s.value = 10;
  check("updates on src change", t.value === 10);
  t.value = 999;  // manual write
  check("manual write to target works", t.value === 999);
  s.value = 50;
  check("next src change overwrites manual", t.value === 50);
  stop();
  s.value = 100;
  check("after dispose, no update", t.value === 50);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
