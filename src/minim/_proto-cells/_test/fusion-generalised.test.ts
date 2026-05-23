// fusion-generalised.test.ts — fusion across the generalised primitives:
// `lensTo` (cross-type writable), `deriveTo` (cross-type RO), and the
// `field()`/`derived()` helpers built on them.
//
// The original `.through()` fusion only collapsed endo chains (T → T).
// After generalisation, any receiver-anchored chain of value-space
// pipelines collapses to one cell pointing at the chain's root, no
// matter how the value type changes layer-to-layer.

import { describe, expect, it } from "vitest";
import { effect, Num, num, Signal, Transform, transform, Vec, vec } from "../index";

// ─── Helpers: peer into engine internals to assert fusion happened ─

// biome-ignore lint/suspicious/noExplicitAny: probing engine internals
const subs = (s: any) => (s as { subs: unknown }).subs;
// biome-ignore lint/suspicious/noExplicitAny: probing engine internals
const fusedParent = (s: any): Signal<unknown> | undefined =>
  (s as { _fusedOf?: { parent: Signal<unknown> } })._fusedOf?.parent;

describe("deriveTo chains (RO fusion)", () => {
  it("deriveTo ∘ deriveTo fuses to a single computed onto root", () => {
    const a = num(3);
    const b = a.deriveTo(Num, v => v * 2);
    const c = b.deriveTo(Num, v => v + 10);
    expect(c.value).toBe(16);
    // Witness: c's _fusedOf.parent is a, not b.
    expect(fusedParent(c)).toBe(a);
    // Reading c doesn't add b as a subscriber.
    const sBefore = subs(b);
    void c.value;
    void c.value;
    expect(subs(b)).toBe(sBefore);
    a.value = 5;
    expect(c.value).toBe(20);
  });

  it("derive chain across different classes (Num → Vec via deriveTo)", () => {
    const a = num(3);
    const v = a.deriveTo(Vec, n => ({ x: n, y: n * 2 }));
    const mag = v.deriveTo(Num, p => Math.hypot(p.x, p.y));
    expect(mag.value).toBeCloseTo(Math.hypot(3, 6));
    // Fused onto a directly.
    expect(fusedParent(mag)).toBe(a);
    a.value = 4;
    expect(mag.value).toBeCloseTo(Math.hypot(4, 8));
  });

  it("4-deep deriveTo chain fuses to one cell", () => {
    const a = num(1);
    const c = a
      .deriveTo(Num, v => v + 1)
      .deriveTo(Num, v => v * 2)
      .deriveTo(Num, v => v - 3)
      .deriveTo(Num, v => v * 5);
    expect(c.value).toBe(5); // ((((1+1)*2)-3)*5)
    expect(fusedParent(c)).toBe(a);
  });

  it("writing to a deriveTo-fused cell throws (it's a computed)", () => {
    const a = num(0);
    const c = a.deriveTo(Num, v => v * 2).deriveTo(Num, v => v + 1);
    expect(() => {
      (c as unknown as { value: number }).value = 99;
    }).toThrow(/Cannot write to a Computed/);
  });
});

describe("lensTo chains (cross-type writable fusion)", () => {
  it("lensTo ∘ lensTo fuses to single lens onto root, both directions", () => {
    type S = { a: { b: number } };
    const root = new Signal<S>({ a: { b: 42 } });
    const inner = root.lensTo(
      Num,
      s => s.a.b,
      (n, s) => ({ ...s, a: { ...s.a, b: n } }),
    );
    // Two-deep via a generic intermediate (lensTo to a.b is one step;
    // simulate "deeper" by then through-fusing on the Num).
    // Cast: the chained lens type drops the Writable brand even though
    // runtime is writable; tests use raw value assignment.
    const offset = inner.through(
      v => v + 100,
      v => v - 100,
    ) as Num & { value: number };
    expect(offset.value).toBe(142);
    expect(fusedParent(offset)).toBe(root);
    offset.value = 200;
    // bwd: 200 - 100 = 100, then write into a.b.
    expect(root.value.a.b).toBe(100);
    expect(offset.value).toBe(200);
  });

  it("field chain transform.translate.x fuses to a single lens onto transform", () => {
    const tr = transform({ translate: { x: 5, y: 10 } });
    const x = tr.translate.x;
    // Single fused lens onto tr, NOT onto tr.translate.
    expect(fusedParent(x as Signal<unknown>)).toBe(tr);

    // Reading x doesn't subscribe to tr.translate.
    const sBefore = subs(tr.translate as Signal<unknown>);
    let observed = 0;
    const stop = effect(() => {
      observed = x.value;
    });
    expect(observed).toBe(5);
    expect(subs(tr.translate as Signal<unknown>)).toBe(sBefore);

    // Writing x propagates to tr (single spread-replace per level).
    x.value = 99;
    expect(tr.value.translate.x).toBe(99);
    expect(tr.value.translate.y).toBe(10); // y untouched
    expect(observed).toBe(99);
    stop();
  });

  it.skip("field chain box.center — skipped (Box not ported)", () => {});

  it("write-then-read round-trips on a 3-deep field chain", () => {
    // Box has no nested-object field by default; build one via Transform.
    const tr = transform({ translate: { x: 1, y: 2 } });
    const xPath = tr.translate.x;
    xPath.value = 7;
    expect(xPath.value).toBe(7);
    expect(tr.value.translate.x).toBe(7);
    expect(tr.value.translate.y).toBe(2);
  });

  it("multiple field reads of the same path share identity (lazy cache)", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    // .translate is cached → same Vec lens on each access.
    expect(tr.translate).toBe(tr.translate);
    // .x on that is cached → same Num lens on each access.
    expect(tr.translate.x).toBe(tr.translate.x);
  });
});

describe("mixed-flavour fusion (through ∘ lensTo, lensTo ∘ deriveTo, …)", () => {
  it("through then deriveTo: writable scale then RO derive fuses onto root", () => {
    const a = num(2);
    const fused = a
      .through(
        v => v * 3,
        v => v / 3,
      )
      .deriveTo(Num, v => v + 100);
    expect(fused.value).toBe(106); // 2*3 + 100
    expect(fusedParent(fused)).toBe(a);
    a.value = 5;
    expect(fused.value).toBe(115);
  });

  it("deriveTo then lensTo: writable view on top of RO chain throws at construction", () => {
    // The chain upstream has no bwd (deriveTo is RO), so we can't
    // compose a writable bwd through it. TS rejects this at the type
    // level (deriveTo returns bare RO `Num`); the runtime check is
    // a defense against escape-hatch casts. Error fires at the
    // `.lensTo()` call so the stack trace points at the user's
    // mistake rather than a much-later write.
    const a = num(0);
    const ro = a.deriveTo(Num, v => v * 2);
    expect(() =>
      ro.lensTo(
        Num,
        n => n + 1,
        (v, _s) => v - 1,
      ),
    ).toThrow(/writable view on top of a read-only fused chain/);
  });

  it.skip("box.expand(5).x — skipped (Box not ported)", () => {});
});

describe("equality propagation across generalised fusion", () => {
  it("non-injective deriveTo collapses duplicate root writes to one fire", () => {
    const a = num(0);
    // sin: sin(0) = sin(π).
    const c = a.deriveTo(Num, v => Math.round(Math.sin(v * Math.PI) * 1e9) / 1e9);
    let fires = 0;
    const stop = effect(() => {
      void c.value;
      fires++;
    });
    expect(fires).toBe(1);
    a.value = 1; // sin(π) ≈ 0 — same fused output, no fire.
    expect(fires).toBe(1);
    a.value = 0.5; // sin(π/2) = 1 — fires.
    expect(fires).toBe(2);
    stop();
  });

  it("Vec equality through field chain: writing the same vec doesn't fire", () => {
    // Vec uses structural equality; writing the same x,y twice should
    // not fire the effect twice.
    const tr = transform({ translate: { x: 1, y: 2 } });
    let fires = 0;
    const stop = effect(() => {
      void tr.translate.x.value;
      fires++;
    });
    expect(fires).toBe(1);
    tr.translate.x.value = 1; // same value: Num equality stops propagation.
    expect(fires).toBe(1);
    tr.translate.x.value = 2;
    expect(fires).toBe(2);
    stop();
  });
});

describe("class identity preservation", () => {
  it("deriveTo across classes returns instance of target Cls", () => {
    const a = num(3);
    const v = a.deriveTo(Vec, n => ({ x: n, y: n }));
    expect(v).toBeInstanceOf(Vec);
  });

  it("lensTo across classes returns instance of target Cls (writable)", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    expect(tr.translate).toBeInstanceOf(Vec);
    expect(tr.translate.x).toBeInstanceOf(Num);
  });
});

describe("cleanup across fused chains", () => {
  it("effect on fused leaf cleans up its dep on root", () => {
    const a = num(0);
    const c = a.deriveTo(Num, v => v * 2).deriveTo(Num, v => v + 10);
    const stop = effect(() => {
      void c.value;
    });
    expect(subs(a)).not.toBeUndefined();
    stop();
    expect(subs(a)).toBeUndefined();
  });

  it("effect on field-chain cleans up its dep on the transform root", () => {
    const tr = transform({ translate: { x: 1, y: 2 } });
    const stop = effect(() => {
      void tr.translate.x.value;
    });
    expect(subs(tr)).not.toBeUndefined();
    stop();
    expect(subs(tr)).toBeUndefined();
  });
});

describe("subtle: state-passing in composed bwd", () => {
  it("nested-field write uses current root state for spread-replace", () => {
    // Subtle: when writing transform.translate.x = 5, the composed
    // bwd must compute new translate = {...current_translate, x: 5}
    // — not based on a stale snapshot. This verifies the composition
    // correctly threads `prior.fwd(s_root)` to the inner bwd.
    const tr = transform({ translate: { x: 1, y: 2 } });
    // Mutate y first (via the other field-lens).
    tr.translate.y.value = 99;
    expect(tr.value.translate).toEqual({ x: 1, y: 99 });
    // Now write x. y must remain 99 (read from current state, not stale).
    tr.translate.x.value = 5;
    expect(tr.value.translate).toEqual({ x: 5, y: 99 });
  });

  it("write to one field doesn't disturb sibling fields", () => {
    const v = vec(10, 20);
    v.x.value = 100;
    expect(v.value).toEqual({ x: 100, y: 20 });
    v.y.value = 200;
    expect(v.value).toEqual({ x: 100, y: 200 });
  });
});

describe("non-fusion barriers (semantics preserved)", () => {
  it("axes() composite (multi-source) is NOT fused; writes batch", () => {
    // axes() takes two writable Nums and builds a Vec lens on both.
    // It's NOT a single-input pipeline so it doesn't get _fusedOf.
    const x = num(1);
    const y = num(2);
    // axes is a free factory in vec module
    const v = vec(x, y); // smart-dispatches to axes when both args are Num
    expect(v.value).toEqual({ x: 1, y: 2 });
    // v should NOT have _fusedOf (it's a multi-source join).
    expect(fusedParent(v as Signal<unknown>)).toBeUndefined();
    v.value = { x: 10, y: 20 };
    expect(x.value).toBe(10);
    expect(y.value).toBe(20);
  });

  it("manual Cls.lens(g, s) doesn't tag, so .lensTo on it doesn't fuse", () => {
    const a = num(0);
    const manual = Num.lens(
      () => a.value * 2,
      v => {
        a.value = v / 2;
      },
    );
    // .deriveTo on manual: receiver has no _fusedOf, so parent = manual.
    const c = manual.deriveTo(Num, v => v + 1);
    expect(fusedParent(c)).toBe(manual);
    expect(c.value).toBe(1); // 0*2 + 1
  });
});

describe("regression: original endo through still works", () => {
  it("2-deep .through still fuses to one cell (regression)", () => {
    const a = num(3);
    const c = a
      .through(
        v => v * 2,
        v => v / 2,
      )
      .through(
        v => v + 10,
        v => v - 10,
      );
    expect(c.value).toBe(16);
    expect(fusedParent(c)).toBe(a);
    c.value = 50;
    expect(a.value).toBe(20);
  });
});

// rgb / Color tests skipped — Color not ported in prototype.
