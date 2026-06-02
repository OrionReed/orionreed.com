// glitch.test.ts — the payoff of the pivot model: a backward write is
// compiled to source edits, then the SINGLE forward propagate (with
// value-gated checkDirty) refreshes views. So backward writes inherit
// forward's glitch-freedom and short-circuiting for free.
//
// These tests fail under the old "propagate per node during the bwd
// walk" model (double-fires, observes intermediate states, re-fires on
// no-op writes).

import { describe, expect, it, vi } from "vitest";
import { batch, computed, effect, lens, signal, sumPolicy } from "../index";

describe("backward glitch-freedom", () => {
  it("diamond: effect reading two views of one source fires ONCE per bwd write", () => {
    // root ──→ a = root+1
    //      └─→ b = root*2
    // c = derive(a,b); effect reads c. Writing through `a` lands a new
    // root, which the forward pass fans out to both a and b. The effect
    // must fire exactly once and never observe a/b out of sync.
    const root = signal(10);
    const a = lens(root, (v) => v + 1, (t) => t - 1);
    const b = lens(root, (v) => v * 2, (t) => t / 2);
    const seen: Array<[number, number]> = [];
    const c = computed(() => [a.value, b.value] as [number, number]);

    const fn = vi.fn(() => {
      seen.push(c.value);
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual([11, 20]);

    // Backward write through `a`: target 21 ⇒ root = 20.
    a.value = 21;

    expect(fn).toHaveBeenCalledTimes(2); // ONCE, not twice
    expect(root.value).toBe(20);
    // Consistent snapshot: a = 21, b = 40 (both reflect root=20).
    expect(seen.at(-1)).toEqual([21, 40]);
    expect(a.value).toBe(21);
    expect(b.value).toBe(40);
  });

  it("value-gated: bwd write that resolves to an unchanged source fires nothing", () => {
    const root = signal(4);
    // Lossy lens: floor to even. put(t) snaps to nearest lower even.
    const evenView = lens(
      root,
      (v) => v - (v % 2),
      (t) => t - (t % 2),
    );
    const fn = vi.fn(() => {
      void evenView.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(evenView.value).toBe(4);

    // Writing 5 snaps to 4 — the source is unchanged ⇒ no propagation.
    evenView.value = 5;
    expect(root.value).toBe(4);
    expect(fn).toHaveBeenCalledTimes(1); // short-circuited at the source
    expect(evenView.value).toBe(4);
  });

  it("value-gated downstream: source changes but a boolean view stays put", () => {
    // root ─→ isPos = root > 0 ─→ effect. Backward-writing root from 5
    // to 3 changes root but NOT isPos, so the effect must not re-fire.
    const root = signal(5);
    const ident = lens(root, (v) => v, (t) => t);
    const isPos = computed(() => root.value > 0);
    const fn = vi.fn(() => {
      void isPos.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);

    ident.value = 3; // root 5 → 3, isPos stays true
    expect(root.value).toBe(3);
    expect(fn).toHaveBeenCalledTimes(1); // checkDirty pruned the re-fire

    ident.value = -2; // root 3 → -2, isPos flips to false
    expect(fn).toHaveBeenCalledTimes(2);
    expect(isPos.value).toBe(false);
  });

  it("unrelated subgraph is untouched by a bwd write", () => {
    const root = signal(0);
    const l = lens(root, (v) => v + 1, (t) => t - 1);
    const other = signal(100);
    const otherFn = vi.fn(() => {
      void other.value;
    });
    effect(otherFn);
    expect(otherFn).toHaveBeenCalledTimes(1);

    l.value = 50;
    expect(root.value).toBe(49);
    expect(otherFn).toHaveBeenCalledTimes(1); // never re-ran
  });

  it("merge fan-in: effect over the merged source fires once per batch", () => {
    const root = signal(0);
    const m = root.merge(sumPolicy);
    const a = lens(m, (v) => v, (t) => t);
    const b = lens(m, (v) => v, (t) => t);
    const fn = vi.fn(() => {
      void root.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);

    batch(() => {
      a.value = 10;
      b.value = 20;
    });
    expect(root.value).toBe(30);
    expect(fn).toHaveBeenCalledTimes(2); // single settle ⇒ one re-fire
  });

  it("no intermediate observation: chain bwd write is atomic to observers", () => {
    // L2 ─→ L1 ─→ root. An effect on L2 must only ever see the final
    // committed value, never a half-applied chain.
    const root = signal(0);
    const l1 = lens(root, (v) => v + 1, (t) => t - 1);
    const l2 = lens(l1, (v) => v * 10, (t) => t / 10);
    const observed: number[] = [];
    effect(() => {
      observed.push(l2.value);
    });
    expect(observed).toEqual([10]); // (0+1)*10

    l2.value = 500; // ⇒ l1 = 50, root = 49, l2 reads back to 500
    expect(root.value).toBe(49);
    expect(observed).toEqual([10, 500]); // no glitchy intermediate
  });
});
