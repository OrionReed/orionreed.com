import { Shape } from "../shape";
import { Point, pt } from "../point";
import { Heading } from "../heading";
import { aabb } from "../bounds";
import { read, type Arg } from "../signal";
import type { Segment } from "../dashed";
import { applyOpts, type CommonOpts } from "./common";

export interface PathOpts extends CommonOpts {
  closed?: boolean;
}

/**
 * Open or closed polyline through a list of reactive Points.
 *
 * Construction:
 *   - `new Path([p1, p2, p3], opts?)`        — explicit array
 *   - `new Path(builder, opts?)`             — from a fluent builder
 *   - `path(start).up(8).along(angle, 14)`   — fluent (returns builder)
 */
export class Path extends Shape {
  readonly points: readonly Point[];
  readonly closed: boolean;

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

    this.attr("d", () => {
      if (points.length === 0) return "";
      const parts: string[] = [`M ${points[0].x()} ${points[0].y()}`];
      for (let i = 1; i < points.length; i++) {
        parts.push(`L ${points[i].x()} ${points[i].y()}`);
      }
      if (closed) parts.push("Z");
      return parts.join(" ");
    });

    applyOpts(this, opts);
  }

  /** Heading at the path's last point — direction = last segment's tangent. */
  get tip(): Heading {
    const n = this.points.length;
    if (n === 0) return new Heading(pt(0, 0), pt(1, 0));
    if (n === 1) return new Heading(this.points[0], pt(1, 0));
    const last = this.points[n - 1];
    const prev = this.points[n - 2];
    return new Heading(last, last.sub(prev).normalize());
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

/** Fluent path-data builder. Pure values; no DOM. Call into `new Path(b)`
 *  (or pass to the `Path` constructor) to materialize. */
export class PathBuilder {
  constructor(readonly points: readonly Point[]) {}

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
    const aFn = read(angle);
    const dFn = read(dist);
    return this.extend(
      this.last.offset(
        () => Math.cos(aFn()) * dFn(),
        () => Math.sin(aFn()) * dFn(),
      ),
    );
  }
  to(p: Point): PathBuilder {
    return this.extend(p);
  }

  /** Heading at the builder's last point. */
  get tip(): Heading {
    const n = this.points.length;
    if (n === 0) return new Heading(pt(0, 0), pt(1, 0));
    if (n === 1) return new Heading(this.points[0], pt(1, 0));
    const last = this.points[n - 1];
    const prev = this.points[n - 2];
    return new Heading(last, last.sub(prev).normalize());
  }
}

/** Start a fluent path at `start`. */
export const path = (start: Point): PathBuilder => new PathBuilder([start]);
