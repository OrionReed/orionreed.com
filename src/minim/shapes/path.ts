import {
  Shape,
  Point,
  aabb,
  computed,
  toSig,
  type Segment,
  type Arg,
  type ReadonlySignal,
} from "../core";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface PathOpts extends CommonOpts {
  closed?: boolean;
}

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;

/** Pure-geometry sampling over a polyline of reactive Points. Reused
 *  by both Path and PathBuilder so the latter can compute geometry
 *  without materializing a Shape. Sampling is by normalized fraction
 *  (`at(t)`, `t ∈ [0,1]`) or by arc-length distance (`atDistance(d)`). */
function sampler(points: readonly Point[]) {
  const cumLen = computed(() => {
    const lens = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].value;
      const b = points[i].value;
      lens.push(lens[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    return lens;
  });

  /** Locate by absolute arc-length `d` (px), clamped to [0, total]. */
  const locateAt = (d: number): { i: number; segT: number } => {
    const lens = cumLen.value;
    const total = lens[lens.length - 1] ?? 0;
    if (points.length < 2 || total === 0) return { i: 0, segT: 0 };
    const target = d < 0 ? 0 : d > total ? total : d;
    let i = 1;
    while (i < lens.length - 1 && lens[i] < target) i++;
    const segLen = lens[i] - lens[i - 1];
    const segT = segLen > 0 ? (target - lens[i - 1]) / segLen : 0;
    return { i: i - 1, segT };
  };

  const length = () =>
    computed(() => {
      const lens = cumLen.value;
      return lens[lens.length - 1] ?? 0;
    });

  const sample = (d: ReturnType<typeof toSig<number>>) =>
    computed(() => {
      if (points.length === 0) return { x: 0, y: 0 };
      if (points.length === 1) return points[0].value;
      const { i, segT } = locateAt(d.value);
      const a = points[i].value;
      const b = points[i + 1].value;
      return { x: a.x + (b.x - a.x) * segT, y: a.y + (b.y - a.y) * segT };
    });

  const at = (t: Arg<number>): Point => {
    if (typeof t === "number" && points.length > 0) {
      if (t === 0) return points[0];
      if (t === 1) return points[points.length - 1];
    }
    const ts = toSig(t);
    const total = cumLen;
    const ds = computed(
      () => clamp01(ts.value) * (total.value[total.value.length - 1] ?? 0),
    );
    const s = sample(ds);
    return new Point(
      computed(() => s.value.x),
      computed(() => s.value.y),
    );
  };

  /** Sample at absolute arc-length distance (px from start). */
  const atDistance = (d: Arg<number>): Point => {
    const ds = toSig(d);
    const s = sample(ds);
    return new Point(
      computed(() => s.value.x),
      computed(() => s.value.y),
    );
  };

  const tangentAt = (t: Arg<number>): Point => {
    const ts = toSig(t);
    const tangent = computed(() => {
      if (points.length < 2) return { x: 1, y: 0 };
      const total = cumLen.value[cumLen.value.length - 1] ?? 0;
      const { i } = locateAt(clamp01(ts.value) * total);
      const a = points[i].value;
      const b = points[i + 1].value;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: dx / len, y: dy / len };
    });
    return new Point(
      computed(() => tangent.value.x),
      computed(() => tangent.value.y),
    );
  };

  const normalAt = (t: Arg<number>): Point => tangentAt(t).perp();

  const angleAt = (t: Arg<number>): ReadonlySignal<number> => {
    const tan = tangentAt(t);
    return computed(() => Math.atan2(tan.y.value, tan.x.value));
  };

  return { length, at, atDistance, tangentAt, normalAt, angleAt };
}

/** Open or closed polyline through a list of reactive Points.
 *
 *   new Path([p1, p2, p3], opts?)         — explicit
 *   new Path(builder, opts?)              — from fluent builder
 *   path(start).up(8).along(angle, 14)    — fluent (returns builder)
 *
 *  Reactive sampling: `at(t)`, `atDistance(d)`, `tangentAt(t)`,
 *  `normalAt(t)`, `angleAt(t)`, `length()`. */
export class Path<O extends PathOpts = PathOpts> extends Shape<O> {
  readonly points: readonly Point[];
  readonly closed: boolean;

  readonly length: () => ReadonlySignal<number>;
  readonly at: (t: Arg<number>) => Point;
  readonly atDistance: (d: Arg<number>) => Point;
  readonly tangentAt: (t: Arg<number>) => Point;
  readonly normalAt: (t: Arg<number>) => Point;
  readonly angleAt: (t: Arg<number>) => ReadonlySignal<number>;

  constructor(arg: readonly Point[] | PathBuilder, opts: O = {} as O) {
    const points = arg instanceof PathBuilder ? arg.points : arg;
    const closed = opts.closed ?? false;

    super(
      "path",
      () => {
        if (points.length === 0) return aabb(0, 0, 0, 0);
        let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
        for (const p of points) {
          const v = p.value;
          if (v.x < xMin) xMin = v.x;
          if (v.y < yMin) yMin = v.y;
          if (v.x > xMax) xMax = v.x;
          if (v.y > yMax) yMax = v.y;
        }
        return aabb(xMin, yMin, xMax - xMin, yMax - yMin);
      },
      opts,
      {
        // First vertex — consistent with `path.at(0)`. Authors with a
        // richer "path center" can override.
        origin: () =>
          points.length > 0 ? points[0].value : { x: 0, y: 0 },
      },
    );

    this.points = points;
    this.closed = closed;
    const s = sampler(points);
    this.length = s.length;
    this.at = s.at;
    this.atDistance = s.atDistance;
    this.tangentAt = s.tangentAt;
    this.normalAt = s.normalAt;
    this.angleAt = s.angleAt;

    // Dashed paths get their `d` from `setupDashed` instead.
    if (!opts.dashed) {
      this.attr(
        "d",
        computed(() => {
          if (points.length === 0) return "";
          const parts: string[] = [`M ${points[0].x.value} ${points[0].y.value}`];
          for (let i = 1; i < points.length; i++) {
            parts.push(`L ${points[i].x.value} ${points[i].y.value}`);
          }
          if (closed) parts.push("Z");
          return parts.join(" ");
        }),
      );
    }
    setupDashed(this, opts, closed);
    applyOpts(this, opts);
  }

  override segments(): Segment[] {
    const segs: Segment[] = [];
    for (let i = 0; i < this.points.length - 1; i++) {
      segs.push({ type: "line", from: this.points[i], to: this.points[i + 1] });
    }
    if (this.closed && this.points.length > 1) {
      segs.push({
        type: "line",
        from: this.points[this.points.length - 1],
        to: this.points[0],
      });
    }
    return segs;
  }
}

/** Fluent path-data builder. Pure values; pass to `new Path(b)` to
 *  materialize, or sample geometry directly via its methods. */
export class PathBuilder {
  readonly length: () => ReadonlySignal<number>;
  readonly at: (t: Arg<number>) => Point;
  readonly atDistance: (d: Arg<number>) => Point;
  readonly tangentAt: (t: Arg<number>) => Point;
  readonly normalAt: (t: Arg<number>) => Point;
  readonly angleAt: (t: Arg<number>) => ReadonlySignal<number>;

  constructor(readonly points: readonly Point[]) {
    const s = sampler(points);
    this.length = s.length;
    this.at = s.at;
    this.atDistance = s.atDistance;
    this.tangentAt = s.tangentAt;
    this.normalAt = s.normalAt;
    this.angleAt = s.angleAt;
  }

  private extend(p: Point): PathBuilder {
    return new PathBuilder([...this.points, p]);
  }

  private get last(): Point {
    return this.points[this.points.length - 1];
  }

  up(n: Arg<number>): PathBuilder {
    return this.extend(this.last.up(n));
  }
  down(n: Arg<number>): PathBuilder {
    return this.extend(this.last.down(n));
  }
  left(n: Arg<number>): PathBuilder {
    return this.extend(this.last.left(n));
  }
  right(n: Arg<number>): PathBuilder {
    return this.extend(this.last.right(n));
  }
  offset(dx: Arg<number>, dy: Arg<number>): PathBuilder {
    return this.extend(this.last.offset(dx, dy));
  }
  /** Walk `dist` at `angle` (radians, y-down). */
  along(angle: Arg<number>, dist: Arg<number>): PathBuilder {
    const a = toSig(angle);
    const d = toSig(dist);
    return this.extend(
      this.last.offset(
        computed(() => Math.cos(a.value) * d.value),
        computed(() => Math.sin(a.value) * d.value),
      ),
    );
  }
  to(p: Point): PathBuilder {
    return this.extend(p);
  }
}

/** Start a fluent path at `start`. */
export const path = (start: Point): PathBuilder => new PathBuilder([start]);
