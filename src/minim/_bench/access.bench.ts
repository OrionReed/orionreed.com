import { computed, effect, signal } from "@minim/signals";
import { Vec } from "@minim/values";
import { bench, group } from "mitata";

// ── Reads ───────────────────────────────────────────────────────────

group("axis read (after first-access cache)", () => {
  const raw = signal({ x: 1, y: 2 });
  const v: any = Vec.signal({ x: 1, y: 2 });
  void v.x; // Warm: first access installs the lens as own-property.
  void v.y;

  bench("raw signal: sig.value.x", () => raw.value.x).baseline(true);
  bench("Vec lens: v.x.value", () => v.x.value);
  bench("Vec whole-value: v.value.x", () => v.value.x);
});

group("whole-value read", () => {
  const raw = signal({ x: 1, y: 2 });
  const v = Vec.signal({ x: 1, y: 2 });

  bench("raw signal: sig.value", () => raw.value).baseline(true);
  bench("Vec: v.value", () => v.value);
});

// ── Writes ──────────────────────────────────────────────────────────
//
// Each iter changes the value (++i) so equality doesn't suppress the
// notify; this measures the *full* write path (write + equals +
// notify-no-subscribers).

group("axis write — no subscribers (write + equals)", () => {
  const raw = signal({ x: 1, y: 2 });
  const v: any = Vec.signal({ x: 1, y: 2 });
  void v.x;

  let i = 0;
  bench("raw: sig.value = {x: ++i, y: cur.y}", () => {
    const cur = raw.peek();
    raw.value = { x: ++i, y: cur.y };
  }).baseline(true);
  bench("Vec lens: v.x.value = ++i (construct writer)", () => {
    v.x.value = ++i;
  });
  bench("Vec whole: v.value = {x: ++i, y: cur.y}", () => {
    const cur = v.peek();
    v.value = { x: ++i, y: cur.y };
  });
});

group("axis write — with 1 subscriber", () => {
  const raw = signal({ x: 1, y: 2 });
  const v: any = Vec.signal({ x: 1, y: 2 });
  void v.x;

  // Subscribe via effect so the .x signal has someone to notify.
  let observed = 0;
  const e1 = effect(() => {
    observed = raw.value.x;
  });
  const e2 = effect(() => {
    observed = v.value.x;
  });

  let i = 0;
  bench("raw: sig.value = {x: ++i, y: cur.y}", () => {
    const cur = raw.peek();
    raw.value = { x: ++i, y: cur.y };
  }).baseline(true);
  bench("Vec lens: v.x.value = ++i", () => {
    v.x.value = ++i;
  });

  // Keep references alive
  void e1;
  void e2;
  void observed;
});

// ── Round-trip: lens read after write ───────────────────────────────

group("axis write → read derived chain", () => {
  // Setup: writer changes .x; an 'add' op produces a derived; we read
  // its value. Measures the full reactivity round-trip.
  const a: any = Vec.signal({ x: 1, y: 2 });
  const b = Vec.signal({ x: 3, y: 4 });
  void a.x;
  const sumLifted = a.add(b);

  // Hand-written equivalent for reference.
  const sumHand = computed(() => ({
    x: a.value.x + b.value.x,
    y: a.value.y + b.value.y,
  }));

  let i = 0;
  bench("Vec: write a.x → read sumLifted.value", () => {
    a.x.value = ++i;
    return sumLifted.value;
  }).baseline(true);
  bench("Vec: write a.x → read sumHand.value", () => {
    a.x.value = ++i;
    return sumHand.value;
  });
});
