// Benches for `.nested()` SoA storage. Compares Transform-as-one-
// reactive-struct against the current "five separate fields on
// Shape" baseline across the dimensions that actually drive Shape
// performance:
//
//   1. Construction
//   2. Per-axis nested write (translate.x.value = ++i) — the dominant
//      Shape mutation pattern (drag, animate one axis)
//   3. Per-axis AoS write (rotate.value = ++i)
//   4. Whole-value read (the transform-effect re-runs reading `.value`)
//   5. Whole-value write (a tween on the whole transform)
//   6. Composed transform-matrix read (the actual hot path: read all
//      five animatable props + compose a matrix)
//
// Two baselines:
//
//   - "5 fields": Vec.signal × 3, signal × 2.
//   - "5 fields + lens-Vec": same but the nested fields are wrapped
//     in lens-flavored Vecs (matching the pre-Transform Shape layout
//     when external Signals were passed in via opts).
//
// Reference for matrix-compose: a tiny inline `compose(t, r, s, o)`
// that mirrors what `values/matrix.ts` does, so we measure the cost
// of the *reads* not the matrix math.

import { Signal, signal } from "@minim/signals";
import { Vec, type V } from "@minim/values";
import { struct } from "@minim/signals";
import { bench, group } from "mitata";

// ── The candidate: Transform-as-struct with nested Vec fields ────

type Tr = {
  translate: V;
  rotate: number;
  scale: V;
  origin: V;
  opacity: number;
};

const Transform = struct<Tr>("Transform", {
  translate: { x: 0, y: 0 },
  rotate: 0,
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  opacity: 1,
})
  .nested({ translate: Vec, scale: Vec, origin: Vec })
  .ops({
    lerp: (a, b: Tr, t: number): Tr => ({
      translate: {
        x: a.translate.x + (b.translate.x - a.translate.x) * t,
        y: a.translate.y + (b.translate.y - a.translate.y) * t,
      },
      rotate: a.rotate + (b.rotate - a.rotate) * t,
      scale: {
        x: a.scale.x + (b.scale.x - a.scale.x) * t,
        y: a.scale.y + (b.scale.y - a.scale.y) * t,
      },
      origin: {
        x: a.origin.x + (b.origin.x - a.origin.x) * t,
        y: a.origin.y + (b.origin.y - a.origin.y) * t,
      },
      opacity: a.opacity + (b.opacity - a.opacity) * t,
    }),
  })
  .build();

// Default initial transform (identity) — used in construction benches.
const TR0: Tr = {
  translate: { x: 0, y: 0 },
  rotate: 0,
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  opacity: 1,
};

// ── Reference: 5 separate fields (today's Shape layout) ──────────

class FiveFields {
  readonly translate = Vec.signal({ x: 0, y: 0 });
  readonly rotate = signal(0);
  readonly scale = Vec.signal({ x: 1, y: 1 });
  readonly origin = Vec.signal({ x: 0, y: 0 });
  readonly opacity = signal(1);
}

// ── Reference: 5 fields, with lens-Vec wrappers (Shape's actual ctor) ──

const lensVec = (src: Signal<V>) =>
  Vec.lens(
    () => src.value,
    (v) => {
      src.value = v;
    },
  );

class FiveFieldsLensed {
  readonly _t = Vec.signal({ x: 0, y: 0 });
  readonly translate = lensVec(this._t);
  readonly rotate = signal(0);
  readonly _s = Vec.signal({ x: 1, y: 1 });
  readonly scale = lensVec(this._s);
  readonly _o = Vec.signal({ x: 0, y: 0 });
  readonly origin = lensVec(this._o);
  readonly opacity = signal(1);
}

// ── Matrix compose helper (read-cost dominated) ──────────────────

function composeRead(t: V, r: number, s: V, o: V): number {
  // Mirrors `values/matrix.ts` `compose` shape, but returns a single
  // number so the JIT can't dead-code-eliminate the reads.
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return (
    t.x +
    t.y +
    s.x * c +
    s.y * sn -
    o.x * (c - 1) -
    o.y * sn
  );
}

// ── 1. Construction ──────────────────────────────────────────────

group("nested: construct", () => {
  bench("5 fields", () => new FiveFields()).baseline(true);
  bench("5 fields + lens", () => new FiveFieldsLensed());
  bench("Transform.signal()", () => Transform.signal(TR0));
});

// ── 2. Per-axis nested write ─────────────────────────────────────

group("nested: per-axis nested write (translate.x = ++i)", () => {
  const a = new FiveFields();
  const b = new FiveFieldsLensed();
  const c: any = Transform.signal(TR0);
  void c.translate;
  void c.translate.x;
  let i = 0;
  bench("5 fields: translate.x.value = ++i", () => {
    a.translate.x.value = ++i;
  }).baseline(true);
  bench("5 fields + lens: translate.x.value = ++i", () => {
    b.translate.x.value = ++i;
  });
  bench("Transform: translate.x.value = ++i", () => {
    c.translate.x.value = ++i;
  });
});

// ── 3. Per-axis AoS write (rotate, opacity) ──────────────────────

group("nested: per-axis AoS write (rotate.value = ++i)", () => {
  const a = new FiveFields();
  const b = new FiveFieldsLensed();
  const c: any = Transform.signal(TR0);
  void c.rotate;
  let i = 0;
  bench("5 fields: rotate.value = ++i", () => {
    a.rotate.value = ++i;
  }).baseline(true);
  bench("5 fields + lens: rotate.value = ++i", () => {
    b.rotate.value = ++i;
  });
  bench("Transform: rotate.value = ++i", () => {
    c.rotate.value = ++i;
  });
});

// ── 4. Whole-value read ──────────────────────────────────────────

group("nested: whole-value read", () => {
  const a = new FiveFields();
  const b = new FiveFieldsLensed();
  const c: any = Transform.signal(TR0);
  bench("5 fields: assemble manually", () => {
    return {
      translate: a.translate.value,
      rotate: a.rotate.value,
      scale: a.scale.value,
      origin: a.origin.value,
      opacity: a.opacity.value,
    };
  }).baseline(true);
  bench("5 fields + lens: assemble manually", () => {
    return {
      translate: b.translate.value,
      rotate: b.rotate.value,
      scale: b.scale.value,
      origin: b.origin.value,
      opacity: b.opacity.value,
    };
  });
  bench("Transform: c.value (composed)", () => c.value);
});

// ── 5. Whole-value write ─────────────────────────────────────────

const target: Tr = {
  translate: { x: 100, y: 200 },
  rotate: 1.5,
  scale: { x: 2, y: 3 },
  origin: { x: 5, y: 5 },
  opacity: 0.7,
};

group("nested: whole-value write", () => {
  const a = new FiveFields();
  const b = new FiveFieldsLensed();
  const c: any = Transform.signal(TR0);
  let i = 0;
  bench("5 fields: write each field", () => {
    a.translate.value = { ...target.translate, x: target.translate.x + ++i };
    a.rotate.value = target.rotate + i;
    a.scale.value = target.scale;
    a.origin.value = target.origin;
    a.opacity.value = target.opacity;
  }).baseline(true);
  bench("5 fields + lens: write each field", () => {
    b.translate.value = { ...target.translate, x: target.translate.x + ++i };
    b.rotate.value = target.rotate + i;
    b.scale.value = target.scale;
    b.origin.value = target.origin;
    b.opacity.value = target.opacity;
  });
  bench("Transform: c.value = {...} (decomposed)", () => {
    c.value = {
      ...target,
      translate: { ...target.translate, x: target.translate.x + ++i },
      rotate: target.rotate + i,
    };
  });
});

// ── 6. Compose-matrix read (the real Shape transform-effect) ─────

group("nested: compose-matrix read (transform effect)", () => {
  const a = new FiveFields();
  const b = new FiveFieldsLensed();
  const c: any = Transform.signal(TR0);
  bench("5 fields: read all 5", () => {
    return composeRead(
      a.translate.value,
      a.rotate.value,
      a.scale.value,
      a.origin.value,
    );
  }).baseline(true);
  bench("5 fields + lens: read all 5", () => {
    return composeRead(
      b.translate.value,
      b.rotate.value,
      b.scale.value,
      b.origin.value,
    );
  });
  bench("Transform: read via c.value", () => {
    const v = c.value;
    return composeRead(v.translate, v.rotate, v.scale, v.origin);
  });
  bench("Transform: read per-field", () => {
    return composeRead(
      c.translate.value,
      c.rotate.value,
      c.scale.value,
      c.origin.value,
    );
  });
});
