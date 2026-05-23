// box.ts — reactive axis-aligned rectangle.
//
// Invertibles (`add`, `sub`, `scale`, `expand`) return `: this` and
// ride on `Signal#through(fwd, bwd)`. Chained calls auto-fuse.

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { bind } from "../lateral";
import {
  computed,
  lazy,
  type Of,
  Signal,
  type SignalOptions,
  type Val,
  valFn,
  value,
} from "../signal";
import { type Linear, type Pack, traits } from "../traits";
import { derived, field, type Wr, type Writable } from "../writable";
import { Num } from "./num";
import { Vec } from "./vec";

type V = { x: number; y: number; w: number; h: number };

export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, w: a.w + b.w, h: a.h + b.h });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, w: a.w - b.w, h: a.h - b.h });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k, w: a.w * k, h: a.h * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});
export const equals = (a: V, b: V) =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
export const expand = (b: V, n: number): V => ({
  x: b.x - n,
  y: b.y - n,
  w: b.w + 2 * n,
  h: b.h + 2 * n,
});
export const contains = (b: V, p: Of<Vec>): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** Bounding box around a set of boxes. */
export function union(...bs: V[]): V {
  if (bs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let xMin = bs[0].x,
    yMin = bs[0].y;
  let xMax = xMin + bs[0].w,
    yMax = yMin + bs[0].h;
  for (let i = 1; i < bs.length; i++) {
    const o = bs[i];
    if (o.x < xMin) xMin = o.x;
    if (o.y < yMin) yMin = o.y;
    if (o.x + o.w > xMax) xMax = o.x + o.w;
    if (o.y + o.h > yMax) yMax = o.y + o.h;
  }
  return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };
}

/** Perimeter point on a Box facing `toward`. Used by default
 *  `Shape.boundary`. */
export function edgeFrom(b: V, toward: Of<Vec>): Of<Vec> {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min(
    dx === 0 ? Infinity : b.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : b.h / 2 / Math.abs(dy),
  );
  return { x: cx + dx * k, y: cy + dy * k };
}

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 4,
  read: (v, a, o) => {
    a[o] = v.x;
    a[o + 1] = v.y;
    a[o + 2] = v.w;
    a[o + 3] = v.h;
  },
  write: (a, o) => ({ x: a[o]!, y: a[o + 1]!, w: a[o + 2]!, h: a[o + 3]! }),
};

export class Box extends Signal<V> {
  static traits = traits<V>()({ linear: linearImpl, lerp, equals, pack: packImpl });

  /** Phantom registry brand — `Writable<Box>` resolves to `Wr<Box>`. */
  declare readonly _writable: Wr<Box>;

  constructor(v: V = { x: 0, y: 0, w: 0, h: 0 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(
      v => add(v, bf()),
      n => sub(n, bf()),
    );
  }
  sub(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(
      v => sub(v, bf()),
      n => add(n, bf()),
    );
  }
  scale(k: Val<number>): this {
    const kf = valFn(k);
    return this.through(
      v => scale(v, kf()),
      n => scale(n, 1 / kf()),
    );
  }
  expand(n: Val<number>): this {
    const nf = valFn(n);
    return this.through(
      v => expand(v, nf()),
      o => expand(o, -nf()),
    );
  }

  lerp(b: Val<V>, t: Val<number>): Box {
    return Box.derive(() => lerp(this.value, value(b), value(t)));
  }
  contains(p: Val<Of<Vec>>): Signal<boolean> {
    return computed(() => contains(this.value, value(p)));
  }

  // ── field lenses & derived views ──────────────────────────────────
  get x() {
    return field(this, "x", Num);
  }
  get y() {
    return field(this, "y", Num);
  }
  get w() {
    return field(this, "w", Num);
  }
  get h() {
    return field(this, "h", Num);
  }
  get area() {
    return derived(this, "area", Num, b => b.w * b.h);
  }

  /** Vec at parametric (u, v) within `[0,1]²`. Not memoised — arbitrary
   *  (u, v) calls otherwise leak a cache entry per pair. Use the named
   *  edge getters (`.center`, `.top`, …) when you want stable identity. */
  at(u: number, v: number): Vec {
    return this.deriveTo(Vec, b => ({ x: b.x + u * b.w, y: b.y + v * b.h }));
  }
  // Named edges — derived RO views over `at(u, v)`. Memoised under
  // stable keys for identity (effects subscribing to `b.center` should
  // always see the same Vec). `lazy()` directly because `at()` already
  // returns a Vec — no need to `derived(this, …, Vec, fn)` again.
  get center(): Vec {
    return lazy(this, "center", () => this.at(0.5, 0.5));
  }
  get top(): Vec {
    return lazy(this, "top", () => this.at(0.5, 0));
  }
  get bottom(): Vec {
    return lazy(this, "bottom", () => this.at(0.5, 1));
  }
  get left(): Vec {
    return lazy(this, "left", () => this.at(0, 0.5));
  }
  get right(): Vec {
    return lazy(this, "right", () => this.at(1, 0.5));
  }

  /** Tween-builder, implied by the lerp trait. */
  to(this: Writable<Box>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}
export interface Box {
  readonly constructor: typeof Box;
  get value(): V;
}

export function box(
  x: Val<number> = 0,
  y: Val<number> = 0,
  w: Val<number> = 0,
  h: Val<number> = 0,
): Writable<Box> {
  const b = new Box() as Writable<Box>;
  bind(b.x, x);
  bind(b.y, y);
  bind(b.w, w);
  bind(b.h, h);
  return b;
}
