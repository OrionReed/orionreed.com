// _hooks.test.ts — verify watched/unwatched lifecycle hooks fire correctly.

import { Signal, signal, effect, computed } from "../engine";

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n── ${name}`); }

section("watched fires on first subscriber");
{
  let watchedCount = 0;
  const s = new Signal(0, { watched: () => { watchedCount++; } });
  check("not watched yet", watchedCount === 0);
  const stop = effect(() => { void s.value; });
  check("first effect → watched fired", watchedCount === 1);
  const stop2 = effect(() => { void s.value; });
  check("second effect → no extra fire", watchedCount === 1);
  stop(); stop2();
}

section("unwatched fires on last subscriber detach");
{
  let unwatchedCount = 0;
  const s = new Signal(0, { unwatched: () => { unwatchedCount++; } });
  const stop1 = effect(() => { void s.value; });
  const stop2 = effect(() => { void s.value; });
  check("no unwatched yet", unwatchedCount === 0);
  stop1();
  check("one subscriber left, no fire", unwatchedCount === 0);
  stop2();
  check("last subscriber gone → unwatched fired", unwatchedCount === 1);
}

section("watched/unwatched cycle on add/remove/re-add");
{
  let watched = 0, unwatched = 0;
  const s = new Signal(0, {
    watched: () => { watched++; },
    unwatched: () => { unwatched++; },
  });
  const e1 = effect(() => { void s.value; });
  check("watched=1, unwatched=0", watched === 1 && unwatched === 0);
  e1();
  check("watched=1, unwatched=1", watched === 1 && unwatched === 1);
  const e2 = effect(() => { void s.value; });
  check("re-watched (watched=2)", watched === 2 && unwatched === 1);
  e2();
  check("re-unwatched (unwatched=2)", watched === 2 && unwatched === 2);
}

section("hook fires for computed → signal too");
{
  let watched = 0;
  const s = new Signal(0, { watched: () => { watched++; } });
  const c = computed(() => s.value * 2);
  check("computed doesn't read yet, no watched", watched === 0);
  const stop = effect(() => { void c.value; });
  check("effect subscribes to computed which subscribes to s", watched === 1);
  stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
