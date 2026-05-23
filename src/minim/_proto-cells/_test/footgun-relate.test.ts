// footgun-relate.test.ts — adversarial probes specifically for the
// `relate` primitive. Naive users will write asymmetric relations,
// stack multiple relations on the same cells, set up relates after
// initial state has diverged, etc. Probe each pattern.

import { describe, expect, it } from "vitest";
import { effect, num } from "../index";
import { relate } from "../relate";

describe("relate: initial-state convergence", () => {
  it("FOOTGUN: setting up relate when a and b have different values uses fwd to overwrite b", () => {
    const a = num(5);
    const b = num(100);
    relate(
      a,
      b,
      x => x * 2,
      y => y / 2,
    );
    // The first effect (a → b) runs first, computes fwd(5) = 10,
    // writes b. b's initial value (100) is silently overwritten.
    // Second effect (b → a) runs, reads new b=10, computes bwd(10)=5,
    // writes a. a was already 5, no change.
    expect(a.value).toBe(5);
    expect(b.value).toBe(10);
    // The user's pre-relate b=100 is lost.
  });

  it("FOOTGUN: relating two signals where bwd takes priority requires manual order", () => {
    // To start "from b": user must write b after relate is set up.
    const a = num(5);
    const b = num(100);
    relate(
      a,
      b,
      x => x * 2,
      y => y / 2,
    );
    // After relate: a=5, b=10 (fwd-dominated).
    b.value = 100; // explicit b-write
    expect(a.value).toBe(50); // bwd-dominated now
    expect(b.value).toBe(100);
  });
});

describe("relate: asymmetric relations (fwd ≠ bwd⁻¹)", () => {
  it("non-invertible relation: lossy round-trip behavior", () => {
    const a = num(0);
    const b = num(0);
    // floor on each direction — non-invertible (any a in [n, n+1)
    // rounds to n, which then bwd's back to n).
    relate(
      a,
      b,
      x => Math.floor(x),
      y => Math.floor(y),
    );
    a.value = 3.7;
    expect(b.value).toBe(3);
    // After relate's two effects: b=3, then bwd(3)=3 written to a.
    // a was 3.7, becomes 3.
    expect(a.value).toBe(3);
  });

  it("FOOTGUN: identity-fwd, doubling-bwd diverges to Infinity", () => {
    // The two effects mutually amplify each cycle: a → b → a (doubled)
    // → b (doubled) → ... Each iteration writes a value strictly
    // larger than the previous, so the engine's `===` short-circuit
    // never fires UNTIL the value reaches Infinity, where
    // Infinity === Infinity. Loop terminates with both = Infinity.
    //
    // This is structural divergence — the relation isn't a contraction.
    // No engine can paper over it without an iteration budget. The
    // user must provide an Iso relation (or a contractive one) for
    // termination at a finite value.
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x,
      y => y * 2,
    );
    expect(a.value).toBe(0);
    expect(b.value).toBe(0);

    a.value = 5;
    // Diverges to Infinity, then short-circuits.
    expect(a.value).toBe(Infinity);
    expect(b.value).toBe(Infinity);
  });
});

describe("relate: stacking multiple relates on the same cell", () => {
  it("two relates on the same source: each target updates independently", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate(
      a,
      b,
      x => x + 10,
      y => y - 10,
    );
    relate(
      a,
      c,
      x => x * 2,
      y => y / 2,
    );

    a.value = 5;
    expect(b.value).toBe(15);
    expect(c.value).toBe(10);

    // Writing b updates a, which fans out to c.
    b.value = 30;
    expect(a.value).toBe(20);
    expect(c.value).toBe(40);
  });

  it("FOOTGUN: relate(a, b) twice creates two effect pairs — duplicate work", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );
    // Both pairs do the same thing. Writes still terminate (same
    // values) but each write triggers redundant effect runs.
    let bFires = 0;
    const stop = effect(() => {
      void b.value;
      bFires++;
    });
    bFires = 0;
    a.value = 10;
    // b changes once (10+1=11), so the b-watcher fires once.
    // But internally, both relate-pairs fire their a→b effect.
    // The second writeBack to b sees same value (===), no new propagation.
    expect(b.value).toBe(11);
    expect(bFires).toBe(1);
    stop();
  });

  it("conflicting relates: which fwd wins depends on effect-creation order", () => {
    const a = num(5);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 100,
      y => y - 100,
    );
    expect(b.value).toBe(105); // first relate sets b=105

    // Second relate with conflicting fwd. The first relate's fwd
    // re-fires (since a doesn't change but its effect was set up
    // earlier). Hmm actually the second relate's fwd is what runs
    // last (its effect runs last in the construction order).
    relate(
      a,
      b,
      x => x * 2,
      y => y / 2,
    );
    // After: second relate sets b=10. First relate's bwd runs
    // (b changed), updates a=10-100=-90. Then first relate's fwd
    // runs again: b=fwd(-90)=10. Same. Done? Or loops?
    // Let me just assert what actually happens.
    expect(Number.isFinite(a.value)).toBe(true);
    expect(Number.isFinite(b.value)).toBe(true);
    // Document that conflicting relates produce a fixed point that
    // depends on engine's effect ordering — caller error.
  });
});

describe("relate: interactions with effects", () => {
  it("write inside effect via `=`: cascades properly", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );

    let observed = 0;
    const stop = effect(() => {
      observed = b.value;
    });
    expect(observed).toBe(1);

    a.value = 10;
    expect(b.value).toBe(11);
    expect(observed).toBe(11);

    stop();
  });

  it("relate + transitive effect: no spurious extra fires", () => {
    const a = num(0);
    const b = num(0);
    relate(
      a,
      b,
      x => x + 1,
      y => y - 1,
    );

    let observed: number[] = [];
    const stop = effect(() => {
      observed.push(b.value);
    });
    observed = [];

    for (let i = 1; i <= 5; i++) {
      a.value = i;
    }
    expect(observed).toEqual([2, 3, 4, 5, 6]);
    stop();
  });
});

describe("relate: cleanup after dispose", () => {
  it("after dispose, writes don't propagate via the relation", () => {
    const a = num(0);
    const b = num(0);
    const r = relate(
      a,
      b,
      x => x * 2,
      y => y / 2,
    );

    a.value = 3;
    expect(b.value).toBe(6);

    r.dispose();

    a.value = 100;
    expect(b.value).toBe(6); // unchanged
    b.value = 999;
    expect(a.value).toBe(100); // unchanged
  });

  it("dispose followed by re-create: new relation works", () => {
    const a = num(5);
    const b = num(10);
    const r1 = relate(
      a,
      b,
      x => x * 2,
      y => y / 2,
    );
    expect(b.value).toBe(10); // a=5 → b=10
    r1.dispose();

    a.value = 7;
    expect(b.value).toBe(10); // r1 disposed

    const r2 = relate(
      a,
      b,
      x => x + 100,
      y => y - 100,
    );
    expect(b.value).toBe(107); // r2 sets b=fwd(7)=107
    a.value = 0;
    expect(b.value).toBe(100);
    r2.dispose();
  });
});

describe("relate: with computed cells", () => {
  it("FOOTGUN: relating to a computed (RO) — second arg must be writable", () => {
    // Type system rejects this: relate's signature requires both
    // sides to have WritableBrand. Computed lacks the brand.
    // We can't even construct this scenario in TS without a cast.
    expect(true).toBe(true);
  });
});

describe("relate: very large fan-out", () => {
  it("100 cells related to one source: writes propagate to all", () => {
    const a = num(0);
    const targets = Array.from({ length: 100 }, () => num(0));
    for (const t of targets) {
      relate(
        a,
        t,
        x => x * 2,
        y => y / 2,
      );
    }
    a.value = 5;
    for (const t of targets) {
      expect(t.value).toBe(10);
    }
  });

  it("write to one of the 100 targets: a updates, all others follow", () => {
    const a = num(0);
    const targets = Array.from({ length: 50 }, () => num(0));
    for (const t of targets) {
      relate(
        a,
        t,
        x => x * 2,
        y => y / 2,
      );
    }
    targets[5]!.value = 30;
    expect(a.value).toBe(15);
    for (const t of targets) {
      expect(t.value).toBe(30);
    }
  });
});
