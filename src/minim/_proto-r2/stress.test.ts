// stress.test.ts — try to break things on the new value types.
//
// Each test targets a footgun I'd worry about in production:
//   - Sparse trait dicts (Matrix has only `equals`)
//   - Nested-class field lenses (Transform.translate is a Vec, not Num)
//   - Name collisions (Transform.scale is Vec lens; chain.scale is scalar)
//   - Cross-type composition (writing through a Vec field of a Transform
//     of a Matrix multiplication...)
//   - Large field counts (Matrix has 6 fields)
//   - Custom equality with floating-point epsilon
//   - String-typed Computed (Color.css returns a Computed<string>, no
//     value class)
//   - Long chains stressing memo() through nested derivations
//   - Animator dispatch against types with sparse traits (Matrix should
//     fail spring at compile time)

import { describe, it, expect } from "vitest";
import { Signal, signal, computed, lens, effect, batch, untracked, type Computed } from "./signal";
import { type Traits } from "./traits";
import { Num, num } from "./values/num";
import { Vec, vec } from "./values/vec";
import { Box, box } from "./values/box";
import {
  Color, ColorChain, rgb, rgba, type ColorValue,
} from "./values/color";
import {
  Matrix, MatrixChain, matrix,
  identity, fromTranslate, fromScale, fromRotate,
  multiply, invert, determinant, transformPoint, isIdentity,
  type MatrixValue,
} from "./values/matrix";
import {
  Transform, TransformChain, transform,
  type TransformValue, DEFAULT as TR_DEFAULT,
} from "./values/transform";
import { spring, tween, attract } from "./anim";
import { mean } from "./values/multi";

// ─── Color ──────────────────────────────────────────────────────────

describe("Color", () => {
  it("rgb / rgba / instanceof", () => {
    const c = rgb(1, 0, 0);
    expect(c).toBeInstanceOf(Color);
    expect(c).toBeInstanceOf(Signal);
    expect(c.value).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(rgba(0.5, 0.5, 0.5, 0.5).value).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 0.5 });
  });

  it("luminance is a reactive Num", () => {
    const c = rgb(1, 0, 0);
    expect(c.luminance).toBeInstanceOf(Num);
    expect(c.luminance.value).toBeCloseTo(0.299, 5);
    c.value = { r: 0, g: 1, b: 0, a: 1 };
    expect(c.luminance.value).toBeCloseTo(0.587, 5);
  });

  it("css is a Computed<string> (no value class for strings)", () => {
    const c = rgb(1, 0, 0);
    const s: Computed<string> = c.css;
    expect(s.value).toBe("rgba(255, 0, 0, 1)");
    c.value = { r: 0, g: 0, b: 1, a: 0.5 };
    expect(c.css.value).toBe("rgba(0, 0, 255, 0.5)");
    // Same memoized instance returned each time
    expect(c.css).toBe(c.css);
  });

  it("traits dispatch — lerp works via static traits", () => {
    const a = rgb(0, 0, 0);
    const b = rgb(1, 1, 1);
    const half = a.lerp(b, 0.5);
    expect(half.value).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  });

  it("chain duality: a.lerp(b, t) === a.derive(c => c.lerp(b, t))", () => {
    const a = rgb(0, 0, 0); const b = rgb(1, 0, 0);
    const eager = a.lerp(b, 0.5);
    const fused = a.derive((c) => c.lerp(b, 0.5));
    expect(fused.value).toEqual(eager.value);
  });

  it("attract works on Color (linear trait sufficient)", () => {
    const c = rgb(0, 0, 0);
    // k=2, dt=0.05 → step = 0.1 of remaining distance per frame
    const g = (function* () { yield* attract(c, { r: 1, g: 1, b: 1, a: 1 }, 2); })();
    for (let i = 0; i < 3; i++) g.next({ dt: 0.05, elapsed: i * 0.05 });
    expect(c.value.r).toBeGreaterThan(0);
    expect(c.value.r).toBeLessThan(1);
  });
});

// ─── Matrix ─────────────────────────────────────────────────────────

describe("Matrix", () => {
  it("identity / multiply / invert", () => {
    const m = matrix();
    expect(m.value).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const trans = fromTranslate(5, 10);
    const m2 = m.multiply(trans);
    expect(m2.value).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 5, f: 10 });
  });

  it("6 field lenses all have stable identity", () => {
    const m = matrix();
    expect(m.a).toBe(m.a);
    expect(m.b).toBe(m.b);
    expect(m.c).toBe(m.c);
    expect(m.d).toBe(m.d);
    expect(m.e).toBe(m.e);
    expect(m.f).toBe(m.f);
  });

  it("field-lens write propagates to determinant", () => {
    const m = matrix(2, 0, 0, 3);
    expect(m.determinant.value).toBe(6);
    m.a.value = 10;
    expect(m.determinant.value).toBe(30);
  });

  it("invert chain: m.derive(c => c.invert().invert()) is identity", () => {
    const m = matrix(2, 0, 0, 3, 5, 7);
    const r = m.derive((c) => c.invert().invert());
    expect(r.value.a).toBeCloseTo(2, 10);
    expect(r.value.d).toBeCloseTo(3, 10);
    expect(r.value.e).toBeCloseTo(5, 10);
    expect(r.value.f).toBeCloseTo(7, 10);
  });

  it("invertible throws on singular matrix", () => {
    expect(() => invert({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toThrow();
  });

  it("equality dedup: writing same value doesn't fire effects", () => {
    const m = matrix();
    let runs = 0;
    effect(() => { void m.value; runs++; });
    expect(runs).toBe(1);
    m.value = identity();
    expect(runs).toBe(1);
    m.value = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 1 };
    expect(runs).toBe(2);
  });

  it("transformPoint composes with Vec reads", () => {
    const m = matrix(2, 0, 0, 2, 10, 0);
    const p = vec(3, 4);
    const transformed = computed(() => transformPoint(m.value, p.value), Vec);
    expect(transformed.value).toEqual({ x: 16, y: 8 });
    p.value = { x: 0, y: 0 };
    expect(transformed.value).toEqual({ x: 10, y: 0 });
  });
});

// ─── Transform ──────────────────────────────────────────────────────

describe("Transform", () => {
  it("default / instanceof", () => {
    const tr = transform();
    expect(tr).toBeInstanceOf(Transform);
    expect(tr.value).toEqual(TR_DEFAULT);
  });

  it("nested field lens: translate is a Vec, not a Num", () => {
    const tr = transform();
    expect(tr.translate).toBeInstanceOf(Vec);
    expect(tr.scale).toBeInstanceOf(Vec);
    expect(tr.origin).toBeInstanceOf(Vec);
    expect(tr.rotate).toBeInstanceOf(Num);
    expect(tr.opacity).toBeInstanceOf(Num);
  });

  it("nested field lens write → composite changes", () => {
    const tr = transform();
    tr.translate.value = { x: 100, y: 50 };
    expect(tr.value.translate).toEqual({ x: 100, y: 50 });
  });

  it("DOUBLY nested lens: translate.x is Num lens through Vec lens", () => {
    const tr = transform();
    expect(tr.translate.x).toBeInstanceOf(Num);
    tr.translate.x.value = 42;
    expect(tr.value.translate).toEqual({ x: 42, y: 0 });
    expect(tr.translate.value).toEqual({ x: 42, y: 0 });
    // and write through the composite still updates the nested lens read
    tr.value = { ...tr.peek(), translate: { x: 7, y: 11 } };
    expect(tr.translate.x.value).toBe(7);
  });

  it("name collision: Transform.scale is Vec lens, chain.scale is scalar", () => {
    const tr = transform();
    // `tr.scale` returns the axis lens (a Vec)
    expect(tr.scale).toBeInstanceOf(Vec);
    // `tr.derive(c => c.scale(2))` uses TransformChain.scale (scalar)
    const doubled = tr.derive((c) => c.scale(2));
    expect(doubled.value.scale).toEqual({ x: 2, y: 2 });
    expect(doubled.value.opacity).toBe(2);  // also scaled
  });

  it("init declarative construction binds nested signals", () => {
    const rot = num(0);
    const tx = num(0);
    const tr = transform({
      translate: () => ({ x: tx.value, y: 0 }),
      rotate: rot,
      opacity: 0.5,
    });
    expect(tr.value.rotate).toBe(0);
    expect(tr.value.opacity).toBe(0.5);
    rot.value = 1.57;
    expect(tr.value.rotate).toBe(1.57);
    tx.value = 50;
    expect(tr.value.translate).toEqual({ x: 50, y: 0 });
  });

  it("spring works on Transform (full trait set)", () => {
    const tr = transform();
    const target: TransformValue = {
      translate: { x: 10, y: 5 },
      scale: { x: 1.5, y: 1.5 },
      origin: { x: 0, y: 0 },
      rotate: 0.5,
      opacity: 0.8,
    };
    const g = (function* () { yield* spring(tr, target, { omega: 30, zeta: 1, precision: 1e-3 }); })();
    for (let i = 0; i < 200; i++) {
      const r = g.next({ dt: 1 / 60, elapsed: i / 60 });
      if (r.done) break;
    }
    expect(tr.value.translate.x).toBeCloseTo(10, 2);
    expect(tr.value.rotate).toBeCloseTo(0.5, 2);
  });

  it("mean of transforms (linear trait → mean accepts)", () => {
    const a = transform({ translate: { x: 0, y: 0 } });
    const b = transform({ translate: { x: 10, y: 20 } });
    const m = mean(a, b);
    expect(m).toBeInstanceOf(Transform);
    expect(m.value.translate).toEqual({ x: 5, y: 10 });
    m.value = { ...m.peek(), translate: { x: 100, y: 100 } };
    // delta = (100 - 5, 100 - 10) = (95, 90); split: each gets +95, +90
    expect(a.value.translate).toEqual({ x: 95, y: 90 });
    expect(b.value.translate).toEqual({ x: 105, y: 110 });
  });
});

// ─── Type-only stress: trait constraints reject Matrix where appropriate ──

function _typeProbe(): void {
  if (Math.random() < -1) {
    // ✓ Color has linear+lerp+equals → attract accepts
    attract(rgb(0, 0, 0), { r: 1, g: 1, b: 1, a: 1 });
    // ✓ Transform has full trait set → spring accepts
    spring(transform(), TR_DEFAULT);

    // ✗ Matrix only has `equals` — fails spring (needs linear+metric)
    // @ts-expect-error
    spring(matrix(), identity());
    // ✗ Matrix has no lerp → fails tween
    // @ts-expect-error
    tween(matrix(), identity(), 0.5);
    // ✗ Matrix has no linear → fails attract
    // @ts-expect-error
    attract(matrix(), identity());
    // ✗ Matrix has no linear → fails mean
    // @ts-expect-error
    mean(matrix(), matrix());

    // ✓ Color has linear → mean accepts
    mean(rgb(0, 0, 0), rgb(1, 1, 1));
    // ✓ Transform has linear → mean accepts
    mean(transform(), transform());
  }
}
void _typeProbe;

// ─── Cross-type composition stress: lens chains across many types ───

describe("cross-type stress", () => {
  it("vec.add(transform.translate) reactive composition", () => {
    const offset = vec(10, 20);
    const tr = transform({ translate: { x: 5, y: 0 } });
    const sum = offset.add(tr.translate);
    expect(sum.value).toEqual({ x: 15, y: 20 });
    tr.translate.value = { x: 100, y: 0 };
    expect(sum.value).toEqual({ x: 110, y: 20 });
    offset.value = { x: 0, y: 0 };
    expect(sum.value).toEqual({ x: 100, y: 0 });
  });

  it("matrix chain × box render (transformPoint over time)", () => {
    const t = num(0);
    const m = computed(() => fromRotate(t.value), Matrix);
    const corners = [vec(0, 0), vec(10, 0), vec(10, 10), vec(0, 10)];
    const rotated = corners.map((p) => computed(() => transformPoint(m.value, p.value), Vec));
    t.value = Math.PI / 2;
    expect(rotated[1].value.x).toBeCloseTo(0, 10);
    expect(rotated[1].value.y).toBeCloseTo(10, 10);
  });

  it("Transform.translate.x → drives box.center.x → drives derived computed", () => {
    const tr = transform();
    const b = box(0, 0, 20, 20);
    const total = computed(() => tr.translate.x.value + b.center.value.x, Num);
    expect(total.value).toBe(10);  // 0 + 10
    tr.translate.x.value = 7;
    expect(total.value).toBe(17);
    b.x.value = 100;
    expect(total.value).toBe(117); // 7 + (100 + 10)
  });
});

// ─── Stress: memo cache scaling ────────────────────────────────────

describe("memo cache scaling", () => {
  it("100 distinct memo keys on one instance", () => {
    const m = matrix();
    const cached: Num[] = [];
    for (let i = 0; i < 100; i++) {
      // Use Box-style at() pattern with dynamic key
      cached.push(m.memo(`computed-${i}`, () => computed(() => m.value.a * i, Num)));
    }
    expect(cached.length).toBe(100);
    expect(cached[50].value).toBe(50);
    // Repeated access returns same instance
    expect(m.memo("computed-50", () => computed(() => 999, Num))).toBe(cached[50]);
    m.a.value = 2;
    expect(cached[50].value).toBe(100);
  });
});

// ─── Stress: custom equals with floating-point epsilon ─────────────

describe("custom equals (epsilon)", () => {
  it("opts.equals on a Color (per-instance epsilon)", () => {
    const eps = 0.01;
    const colorEq = (a: ColorValue, b: ColorValue) =>
      Math.abs(a.r - b.r) < eps && Math.abs(a.g - b.g) < eps &&
      Math.abs(a.b - b.b) < eps && Math.abs(a.a - b.a) < eps;
    const c = new Color({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, { equals: colorEq });
    let runs = 0;
    effect(() => { void c.value; runs++; });
    expect(runs).toBe(1);
    c.value = { r: 0.505, g: 0.502, b: 0.499, a: 1 };  // within eps
    expect(runs).toBe(1);
    c.value = { r: 0.6, g: 0.5, b: 0.5, a: 1 };  // outside eps
    expect(runs).toBe(2);
  });
});

// ─── Stress: lens on Vec field → lens on Num field (3-deep) ────────

describe("deep field lens chain", () => {
  it("transform.translate.x is functional in both directions", () => {
    const tr = transform({ translate: { x: 10, y: 5 } });
    const x = tr.translate.x;
    expect(x.value).toBe(10);
    x.value = 99;
    expect(tr.translate.value).toEqual({ x: 99, y: 5 });
    expect(tr.value.translate).toEqual({ x: 99, y: 5 });

    // Write whole transform → re-reading x should see it
    tr.value = { ...tr.peek(), translate: { x: 1, y: 2 } };
    expect(x.value).toBe(1);
  });

  it("effect on translate.x doesn't fire on opacity write", () => {
    const tr = transform();
    let xRuns = 0;
    effect(() => { void tr.translate.x.value; xRuns++; });
    expect(xRuns).toBe(1);
    tr.opacity.value = 0.5;
    expect(xRuns).toBe(1);
    tr.translate.x.value = 7;
    expect(xRuns).toBe(2);
  });
});

// ─── Stress: identity persists across writes ────────────────────────

describe("identity through writes", () => {
  it("matrix.a === matrix.a even after multiple writes", () => {
    const m = matrix();
    const a1 = m.a;
    m.a.value = 5;
    m.value = identity();
    m.a.value = 9;
    expect(m.a).toBe(a1);
  });

  it("transform.translate === transform.translate (Vec lens identity)", () => {
    const tr = transform();
    const t1 = tr.translate;
    tr.translate.value = { x: 1, y: 2 };
    expect(tr.translate).toBe(t1);
  });
});
