// Reproduce the stack overflow in flush() under many cascading
// bind-effects. Confirms the bug report.
//
// Run: npx vite-node src/minim/_proto-reactive/repro-flush-overflow.ts

import { signal, computed, lens, effect } from "../signals/signal";

// Simulate the production scenario: one source signal, N field-lens
// bind-effects subscribed to it. Each bind effect writes to a lens,
// which cascades to a parent signal write, which triggers flush().

function reproWithLensBinds(N: number): { error: string | null } {
  // Production pattern: a parent (e.g. transform), field lenses on it
  // (e.g. transform.translate), with both READ subs (someone using the
  // lens value) AND WRITE bind-effects (binding source to lens).
  //
  // The cascade: source write → bind effects → each writes lens → lens
  // write cascades to parent.value → parent's propagate notifies the
  // READ effects → flush() recursively.

  const parents = Array.from({ length: N }, () => signal({ x: 0, y: 0 }));

  // Field-lens style: writing to the lens spread-replaces the parent.
  // Reading subscribes to the parent (via parent.value access in the
  // getter), so parent changes propagate to lens subscribers.
  const lenses = parents.map((p) =>
    lens(
      () => p.value.x,  // reads parent.value — creates subscription to parent
      (v: number) => { p.value = { ...p.peek(), x: v }; },
    ),
  );

  // Source signal that drives all bind-effects
  const source = signal(0);

  // READ effects: each one subscribes to a lens (via the lens's getter,
  // which subscribes to its parent). When source changes via the bind
  // effect, the parent is written, parent's subs (this read effect) get
  // notified.
  for (let i = 0; i < N; i++) {
    const li = lenses[i];
    effect(() => { void li.value; });
  }

  // WRITE bind-effects: when source changes, write source.value into lens
  for (let i = 0; i < N; i++) {
    const li = lenses[i];
    effect(() => { li.value = source.value; });
  }

  try {
    source.value = 1;
    return { error: null };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

console.log("=== Stack overflow repro: cascading lens binds ===\n");

for (const N of [100, 500, 1000, 2000, 5000]) {
  const r = reproWithLensBinds(N);
  if (r.error) {
    console.log(`N=${N.toString().padStart(5)}: ✗ ${r.error}`);
  } else {
    console.log(`N=${N.toString().padStart(5)}: ✓ no error`);
  }
}
