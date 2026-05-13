// Shape-level benchmarks. Measures the actual reactive surface that
// Shape exposes after the Transform-as-struct migration:
//
//   1. Transform-in-Shape "construction" (the reactive bits — no DOM)
//   2. Per-axis write (`shape.translate.x.value = ++i`)
//   3. localFrame compose-recompute on per-axis write
//   4. Whole-pose tween: `transform.to(target, dur)` per-frame step
//   5. worldFrame reactive chain — write root, observe leaves
//   6. Smart-adoption overhead in `Transform.signal({...})`

import { cell, type ReadonlyCell } from "@minim/core";
import {
  compose,
  multiply,
  Vec,
  vec,
  struct,
  type Matrix2D,
  type V,
  type WriteOf,
} from "@minim/values";
import { bench, group } from "mitata";

// ── The Transform struct (matches values/transform.ts) ───────────

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

const TR0: Tr = {
  translate: { x: 0, y: 0 },
  rotate: 0,
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  opacity: 1,
};

// ── A minimal "Shape-like" — the reactive bits only (no DOM). ────

type TR = WriteOf<typeof Transform>;

class ShapeLike {
  readonly transform: TR;
  readonly translate: TR["translate"];
  readonly rotate: TR["rotate"];
  readonly scale: TR["scale"];
  readonly origin: TR["origin"];
  readonly opacity: TR["opacity"];
  readonly localFrame: ReadonlyCell<Matrix2D>;
  readonly worldFrame: ReadonlyCell<Matrix2D>;
  parent: ShapeLike | null = null;
  constructor(opts: Partial<Tr> = {}, parent: ShapeLike | null = null) {
    this.parent = parent;
    this.transform = Transform.signal({ ...TR0, ...opts });
    this.translate = this.transform.translate;
    this.rotate = this.transform.rotate;
    this.scale = this.transform.scale;
    this.origin = this.transform.origin;
    this.opacity = this.transform.opacity;
    const tr = this.transform;
    this.localFrame = cell.derived(() => {
      const t = tr.translate.value;
      const r = tr.rotate.value;
      const sc = tr.scale.value;
      if (t.x === 0 && t.y === 0 && r === 0 && sc.x === 1 && sc.y === 1) {
        return compose(t, r, sc, { x: 0, y: 0 });
      }
      return compose(t, r, sc, tr.origin.value);
    });
    this.worldFrame = cell.derived(() => {
      const local = this.localFrame.value;
      return this.parent ? multiply(this.parent.worldFrame.value, local) : local;
    });
  }
}

// ── 1. Construction (reactive bits only — no DOM) ────────────────

group("shape: construction (reactive bits)", () => {
  bench("ShapeLike()", () => new ShapeLike());
  bench("ShapeLike() with translate=vec(0,0) (adopted)", () => {
    const p = vec(0, 0);
    return new ShapeLike({ translate: p as unknown as V });
  });
});

// ── 2. Per-axis write through shape.translate.x ──────────────────

group("shape: per-axis write (translate.x = ++i)", () => {
  const sh = new ShapeLike();
  void sh.translate.x; // warm
  let i = 0;
  bench("sh.translate.x.value = ++i", () => {
    sh.translate.x.value = ++i;
  });
});

// ── 3. localFrame recompute on per-axis write (the realistic
//     transform-effect path: write axis → localFrame recompute → matrix). ──

group("shape: write triggers localFrame recompute", () => {
  const sh = new ShapeLike();
  // Subscribe so the Computed actually runs (matches the Shape effect
  // that wires localFrame to el.style.transform).
  let observed = 0;
  const dispose = sh.localFrame.subscribe((m) => {
    observed += m.e | 0;
  });
  let i = 0;
  bench("translate.x = ++i; localFrame fires", () => {
    sh.translate.x.value = ++i;
  });
  void dispose;
  void observed;
});

// ── 4. Whole-pose tween — per-frame step using lerp ──────────────

const TARGET: Tr = {
  translate: { x: 100, y: 200 },
  rotate: 1.5,
  scale: { x: 2, y: 3 },
  origin: { x: 0, y: 0 },
  opacity: 0.5,
};

group("shape: whole-pose tween (per-frame .to step)", () => {
  const sh = new ShapeLike();
  // Warm up the lerp lookup.
  sh.transform.value = TR0;
  let t = 0;
  bench("manual: write each field to lerped value", () => {
    t = (t + 0.016) % 1;
    sh.translate.value = {
      x: TR0.translate.x + (TARGET.translate.x - TR0.translate.x) * t,
      y: TR0.translate.y + (TARGET.translate.y - TR0.translate.y) * t,
    };
    sh.rotate.value = TR0.rotate + (TARGET.rotate - TR0.rotate) * t;
    sh.scale.value = {
      x: TR0.scale.x + (TARGET.scale.x - TR0.scale.x) * t,
      y: TR0.scale.y + (TARGET.scale.y - TR0.scale.y) * t,
    };
    sh.opacity.value = TR0.opacity + (TARGET.opacity - TR0.opacity) * t;
  }).baseline(true);
  bench("transform.value = lerp(...) (whole-pose)", () => {
    t = (t + 0.016) % 1;
    sh.transform.value = {
      translate: {
        x: TR0.translate.x + (TARGET.translate.x - TR0.translate.x) * t,
        y: TR0.translate.y + (TARGET.translate.y - TR0.translate.y) * t,
      },
      rotate: TR0.rotate + (TARGET.rotate - TR0.rotate) * t,
      scale: {
        x: TR0.scale.x + (TARGET.scale.x - TR0.scale.x) * t,
        y: TR0.scale.y + (TARGET.scale.y - TR0.scale.y) * t,
      },
      origin: TR0.origin,
      opacity: TR0.opacity + (TARGET.opacity - TR0.opacity) * t,
    };
  });
});

// ── 5. worldFrame reactive chain — Shape-style nested groups ─────

const TREE_N = 1000;

group(`shape: worldFrame chain — write root, READ ALL N leaves (n=${TREE_N})`, () => {
  // Build a chain: shape[i].parent = shape[i-1]
  const chain: ShapeLike[] = [];
  for (let i = 0; i < TREE_N; i++) {
    chain.push(new ShapeLike({ translate: { x: 1, y: 0 } }, chain[i - 1] ?? null));
  }
  // Pre-touch so Computeds settle before the bench
  for (const s of chain) void s.worldFrame.value;
  let i = 0;
  bench("write root.translate.x; read all worldFrame.e", () => {
    chain[0].translate.x.value = ++i;
    let s = 0;
    for (const sh of chain) s += sh.worldFrame.value.e | 0;
    return s;
  });
});

group(`shape: worldFrame chain — write root, READ ONE LEAF (n=${TREE_N})`, () => {
  const chain: ShapeLike[] = [];
  for (let i = 0; i < TREE_N; i++) {
    chain.push(new ShapeLike({ translate: { x: 1, y: 0 } }, chain[i - 1] ?? null));
  }
  const leaf = chain[TREE_N - 1];
  void leaf.worldFrame.value;
  let i = 0;
  bench("write root.translate.x; read leaf.worldFrame.e", () => {
    chain[0].translate.x.value = ++i;
    return leaf.worldFrame.value.e | 0;
  });
});

group(`shape: worldFrame chain — write root, NO READ (drag-only) (n=${TREE_N})`, () => {
  const chain: ShapeLike[] = [];
  for (let i = 0; i < TREE_N; i++) {
    chain.push(new ShapeLike({ translate: { x: 1, y: 0 } }, chain[i - 1] ?? null));
  }
  let i = 0;
  bench("write root.translate.x; no read", () => {
    chain[0].translate.x.value = ++i;
  });
});

// ── 6. Smart-adoption overhead in Transform.signal({...}) ─────────

group("nested: smart-adoption overhead", () => {
  bench("Transform.signal({literal})", () =>
    Transform.signal({ ...TR0 }),
  ).baseline(true);
  bench("Transform.signal({translate: vec(0,0)}) (adopt Vec)", () => {
    const p = vec(0, 0);
    return Transform.signal({ ...TR0, translate: p as unknown as V });
  });
  bench("Transform.signal({translate: cell({x,y})}) (wrap raw Signal)", () => {
    const s = cell({ x: 0, y: 0 });
    return Transform.signal({ ...TR0, translate: s as unknown as V });
  });
  bench("Transform.signal({translate: () => ({x,y})}) (wrap thunk)", () => {
    return Transform.signal({
      ...TR0,
      translate: (() => ({ x: 0, y: 0 })) as unknown as V,
    });
  });
});
