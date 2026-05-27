// aliasing.test.ts — what happens when a writable cell is referenced by
// multiple lenses, when it's already a lens itself, when bwd intentions
// fan in to the same cell?
//
// These are the cases the literature warns about (`lensProduct` is
// unsound when projections overlap, partial-state lenses propose
// per-cell merge to handle, etc.). Let's see what the *current* engine
// semantics actually do.

import { describe, expect, it } from "vitest";
import { batch, effect, Num, num, vec, type Writable } from "../../../index";
import { lensW, numAddW, vecRightW } from "../wp";

describe("shared writable param across two sibling lenses", () => {
  it("two lenses, same n: drag either, both views update", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    const c = vecRightW(a, n);
    expect(b.value).toEqual({ x: 15, y: 20 });
    expect(c.value).toEqual({ x: 15, y: 20 });

    b.value = { x: 100, y: 20 };
    // n := 90. Both b and c re-read with new n.
    expect(n.peek()).toBe(90);
    expect(b.value).toEqual({ x: 100, y: 20 });
    expect(c.value).toEqual({ x: 100, y: 20 }); // c follows b via shared n!
  });

  it("dragging c writes n; b moves in sympathy", () => {
    const a = vec(10, 20);
    const n = num(5);
    const b = vecRightW(a, n);
    const c = vecRightW(a, n);

    c.value = { x: 75, y: 25 };
    // c.bwd: n := 65, a.y := 25
    expect(n.peek()).toBe(65);
    expect(a.peek()).toEqual({ x: 10, y: 25 });
    expect(b.value).toEqual({ x: 75, y: 25 }); // b follows c
  });

  it("VERDICT: shared writable params just work, behave like shared signals", () => {
    // No new behavior class: shared writable params behave the way shared
    // writable cells behave anywhere in a signals graph — last write wins.
    const a = vec(0, 0);
    const n = num(0);
    const b = vecRightW(a, n);
    const c = vecRightW(a, n);
    b.value = { x: 10, y: 0 };
    c.value = { x: 20, y: 0 };
    expect(n.peek()).toBe(20);
    expect(b.value).toEqual({ x: 20, y: 0 }); // last write wins; b follows
  });
});

describe("writable param is itself a lens (chained-bwd cascade)", () => {
  it("scale lens as writable param: bwd cascades upstream", () => {
    const raw = num(10);
    const scaled = raw.scale(2); // writable lens; scaled.bwd writes raw

    const a = vec(0, 0);
    const b = vecRightW(a, scaled);
    expect(b.value).toEqual({ x: 20, y: 0 });

    b.value = { x: 40, y: 0 };
    // bwd: scaled := 40; scaled's bwd: raw := 20
    expect(raw.peek()).toBe(20);
    expect(scaled.value).toBe(40);
    expect(b.value).toEqual({ x: 40, y: 0 });
  });

  it("scaled used multiple places: drag-through stays consistent", () => {
    const raw = num(10);
    const scaled = raw.scale(2);

    const a = vec(0, 0);
    const b = vecRightW(a, scaled);

    // Another consumer of raw — not through scaled.
    const otherUser = raw.add(1000);
    expect(otherUser.value).toBe(1010);

    b.value = { x: 60, y: 0 };
    // scaled := 60 → raw := 30
    expect(raw.peek()).toBe(30);
    expect(otherUser.value).toBe(1030); // independently re-derives
    expect(b.value).toEqual({ x: 60, y: 0 });
  });
});

// ─── The DANGEROUS case: lensProduct-style aliasing through bwd ────

describe("DIAMOND: bwd writes to two cells, both ultimately rooted in the same primitive", () => {
  it("n and n_alias both writable params; same source — what happens?", () => {
    // Construct a lens where TWO of its writable parents are different
    // lens views of the SAME primitive. Each receives an independent
    // intention; both intentions land on the primitive; last write wins.
    const raw = num(10);
    const view1 = raw.add(0); // identity lens on raw; raw is the source
    const view2 = raw.add(0); // another identity lens on raw

    // 2-input sum lens reading view1 + view2 (i.e., 2*raw). Bwd splits
    // 50/50 between view1 and view2 in INTENTIONS — but those intentions
    // both route through to raw via the add(0).bwd.
    const sum = numAddW(view1 as Writable<Num>, view2 as Writable<Num>);
    expect(sum.value).toBe(20);

    // Write sum = 30 → delta = 10 → +5 to view1, +5 to view2
    // → raw gets two writes in one batch: raw := 15 (from view1), then
    // raw := 15 (from view2). Result: raw = 15. sum reads back 2*15 = 30.
    sum.value = 30;
    expect(raw.peek()).toBe(15);
    expect(sum.value).toBe(30);

    // PutGet holds! Even though the bwd "split" the write 50/50, the
    // diamond means both halves wrote to the same primitive. The
    // RESULT, miraculously, satisfies PutGet because both intentions
    // produced the same target (since each view sees +5 from a
    // symmetric split of a symmetric sum).
  });

  it("ASYMMETRIC diamond: PutGet violation", () => {
    // Same fixture, but weight the split asymmetrically. Now the two
    // intentions for raw disagree, and last-write-wins decides.
    const raw = num(10);
    const view1 = raw.add(0);
    const view2 = raw.add(0);

    const sum = numAddW(view1 as Writable<Num>, view2 as Writable<Num>, 0.8);
    // weightA = 0.8 → view1 absorbs 80% of delta; view2 absorbs 20%.

    sum.value = 30; // delta = 10. view1 += 8 → 18. view2 += 2 → 12.
    // bwd writes intentions: view1 := 18, view2 := 12.
    // Both route to raw. Last write wins → raw = 12. sum reads 24.
    expect(raw.peek()).toBe(12); // last write (view2) wins
    expect(sum.value).toBe(24); // NOT 30. PUTGET VIOLATED.
  });

  it("VERDICT: diamonds break PutGet under asymmetric write distributions", () => {
    // This is the classical `lensProduct` unsoundness from Haskell `lens`.
    // It's the user's footgun pattern: passing two writable views of the
    // same underlying cell into a multi-input lens.
    //
    // The pattern is detectable at construction: if any two writable
    // parents share a transitive root, the diamond exists. Engine
    // doesn't detect it today.
    expect(true).toBe(true);
  });
});

describe("downstream consumer re-fires when writable param updates", () => {
  it("effect on n re-runs when bwd writes through the lens", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = vecRightW(a, n);

    let nObs = 0;
    let lastN = 0;
    const stop = effect(() => {
      lastN = n.value;
      nObs++;
    });

    expect(nObs).toBe(1); // initial fire
    b.value = { x: 100, y: 0 };
    expect(nObs).toBe(2);
    expect(lastN).toBe(100);

    stop();
  });

  it("batch coalesces: 3 writes to b → 1 effect fire on n", () => {
    const a = vec(0, 0);
    const n = num(5);
    const b = vecRightW(a, n);

    let fires = 0;
    let lastN = 0;
    const stop = effect(() => {
      lastN = n.value;
      fires++;
    });

    fires = 0;
    batch(() => {
      b.value = { x: 10, y: 0 };
      b.value = { x: 20, y: 0 };
      b.value = { x: 30, y: 0 };
    });
    expect(fires).toBe(1);
    expect(lastN).toBe(30);

    stop();
  });
});

describe("the most pathological diamond: writable param FED BY the lens output", () => {
  it("CANNOT be constructed without explicit effect — lens construction is acyclic", () => {
    // Try to spell: b = vecRightW(a, n), where n = f(b).
    // At the moment of vecRightW(a, n), `n` must already exist as a writable Num.
    // To make n depend on b would require constructing n before b — circular.
    // The TYPE SYSTEM enforces this implicitly via expression order.
    const a = vec(0, 0);
    const n = num(5);
    const b = vecRightW(a, n);
    expect(b.value).toEqual({ x: 5, y: 0 });

    // Now if you WANT b → n cycle, you must use effect():
    let cycleFires = 0;
    const stop = effect(() => {
      const bv = b.value;
      cycleFires++;
      if (cycleFires < 3) {
        // dangerous: writes to n from inside an effect on b's value
        n.value = bv.x * 2;
      }
    });
    // This is the SAME footgun as today's signal effects. Acceptable per
    // the invariant: cycles require effect, full stop. wp lenses don't
    // give you a new way to spell this.
    stop();
  });

  it("VERDICT: invariant A preserved — cycles still require effect", () => {
    // No way to construct a cycle through pure lens+method composition.
    expect(true).toBe(true);
  });
});

describe("`Cls.derive` (read-only) used in a writable-param slot", () => {
  it("Cls.derive yields no setter; engine throws if bwd writes to it", () => {
    const raw = num(10);
    const derived = raw.lens(
      v => v * 2,
      n => n / 2,
    ); // writable lens, fine
    void derived;

    const a = vec(0, 0);
    // What if we sneak a read-only signal in via cast?
    // Vec.derive of raw is read-only.
    const readOnly = Num.derive([num(10)], ([v]) => v + 1) as unknown as Writable<Num>;
    // .lens(g) with one arg is a getter-only — read-only. Type lies via cast.
    // But the engine throws when bwd tries to write.
    const b = vecRightW(a, readOnly);
    expect(b.value).toEqual({ x: 11, y: 0 });

    expect(() => {
      b.value = { x: 100, y: 0 };
    }).toThrow("Cannot write to a Computed");
    // VERDICT: engine catches this at WRITE TIME, not at construction.
    // Surface as a clearer error in production.
  });
});

describe("ordering: writes inside same batch", () => {
  it("two writes through different paths: later wins", () => {
    const n = num(0);
    const a = vec(0, 0);
    const b = vecRightW(a, n);
    batch(() => {
      n.value = 100;
      b.value = { x: 5, y: 0 }; // overrides n to 5
    });
    expect(n.peek()).toBe(5);
    expect(b.value).toEqual({ x: 5, y: 0 });
  });

  it("write to lens followed by write to param: param-write wins", () => {
    const n = num(0);
    const a = vec(0, 0);
    const b = vecRightW(a, n);
    batch(() => {
      b.value = { x: 5, y: 0 }; // n := 5
      n.value = 100; // n := 100
    });
    expect(n.peek()).toBe(100);
    expect(b.value).toEqual({ x: 100, y: 0 });
  });
});
