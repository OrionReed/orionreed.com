// Box on the new struct Builder.

import { computed, type ReadonlySignal } from "../../core/signal";
import { struct } from "./struct";
import { Vec, type V } from "./vec";

export type Box = { x: number; y: number; w: number; h: number };

export const Box = struct<Box>("Box", { x: 0, y: 0, w: 0, h: 0 })
  .construct((x: number, y: number, w: number, h: number): Box => ({ x, y, w, h }))
  .equals((a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
  .ops({
    expand: (b, n: number): Box => ({
      x: b.x - n,
      y: b.y - n,
      w: b.w + 2 * n,
      h: b.h + 2 * n,
    }),
    union: (a, b: Box): Box => {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.max(a.x + a.w, b.x + b.w) - x;
      const h = Math.max(a.y + a.h, b.y + b.h) - y;
      return { x, y, w, h };
    },
    lerp: (a, b: Box, t: number): Box => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      w: a.w + (b.w - a.w) * t,
      h: a.h + (b.h - a.h) * t,
    }),
  })
  .scalars({
    contains: (a, p: V): boolean =>
      p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h,
  })
  .getters({
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
  })
  .build();
