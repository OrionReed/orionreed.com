// bidirectional.test.ts — write-through invertible methods + chains.
//
// The key invariant the lens-ified value classes uphold:
//   For any invertible operation, `parent.foo(args).value = next`
//   results in `parent.value` being updated such that
//   `parent.foo(args).value` reads back as `next`.
//
// And the same for chains:
//   `parent.derive(c => c.foo(...).bar(...)).value = next` walks the
//   inverses in reverse and writes the parent.

import { describe, it, expect } from "vitest";
import { num } from "./values/num";
import { vec, Vec } from "./values/vec";
import { box } from "./values/box";
import { rgb } from "./values/color";
import { matrix, identity, fromTranslate, multiply, invert } from "./values/matrix";
import { transform } from "./values/transform";
import { Signal, type RO } from "./signal";

// ─── Num: eager invertible ─────────────────────────────────────────

describe("Num — eager invertible methods are lenses", () => {
  it("add: write-through subtracts b", () => {
    const a = num(5); const b = num(3);
    const sum = a.add(b);
    expect(sum.value).toBe(8);
    sum.value = 100;
    expect(a.value).toBe(97);  // 100 - 3
    expect(b.value).toBe(3);   // unchanged
  });

  it("sub: write-through adds b", () => {
    const a = num(10); const b = num(4);
    const diff = a.sub(b);
    diff.value = 0;
    expect(a.value).toBe(4);   // 0 + 4
    expect(b.value).toBe(4);
  });

  it("scale: write-through divides by k", () => {
    const a = num(7); const k = num(2);
    const doubled = a.scale(k);
    doubled.value = 100;
    expect(a.value).toBe(50);  // 100 / 2
  });

  it("chained eager: a.add(b).scale(k) writes through both", () => {
    const a = num(1); const b = num(2); const k = num(3);
    const r = a.add(b).scale(k);  // (a + b) * k = (1+2)*3 = 9
    expect(r.value).toBe(9);
    r.value = 30;     // (a + b) * k = 30 ; with k=3, a+b=10; with b=2, a=8
    expect(a.value).toBe(8);
    expect(b.value).toBe(2);  // unchanged
    expect(k.value).toBe(3);  // unchanged
  });
});

// ─── Vec: eager invertible ─────────────────────────────────────────

describe("Vec — eager invertible methods are lenses", () => {
  it("add: write-through subtracts b", () => {
    const a = vec(1, 2); const b = vec(10, 20);
    const sum = a.add(b);
    sum.value = { x: 100, y: 200 };
    expect(a.value).toEqual({ x: 90, y: 180 });
    expect(b.value).toEqual({ x: 10, y: 20 });
  });

  it("scale: write-through divides", () => {
    const a = vec(2, 3);
    const doubled = a.scale(2);
    doubled.value = { x: 10, y: 20 };
    expect(a.value).toEqual({ x: 5, y: 10 });
  });

  it("offset: write-through reverses dx,dy", () => {
    const a = vec(0, 0);
    const offset = a.offset(5, 10);
    offset.value = { x: 100, y: 50 };
    expect(a.value).toEqual({ x: 95, y: 40 });
  });

  it("up/down/left/right are invertible", () => {
    const a = vec(0, 0);
    const u = a.up(10);
    u.value = { x: 5, y: -3 };   // up(10) puts y at -10; new y is -3, so a.y = -3 + 10 = 7
    expect(a.value.y).toBe(7);
    expect(a.value.x).toBe(5);
  });
});

// ─── Vec: chain produces a lens ────────────────────────────────────

describe("Vec.derive — chain produces a Lens", () => {
  it("identical results to eager chain", () => {
    const a = vec(0, 0); const b = vec(1, 2);
    const eager = a.add(b).scale(3).offset(10, 0);  // ((a + b) * 3) + (10, 0)
    const fused = a.derive((c) => c.add(b).scale(3).offset(10, 0));

    // Read identity
    expect(fused.value).toEqual(eager.value);

    // Write identity — both lens chains accept the same write
    fused.value = { x: 31, y: 30 };
    // Solve: ((a + (1,2)) * 3) + (10, 0) = (31, 30)
    //   → ((a + (1,2)) * 3) = (21, 30)
    //   → (a + (1,2)) = (7, 10)
    //   → a = (6, 8)
    expect(a.value).toEqual({ x: 6, y: 8 });
  });

  it("empty chain: vec.derive(c => c) is identity lens", () => {
    const a = vec(7, 8);
    const id = a.derive((c) => c);
    expect(id.value).toEqual({ x: 7, y: 8 });
    id.value = { x: 1, y: 2 };
    expect(a.value).toEqual({ x: 1, y: 2 });
  });

  it("chain captures Val<…> reactively", () => {
    const a = vec(0, 0); const k = num(2);
    const r = a.derive((c) => c.scale(k));
    r.value = { x: 10, y: 20 };  // a = (10, 20) / 2 = (5, 10)
    expect(a.value).toEqual({ x: 5, y: 10 });
    // change k after construction; subsequent writes use new k
    k.value = 5;
    r.value = { x: 100, y: 50 };
    expect(a.value).toEqual({ x: 20, y: 10 });
  });
});

// ─── Box: invertible chain (expand) ────────────────────────────────

describe("Box.derive — expand is its own inverse", () => {
  it("expand chain writes through correctly", () => {
    const b = box(10, 10, 20, 20);
    const padded = b.derive((c) => c.expand(5));
    expect(padded.value).toEqual({ x: 5, y: 5, w: 30, h: 30 });
    padded.value = { x: 0, y: 0, w: 50, h: 50 };
    // expand(-5) of (0,0,50,50) = (5,5,40,40)
    expect(b.value).toEqual({ x: 5, y: 5, w: 40, h: 40 });
  });

  it("eager equivalent: b.expand(5)", () => {
    const b = box(0, 0, 10, 10);
    const eager = b.expand(5);
    const fused = b.derive((c) => c.expand(5));
    expect(fused.value).toEqual(eager.value);
    eager.value = { x: 0, y: 0, w: 30, h: 30 };
    expect(b.value).toEqual({ x: 5, y: 5, w: 20, h: 20 });
  });
});

// ─── Matrix: multiply & invert as lenses ───────────────────────────

describe("Matrix — multiply and invert are lenses", () => {
  it("multiply: writing the product solves for self", () => {
    const m = matrix();  // identity
    const t = fromTranslate(10, 0);
    const product = m.multiply(t);
    expect(product.value).toEqual(t);
    // Write a new product; m should become product * t^-1
    product.value = fromTranslate(50, 20);
    // new m = fromTranslate(50, 20) * invert(t)
    //       = fromTranslate(50, 20) * fromTranslate(-10, 0)
    //       = fromTranslate(40, 20)
    expect(m.value).toEqual(fromTranslate(40, 20));
  });

  it("invert: its own inverse", () => {
    const m = matrix(2, 0, 0, 3, 5, 7);
    const inv = m.invert();
    const expectedInv = invert(m.peek());
    expect(inv.value.a).toBeCloseTo(expectedInv.a, 10);
    expect(inv.value.e).toBeCloseTo(expectedInv.e, 10);
    // Write back: invert(invert(m)) = m. Allow ±0 noise from float math.
    inv.value = fromTranslate(100, 200);
    const expected = fromTranslate(-100, -200);
    expect(m.value.a).toBeCloseTo(expected.a, 10);
    expect(m.value.d).toBeCloseTo(expected.d, 10);
    expect(m.value.e).toBeCloseTo(expected.e, 10);
    expect(m.value.f).toBeCloseTo(expected.f, 10);
    expect(Math.abs(m.value.b)).toBeLessThan(1e-10);
    expect(Math.abs(m.value.c)).toBeLessThan(1e-10);
  });

  it("chained matrix: derive(c => c.multiply(t).invert())", () => {
    const m = matrix();
    const t = fromTranslate(5, 0);
    const r = m.derive((c) => c.multiply(t).invert());
    // r = invert(m * t)
    // Write r = identity → invert(m * t) = identity → m * t = identity → m = t^-1
    r.value = identity();
    expect(m.value).toEqual(invert(t));
  });
});

// ─── Transform: invertible composite ───────────────────────────────

describe("Transform — invertible composite write-through", () => {
  it("derive(c => c.scale(2)) doubles everything; write halves", () => {
    const tr = transform({ translate: { x: 5, y: 0 }, opacity: 0.5 });
    const big = tr.derive((c) => c.scale(2));
    expect(big.value.translate).toEqual({ x: 10, y: 0 });
    expect(big.value.opacity).toBe(1);
    // Write big = some_value → tr = big / 2
    big.value = {
      translate: { x: 20, y: 4 },
      scale: { x: 4, y: 4 },
      origin: { x: 0, y: 0 },
      rotate: 0.6,
      opacity: 0.8,
    };
    expect(tr.value.translate).toEqual({ x: 10, y: 2 });
    expect(tr.value.opacity).toBeCloseTo(0.4, 10);
  });
});

// ─── Cross-type chain: vec.field through Transform.translate ───────

describe("Cross-type bidirectional flow", () => {
  it("transform.translate.x is bidirectionally written via chain", () => {
    const tr = transform({ translate: { x: 5, y: 5 } });
    const offsetX = tr.translate.x.add(10);  // x + 10
    offsetX.value = 100;                     // x = 90
    expect(tr.translate.x.value).toBe(90);
    expect(tr.value.translate.x).toBe(90);
  });
});

// ─── Type probes: non-invertible methods return RO<…>, writes are TS errors ──
function _typeOnlyProbe(): void {
  if (Math.random() < -1) {
    const v = vec(0, 0);

    // Invertible methods return the writable class
    const sum = v.add(vec(1, 1));  // Vec
    sum.value = { x: 0, y: 0 };  // OK

    // Non-invertible methods return RO<...>
    const norm = v.normalize();        // RO<Vec>
    const perp = v.perp();             // RO<Vec>
    const dist = v.distance(vec(0,0)); // RO<Num>

    // @ts-expect-error — RO<Vec>.value is readonly
    norm.value = { x: 1, y: 1 };
    // @ts-expect-error — RO<Vec>.value is readonly
    perp.value = { x: 1, y: 1 };
    // @ts-expect-error — RO<Num>.value is readonly
    dist.value = 5;

    // Chain class doesn't expose non-invertible methods
    v.derive((c) => {
      // @ts-expect-error — normalize() not on VecChain
      c.normalize();
      // @ts-expect-error — perp() not on VecChain
      c.perp();
      // @ts-expect-error — lerp() not on VecChain (multi-inverse)
      c.lerp(vec(1, 1), 0.5);
      return c;
    });
  }
}
void _typeOnlyProbe;
