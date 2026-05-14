// Box — the reactive rectangular-region primitive (axis-aligned).
//
// Pattern:
//   interface Box        — plain shape ({ x, y, w, h })
//   const Box            — registered struct
//   Box.Writable         — writable cell type
//   Box.Readonly         — readonly cell type
//   Box.Like             — either flavor
//
// Plain-value helpers (`box`, `expandBox`, `unionBox`, `boxEdgeFrom`)
// live alongside the struct so the struct's `expand` / `union` ops
// can reuse them. The plain `box()` constructor is internal-only (not
// re-exported from `minim/index`) to avoid colliding with the
// `decorations.box(part)` shape factory.
//
// Cardinal anchors (`center`, `top`, `bottom`, `left`, `right`) are
// declared as **lazy property getters** via `.getters({...})`. Each
// is built on first access and cached as an own-property on the
// instance. Most consumers only touch one or two anchors per box —
// the rest never allocate.

import {
  computed,
  defineStruct,
  type ReadonlyCell,
  type WriteOf,
  type ReadOf,
} from "@minim/signals";
import { Vec } from "./vec";
import { transformBox, type Matrix2D } from "./matrix";

/** Plain `{x, y, w, h}` rectangular region. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── Plain-value helpers ────────────────────────────────────────────
//
// Internal — not re-exported from the main barrel (would collide
// with the `box(part)` decoration). External callers use
// `Box.signal({...})` for reactive boxes and `{ x, y, w, h }`
// literals for plain values.

export const box = (x: number, y: number, w: number, h: number): Box =>
  ({ x, y, w, h });

export const expandBox = (b: Box, n: number): Box =>
  box(b.x - n, b.y - n, b.w + 2 * n, b.h + 2 * n);

export function unionBox(...bs: Box[]): Box {
  if (bs.length === 0) return box(0, 0, 0, 0);
  let xMin = bs[0].x;
  let yMin = bs[0].y;
  let xMax = xMin + bs[0].w;
  let yMax = yMin + bs[0].h;
  for (let i = 1; i < bs.length; i++) {
    const o = bs[i];
    if (o.x < xMin) xMin = o.x;
    if (o.y < yMin) yMin = o.y;
    if (o.x + o.w > xMax) xMax = o.x + o.w;
    if (o.y + o.h > yMax) yMax = o.y + o.h;
  }
  return box(xMin, yMin, xMax - xMin, yMax - yMin);
}

/** Perimeter point on a Box facing `toward`. Used by default
 *  `Shape.boundary`. */
export function boxEdgeFrom(
  b: Box,
  toward: { x: number; y: number },
): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min(
    dx === 0 ? Infinity : (b.w / 2) / Math.abs(dx),
    dy === 0 ? Infinity : (b.h / 2) / Math.abs(dy),
  );
  return { x: cx + dx * k, y: cy + dy * k };
}

// ── Reactive struct ────────────────────────────────────────────────
//
// The `in` op below uses `transformBox` from `./matrix` (single
// source of truth for matrix-aware box math, including the identity
// shortcut).

export const Box = defineStruct({
  name: "Box",
  defaults: { x: 0, y: 0, w: 0, h: 0 } as Box,
  construct: (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h }),
  equals: (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h,
  // ── Capabilities ────────────────────────────────────────────────
  algebra: {
    add:   (a, b) => ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h }),
    sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k }),
  },
  /** Component-wise lerp. */
  lerp: (a, b, t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  }),
  /** Distance between two boxes — Euclidean over (x, y, w, h). */
  metric: (a, b) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h),
  ops: {
    expand: expandBox,
    union: (a, b: Box): Box => unionBox(a, b),
    /** This box in the frame `m`. Loose box around the four transformed corners. */
    in: (b: Box, m: Matrix2D): Box => transformBox(m, b),
  },
  scalars: {
    contains: (a, p: Vec): boolean =>
      p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h,
  },
  getters: {
    /** Area of this box, reactive. Lazy + cached as own-property. */
    area(this: { value: Box }): ReadonlyCell<number> {
      const self = this;
      return computed(() => self.value.w * self.value.h);
    },
    /** Self-reference so reactive `Box` values satisfy the `BoxLike`
     *  interface (which has `box: ReadonlyCell<Box>`). Shape/Part hold
     *  the Box as a field; bare reactive Box cells satisfy the same
     *  surface because of this self-getter (`b.box === b`). */
    box(this: any) {
      return this;
    },
    /** `at(u, v)` returns a reactive Vec at normalized fraction
     *  `(0, 0)` (top-left) to `(1, 1)` (bottom-right). Available on
     *  every cell flavor; cardinals (`.center`, etc.) are sugar over
     *  this. */
    at(this: { value: Box }) {
      const self = this;
      return (u: number, v: number): Vec.Readonly =>
        Vec.derived(() => {
          const b = self.value;
          return { x: b.x + u * b.w, y: b.y + v * b.h };
        });
    },
    /** Centre point — `at(0.5, 0.5)`. Lazy: built on first access. */
    center(this: { value: Box }): Vec.Readonly {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + 0.5 * b.h };
      });
    },
    top(this: { value: Box }): Vec.Readonly {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y };
      });
    },
    bottom(this: { value: Box }): Vec.Readonly {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + b.h };
      });
    },
    left(this: { value: Box }): Vec.Readonly {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x, y: b.y + 0.5 * b.h };
      });
    },
    right(this: { value: Box }): Vec.Readonly {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + b.w, y: b.y + 0.5 * b.h };
      });
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Box {
  /** Writable reactive Box. */
  export type Writable = WriteOf<typeof Box>;
  /** Read-only reactive Box. */
  export type Readonly = ReadOf<typeof Box>;
  /** Anything with a `Box`-shaped surface — reactive Box cells, plus
   *  Shape / Part (which carry a `box` field). The full structural
   *  shape is `BoxLike` below; `Box.Like` is the union of cell flavors. */
  export type Like = Writable | Readonly;
}

/** Reactive parametric anchor on a Box — sugar over `box.at(u, v)`. */
export const boxAt = (
  b: { at: (u: number, v: number) => Vec.Like },
  u: number,
  v: number,
) => b.at(u, v);

// ── BoxLike — structural surface ───────────────────────────────────
//
// Implemented by `Shape`, `Part`, and any reactive `Box` from this
// module. Consumers take `BoxLike` and don't care which.

/** Reactive rectangular region with cardinals + `at(u, v)`. */
export interface BoxLike {
  /** Source-of-truth Box signal; everything else derives from it. For
   *  `Reactive<Box>`, `box === box.box` (self-reference). */
  readonly box: ReadonlyCell<Box>;

  readonly x: ReadonlyCell<number>;
  readonly y: ReadonlyCell<number>;
  readonly w: ReadonlyCell<number>;
  readonly h: ReadonlyCell<number>;

  readonly center: Vec.Like;
  readonly top: Vec.Like;
  readonly bottom: Vec.Like;
  readonly left: Vec.Like;
  readonly right: Vec.Like;

  /** Reactive Vec at `(u, v)`: `(0, 0)` is top-left, `(1, 1)` bottom-right. */
  at(u: number, v: number): Vec.Like;
}

/** Detect a `BoxLike` value structurally — anything with `box` and `at`.
 *  Matches `Reactive<Box>`, `Shape`, `Part`, splits/grids, etc. */
export function isBox(v: unknown): v is BoxLike {
  return (
    typeof v === "object" &&
    v !== null &&
    "box" in v &&
    typeof (v as { at?: unknown }).at === "function"
  );
}

