// cycle-probe.test.ts — when does the lens system loop?
//
// Claim: a single write event is DAG-shaped — propagate() visits each
// subscriber at most once. The cycle question is at the *event* level:
// effects fire and spawn new write events. The sequence of events
// terminates iff each successive write either (a) hits the strict-===
// equality skip in the `value` setter or (b) hits a no-write guard in
// the effect body (`if (a !== b) ...`).
//
// What we test:
//  (1) Simple bidirectional-sync cycles terminate (engine's strict
//      === already handles).
//  (2) Sync-with-drifty-roundtrip oscillates forever without an
//      iteration budget. (Demonstrates the real failure mode our
//      recent equality discussion was pointing at.)
//
// Two-cell bidirectional sync is set up inline (a tiny effect pair)
// rather than reaching for a `eq` helper — keeps the test
// self-contained and the failure mode crystal clear.

import { describe, expect, it } from "vitest";
import { effect, Num, num } from "../index";

/** Inline bidirectional sync via two guarded effects. */
function sync<T>(a: { value: T; peek(): T }, b: { value: T; peek(): T }): () => void {
  const s1 = effect(() => {
    const v = a.value;
    if (b.peek() !== v) b.value = v;
  });
  const s2 = effect(() => {
    const v = b.value;
    if (a.peek() !== v) a.value = v;
  });
  return () => {
    s1();
    s2();
  };
}

describe("cycle: single write is finite", () => {
  it("simple bidirectional sync terminates", () => {
    const a = num(0);
    const b = num(0);
    sync(a, b);
    let runs = 0;
    effect(() => {
      void a.value;
      runs++;
    });
    runs = 0;
    a.value = 1;
    expect(runs).toBe(1);
    expect(b.value).toBe(1);
  });

  it("sync + exactly-invertible lens chain terminates", () => {
    // .add(2).sub(2) is exact in IEEE 754 for integers near 0 — fwd
    // and bwd both lossless. Engine === catches the no-op.
    const a = num(0);
    const b = a.add(2).sub(2);
    expect(b.value).toBe(0);
    b.value = 10;
    expect(a.value).toBe(10);
  });
});

describe("cycle: drift-prone roundtrip — the actual failure mode", () => {
  it("THIS IS THE BUG: a drift roundtrip never reaches a fixpoint", () => {
    // `drifty` reads `a * (1+ε)` and writes through identity. Wiring it
    // to `a` with sync() is the canonical non-terminating cycle: each
    // round, fwd drifts `a` up by ε and the back-write commits it, so
    // the values genuinely change every step — the engine's view-change
    // short-circuit never fires (the view really IS different each time).
    //
    // Driving that through the engine's effect loop hangs (it only stops
    // when an internal queue overflows). We instead step the roundtrip by
    // hand: one `a := drifty` per round. The point of the probe stands —
    // the system has no fixpoint; `a` climbs monotonically without bound.
    const DRIFT = 1 + 1e-7;
    const a = num(1);
    const drifty = Num.lens(
      a,
      av => av * DRIFT,
      v => v,
    );

    let prev = a.peek();
    for (let round = 0; round < 50; round++) {
      a.value = drifty.value; // push the drifted view back into the source
      expect(a.peek()).toBeGreaterThan(prev); // strictly drifts every round
      prev = a.peek();
    }
    // 50 rounds of ×(1+ε) compounding ⇒ a has drifted clear of its start.
    expect(a.peek()).toBeGreaterThan(1 + 40 * 1e-7);
  });

  it("control: identity lens — no drift", () => {
    const a = num(5);
    let writes = 0;
    const clean = Num.lens(
      [a] as const,
      ([av]) => av,
      v => [v],
    );
    sync(a, clean);

    effect(() => {
      void a.value;
      writes++;
    });
    writes = 0;

    a.value = 5;
    expect(writes).toBe(0);
    a.value = 6;
    expect(writes).toBe(1);
    expect(clean.value).toBe(6);
  });
});
