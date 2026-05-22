// cycle-probe.test.ts — when does the lens system loop?
//
// Claim: a single write event is DAG-shaped — propagate() visits each
// subscriber at most once. The cycle question is at the *event* level:
// effects fire and spawn new write events. The sequence of events
// terminates iff each successive write either (a) hits the strict-===
// equality skip in `Signal.set value` or (b) hits a no-write guard in
// the effect body (`if (a !== b) ...`).
//
// What we test:
//  (1) Simple eq cycles terminate (engine's strict === already handles).
//  (2) Eq-with-drifty-roundtrip can be made to oscillate forever
//      without an iteration budget. (Demonstrates the real failure
//      mode our recent equality discussion was pointing at.)

import { describe, expect, it } from "vitest";
import { effect, eq, Num, num } from "../index";

describe("cycle: single write is finite", () => {
  it("simple eq terminates", () => {
    const a = num(0);
    const b = num(0);
    eq(a, b);
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

  it("eq + exactly-invertible lens chain terminates", () => {
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
  it("THIS IS THE BUG: eq(a, drifty) loops indefinitely under multiplicative drift", () => {
    // The lens reads `a * (1+ε)` and writes through identity. eq()
    // ties the two together. effect1 sees a≠drifty (fwd drifted ε)
    // and writes drifty:=a; effect2 then re-reads drifty (recomputes
    // fwd from the just-written a, drifting again) and sees b≠a,
    // writes a:=b. Each iteration drifts a another ε. The engine's
    // strict-=== skip never fires because the values genuinely change.
    //
    // We cap the lens's bwd at BUDGET writes to keep the test from
    // hanging. The expected behaviour: blow through the budget.
    const DRIFT = 1 + 1e-7;
    const BUDGET = 1000;
    const a = num(1);
    let writes = 0;
    const drifty = Num.lens(
      () => a.value * DRIFT,
      v => {
        writes++;
        if (writes > BUDGET) throw new Error("BUDGET");
        (a as unknown as { value: number }).value = v;
      },
    );

    expect(() => {
      eq(a, drifty);
      a.value = 2;
    }).toThrow(/BUDGET/);

    // a has drifted significantly from the value (2) that was written.
    expect(a.peek()).toBeGreaterThan(2.0001);
  });

  it("control: identity lens — no drift", () => {
    const a = num(5);
    let writes = 0;
    const clean = Num.lens(
      () => a.value,
      v => {
        (a as unknown as { value: number }).value = v;
      },
    );
    eq(a, clean);

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
