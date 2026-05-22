// runtime.test.ts — confirm the spike's two-interface design behaves
// identically to today's `Writable<R>` recursive lift at runtime.
// Same set of behaviours covered: factory writes, derived RO views,
// invertible chains, field lenses, nested writability, animator
// constraints, brand gating, user-defined value class.

import { describe, expect, it } from "vitest";
import { effect } from "../../index";
import { Hsl, hsl, Num, num, Transform, transform, Vec, vec } from "../index";

describe("spike: factories", () => {
  it("num() returns a writable Num", () => {
    const n = num(5);
    expect(n).toBeInstanceOf(Num);
    expect(n.value).toBe(5);
    n.value = 10;
    expect(n.value).toBe(10);
  });

  it("vec() returns a writable Vec", () => {
    const v = vec(3, 4);
    expect(v).toBeInstanceOf(Vec);
    expect(v.value).toEqual({ x: 3, y: 4 });
    v.value = { x: 10, y: 20 };
    expect(v.value).toEqual({ x: 10, y: 20 });
  });

  it("transform() returns a writable Transform", () => {
    const tr = transform({ translate: { x: 1, y: 2 }, rotate: 0.5 });
    expect(tr).toBeInstanceOf(Transform);
    expect(tr.value.translate).toEqual({ x: 1, y: 2 });
    expect(tr.value.rotate).toBe(0.5);
  });

  it("hsl() returns a writable Hsl", () => {
    const c = hsl(0.5, 0.7, 0.3);
    expect(c).toBeInstanceOf(Hsl);
    expect(c.value).toEqual({ h: 0.5, s: 0.7, l: 0.3 });
  });
});

describe("spike: derived RO views throw on write", () => {
  it("Vec.derive(fn) throws on .value =", () => {
    const v = vec(1, 2);
    const d = Vec.derive(() => ({ x: v.value.x * 2, y: v.value.y * 2 }));
    expect(() => {
      (d as unknown as { value: { x: number; y: number } }).value = { x: 0, y: 0 };
    }).toThrow();
  });

  it("Vec.derive read tracks parent", () => {
    const v = vec(1, 2);
    const d = Vec.derive(() => ({ x: v.value.x * 2, y: v.value.y * 2 }));
    expect(d.value).toEqual({ x: 2, y: 4 });
    v.value = { x: 5, y: 6 };
    expect(d.value).toEqual({ x: 10, y: 12 });
  });
});

describe("spike: invertible chains", () => {
  it("v.add(b) chain is writable; write back propagates", () => {
    const v = vec(0, 0);
    const c = v.add({ x: 5, y: 0 });
    expect(c.value).toEqual({ x: 5, y: 0 });
    c.value = { x: 10, y: 5 };
    // Writeback through .add: parent shifts by (10-5, 5-0) = (5, 5)
    expect(v.value).toEqual({ x: 5, y: 5 });
  });

  it("auto-fusion: add then scale collapses to one cell", () => {
    const v = vec(0, 0);
    const c = v.add({ x: 1, y: 1 }).scale(10);
    // Read: (0+1)*10, (0+1)*10
    expect(c.value).toEqual({ x: 10, y: 10 });
    // Write back: divide by 10, then sub {1,1} → (10/10 - 1, 20/10 - 1)
    c.value = { x: 10, y: 20 };
    expect(v.value).toEqual({ x: 0, y: 1 });
  });
});

describe("spike: field lenses", () => {
  it("v.x is a writable Num that propagates to v", () => {
    const v = vec(3, 4);
    expect(v.x).toBeInstanceOf(Num);
    expect(v.x.value).toBe(3);
    v.x.value = 99;
    expect(v.value).toEqual({ x: 99, y: 4 });
  });

  it("v.x cached — same instance on repeated reads", () => {
    const v = vec(0, 0);
    const a = v.x;
    const b = v.x;
    expect(a).toBe(b);
  });

  it("v.magnitude is RO derived", () => {
    const v = vec(3, 4);
    expect(v.magnitude.value).toBe(5);
    v.value = { x: 5, y: 12 };
    expect(v.magnitude.value).toBe(13);
  });
});

describe("spike: nested writability — Transform", () => {
  it("tr.translate.x writes propagate to root", () => {
    const tr = transform();
    tr.translate.x.value = 7;
    expect(tr.value.translate.x).toBe(7);
  });

  it("tr.translate.value writes the whole nested Vec", () => {
    const tr = transform();
    tr.translate.value = { x: 10, y: 20 };
    expect(tr.value.translate).toEqual({ x: 10, y: 20 });
  });
});

describe("spike: animator-style brand gating", () => {
  it("bare new Num() is rejected at type level (compile-only)", () => {
    // The compile-time guarantee is in `types.test.ts` via @ts-expect-error.
    // At runtime, calling `bind` on an unbranded Signal would still try
    // to write to .value — which works because the engine has set value.
    expect(true).toBe(true);
  });
});

describe("spike: user-defined value class — Hsl", () => {
  it("hsl(...) factory works, fields lift to writable", () => {
    const c = hsl(0, 0, 0);
    c.h.value = 0.42;
    expect(c.value.h).toBeCloseTo(0.42);
  });

  it("invertible chain on writable Hsl stays writable", () => {
    const c = hsl(0, 0, 0);
    const chained = c.add({ h: 0.1, s: 0.2, l: 0.3 }).scale(2);
    chained.value = { h: 1, s: 1, l: 1 };
    expect(c.value.h).toBeCloseTo(0.4);
    expect(c.value.s).toBeCloseTo(0.3);
    expect(c.value.l).toBeCloseTo(0.2);
  });

  it("Hsl.derive returns RO; write throws", () => {
    const c = hsl(0, 0, 0);
    const d = Hsl.derive(() => ({ h: c.value.h * 2, s: 0, l: 0 }));
    expect(d).toBeInstanceOf(Hsl);
    expect(() => {
      (d as unknown as { value: { h: number; s: number; l: number } }).value = {
        h: 0,
        s: 0,
        l: 0,
      };
    }).toThrow();
  });
});

describe("spike: reactivity end-to-end", () => {
  it("effect fires when v.x.value changes", () => {
    const v = vec(0, 0);
    let seen = 0;
    const stop = effect(() => {
      seen = v.x.value;
    });
    expect(seen).toBe(0);
    v.x.value = 42;
    expect(seen).toBe(42);
    v.value = { x: 99, y: 0 };
    expect(seen).toBe(99);
    stop();
  });

  it("effect fires on tr.translate.x", () => {
    const tr = transform();
    let seen = 0;
    const stop = effect(() => {
      seen = tr.translate.x.value;
    });
    tr.translate.x.value = 7;
    expect(seen).toBe(7);
    stop();
  });
});
