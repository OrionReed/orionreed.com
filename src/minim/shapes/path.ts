import {
  Shape,
  Point,
  aabb,
  computed,
  signal,
  toSig,
  type Segment,
  type Arg,
  type ReadonlySignal,
  type Signal,
} from "../core";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface PathOpts extends CommonOpts {
  closed?: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Pure-geometry sampler over a reactive list of Points. The `pts`
 *  signal is read inside every computed, so adding/removing points
 *  (via `Path.to`, `.up`, etc.) re-runs `length`/`at`/`atDistance`/
 *  `tangentAt`/`angleAt` automatically. */
function sampler(pts: Signal<readonly Point[]>) {
  const cumLen = computed(() => {
    const points = pts.value;
    const lens = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].value;
      const b = points[i].value;
      lens.push(lens[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    return lens;
  });

  const length: ReadonlySignal<number> = computed(() => {
    const lens = cumLen.value;
    return lens[lens.length - 1] ?? 0;
  });

  /** Locate by absolute arc-length `d` (px), clamped to [0, total]. */
  const locateAt = (d: number, points: readonly Point[]) => {
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

  const sample = (d: ReadonlySignal<number>) =>
    computed(() => {
      const points = pts.value;
      if (points.length === 0) return { x: 0, y: 0 };
      if (points.length === 1) return points[0].value;
      const { i, segT } = locateAt(d.value, points);
      const a = points[i].value;
      const b = points[i + 1].value;
      return { x: a.x + (b.x - a.x) * segT, y: a.y + (b.y - a.y) * segT };
    });

  const at = (t: Arg<number>): Point => {
    const ts = toSig(t);
    const ds = computed(() => clamp01(ts.value) * length.value);
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
      const points = pts.value;
      if (points.length < 2) return { x: 1, y: 0 };
      const total = length.value;
      const { i } = locateAt(clamp01(ts.value) * total, points);
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
 *   path(start, opts?).to(p2).to(p3)        — fluent (preferred)
 *   new Path([p1, p2, p3], opts?)           — explicit array
 *
 *  All extension methods (`to`/`up`/`down`/`left`/`right`/`offset`/
 *  `along`) mutate the points list in place and return `this`, so
 *  chaining works without producing intermediate Shapes. The `d`
 *  attribute and all sampling methods (`at`/`atDistance`/`length`/
 *  …) re-run automatically when points change. */
export class Path<O extends PathOpts = PathOpts> extends Shape<O> {
  private readonly _points: Signal<readonly Point[]>;
  readonly closed: boolean;

  readonly length: ReadonlySignal<number>;
  readonly at: (t: Arg<number>) => Point;
  readonly atDistance: (d: Arg<number>) => Point;
  readonly tangentAt: (t: Arg<number>) => Point;
  readonly normalAt: (t: Arg<number>) => Point;
  readonly angleAt: (t: Arg<number>) => ReadonlySignal<number>;

  constructor(start: Point | readonly Point[] = [], opts: O = {} as O) {
    const init: readonly Point[] = start instanceof Point ? [start] : start;
    const points = signal<readonly Point[]>(init);
    const closed = opts.closed ?? false;

    super(
      "path",
      () => {
        const ps = points.value;
        if (ps.length === 0) return aabb(0, 0, 0, 0);
        let xMin = Infinity,
          yMin = Infinity,
          xMax = -Infinity,
          yMax = -Infinity;
        for (const p of ps) {
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
        origin: () => {
          const ps = points.value;
          return ps.length > 0 ? ps[0].value : { x: 0, y: 0 };
        },
      },
    );

    this._points = points;
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
          const ps = points.value;
          if (ps.length === 0) return "";
          const parts: string[] = [`M ${ps[0].x.value} ${ps[0].y.value}`];
          for (let i = 1; i < ps.length; i++) {
            parts.push(`L ${ps[i].x.value} ${ps[i].y.value}`);
          }
          if (closed) parts.push("Z");
          return parts.join(" ");
        }),
      );
    }
    setupDashed(this, opts, closed);
    applyOpts(this, opts);
  }

  /** Snapshot of the current points list (untracked). */
  get points(): readonly Point[] {
    return this._points.peek();
  }

  private get last(): Point {
    const ps = this._points.peek();
    return ps[ps.length - 1];
  }

  private extend(p: Point): this {
    this._points.value = [...this._points.peek(), p];
    return this;
  }

  to(p: Point): this {
    return this.extend(p);
  }
  up(n: Arg<number>) {
    return this.extend(this.last.up(n));
  }
  down(n: Arg<number>) {
    return this.extend(this.last.down(n));
  }
  left(n: Arg<number>) {
    return this.extend(this.last.left(n));
  }
  right(n: Arg<number>) {
    return this.extend(this.last.right(n));
  }
  offset(dx: Arg<number>, dy: Arg<number>) {
    return this.extend(this.last.offset(dx, dy));
  }
  /** Walk `dist` at `angle` (radians, y-down). */
  along(angle: Arg<number>, dist: Arg<number>) {
    const a = toSig(angle);
    const d = toSig(dist);
    return this.extend(
      this.last.offset(
        computed(() => Math.cos(a.value) * d.value),
        computed(() => Math.sin(a.value) * d.value),
      ),
    );
  }

  override segments(): Segment[] {
    const ps = this._points.peek();
    const segs: Segment[] = [];
    for (let i = 0; i < ps.length - 1; i++) {
      segs.push({ type: "line", from: ps[i], to: ps[i + 1] });
    }
    if (this.closed && ps.length > 1) {
      segs.push({ type: "line", from: ps[ps.length - 1], to: ps[0] });
    }
    return segs;
  }
}

/** Start a fluent path at `start`. Returns a Path you can chain on
 *  (`.to(p)`, `.up(n)`, etc.) and pass to `s(...)` to render. */
export const path = <const O extends PathOpts>(
  start: Point,
  opts?: O,
): Path<O> => new Path<O>(start, opts);
