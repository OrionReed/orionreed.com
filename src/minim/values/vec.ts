// Vec — the reactive 2D point primitive.
//
// Consistent struct-naming pattern:
//
//   interface Vec        — plain JS shape ({ x, y })
//   const Vec            — the registered struct (same name as the type)
//   const vec(x, y)      — factory shorthand
//   Vec.Writable         — writable cell type        (was `Point`)
//   Vec.Readonly         — readonly cell type        (was `DerivedPoint`)
//   Vec.Like             — either flavor             (was `VecLike`)
//   Vec.Resolve<A>       — per-input narrowing       (was `ResolveVec<A>`)
//
// The interface + const + namespace declarations all merge under one
// name. Every value type in `values/` follows this exact pattern.

import {
  computed,
  defineStruct,
  effect,
  toSig,
  type Cell,
  type ReadonlyCell,
  type Val,
  type WriteOf,
  type ReadOf,
} from "@minim/signals";
import { Num } from "./num";
import type { Matrix2D } from "./matrix";

/** Plain 2D point shape. The `Vec` const struct wraps this in a
 *  reactive cell; the `Vec.Writable` / `Vec.Readonly` types name the
 *  cell flavors. */
export interface Vec {
  x: number;
  y: number;
}

export const Vec = defineStruct({
  name: "Vec",
  defaults: { x: 0, y: 0 } as Vec,
  construct: (x: number, y: number): Vec => ({ x, y }),
  equals: (a, b) => a.x === b.x && a.y === b.y,
  // `.x` and `.y` become `Num.signal`s (per-axis SoA), so per-axis
  // tweens (`pos.x.to(100, 0.5)`) work via the Num-installed `.to`.
  nested: { x: Num, y: Num },
  // ── Capabilities ────────────────────────────────────────────────
  algebra: {
    add:   (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, k) => ({ x: a.x * k, y: a.y * k }),
  },
  lerp:   (a, b, t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }),
  metric: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  // ── Extra ops + getters + methods ──────────────────────────────
  ops: {
    perp:      (a): Vec => ({ x: -a.y, y: a.x }),
    normalize: (a): Vec => {
      const len = Math.hypot(a.x, a.y) || 1;
      return { x: a.x / len, y: a.y / len };
    },
    offset:    (a, dx: number, dy: number): Vec => ({ x: a.x + dx, y: a.y + dy }),
    up:        (a, n: number): Vec => ({ x: a.x, y: a.y - n }),
    down:      (a, n: number): Vec => ({ x: a.x, y: a.y + n }),
    left:      (a, n: number): Vec => ({ x: a.x - n, y: a.y }),
    right:     (a, n: number): Vec => ({ x: a.x + n, y: a.y }),
    /** This point in the frame `m`. */
    in: (p, m: Matrix2D): Vec => ({
      x: m.a * p.x + m.c * p.y + m.e,
      y: m.b * p.x + m.d * p.y + m.f,
    }),
  },
  getters: {
    /** Magnitude of this Vec. Lazy + cached as own-property; reads as
     *  a signal property (`v.length`), not a method call. */
    length(this: { value: Vec }): ReadonlyCell<number> {
      const self = this;
      return computed(() => Math.hypot(self.value.x, self.value.y));
    },
  },
  methods: {
    /** Copy `target.value` into this point — convenience over
     *  `this.value = target.value`. Returns `this` for chaining.
     *  Typed via the underlying `Cell<Vec>` to break a type-level
     *  cycle (`Vec.Writable` is defined in terms of `typeof Vec`). */
    set(this: Cell<Vec>, target: ReadonlyCell<Vec>) {
      this.value = target.value;
      return this;
    },
    /** Continuously mirror `target` into this point. Returns a
     *  disposer that stops the binding. */
    bind(this: Cell<Vec>, target: ReadonlyCell<Vec>) {
      const self = this;
      return effect(() => {
        self.value = target.value;
      });
    },
  },
});

type IsAny<A> = 0 extends 1 & A ? true : false;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Vec {
  /** Writable reactive Vec — `Vec.signal({...})` return type. */
  export type Writable = WriteOf<typeof Vec>;
  /** Read-only reactive Vec — `Vec.derived(...)` return type. */
  export type Readonly = ReadOf<typeof Vec>;
  /** Either flavor — writable or derived. */
  export type Like = Writable | Readonly;
  /** Resolve the right reactive Vec flavor based on input arg type.
   *  - `any`                       → `Like` (broad)
   *  - `Writable`                  → `Writable`
   *  - any other readable / thunk  → `Readonly`
   *  - literal `Vec` or anything   → `Writable` (fresh writable) */
  export type Resolve<A> = IsAny<A> extends true
    ? Like
    : [A] extends [Writable]
      ? Writable
      : [A] extends [ReadonlyCell<Vec> | (() => Vec)]
        ? Readonly
        : Writable;
}

/** Detect a Vec-shaped reactive at runtime. Sugar for `v instanceof Vec`. */
export const isVec = (v: unknown): v is Vec.Like => Vec.is(v);

/** Structural equality for plain Vec values (not reactives). */
export const vecEquals = (a: Vec, b: Vec): boolean =>
  a === b || (a.x === b.x && a.y === b.y);

/** Construct a reactive Vec. Two numbers → writable; any reactive input → derived. */
export function vec(x: number, y: number): Vec.Writable;
export function vec(x: Val<number>, y: Val<number>): Vec.Like;
export function vec(x: Val<number>, y: Val<number>): Vec.Like {
  if (typeof x === "number" && typeof y === "number") {
    return Vec.signal({ x, y });
  }
  const xs = toSig(x);
  const ys = toSig(y);
  return Vec.derived(() => ({ x: xs.value, y: ys.value }));
}

/** Derived Vec at radius `r` and angle `θ` (radians, y-down) from `c`. */
export const polar = (
  c: Vec.Like,
  r: Val<number>,
  angle: Val<number>,
): Vec.Readonly => {
  const rs = toSig(r);
  const as = toSig(angle);
  return Vec.derived(() => {
    const cv = c.value;
    return {
      x: cv.x + rs.value * Math.cos(as.value),
      y: cv.y + rs.value * Math.sin(as.value),
    };
  });
};
