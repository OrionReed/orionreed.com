// lossy.test.ts — backward writes through LOSSY lenses (clamp/quantize)
// over an OFF-GRID source. This is the md-clamp-quantize scenario: the
// source carries information the lens hides (an off-grid remainder), and
// a within-tolerance view write must NOT clobber it.
//
// Desired semantics ("least change" / GetPut / constant-complement):
//   * within-bucket write  → source preserved (no snap, no upstream fire)
//   * cross-bucket write    → source moves (genuine edit propagates)
//
// These use the value layer's CURRENT arity-1 `quantize`/`clamp`
// (`this.lens(q, q)`), so they probe whether the ENGINE makes a naive
// lossy lens behave (Route B) without per-lens discipline.

import { describe, expect, it, vi } from "vitest";
import { effect, lens, signal } from "../index";
import { num } from "../values/num";

const q = (step: number) => (v: number) => Math.round(v / step) * step;

describe("off-grid source, 2-level (source → quantize)", () => {
  it("within-bucket write preserves the off-grid source", () => {
    const b = num(13);
    const c = b.quantize(10); // q(13) = 10
    expect(c.value).toBe(10);
    c.value = 14; // q(14) = 10 — same bucket, display unchanged
    expect(b.value).toBe(13); // off-grid remainder (3) preserved
    expect(c.value).toBe(10);
  });

  it("cross-bucket write moves the source", () => {
    const b = num(13);
    const c = b.quantize(10);
    expect(c.value).toBe(10);
    c.value = 26; // q(26) = 30 — different bucket
    expect(c.value).toBe(30);
    expect(b.value).toBe(30); // arity-1 put snaps source to the detent
  });

  it("within-bucket write fires no downstream effect", () => {
    const b = num(13);
    const c = b.quantize(10);
    void c.value;
    const fn = vi.fn(() => void b.value);
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    c.value = 12; // q(12) = 10, same bucket
    expect(fn).toHaveBeenCalledTimes(1); // source untouched → no fire
  });
});

describe("off-grid source, 3-level (source → clamp → quantize) — md scene", () => {
  it("within-bucket drag of the quantized row preserves t (no snap of rows 1&2)", () => {
    const t = num(0.53); // off-grid source (row 1 dragged here)
    const tC = t.clamp(0.2, 0.8); // 0.53 in range → 0.53
    const tQ = tC.quantize(0.1); // q(0.53) = 0.5
    expect(tQ.value).toBeCloseTo(0.5, 10);
    expect(tC.value).toBeCloseTo(0.53, 10);

    tQ.value = 0.52; // continuous, same 0.5 bucket
    expect(t.value).toBeCloseTo(0.53, 10); // PRESERVED — no snap
    expect(tQ.value).toBeCloseTo(0.5, 10);
  });

  it("cross-bucket drag moves t to the new detent", () => {
    const t = num(0.53);
    const tC = t.clamp(0.2, 0.8);
    const tQ = tC.quantize(0.1);
    void tQ.value;
    tQ.value = 0.57; // q = 0.6, new bucket
    expect(tQ.value).toBeCloseTo(0.6, 10);
    expect(t.value).toBeCloseTo(0.6, 10);
  });
});

describe("raw lens (engine-level, no value classes)", () => {
  it("within-bucket write through an arity-1 quantize lens preserves source", () => {
    const s = signal(7);
    const ql = lens(s, q(10), q(10)); // q(7) = 10
    expect(ql.value).toBe(10);
    ql.value = 12; // q(12) = 10, same bucket
    expect(s.value).toBe(7); // preserved
  });
});
