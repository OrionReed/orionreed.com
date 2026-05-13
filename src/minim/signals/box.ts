// Box — the reactive rectangular-region primitive (axis-aligned).
// Mirrors the Vec/V split: `Box` is the registered struct value
// (`Box.signal({...})`, `instanceof Box`, etc.), `B` is the plain
// `{x, y, w, h}` value type.
//
// Plain-value helpers (`box`, `expandBox`, `unionBox`, `boxEdgeFrom`)
// live alongside the struct so the struct's `expand` / `union` ops
// can reuse them — one source of truth, matching the matrix.ts
// pattern. The plain `box()` constructor is internal-only (not
// re-exported from `minim/index`) to avoid colliding with the
// `decorations.box(part)` shape factory.
//
// Cardinal anchors (`center`, `top`, `bottom`, `left`, `right`) are
// declared as **lazy property getters** via `.getters({...})`. Each
// is built on first access and cached as an own-property on the
// instance. Most consumers only touch one or two anchors per box —
// the rest never allocate.

import { struct } from "./struct";
import { Vec, type V, type Pointlike, type DerivedPoint } from "./vec";
import { transformBox, type M } from "./matrix";
import { computed, type ReadonlySignal } from "../core/signal";

/** Plain Box value — `{x, y, w, h}`. The struct's value type. The
 *  identifier `Box` is BOTH this type AND the registered struct value
 *  below — same trick a `class` uses by default (a class declaration
 *  introduces both a value and a type under one name). `B` is an alias
 *  for the value type, kept for symmetry with `V` (Vec) and `C`
 *  (Color). */
export type Box = { x: number; y: number; w: number; h: number };
export type B = Box;

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

export const Box = struct<Box>("Box", { x: 0, y: 0, w: 0, h: 0 })
  .construct(
    (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h }),
  )
  .equals((a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
  .ops({
    /** Component-wise add. Stamps `[ALGEBRA]` (with sub/scale below)
     *  so integrators (spring/oscillate/drift/attract) and aggregates
     *  (mean) work on `Reactive<Box>`. */
    add: (a, b: Box): Box => ({
      x: a.x + b.x,
      y: a.y + b.y,
      w: a.w + b.w,
      h: a.h + b.h,
    }),
    sub: (a, b: Box): Box => ({
      x: a.x - b.x,
      y: a.y - b.y,
      w: a.w - b.w,
      h: a.h - b.h,
    }),
    scale: (a, k: number): Box => ({
      x: a.x * k,
      y: a.y * k,
      w: a.w * k,
      h: a.h * k,
    }),
    expand: expandBox,
    union: (a, b: Box): Box => unionBox(a, b),
    /** Component-wise lerp; enables `.to(target, dur)` tween. */
    lerp: (a, b: Box, t: number): Box => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      w: a.w + (b.w - a.w) * t,
      h: a.h + (b.h - a.h) * t,
    }),
    /** This box in the frame `m`. Loose box around the four transformed
     *  corners. */
    in: (b: Box, m: M): Box => transformBox(m, b),
  })
  .scalars({
    contains: (a, p: V): boolean =>
      p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h,
  })
  .getters({
    /** Area of this box, reactive. Lazy + cached as own-property. */
    area(this: { value: Box }): ReadonlySignal<number> {
      const self = this;
      return computed(() => self.value.w * self.value.h);
    },
    /** Self-reference so `Reactive<Box>` values satisfy the
     *  `Boxlike` interface (which has `box: ReadonlySignal<Box>` so
     *  Shape/Part — who hold the Box as a *field* — and bare
     *  Reactive<Box> are interchangeable to consumers). The Reactive
     *  *is* its own Box signal — `b.box === b`. */
    box(this: any) {
      return this;
    },
    /** `at(u, v)` returns a reactive Point at normalized fraction
     *  `(0, 0)` (top-left) to `(1, 1)` (bottom-right). Implemented as
     *  a getter that returns a method-shaped closure, so it's
     *  available on every Reactive flavor (signal, derived, lens) —
     *  cardinals (`.center`, etc.) are sugar built on top. */
    at(this: { value: Box }) {
      const self = this;
      return (u: number, v: number): DerivedPoint =>
        Vec.derived(() => {
          const b = self.value;
          return { x: b.x + u * b.w, y: b.y + v * b.h };
        });
    },
    /** Centre point — `at(0.5, 0.5)`. Lazy: built on first access. */
    center(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + 0.5 * b.h };
      });
    },
    top(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y };
      });
    },
    bottom(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + b.h };
      });
    },
    left(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x, y: b.y + 0.5 * b.h };
      });
    },
    right(this: { value: Box }): DerivedPoint {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + b.w, y: b.y + 0.5 * b.h };
      });
    },
  })
  .build();

/** Reactive parametric anchor on a Box — sugar over `box.at(u, v)`. */
export const boxAt = (
  b: { at: (u: number, v: number) => Pointlike },
  u: number,
  v: number,
) => b.at(u, v);

// ── Boxlike — structural surface ───────────────────────────────────
//
// Implemented by:
//
//   - Shape (class with a `.box` field + transform-aware anchors)
//   - Part  (class with a `.box` field; cardinals via `delegate`)
//   - any `Reactive<Box>` from this module (the framework's prototype
//     provides `.box` as a self-reference, plus the cardinals and
//     `.at(u, v)` via `.getters({...})`)
//
// All three types satisfy this interface structurally — consumers
// take `Boxlike` and don't care which one they got. (Mirrors how
// `Pointlike` unifies Vec.signal / Vec.derived / Vec.lens results.)

/** Reactive rectangular region. Anchor types are `Pointlike` so
 *  implementations can narrow: views, splits, parts return read-only
 *  `DerivedPoint`s; `Shape` returns writable `Point`s (lens-backed
 *  through `translate`). */
export interface Boxlike {
  /** Source-of-truth Box signal; everything else derives from it.
   *  For `Reactive<Box>` values from the framework, this is a
   *  self-reference (`box.box === box`); for `Shape`/`Part`, it's
   *  a real field. */
  readonly box: ReadonlySignal<Box>;

  readonly x: ReadonlySignal<number>;
  readonly y: ReadonlySignal<number>;
  readonly w: ReadonlySignal<number>;
  readonly h: ReadonlySignal<number>;

  readonly center: Pointlike;
  readonly top: Pointlike;
  readonly bottom: Pointlike;
  readonly left: Pointlike;
  readonly right: Pointlike;

  /** Reactive Point at normalized fraction `(u, v)`: `(0, 0)` is
   *  top-left, `(1, 1)` is bottom-right. Cardinals are sugar. */
  at(u: number, v: number): Pointlike;
}
