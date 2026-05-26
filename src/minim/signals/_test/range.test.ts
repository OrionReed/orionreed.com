// range.test.ts — Range value class: field lenses, slider, body-drag,
// derived views, codec round-trips.

import { describe, expect, it } from "vitest";
import { isComputed, isLens, num, Range, range, span } from "../index";

describe("Range — construction", () => {
  it("range(lo, hi) writable", () => {
    const r = range(0, 10);
    expect(r).toBeInstanceOf(Range);
    expect(r.value).toEqual({ lo: 0, hi: 10 });
    r.value = { lo: 1, hi: 5 };
    expect(r.value).toEqual({ lo: 1, hi: 5 });
  });

  it("range(num, num) — bidirectional Range from two writable Nums", () => {
    const lo = num(0);
    const hi = num(10);
    const r = range(lo, hi);
    r.value = { lo: 2, hi: 8 };
    expect(lo.value).toBe(2);
    expect(hi.value).toBe(8);
  });

  it("range(num, literal) lifts literal to a fresh seed; writes propagate to source num", () => {
    const lo = num(3);
    const r = range(lo, 7);
    r.value = { lo: 1, hi: 9 };
    expect(lo.value).toBe(1);
    // hi was a literal seed; writes land on the local seed.
    expect(r.value.hi).toBe(9);
  });
});

describe("Range — field lenses (start/end knob)", () => {
  it(".lo: write preserves hi (start-knob semantics)", () => {
    const r = range(0, 10);
    r.lo.value = 3;
    expect(r.value).toEqual({ lo: 3, hi: 10 });
  });

  it(".hi: write preserves lo (end-knob semantics)", () => {
    const r = range(0, 10);
    r.hi.value = 7;
    expect(r.value).toEqual({ lo: 0, hi: 7 });
  });

  it("field lenses are stable identities (lazy-cached)", () => {
    const r = range(0, 10);
    expect(r.lo).toBe(r.lo);
    expect(r.hi).toBe(r.hi);
  });
});

describe("Range — derived views", () => {
  it(".width and .center are RO derives", () => {
    const r = range(2, 8);
    expect(r.width.value).toBe(6);
    expect(r.center.value).toBe(5);
    expect(isComputed(r.width)).toBe(true);
    r.lo.value = 0;
    expect(r.width.value).toBe(8);
    expect(r.center.value).toBe(4);
  });

  it(".contains(v) tracks v reactively", () => {
    const r = range(0, 10);
    const v = num(5);
    const inside = r.contains(v);
    expect(inside.value).toBe(true);
    v.value = 11;
    expect(inside.value).toBe(false);
    r.hi.value = 15;
    expect(inside.value).toBe(true);
  });
});

describe("Range — body-drag (.start)", () => {
  it("read returns lo, write shifts both endpoints (preserves width)", () => {
    const r = range(2, 7);
    expect(r.start.value).toBe(2);
    r.start.value = 10;
    expect(r.value).toEqual({ lo: 10, hi: 15 });
  });

  it(".start composes through span() onto the underlying at/dur", () => {
    const at = num(2);
    const dur = num(5);
    const s = span(at, dur);
    s.start.value = 10;
    expect(at.value).toBe(10);
    expect(dur.value).toBe(5);
  });
});

describe("Range — slider", () => {
  it("read: lo + t·(hi - lo)", () => {
    const r = range(100, 200);
    const t = num(0.25);
    const v = r.slider(t);
    expect(v.value).toBe(125);
    t.value = 0.5;
    expect(v.value).toBe(150);
  });

  it("write: solves t; lo and hi stay put", () => {
    const r = range(100, 200);
    const t = num(0);
    const v = r.slider(t);
    v.value = 175;
    expect(t.value).toBe(0.75);
    expect(r.value).toEqual({ lo: 100, hi: 200 });
  });

  it("zero-width range writes t=0 (no division by zero)", () => {
    const r = range(5, 5);
    const t = num(0.5);
    const v = r.slider(t);
    v.value = 7;
    expect(t.value).toBe(0);
  });
});

describe("Range — sample / paramOf / clampedRead", () => {
  it("sample(t) = lo + t·(hi - lo), RO", () => {
    const r = range(10, 20);
    const s = r.sample(0.4);
    expect(s.value).toBe(14);
    expect(isComputed(s)).toBe(true);
  });

  it("paramOf is the inverse of sample", () => {
    const r = range(10, 20);
    const p = r.paramOf(14);
    expect(p.value).toBe(0.4);
  });

  it("clampedRead(v) bounds v into [lo, hi]", () => {
    const r = range(0, 1);
    const v = num(0.5);
    const c = r.clampedRead(v);
    expect(c.value).toBe(0.5);
    v.value = 1.5;
    expect(c.value).toBe(1);
    v.value = -0.3;
    expect(c.value).toBe(0);
  });
});

describe("Range — invertibles (shift/scale chain)", () => {
  it("shift(by) is invertible and chains writability", () => {
    const r = range(0, 10);
    const s = r.shift(5);
    expect(s.value).toEqual({ lo: 5, hi: 15 });
    expect(isLens(s)).toBe(true);
    s.value = { lo: 10, hi: 20 };
    expect(r.value).toEqual({ lo: 5, hi: 15 });
  });

  it("scale(k) is invertible (k ≠ 0)", () => {
    const r = range(0, 10);
    const s = r.scale(2);
    expect(s.value).toEqual({ lo: 0, hi: 20 });
    s.value = { lo: 0, hi: 40 };
    expect(r.value).toEqual({ lo: 0, hi: 20 });
  });
});

describe("Range — span() construction (timeline pattern)", () => {
  it("[at, dur] ↔ {lo: at, hi: at + dur}", () => {
    const at = num(2);
    const dur = num(5);
    const s = span(at, dur);
    expect(s.value).toEqual({ lo: 2, hi: 7 });
  });

  it("writing .lo updates at; .hi updates dur (preserves at)", () => {
    const at = num(2);
    const dur = num(5);
    const s = span(at, dur);
    s.lo.value = 4;
    expect(at.value).toBe(4);
    expect(dur.value).toBe(3); // hi unchanged at 7 → dur = 7 - 4
    s.hi.value = 10;
    expect(at.value).toBe(4); // lo unchanged
    expect(dur.value).toBe(6); // dur = 10 - 4
  });

  it("writing .start translates the body (preserves dur)", () => {
    const at = num(2);
    const dur = num(5);
    const s = span(at, dur);
    s.start.value = 10;
    expect(at.value).toBe(10);
    expect(dur.value).toBe(5);
  });

  it(".width derived = dur, reactive", () => {
    const at = num(0);
    const dur = num(3);
    const s = span(at, dur);
    expect(s.width.value).toBe(3);
    dur.value = 7;
    expect(s.width.value).toBe(7);
  });
});
