// Reactive 2D point. `pt(x, y)` returns a writable `Point` for
// concrete-number args; reactive inputs produce a read-only
// `DerivedPoint`. Both pass anywhere `Signal<Vec>` is expected. Math
// methods always return `DerivedPoint`.

import {
  Signal,
  Computed,
  computed,
  lens,
  type ReadonlySignal,
} from "../core/signal";
import { toSig, type Arg } from "../core/arg";
import type { Vec } from "../core/vec";

/** Structural equality for `Vec` — suppresses no-op writes from fresh
 *  literals with the same components. */
export const vecEquals = (a: Vec, b: Vec): boolean =>
  a === b || (a.x === b.x && a.y === b.y);

// ── Type surface ────────────────────────────────────────────────────

/** Math methods shared by both Point flavors. Results are always
 *  read-only — math never produces writable points. */
interface PointMath {
  add(p: Pointlike): DerivedPoint;
  sub(p: Pointlike): DerivedPoint;
  scale(k: Arg<number>): DerivedPoint;
  perp(): DerivedPoint;
  normalize(): DerivedPoint;
  lerp(b: Pointlike, t: Arg<number>): DerivedPoint;
  offset(dx: Arg<number>, dy: Arg<number>): DerivedPoint;
  up(n: Arg<number>): DerivedPoint;
  down(n: Arg<number>): DerivedPoint;
  left(n: Arg<number>): DerivedPoint;
  right(n: Arg<number>): DerivedPoint;
  length(): ReadonlySignal<number>;
  distance(b: Pointlike): ReadonlySignal<number>;
}

/** Writable Point. `.value`, `.x`, and `.y` are all writable (axes are
 *  lens-backed); writes to an axis update the parent atomically. */
declare class Point {
  constructor(initial: Vec);
  /** Wrap an existing `Signal<Vec>` (e.g. a lens aggregate) as a Point. */
  static from(source: Signal<Vec>): Point;
  static polar(c: Pointlike, r: Arg<number>, angle: Arg<number>): DerivedPoint;
}
interface Point extends Signal<Vec>, PointMath {
  readonly x: Signal<number>;
  readonly y: Signal<number>;
}

/** Read-only derived Point. The runtime prototype chains through
 *  `Computed` (so `instanceof Signal` is true), but the TS surface
 *  deliberately excludes `Signal` — inheriting `.to` would compile
 *  fine but throw at runtime. */
declare class DerivedPoint {
  constructor(getter: () => Vec);
}
interface DerivedPoint extends ReadonlySignal<Vec>, PointMath {
  readonly x: ReadonlySignal<number>;
  readonly y: ReadonlySignal<number>;
}

/** Either flavor — used in signatures that take any Point. */
export type Pointlike = Point | DerivedPoint;

export const isPoint = (v: unknown): v is Pointlike =>
  v instanceof Point || v instanceof DerivedPoint;

// `ResolveVec` mirrors `ResolveSig` but resolves to the richer
// Point/DerivedPoint types so `.x`/`.y` axis access survives.
type IsAny<A> = 0 extends 1 & A ? true : false;
export type ResolveVec<A> = IsAny<A> extends true
  ? Pointlike
  : [A] extends [Point]
    ? Point
    : [A] extends [DerivedPoint | Signal<Vec> | ReadonlySignal<Vec> | (() => Vec)]
      ? DerivedPoint
      : Point;

// ── Implementation ──────────────────────────────────────────────────

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

/** Wrap an existing `Signal<Vec>` (typically a lens aggregate) as a
 *  Point with writable `.x`/`.y` and math methods. Used by `centroid`
 *  and friends; rarely called directly. */
(Point as unknown as { from(source: Signal<Vec>): Point }).from = function (
  source,
) {
  const p = Object.create(Point.prototype) as Point;
  // Delegate to the source — no independent state on `p`, no
  // `Signal.call` here.
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
  // Chains through Computed at runtime for dep-tracking and the
  // `instanceof Signal` check; the type-surface gap is intentional.
  Computed.call(this as unknown as Computed<Vec>, getter, { equals: vecEquals });
  const self = this as DerivedPoint & {
    x: ReadonlySignal<number>;
    y: ReadonlySignal<number>;
  };
  self.x = computed(() => this.value.x);
  self.y = computed(() => this.value.y);
}
DerivedPoint.prototype = Object.create(Computed.prototype);

// Shared methods on both prototypes; results are fresh DerivedPoints
// reading inputs lazily.
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
};

Object.assign(Point.prototype, PointMethods);
Object.assign(DerivedPoint.prototype, PointMethods);

/** Derived Point at radius `r` and angle `θ` (radians, y-down) from `c`. */
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

/** Construct a Point. Two numbers → writable `Point`; any reactive
 *  input → derived. */
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

/** Normalize a Vec-style arg into a Point. Used by `Shape` so every
 *  transform field gains per-axis tweens (`s.translate.x.to(...)`).
 *  Literal/undefined → writable; Signal/thunk → derived; Pointlike
 *  passes through. */
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
  const v = arg as Vec;
  return new Point({ x: v.x, y: v.y });
}
