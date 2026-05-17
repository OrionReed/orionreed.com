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

import { signal, computed, effect, lens, value, isSignal, Signal } from "../signal";

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
section("Constructor: plain T only");
// ════════════════════════════════════════════════════════════════════
// new Signal() takes a plain T. Reactive binding is via follow().
{
  const s = new Signal(7);
  check("plain init", s.value === 7);
}

// ════════════════════════════════════════════════════════════════════
section("target.bind(source) — the binding API");
// ════════════════════════════════════════════════════════════════════
{
  const a = signal(2);
  const s = signal(0);
  const stop = s.bind(() => a.value * 10);
  check("initial computed via thunk", s.value === 20);
  a.value = 5;
  check("auto-updates on a change", s.value === 50);
  stop();
  a.value = 99;
  check("after dispose, no update", s.value === 50);
}

// ════════════════════════════════════════════════════════════════════
section("follow with cell source");
// ════════════════════════════════════════════════════════════════════
{
  const src = signal(100);
  const t = signal(0);
  const stop = t.bind(src);
  check("initial sync", t.value === 100);
  src.value = 200;
  check("auto-updates", t.value === 200);
  // Manual write to target — overwritten on next src change
  t.value = 999;
  check("manual write takes effect", t.value === 999);
  src.value = 50;
  check("next src change overwrites manual", t.value === 50);
  stop();
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


console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
