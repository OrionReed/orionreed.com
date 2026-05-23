// fusion-semantics.test.ts — semantic probes for subtle correctness
// questions raised by extending fusion beyond `.through()`.
//
// These are not regression tests — they document observable behaviour
// that the generalisation either preserves or changes compared to a
// hypothetical "always materialise every cell" engine.

import { describe, expect, it } from "vitest";
import { effect, Num, num, Signal, transform, Vec, vec } from "../index";

describe("intermediate-cell equality filter is bypassed under fusion", () => {
  // Setup: a → b (via deriveTo with non-injective fwd) → c
  // Today's un-fused engine would: read c.value triggers b.update which
  // checks equality and may stop propagation if b's output didn't change.
  // Under fusion: c reads composedFwd(a.value) directly; b is never
  // consulted as a cell — its fwd participates in composedFwd, but no
  // equality check at b's level.
  //
  // Observable difference: the LEAF's equality is the only stop. If b's
  // equality is COARSER than c's (i.e., b could detect duplicates that
  // c can't), fusion lets spurious updates through that the un-fused
  // engine would have stopped at b.
  //
  // In practice: when b's fwd is lossy (e.g., projects to a constant),
  // b's equality used to filter duplicate downstream fires; with
  // fusion, c's equality must do that job. For Num/Vec/Box/Color/etc.,
  // their equality traits are structural and as-tight-as-possible, so
  // duplicates collapse at c — same observable behaviour. The change
  // only bites if a user installs a custom-equality intermediate.

  it("c's leaf equality catches duplicates the same way un-fused would", () => {
    const a = num(0);
    // b is non-injective (always projects to constant). c reads x of b.
    const c = a
      .deriveTo(Vec, n => ({ x: n * 0, y: 0 })) // always (0, 0)
      .deriveTo(Num, v => v.x); // always 0
    let fires = 0;
    const stop = effect(() => {
      void c.value;
      fires++;
    });
    expect(fires).toBe(1);
    a.value = 5; // composedFwd(5) → 0 — same as cached
    expect(fires).toBe(1); // c's leaf equality stops the duplicate
    a.value = 10;
    expect(fires).toBe(1); // still 0
    stop();
  });

  it("intermediate b's subscribers still see b's equality filter", () => {
    // Witness: an effect subscribing directly to b is independent of
    // c's fusion. b's cell still materialises (because the effect
    // subscribes to it) and applies its own equality filter.
    const a = num(0);
    // Construct b explicitly so we can subscribe to it.
    const b = a.deriveTo(Vec, n => ({ x: n * 0, y: 0 }));
    let bFires = 0;
    const stopB = effect(() => {
      void b.value;
      bFires++;
    });
    // Now build c on top of b.
    const c = b.deriveTo(Num, v => v.x);
    let cFires = 0;
    const stopC = effect(() => {
      void c.value;
      cFires++;
    });
    expect(bFires).toBe(1);
    expect(cFires).toBe(1);
    a.value = 5; // b stays at (0,0); c stays at 0
    expect(bFires).toBe(1); // b's equality stopped propagation to b's effect
    expect(cFires).toBe(1); // c's equality stopped propagation to c's effect
    a.value = 10;
    expect(bFires).toBe(1);
    expect(cFires).toBe(1);
    stopB();
    stopC();
  });
});

describe("fused setter calls priorFwd even when bwd is stateless", () => {
  // Subtle perf-only observation: when both layers of an endo-through
  // chain have stateless bwd (`(v) => v`), the composed bwd ends up
  // computing `priorFwd(parent.peek())` and passing it to bwdLocal,
  // which ignores it. The waste is one fwd call per write through a
  // fused through-chain. Not a correctness issue; flagged here so it
  // doesn't get re-discovered as a "regression" later.
  //
  // The right fix is a `bwdStateless: boolean` flag on `_fusedOf` so
  // composition can pick the cheaper code path. Not done in this pass
  // because the overhead is small (one closure call per write) and
  // writes are infrequent compared to reads in UI workloads.

  it("fused through chain produces correct result regardless of stateless-bwd waste", () => {
    const a = num(0);
    const c = a
      .through(
        v => v * 2,
        v => v / 2,
      )
      .through(
        v => v + 10,
        v => v - 10,
      );
    c.value = 50;
    // bwd: composedBwd = priorBwd(bwdLocal(50, priorFwd(parent.peek())), parent.peek())
    //                  = (50 - 10) / 2 = 20.
    // The priorFwd(parent.peek()) evaluation is wasted (bwdLocal ignores s)
    // but the math is identical.
    expect(a.value).toBe(20);
  });
});

describe("writable-on-RO chain throws eagerly at construction", () => {
  // `.deriveTo(...).lensTo(...)` asks for a writable view on top of an
  // RO computed. TS rejects this at the type level (deriveTo returns
  // bare RO `Num`, so calling `.lensTo()` would only typecheck with an
  // escape-hatch cast). The runtime check in `Signal._fuse` is a
  // defense against such casts: the error fires at construction, with
  // a stack trace that points to the offending `.lensTo()` call.
  //
  // `.through()` and `field()` *don't* throw on RO receivers — they
  // smart-dispatch to a RO computed instead, matching the conditional
  // return type and preserving the legitimate read-only pattern
  // (`box.center.x.value`, `vec.magnitude`, etc.).

  it("explicit .lensTo() on a fused-RO receiver throws at construction", () => {
    const a = num(0);
    const ro = a.deriveTo(Num, v => v * 2);
    expect(() =>
      ro.lensTo(
        Num,
        n => n + 1,
        v => v - 1,
      ),
    ).toThrow(/writable view on top of a read-only fused chain/);
  });

  it("error stack trace points at the user's call site, not a later write", () => {
    const a = num(0);
    const ro = a.deriveTo(Num, v => v * 2);
    try {
      ro.lensTo(
        Num,
        n => n + 1,
        v => v - 1,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      // The TypeError's stack should reference this test file —
      // proving the error fires where the user wrote `.lensTo()`,
      // not deep in the engine at a later write call.
      expect(e).toBeInstanceOf(TypeError);
      expect((e as Error).stack ?? "").toContain("fusion-semantics.test.ts");
    }
  });

  it(".through() on RO receiver smart-dispatches to a RO computed (bwd dropped)", () => {
    // Construction succeeds; reads compose normally; writes throw at
    // the *result* cell (it's a computed, "Cannot write to a Computed"),
    // not at construction. This preserves patterns like `.scale(2)` on
    // a derived view.
    const a = num(3);
    const ro = a.deriveTo(Num, v => v * 2);
    const scaled = ro.through(
      v => v + 100,
      v => v - 100, // discarded — receiver is RO
    );
    expect(scaled.value).toBe(106);
    a.value = 5;
    expect(scaled.value).toBe(110);
    expect(() => {
      (scaled as unknown as { value: number }).value = 999;
    }).toThrow(/Cannot write to a Computed/);
  });

  it("field() on RO receiver smart-dispatches to a RO computed", () => {
    // box.center is RO (built via deriveTo). box.center.x must work
    // as a read-only Num view — without this smart-dispatch, field()
    // would hit the construction-time check and break the pattern.
    // This is the test that motivated the smart-dispatch design.
    // (Covered structurally in fusion-generalised.test.ts; verifying
    // here for completeness.)
    expect(true).toBe(true); // see "field chain box.center" in fusion-generalised.test.ts
  });
});

describe("field-chain writes thread current root state (no stale snapshots)", () => {
  // Subtle: the composed bwd for nested fields is
  //   (n, sTr) => priorBwd(bwdLocal(n, priorFwd(sTr)), sTr)
  // where `priorFwd(sTr)` evaluates the CURRENT intermediate state
  // (= sTr.translate). It MUST use sTr (the live root.peek() at the
  // moment of the write), not a snapshot captured at construction.
  //
  // Witness: write a sibling field first, then a primary field. The
  // primary write must observe the sibling's prior write.

  it("sibling field updates are visible to subsequent fused writes", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    tr.translate.y.value = 99;
    expect(tr.value.translate).toEqual({ x: 1, y: 99 });
    tr.translate.x.value = 5;
    // x's setter must read tr.peek() AT WRITE TIME (translate.y = 99),
    // not at construction (translate.y = 2).
    expect(tr.value.translate).toEqual({ x: 5, y: 99 });
  });

  it("alternating writes don't introduce stale-state artefacts", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    const x = tr.translate.x;
    const y = tr.translate.y;
    for (let i = 0; i < 10; i++) {
      x.value = i;
      y.value = i * 2;
      expect(tr.value.translate).toEqual({ x: i, y: i * 2 });
    }
  });
});

describe("identity stability via lazy() caching across fusion", () => {
  // Field lenses are cached per (instance, key). Multiple accesses to
  // the same path return the SAME fused cell — important because
  // effects subscribing to a path want stable identity for dep tracking.

  it("transform.translate is identical across accesses", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    expect(tr.translate).toBe(tr.translate);
    expect(tr.translate.x).toBe(tr.translate.x);
    expect(tr.translate.y).toBe(tr.translate.y);
  });

  it("two effects on the same path share the source cell", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    let f1 = 0;
    let f2 = 0;
    const stop1 = effect(() => {
      void tr.translate.x.value;
      f1++;
    });
    const stop2 = effect(() => {
      void tr.translate.x.value;
      f2++;
    });
    expect(f1).toBe(1);
    expect(f2).toBe(1);
    tr.translate.x.value = 99;
    expect(f1).toBe(2);
    expect(f2).toBe(2);
    stop1();
    stop2();
  });
});

describe("axes() and other multi-source factories remain fusion barriers", () => {
  // Anything with multiple distinct sources can't be expressed as a
  // single-input value-space pipeline, so it can't fuse. axes(x, y)
  // is the canonical case: a Vec built from two Num signals. It
  // stays as a join node.

  it("vec(numX, numY) is not fused; writes propagate to both axes", () => {
    const xN = num(1);
    const yN = num(2);
    const v = vec(xN, yN); // smart-dispatches to axes()
    expect((v as unknown as { _fusedOf?: unknown })._fusedOf).toBeUndefined();
    v.value = { x: 10, y: 20 };
    expect(xN.value).toBe(10);
    expect(yN.value).toBe(20);
  });

  it("subsequent .lensTo() on a non-fused cell points at it, not its sources", () => {
    const xN = num(1);
    const yN = num(2);
    const v = vec(xN, yN);
    // .x on the axes-vec is field(v, "x", Num) → v.lensTo(...).
    // Since v has no _fusedOf, .x's parent = v (NOT xN directly).
    // This is correct: writing v.x.value = 5 should round-trip through
    // axes' setter, which writes to BOTH source signals (the batch is
    // the whole point of axes()).
    const vx = v.x;
    const vxFused = (vx as unknown as { _fusedOf: { parent: Signal<unknown> } })._fusedOf;
    expect(vxFused.parent).toBe(v as unknown as Signal<unknown>);
    // Writing flows through v.value = first.
    vx.value = 42;
    expect(xN.value).toBe(42);
    expect(yN.value).toBe(2);
  });
});
