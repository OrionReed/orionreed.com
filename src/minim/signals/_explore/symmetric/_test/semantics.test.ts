// semantics.test.ts — backward-write short-circuit semantics. These pin
// down the two equality gates and the consequences for lossy lenses,
// where this engine deliberately differs from the old fused engine.
//
// Two gates, dual to each other:
//   * SOURCE gate (`_writeSource`): a backward write that resolves to
//     the source's current value propagates nothing forward.
//   * VIEW gate (lens setter): writing a lens the value it already
//     displays is a no-op — no cascade, no source shift.
//
// Net effect for a lossy lens (clamp/quantize): "writing what you see"
// never moves the source; only a genuine edit runs `put`, and reading
// back yields the PutGet-snapped value.

import { describe, expect, it, vi } from "vitest";
import { computed, effect, lens, signal } from "../index";

const quantize = (step: number) => (v: number) => Math.round(v / step) * step;

describe("view gate: writing the displayed value is a no-op", () => {
  it("quantize: misaligned source does NOT jump to the grid", () => {
    const root = signal(7);
    const q = lens(root, quantize(10), quantize(10));
    expect(q.value).toBe(10); // 7 snaps to 10 for display
    q.value = 10; // write the value already shown
    // The old fused engine would push put(10)=10 to root, snapping it.
    // Here the view gate makes this a no-op: root stays misaligned.
    expect(root.value).toBe(7);
  });

  it("quantize: a genuine edit DOES run put (PutGet snapping)", () => {
    const root = signal(7);
    const q = lens(root, quantize(10), quantize(10));
    expect(q.value).toBe(10);
    q.value = 24; // genuine edit, different from displayed 10
    expect(root.value).toBe(20); // put(24)=20
    expect(q.value).toBe(20); // read-back snaps (PutGet)
  });

  it("clamp: writing the in-range displayed value leaves source intact", () => {
    const root = signal(5);
    const c = lens(
      root,
      (v) => (v < 0 ? 0 : v > 10 ? 10 : v),
      (t) => (t < 0 ? 0 : t > 10 ? 10 : t),
    );
    expect(c.value).toBe(5);
    c.value = 5; // no-op
    expect(root.value).toBe(5);
  });

  it("clamp: out-of-range write clamps the source", () => {
    const root = signal(5);
    const c = lens(
      root,
      (v) => (v < 0 ? 0 : v > 10 ? 10 : v),
      (t) => (t < 0 ? 0 : t > 10 ? 10 : t),
    );
    expect(c.value).toBe(5);
    c.value = 99;
    expect(root.value).toBe(10);
    expect(c.value).toBe(10);
  });

  it("no-op view write fires no downstream effect", () => {
    const root = signal(10);
    const q = lens(root, quantize(10), quantize(10));
    const fn = vi.fn(() => void q.value);
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    q.value = 10; // displayed value → no cascade, no propagation
    expect(fn).toHaveBeenCalledTimes(1);
    expect(root.value).toBe(10);
  });
});

describe("view gate trustworthiness (clean cache only)", () => {
  it("write before any read still cascades (cache not yet valid)", () => {
    const root = signal(7);
    const q = lens(root, quantize(10), quantize(10));
    // No read of q first → cache stale → gate cannot fire → cascades.
    q.value = 10;
    expect(root.value).toBe(10); // put(10)=10 committed
  });

  it("a pending (upstream-changed) lens cascades, not gated", () => {
    const root = signal(7);
    const id = lens(
      root,
      (v) => v,
      (t) => t,
    );
    expect(id.value).toBe(7); // clean cache = 7
    root.value = 42; // id now pending; cache stale (still 7)
    id.value = 7; // equals the STALE cache — must NOT be gated away
    expect(root.value).toBe(7); // genuine edit back to 7 committed
    expect(id.value).toBe(7);
  });
});

describe("source gate: backward write resolving to current source", () => {
  it("identity chain: writing the current source value propagates nothing", () => {
    const root = signal(5);
    const a = lens(
      root,
      (v) => v + 1,
      (t) => t - 1,
    );
    const fn = vi.fn(() => void root.value);
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a.value).toBe(6);
    a.value = 6; // displayed value → view gate no-op (root untouched)
    expect(fn).toHaveBeenCalledTimes(1);
    a.value = 11; // genuine edit → put(11)=10 → root 5→10 → effect fires
    expect(root.value).toBe(10);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("computed remains read-only", () => {
  it("writing a computed throws", () => {
    const root = signal(1);
    const c = computed(() => root.value * 2);
    expect(c.value).toBe(2);
    expect(() => {
      (c as { value: number }).value = 10;
    }).toThrow(/computed/);
  });
});
