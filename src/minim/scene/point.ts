// Reactive 2D point. `pt(x, y)` returns a writable `Point` (extends
// `Signal<Vec>`) when both args are concrete numbers; otherwise returns
// a derived `DerivedPoint` (a `ReadonlySignal<Vec>`) whose value follows
// the inputs. Both pass anywhere `Signal<Vec>` / `ReadonlySignal<Vec>`
// is expected (`shape.translate`, etc.). Math methods (`add`, `lerp`,
// `polar`, …) always produce `DerivedPoint` — read-only by design.

import {
  Signal,
  Computed,
  computed,
  lens,
  type ReadonlySignal,
} from "../core/signal";
import { toSig, type Arg } from "../core/arg";
import type { Vec } from "../core/vec";

/** Structural equality for `Vec` — suppresses no-op writes when a fresh
 *  Vec literal carries the same components as the previous value. */
export const vecEquals = (a: Vec, b: Vec): boolean =>
  a === b || (a.x === b.x && a.y === b.y);

// ── Type surface ────────────────────────────────────────────────────

/** Methods shared by writable and derived Points. All return
 *  `DerivedPoint` (or a scalar `ReadonlySignal<number>`) — math results
 *  are never writable. Single source of truth for these signatures;
 *  the runtime trait is `PointMethods` below. */
interface PointMath {
  add(p: Pointlike): DerivedPoint;
  sub(p: Pointlike): DerivedPoint;
  scale(k: Arg<number>): DerivedPoint;
  perp(): DerivedPoint;
  normalize(): DerivedPoint;
  lerp(b: Pointlike, t: Arg<number>): DerivedPoint;
  midpoint(b: Pointlike): DerivedPoint;
  offset(dx: Arg<number>, dy: Arg<number>): DerivedPoint;
  up(n: Arg<number>): DerivedPoint;
  down(n: Arg<number>): DerivedPoint;
  left(n: Arg<number>): DerivedPoint;
  right(n: Arg<number>): DerivedPoint;
  length(): ReadonlySignal<number>;
  distance(b: Pointlike): ReadonlySignal<number>;
  dot(p: Pointlike): ReadonlySignal<number>;
}

/** Writable Point. Both `point.value` (the whole Vec) and `point.x` /
 *  `point.y` (each axis as a lens-backed signal) are writable; writes
 *  to an axis update the parent atomically. The class declaration
 *  carries only the constructor + statics; the merged `interface`
 *  brings in the Signal API and `PointMath`. */
declare class Point {
  constructor(initial: Vec);
  /** Wrap an existing `Signal<Vec>` (e.g. a `lens(...)` aggregate) as
   *  a Point with writable axis lenses + math methods. */
  static from(source: Signal<Vec>): Point;
  static polar(c: Pointlike, r: Arg<number>, angle: Arg<number>): DerivedPoint;
}
interface Point extends Signal<Vec>, PointMath {
  readonly x: Signal<number>;
  readonly y: Signal<number>;
}

/** Read-only derived Point. Implements `ReadonlySignal<Vec>` — pass
 *  anywhere a readable Vec signal is expected. Deliberately does NOT
 *  extend `Signal`/`Computed` at the type level: that would inherit the
 *  `.to` tween shortcut, which would compile fine but throw at runtime
 *  (writing through a Computed's value setter is forbidden). The
 *  prototype chain still goes through Computed at runtime —
 *  `instanceof Signal` is true — but the type surface is read-only. */
declare class DerivedPoint {
  constructor(getter: () => Vec);
}
interface DerivedPoint extends ReadonlySignal<Vec>, PointMath {
  readonly x: ReadonlySignal<number>;
  readonly y: ReadonlySignal<number>;
}

/** Either a writable or derived Point — used in signatures that accept
 *  any kind of point. */
export type Pointlike = Point | DerivedPoint;

/** Runtime check: is `v` a Point of either flavor? */
export const isPoint = (v: unknown): v is Pointlike =>
  v instanceof Point || v instanceof DerivedPoint;

// `ResolveVec` mirrors `ResolveSig` for Vec-typed shape props, but
// resolves to the richer `Point` / `DerivedPoint` types so consumers
// keep `.x` / `.y` axis access (and lens-driven writability where
// applicable) at the field level.
type IsAny<A> = 0 extends 1 & A ? true : false;
export type ResolveVec<A> = IsAny<A> extends true
  ? Pointlike
  : [A] extends [Point]
    ? Point
    : [A] extends [DerivedPoint | Signal<Vec> | ReadonlySignal<Vec> | (() => Vec)]
      ? DerivedPoint
      : Point;

// ── Implementation ──────────────────────────────────────────────────

/** Build the two writable axis lenses on a Point — common between
 *  the literal-initial constructor and `Point.from(source)`. */
function attachAxes(p: Point, source: Signal<Vec>): void {
  const self = p as Point & { x: Signal<number>; y: Signal<number> };
  self.x = lens(
    () => source.value.x,
    (n) => {
      source.value = { x: n, y: source.peek().y };
    },
  );
  self.y = lens(
    () => source.value.y,
    (n) => {
      source.value = { x: source.peek().x, y: n };
    },
  );
}

// @ts-ignore: "Cannot redeclare exported variable 'Point'."
function Point(this: Point, initial: Vec) {
  Signal.call(this, initial, { equals: vecEquals });
  attachAxes(this, this);
}
Point.prototype = Object.create(Signal.prototype);

/** Wrap an existing `Signal<Vec>` (typically a `lens(...)` aggregate)
 *  as a Point — adds writable axis lenses (`.x` / `.y`) and the math
 *  methods, while delegating `value` / `peek` / `subscribe` to the
 *  source. Used by `centroid(...)` and friends; users rarely call
 *  this directly. The result is `instanceof Point` (and `Signal`) so
 *  it threads through every API that accepts `Pointlike`. */
(Point as unknown as { from(source: Signal<Vec>): Point }).from = function (
  source,
) {
  const p = Object.create(Point.prototype) as Point;
  // Delegate `value` to the source — picks up source's tracking, no
  // independent state on `p` (we never call Signal.call here).
  Object.defineProperty(p, "value", {
    get() {
      return source.value;
    },
    set(v: Vec) {
      source.value = v;
    },
  });
  (p as { peek: () => Vec; subscribe: typeof source.subscribe }).peek = () =>
    source.peek();
  (p as { peek: () => Vec; subscribe: typeof source.subscribe }).subscribe =
    source.subscribe.bind(source);
  attachAxes(p, source);
  return p;
};

// @ts-ignore: "Cannot redeclare exported variable 'DerivedPoint'."
function DerivedPoint(this: DerivedPoint, getter: () => Vec) {
  // Runtime: chains through Computed.prototype so `instanceof Signal`
  // works and dep tracking is inherited. Cast bypasses the typed
  // class boundary (DerivedPoint deliberately isn't typed as Computed
  // — see the declaration for why).
  Computed.call(this as unknown as Computed<Vec>, getter, { equals: vecEquals });
  const self = this as DerivedPoint & {
    x: ReadonlySignal<number>;
    y: ReadonlySignal<number>;
  };
  self.x = computed(() => this.value.x);
  self.y = computed(() => this.value.y);
}
DerivedPoint.prototype = Object.create(Computed.prototype);

// Shared math methods — assigned to both prototypes. Each returns a
// fresh `DerivedPoint` reading from inputs lazily.
const PointMethods: ThisType<Pointlike> & PointMath = {
  add(p) {
    return new DerivedPoint(() => ({
      x: this.value.x + p.value.x,
      y: this.value.y + p.value.y,
    }));
  },
  sub(p) {
    return new DerivedPoint(() => ({
      x: this.value.x - p.value.x,
      y: this.value.y - p.value.y,
    }));
  },
  scale(k) {
    const ks = toSig(k);
    return new DerivedPoint(() => {
      const v = this.value;
      const s = ks.value;
      return { x: v.x * s, y: v.y * s };
    });
  },
  /** 90° rotation in y-down screen coords: `(x, y) → (-y, x)`. */
  perp() {
    return new DerivedPoint(() => {
      const v = this.value;
      return { x: -v.y, y: v.x };
    });
  },
  normalize() {
    return new DerivedPoint(() => {
      const v = this.value;
      const len = Math.hypot(v.x, v.y) || 1;
      return { x: v.x / len, y: v.y / len };
    });
  },
  /** Linear interpolation; `t=0` → this, `t=1` → `b`. */
  lerp(b, t) {
    const ts = toSig(t);
    return new DerivedPoint(() => {
      const a = this.value;
      const bv = b.value;
      const u = ts.value;
      return { x: a.x + (bv.x - a.x) * u, y: a.y + (bv.y - a.y) * u };
    });
  },
  midpoint(b) {
    return new DerivedPoint(() => {
      const a = this.value;
      const bv = b.value;
      return { x: (a.x + bv.x) / 2, y: (a.y + bv.y) / 2 };
    });
  },
  offset(dx, dy) {
    const dxs = toSig(dx);
    const dys = toSig(dy);
    return new DerivedPoint(() => {
      const v = this.value;
      return { x: v.x + dxs.value, y: v.y + dys.value };
    });
  },
  up(n) {
    const ns = toSig(n);
    return new DerivedPoint(() => {
      const v = this.value;
      return { x: v.x, y: v.y - ns.value };
    });
  },
  down(n) {
    const ns = toSig(n);
    return new DerivedPoint(() => {
      const v = this.value;
      return { x: v.x, y: v.y + ns.value };
    });
  },
  left(n) {
    const ns = toSig(n);
    return new DerivedPoint(() => {
      const v = this.value;
      return { x: v.x - ns.value, y: v.y };
    });
  },
  right(n) {
    const ns = toSig(n);
    return new DerivedPoint(() => {
      const v = this.value;
      return { x: v.x + ns.value, y: v.y };
    });
  },
  length() {
    return computed(() => Math.hypot(this.value.x, this.value.y));
  },
  distance(b) {
    return computed(() =>
      Math.hypot(this.value.x - b.value.x, this.value.y - b.value.y),
    );
  },
  dot(p) {
    return computed(
      () => this.value.x * p.value.x + this.value.y * p.value.y,
    );
  },
};

Object.assign(Point.prototype, PointMethods);
Object.assign(DerivedPoint.prototype, PointMethods);

// `Point.polar` — static helper. Returns a derived Point at radius `r`
// and angle `θ` (radians, y-down) from `c`.
(Point as unknown as {
  polar(c: Pointlike, r: Arg<number>, angle: Arg<number>): DerivedPoint;
}).polar = function (c, r, angle) {
  const rs = toSig(r);
  const as = toSig(angle);
  return new DerivedPoint(() => {
    const cv = c.value;
    return {
      x: cv.x + rs.value * Math.cos(as.value),
      y: cv.y + rs.value * Math.sin(as.value),
    };
  });
};

export { Point, DerivedPoint };

// ── Factories ───────────────────────────────────────────────────────

/** Construct a Point. Both literal numbers → writable `Point`; any
 *  reactive input (signal/thunk) → derived Point that follows it. */
export function pt(x: number, y: number): Point;
export function pt(x: Arg<number>, y: Arg<number>): Pointlike;
export function pt(x: Arg<number>, y: Arg<number>): Pointlike {
  if (typeof x === "number" && typeof y === "number") {
    return new Point({ x, y });
  }
  const xs = toSig(x);
  const ys = toSig(y);
  return new DerivedPoint(() => ({ x: xs.value, y: ys.value }));
}

/** Normalize a `translate`/`scale`/`origin`-style argument into a
 *  Point. Used by `Shape` so every shape's transform fields are
 *  Points (gains per-axis tweens via `shape.translate.x.to(...)`).
 *  Plain Vec literals or `undefined` → fresh writable Point seeded
 *  with the value (or `fallback`). Existing Pointlike → passes
 *  through. Plain `Signal<Vec>` / thunk → wraps as DerivedPoint. */
export function toPoint(
  arg: Arg<Vec> | Pointlike | undefined,
  fallback: Vec,
): Pointlike {
  if (arg === undefined) return new Point({ ...fallback });
  if (arg instanceof Point || arg instanceof DerivedPoint) return arg;
  if (arg instanceof Signal) {
    const sig = arg as { readonly value: Vec };
    return new DerivedPoint(() => sig.value);
  }
  if (typeof arg === "function") return new DerivedPoint(arg as () => Vec);
  // Plain Vec literal — narrowed by elimination above.
  const v = arg as Vec;
  return new Point({ x: v.x, y: v.y });
}
