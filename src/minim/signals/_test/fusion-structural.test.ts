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
import { box, effect, Num, num, rgb, type Signal, transform, Vec, vec } from "../index";

// Does `s` have a non-empty `.subs` linked list?
const hasSubscribers = (s: unknown): boolean => (s as { subs?: unknown }).subs !== undefined;

const fusedParent = (s: unknown): unknown =>
  (s as { _fusedOf?: { parent: unknown } })._fusedOf?.parent;

describe("structural: only root + effect-subscribed leaves carry subs", () => {
  it("4-deep through chain: only root has subs when effect on leaf", () => {
    const a = num(0);
    const l1 = a.lens(
      v => v + 1,
      v => v - 1,
    );
    const l2 = l1.lens(
      v => v * 2,
      v => v / 2,
    );
    const l3 = l2.lens(
      v => v - 3,
      v => v + 3,
    );
    const leaf = l3.lens(
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
    const l1 = Num.derive(a, v => v + 1);
    const l2 = Num.derive(l1, v => v * 2);
    const leaf = Num.derive(l2, v => v - 3);

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
    const l1 = Vec.derive(a, n => ({ x: n, y: n * 2 }));
    const l2 = Num.derive(l1, v => v.x + v.y);
    const leaf = Vec.derive(l2, n => ({ x: n, y: 0 }));

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

  it("box.expand(5).x: through(writable)+field fuses, only box has subs", () => {
    const b = box(0, 0, 10, 20);
    const expanded = b.expand(5);
    const x = expanded.x;

    expect(fusedParent(x)).toBe(b);
    const stop = effect(() => {
      void x.value;
    });
    expect(hasSubscribers(b)).toBe(true);
    expect(hasSubscribers(expanded as unknown as Signal<unknown>)).toBe(false);
    expect(hasSubscribers(x)).toBe(true);
    stop();
  });

  it("multiple effects on the same fused leaf: all on the leaf, none on intermediates", () => {
    const a = num(0);
    const leaf = Num.derive(Num.derive(a, v => v + 1), v => v * 2);
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
    const intermediate = Num.derive(a, v => v * 2);
    const leaf = Num.derive(intermediate, v => v + 1);

    const stopLeaf = effect(() => void leaf.value);
    expect(hasSubscribers(intermediate)).toBe(false); // bypassed by leaf

    const stopMid = effect(() => void intermediate.value);
    expect(hasSubscribers(intermediate)).toBe(true); // now materialised

    stopMid();
    expect(hasSubscribers(intermediate)).toBe(false);
    stopLeaf();
  });
});

describe("structural: stateful-flag propagation (arity-inferred)", () => {
  // Statefulness is inferred from `bwd.length` — `bwd: v => …` is
  // stateless (length 1), `bwd: (v, s) => …` is stateful (length 2).
  // The chain's `_fusedOf.stateful` is the OR over its layers.
  // Stateless setters skip `parent.peek()` + `priorFwd(s)`.

  const stateful = (s: unknown): boolean | undefined =>
    (s as { _fusedOf?: { stateful?: boolean } })._fusedOf?.stateful;

  it("pure 1-arg-bwd through chain is stateless", () => {
    const a = num(0);
    const c = a
      .lens(
        v => v + 1,
        v => v - 1,
      )
      .lens(
        v => v * 2,
        v => v / 2,
      )
      .lens(
        v => v - 3,
        v => v + 3,
      );
    expect(stateful(c)).toBe(false);
  });

  it("field marks the chain stateful (bwd is 2-arg spread-replace)", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    expect(stateful(tr.translate as unknown as Signal<unknown>)).toBe(true);
    expect(stateful(tr.translate.x as unknown as Signal<unknown>)).toBe(true);
  });

  it("through-iso after stateful stays stateful (any layer poisons upward)", () => {
    const tr = transform({ translate: { x: 0, y: 0 } });
    const scaled = tr.translate.x.lens(
      v => v * 10,
      v => v / 10,
    );
    expect(stateful(scaled as unknown as Signal<unknown>)).toBe(true);
  });

  it("deriveTo chain inherits prior's stateful flag (here: false)", () => {
    const a = num(0);
    const ro = Num.derive(a, v => v * 2);
    expect(stateful(ro)).toBe(false);
  });
});
