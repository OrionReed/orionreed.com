// Box ported to the cell primitive. Validates that the lazy-getter
// pattern (center / top / bottom / left / right / at) ports cleanly
// — these are the most "framework-y" parts of the current Box, so if
// they work here, the whole framework works.

import { computed, type ReadonlySignal } from "../../core/signal";
import {
  axes,
  construct,
  defineCell,
  lazies,
  lift,
  liftScalar,
  withAlgebra,
} from "./cell";
import { Vec, type V } from "./vec";

export type Box = { x: number; y: number; w: number; h: number };

let BoxRef: { derived: (fn: () => Box) => unknown };
const mkDerived = (fn: () => Box): unknown => BoxRef.derived(fn);

const BoxMethods = {
  ...withAlgebra<Box>({
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
    lerp: (a, b: Box, t: number): Box => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      w: a.w + (b.w - a.w) * t,
      h: a.h + (b.h - a.h) * t,
    }),
  }),

  expand: lift<Box>(
    (b, n: number): Box => ({
      x: b.x - n,
      y: b.y - n,
      w: b.w + 2 * n,
      h: b.h + 2 * n,
    }),
    mkDerived,
  ),
  union: lift<Box>((a, b: Box): Box => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.max(a.x + a.w, b.x + b.w) - x;
    const h = Math.max(a.y + a.h, b.y + b.h) - y;
    return { x, y, w, h };
  }, mkDerived),

  contains: liftScalar<Box, boolean>(
    (a, p: V): boolean =>
      p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h,
  ),
};

const BoxDescriptors = {
  // 4-arity axes — `construct` provides the unrolled writer for arity 4.
  ...axes<Box, "x" | "y" | "w" | "h">(
    ["x", "y", "w", "h"],
    construct(
      (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h }),
    ),
  ),
  ...lazies({
    area(this: { value: Box }): ReadonlySignal<number> {
      const self = this;
      return computed(() => self.value.w * self.value.h);
    },
    aabb(this: any) {
      return this;
    },
    at(this: { value: Box }) {
      const self = this;
      return (u: number, v: number) =>
        Vec.derived(() => {
          const b = self.value;
          return { x: b.x + u * b.w, y: b.y + v * b.h };
        });
    },
    center(this: { value: Box }) {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + 0.5 * b.h };
      });
    },
    top(this: { value: Box }) {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y };
      });
    },
    bottom(this: { value: Box }) {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + 0.5 * b.w, y: b.y + b.h };
      });
    },
    left(this: { value: Box }) {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x, y: b.y + 0.5 * b.h };
      });
    },
    right(this: { value: Box }) {
      const self = this;
      return Vec.derived(() => {
        const b = self.value;
        return { x: b.x + b.w, y: b.y + 0.5 * b.h };
      });
    },
  }),
};

export const Box = defineCell<Box, typeof BoxMethods>(
  "Box",
  BoxMethods,
  BoxDescriptors,
  { equals: (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h },
);
BoxRef = Box as unknown as { derived: (fn: () => Box) => unknown };

export const aabb = (x: number, y: number, w: number, h: number) =>
  Box.signal({ x, y, w, h });
