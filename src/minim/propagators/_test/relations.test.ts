// relations.test.ts — propagator combinators (arithmetic + universal +
// geometric + set narrowing).

import { describe, expect, it } from "vitest";
import { num, vec } from "../../signals";
import {
  add,
  align,
  allDifferent,
  aspectRatio,
  between,
  centroid,
  constant,
  eq,
  keepDistance,
  mid,
  mul,
  onCircle,
  onLine,
  propagators,
  reflect,
  type SetCell,
  sub,
  sum,
} from "..";
import { signal } from "../../signals";

// ─── Arithmetic ──────────────────────────────────────────────────

describe("add (Num)", () => {
  it("a + b = c — bidirectional", () => {
    const a = num(2);
    const b = num(3);
    const c = num(0);
    const p = propagators();
    p.add(add(a, b, c));
    expect(c.value).toBe(5);

    a.value = 10;
    expect(c.value).toBe(13);

    c.value = 100; // drag c → b derives (= 100 - 10 = 90)
    expect(b.value).toBe(90);
    p.dispose();
  });
});

describe("add (Vec, trait-dispatched)", () => {
  it("a + b = c — works on Vec via Linear trait", () => {
    const a = vec(1, 2);
    const b = vec(3, 4);
    const c = vec(0, 0);
    const p = propagators();
    p.add(add(a, b, c));
    expect(c.value).toEqual({ x: 4, y: 6 });

    a.value = { x: 10, y: 20 };
    expect(c.value).toEqual({ x: 13, y: 24 });
    p.dispose();
  });
});

describe("sub", () => {
  it("a - b = c", () => {
    const a = num(10);
    const b = num(3);
    const c = num(0);
    const p = propagators();
    p.add(sub(a, b, c));
    expect(c.value).toBe(7);

    c.value = 1;
    // b-deriving runs first: b = a - c = 10 - 1 = 9.
    expect(b.value).toBe(9);
    p.dispose();
  });
});

describe("mid (midpoint)", () => {
  it("Vec midpoint, drag any → others follow", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const m = vec(0, 0);
    const p = propagators();
    p.add(mid(a, b, m));
    expect(m.value).toEqual({ x: 5, y: 0 });

    // Drag m → both endpoints translate.
    m.value = { x: 15, y: 5 };
    expect(a.value).toEqual({ x: 10, y: 5 });
    expect(b.value).toEqual({ x: 20, y: 5 });
    p.dispose();
  });
});

describe("centroid", () => {
  it("centroid of 3 vecs — drag any vertex follows; drag centroid translates all", () => {
    const a = vec(0, 0);
    const b = vec(3, 0);
    const c = vec(0, 3);
    const cent = vec(0, 0);
    const p = propagators();
    p.add(centroid(cent, a, b, c));
    expect(cent.value).toEqual({ x: 1, y: 1 });

    // Drag a vertex.
    a.value = { x: 6, y: 0 };
    expect(cent.value).toEqual({ x: 3, y: 1 });

    // Drag centroid.
    cent.value = { x: 4, y: 5 };
    // All three vertices translated by delta (1, 4).
    expect(a.value).toEqual({ x: 7, y: 4 });
    expect(b.value).toEqual({ x: 4, y: 4 });
    expect(c.value).toEqual({ x: 1, y: 7 });
    p.dispose();
  });
});

describe("mul (scalar only)", () => {
  it("a * b = c, bidirectional with division-by-zero guard", () => {
    const a = num(2);
    const b = num(3);
    const c = num(0);
    const p = propagators();
    p.add(mul(a, b, c));
    expect(c.value).toBe(6);

    c.value = 12;
    expect(b.value).toBe(6); // c/a
    p.dispose();
  });
});

describe("aspectRatio", () => {
  it("a/b = k", () => {
    const a = num(0);
    const b = num(0);
    const p = propagators();
    p.add(aspectRatio(a, b, 16 / 9));
    a.value = 16;
    expect(b.value).toBeCloseTo(9);
    p.dispose();
  });
});

describe("sum", () => {
  it("scalar parts → total, with N+1 propagators for any-direction inference", () => {
    const a = num(1);
    const b = num(2);
    const c = num(3);
    const total = num(0);
    const p = propagators();
    p.add(sum([a, b, c], total));
    expect(total.value).toBe(6);

    total.value = 100;
    // One of the parts derives: a, b, or c gets the slack.
    expect(a.value + b.value + c.value).toBe(100);
    p.dispose();
  });
});

// ─── Universal ───────────────────────────────────────────────────

describe("eq (any value type)", () => {
  it("Num: a = b bidirectionally", () => {
    const a = num(5);
    const b = num(0);
    const p = propagators();
    p.add(eq(a, b));
    expect(b.value).toBe(5);

    b.value = 99;
    expect(a.value).toBe(99);
    p.dispose();
  });

  it("Vec: a = b bidirectionally", () => {
    const a = vec(1, 2);
    const b = vec(0, 0);
    const p = propagators();
    p.add(eq(a, b));
    expect(b.value).toEqual({ x: 1, y: 2 });
    p.dispose();
  });
});

describe("constant", () => {
  it("pins a signal; external writes restore", () => {
    const s = num(0);
    const p = propagators();
    p.add(constant(s, 42));
    expect(s.value).toBe(42);

    s.value = 99;
    expect(s.value).toBe(42); // restored
    p.dispose();
  });
});

describe("align (variadic equality)", () => {
  it("N cells share a value; drag any → others follow", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    const p = propagators();
    p.add(align(a, b, c));

    b.value = 7;
    expect(a.value).toBe(7);
    expect(c.value).toBe(7);
    p.dispose();
  });
});

// ─── Geometric (Vec) ─────────────────────────────────────────────

describe("between", () => {
  it("p = a + t(b - a), drag t to traverse", () => {
    const a = vec(0, 0);
    const b = vec(100, 0);
    const t = num(0);
    const p = vec(0, 0);
    const props = propagators();
    props.add(between(a, b, t, p));
    expect(p.value).toEqual({ x: 0, y: 0 });

    t.value = 0.5;
    expect(p.value).toEqual({ x: 50, y: 0 });
    props.dispose();
  });

  it("default mode: drag p projects onto segment, updates t", () => {
    const a = vec(0, 0);
    const b = vec(100, 0);
    const t = num(0);
    const p = vec(0, 0);
    const props = propagators();
    props.add(between(a, b, t, p));

    p.value = { x: 30, y: 5 };
    expect(t.value).toBeCloseTo(0.3);
    props.dispose();
  });
});

describe("keepDistance", () => {
  it("rigid bond — drag a, b stays at distance d", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const p = propagators();
    p.add(keepDistance(a, b, 10));

    a.value = { x: 5, y: 5 };
    const dx = b.value.x - 5;
    const dy = b.value.y - 5;
    expect(Math.hypot(dx, dy)).toBeCloseTo(10);
    p.dispose();
  });

  it("reactive distance signal", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const d = num(10);
    const p = propagators();
    p.add(keepDistance(a, b, d));

    d.value = 20;
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(20);
    p.dispose();
  });
});

describe("onLine", () => {
  it("p sticks to line through a, b", () => {
    const a = vec(0, 0);
    const b = vec(10, 0);
    const p = vec(5, 5);
    const props = propagators();
    props.add(onLine(p, a, b));
    expect(p.value).toEqual({ x: 5, y: 0 });

    p.value = { x: 8, y: 3 };
    expect(p.value).toEqual({ x: 8, y: 0 });
    props.dispose();
  });
});

describe("onCircle", () => {
  it("p snaps to circle of radius r around c", () => {
    const c = vec(0, 0);
    const p = vec(20, 0);
    const props = propagators();
    props.add(onCircle(p, c, 10));
    expect(p.value).toEqual({ x: 10, y: 0 });

    p.value = { x: 0, y: 30 };
    expect(p.value.x).toBeCloseTo(0);
    expect(p.value.y).toBeCloseTo(10);
    props.dispose();
  });
});

describe("reflect", () => {
  it("dst = src reflected across line a-b, bidirectional", () => {
    const src = vec(2, 5);
    const a = vec(0, 0);
    const b = vec(10, 0);
    const dst = vec(0, 0);
    const p = propagators();
    p.add(reflect(src, a, b, dst));
    expect(dst.value).toEqual({ x: 2, y: -5 });

    src.value = { x: 7, y: -3 };
    expect(dst.value).toEqual({ x: 7, y: 3 });
    p.dispose();
  });
});

// ─── Set narrowing ───────────────────────────────────────────────

describe("allDifferent", () => {
  it("singleton elimination across cells", () => {
    const eqSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
      return true;
    };
    const cells: SetCell<number>[] = [
      signal<ReadonlySet<number>>(new Set([1]), { equals: eqSet }), // pinned
      signal<ReadonlySet<number>>(new Set([1, 2, 3, 4]), { equals: eqSet }),
      signal<ReadonlySet<number>>(new Set([1, 2, 3, 4]), { equals: eqSet }),
    ];

    const p = propagators();
    p.add(allDifferent(...cells));

    expect(cells[0]!.value).toEqual(new Set([1]));
    expect(cells[1]!.value.has(1)).toBe(false);
    expect(cells[2]!.value.has(1)).toBe(false);
    p.dispose();
  });
});
