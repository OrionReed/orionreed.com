// fusion-structural.test.ts — structural witnesses for fusion.
//
// The functional tests in fusion-generalised.test.ts probe individual
// fusion cases ("does deriveTo ∘ deriveTo collapse?", "does field
// chain fuse?"). These tests assert a tighter invariant:
//
//   For any fused chain a → b → c → … → leaf, when an effect
//   subscribes to `leaf.value`, the only cells with non-empty `.subs`
//   are the root and the leaf itself (which has the effect subscribed).
//
// This catches behaviours that the per-case tests might miss: any
// intermediate accumulating subscribers under any access pattern.
//
// Internal-cell counting via the engine's `.subs` field is fragile
// (it's an internal Link list), but it's the only structural witness
// available without modifying the engine.

import { describe, expect, it } from "vitest";
import { effect, Num, num, type Signal, transform, Vec, vec } from "../index";

// Does `s` have a non-empty `.subs` linked list?
const hasSubscribers = (s: unknown): boolean => (s as { subs?: unknown }).subs !== undefined;

const fusedParent = (s: unknown): unknown =>
  (s as { _fusedOf?: { parent: unknown } })._fusedOf?.parent;

describe("structural: only root + effect-subscribed leaves carry subs", () => {
  it("4-deep through chain: only root has subs when effect on leaf", () => {
    const a = num(0);
    const l1 = a.through(
      v => v + 1,
      v => v - 1,
    );
    const l2 = l1.through(
      v => v * 2,
      v => v / 2,
    );
    const l3 = l2.through(
      v => v - 3,
      v => v + 3,
    );
    const leaf = l3.through(
      v => v * 5,
      v => v / 5,
    );

    // Pre-effect: no cell has subs.
    expect(hasSubscribers(a)).toBe(false);
    expect(hasSubscribers(l1)).toBe(false);
    expect(hasSubscribers(l2)).toBe(false);
    expect(hasSubscribers(l3)).toBe(false);
    expect(hasSubscribers(leaf)).toBe(false);

    const stop = effect(() => {
      void leaf.value;
    });

    // Post-effect: root has subs (the leaf links to it), leaf has
    // subs (the effect links to it). NO intermediate should have subs.
    expect(hasSubscribers(a)).toBe(true);
    expect(hasSubscribers(l1)).toBe(false);
    expect(hasSubscribers(l2)).toBe(false);
    expect(hasSubscribers(l3)).toBe(false);
    expect(hasSubscribers(leaf)).toBe(true);

    stop();

    // Post-cleanup: everything purged.
    expect(hasSubscribers(a)).toBe(false);
    expect(hasSubscribers(leaf)).toBe(false);
  });

  it("3-deep deriveTo chain: only root + leaf have subs under effect", () => {
    const a = num(0);
    const l1 = a.deriveTo(Num, v => v + 1);
    const l2 = l1.deriveTo(Num, v => v * 2);
    const leaf = l2.deriveTo(Num, v => v - 3);

    const stop = effect(() => {
      void leaf.value;
    });
    expect(hasSubscribers(a)).toBe(true);
    expect(hasSubscribers(l1)).toBe(false);
    expect(hasSubscribers(l2)).toBe(false);
    expect(hasSubscribers(leaf)).toBe(true);
    stop();
    expect(hasSubscribers(a)).toBe(false);
  });

  it("field chain transform.translate.x: only transform + leaf have subs", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    const xPath = tr.translate.x;
    // `tr.translate` is materialised by accessing `.translate` once
    // (it's `lazy()`-cached). Its `_fusedOf.parent === tr`.
    const tlate = tr.translate as unknown as Signal<unknown>;

    expect(fusedParent(xPath)).toBe(tr);
    expect(fusedParent(tlate)).toBe(tr);

    const stop = effect(() => {
      void xPath.value;
    });
    expect(hasSubscribers(tr)).toBe(true);
    // tr.translate is the intermediate from `.x`'s perspective — should
    // NOT pick up subs from xPath's link path. (It might have its own
    // _fusedOf chain but no subs.)
    expect(hasSubscribers(tlate)).toBe(false);
    expect(hasSubscribers(xPath)).toBe(true);
    stop();
    expect(hasSubscribers(tr)).toBe(false);
  });

  it("4-deep deriveTo chain with mixed types (Num→Vec→Num→Vec): only root has subs", () => {
    const a = num(2);
    const l1 = a.deriveTo(Vec, n => ({ x: n, y: n * 2 }));
    const l2 = l1.deriveTo(Num, v => v.x + v.y);
    const leaf = l2.deriveTo(Vec, n => ({ x: n, y: 0 }));

    expect(fusedParent(leaf)).toBe(a);

    const stop = effect(() => {
      void leaf.value;
    });
    expect(hasSubscribers(a)).toBe(true);
    expect(hasSubscribers(l1)).toBe(false);
    expect(hasSubscribers(l2)).toBe(false);
    expect(hasSubscribers(leaf)).toBe(true);
    stop();
  });

  it.skip("box.expand(5).x — skipped (Box not ported)", () => {});

  it("multiple effects on the same fused leaf: all on the leaf, none on intermediates", () => {
    const a = num(0);
    const leaf = a.deriveTo(Num, v => v + 1).deriveTo(Num, v => v * 2);
    const intermediate = (leaf as unknown as { _fusedOf: { parent: unknown } })._fusedOf.parent;
    // The intermediate cell IS the leaf's parent — which IS the root a.
    // (Fusion collapsed the chain, so there's no "real" intermediate cell.)
    expect(intermediate).toBe(a);

    const stops = [
      effect(() => void leaf.value),
      effect(() => void leaf.value),
      effect(() => void leaf.value),
    ];
    expect(hasSubscribers(a)).toBe(true);
    expect(hasSubscribers(leaf)).toBe(true);
    for (const stop of stops) stop();
    expect(hasSubscribers(a)).toBe(false);
    expect(hasSubscribers(leaf)).toBe(false);
  });

  it("separately-held intermediates DO pick up subs when read directly", () => {
    // Witness the inverse: the intermediate cell isn't "skipped from
    // the dep graph in some absolute sense" — it's skipped along the
    // fused-chain's path. If something subscribes to the intermediate
    // independently, it materialises as expected.
    const a = num(0);
    const intermediate = a.deriveTo(Num, v => v * 2);
    const leaf = intermediate.deriveTo(Num, v => v + 1);

    const stopLeaf = effect(() => void leaf.value);
    expect(hasSubscribers(intermediate)).toBe(false); // bypassed by leaf

    const stopMid = effect(() => void intermediate.value);
    expect(hasSubscribers(intermediate)).toBe(true); // now materialised

    stopMid();
    expect(hasSubscribers(intermediate)).toBe(false);
    stopLeaf();
  });
});

describe("structural: lens-law propagation", () => {
  const law = (s: unknown): string | undefined =>
    (s as { _fusedOf?: { law?: string } })._fusedOf?.law;

  it("pure through chain is iso throughout", () => {
    const a = num(0);
    const c = a
      .through(
        v => v + 1,
        v => v - 1,
      )
      .through(
        v => v * 2,
        v => v / 2,
      )
      .through(
        v => v - 3,
        v => v + 3,
      );
    expect(law(c)).toBe("iso");
  });

  it("a single lensTo (via field) marks the chain stateful", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    expect(law(tr.translate as unknown as Signal<unknown>)).toBe("stateful");
    expect(law(tr.translate.x as unknown as Signal<unknown>)).toBe("stateful");
  });

  it("through after stateful stays stateful", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    const scaled = tr.translate.x.through(
      v => v * 10,
      v => v / 10,
    );
    expect(law(scaled as unknown as Signal<unknown>)).toBe("stateful");
  });

  it("clamp is projection law", () => {
    const a = num(0);
    const c = a.clamp(0, 1);
    expect(law(c as unknown as Signal<unknown>)).toBe("projection");
  });

  it("cyclic is stateful law (uses the s argument honestly)", () => {
    const a = num(0);
    const c = a.cyclic(2 * Math.PI);
    expect(law(c as unknown as Signal<unknown>)).toBe("stateful");
  });

  it("deriveTo chain stays iso (no bwd path; law inherited from prior)", () => {
    const a = num(0);
    const ro = a.deriveTo(Num, v => v * 2);
    expect(law(ro)).toBe("iso");
  });
});
