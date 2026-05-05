import { Shape } from "../shape";
import { Point } from "../point";
import { aabb } from "../bounds";
import { computed, toSig, type Arg, type ReadonlySignal } from "../signal";
import type { Segment } from "../dashed";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface PathOpts extends CommonOpts {
  closed?: boolean;
}

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;

/** Sampling primitives over a polyline of reactive Points. Pure geometry —
 *  no DOM, no Shape allocation — so PathBuilder can use the same code as
 *  Path without materializing one. Parameter `t` is arc-length fraction
 *  in [0, 1], so `at(0.5)` is the geometric midpoint. */
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

  // Locate the segment containing arc-length fraction t.
  const locate = (t: number): { i: number; segT: number } => {
    const lens = cumLen.value;
    const total = lens[lens.length - 1] ?? 0;
    if (points.length < 2 || total === 0) return { i: 0, segT: 0 };
    const target = clamp01(t) * total;
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

  const at = (t: Arg<number>): Point => {
    if (typeof t === "number" && points.length > 0) {
      if (t === 0) return points[0];
      if (t === 1) return points[points.length - 1];
    }
    const ts = toSig(t);
    const sample = computed(() => {
      if (points.length === 0) return { x: 0, y: 0 };
      if (points.length === 1) return points[0].value;
      const { i, segT } = locate(ts.value);
      const a = points[i].value;
      const b = points[i + 1].value;
      return { x: a.x + (b.x - a.x) * segT, y: a.y + (b.y - a.y) * segT };
    });
    return new Point(
      computed(() => sample.value.x),
      computed(() => sample.value.y),
    );
  };

  const tangentAt = (t: Arg<number>): Point => {
    const ts = toSig(t);
    const tangent = computed(() => {
      if (points.length < 2) return { x: 1, y: 0 };
      const { i } = locate(ts.value);
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

  return { length, at, tangentAt, normalAt, angleAt };
}

/**
 * Open or closed polyline through a list of reactive Points.
 *
 * Construction:
 *   - `new Path([p1, p2, p3], opts?)`        — explicit array
 *   - `new Path(builder, opts?)`             — from a fluent builder
 *   - `path(start).up(8).along(angle, 14)`   — fluent (returns builder)
 *
 * Sampling: `at(t)`, `tangentAt(t)`, `normalAt(t)`, `angleAt(t)`, `length()`
 * — all reactive, parameterized by arc-length fraction.
 */
export class Path extends Shape {
  readonly points: readonly Point[];
  readonly closed: boolean;

  readonly length: () => ReadonlySignal<number>;
  readonly at: (t: Arg<number>) => Point;
  readonly tangentAt: (t: Arg<number>) => Point;
  readonly normalAt: (t: Arg<number>) => Point;
  readonly angleAt: (t: Arg<number>) => ReadonlySignal<number>;

  constructor(arg: readonly Point[] | PathBuilder, opts: PathOpts = {}) {
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
    );

    this.points = points;
    this.closed = closed;
    const s = sampler(points);
    this.length = s.length;
    this.at = s.at;
    this.tangentAt = s.tangentAt;
    this.normalAt = s.normalAt;
    this.angleAt = s.angleAt;

    // Non-dashed: standard polyline `d`. Dashed: `setupDashed` binds `d`
    // to the segment-by-segment dashed path instead.
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

/** Fluent path-data builder. Pure values; no DOM. Pass to `new Path(b)`
 *  to materialize, or use the sampling methods directly to compute
 *  geometry without ever constructing a Path. */
export class PathBuilder {
  readonly length: () => ReadonlySignal<number>;
  readonly at: (t: Arg<number>) => Point;
  readonly tangentAt: (t: Arg<number>) => Point;
  readonly normalAt: (t: Arg<number>) => Point;
  readonly angleAt: (t: Arg<number>) => ReadonlySignal<number>;

  constructor(readonly points: readonly Point[]) {
    const s = sampler(points);
    this.length = s.length;
    this.at = s.at;
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
  /** Walk `dist` along direction `angle` (radians, y-down). */
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
