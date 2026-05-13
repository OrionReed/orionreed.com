import {
  cell,
  toSig,
  type Arg,
  type Cell,
  type ReadonlyCell,
} from "../core";
import {
  Shape,
  Vec,
  isPoint,
  type DerivedPoint,
  type Pointlike,
  type Segment,
} from "../scene";
import { box } from "../values/box";
import { wireStroke, type CommonOpts } from "./common";

export interface PathOpts extends CommonOpts {
  closed?: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Geometry sampler over a reactive list of Points. `pts` is tracked
 *  by every computed, so mutating the list re-runs sampling. */
function sampler(pts: Cell<readonly Pointlike[]>) {
  const cumLen = cell.derived(() => {
    const points = pts.value;
    const lens = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].value;
      const b = points[i].value;
      lens.push(lens[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    return lens;
  });

  const length: ReadonlyCell<number> = cell.derived(() => {
    const lens = cumLen.value;
    return lens[lens.length - 1] ?? 0;
  });

  /** Locate by arc-length `d` (px), clamped to `[0, total]`. */
  const locateAt = (d: number, points: readonly Pointlike[]) => {
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

  const sampleAt = (ds: ReadonlyCell<number>): DerivedPoint =>
    Vec.derived(() => {
      const points = pts.value;
      if (points.length === 0) return { x: 0, y: 0 };
      if (points.length === 1) return points[0].value;
      const { i, segT } = locateAt(ds.value, points);
      const a = points[i].value;
      const b = points[i + 1].value;
      return { x: a.x + (b.x - a.x) * segT, y: a.y + (b.y - a.y) * segT };
    });

  const at = (t: Arg<number>): DerivedPoint => {
    const ts = toSig(t);
    return sampleAt(cell.derived(() => clamp01(ts.value) * length.value));
  };

  /** Sample at absolute arc-length (px from start). */
  const atDistance = (d: Arg<number>): DerivedPoint => sampleAt(toSig(d));

  const tangentAt = (t: Arg<number>): DerivedPoint => {
    const ts = toSig(t);
    return Vec.derived(() => {
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
  };

  const normalAt = (t: Arg<number>): DerivedPoint => tangentAt(t).perp();

  const angleAt = (t: Arg<number>): ReadonlyCell<number> => {
    const tan = tangentAt(t);
    return cell.derived(() => Math.atan2(tan.y.value, tan.x.value));
  };

  return { length, at, atDistance, tangentAt, normalAt, angleAt };
}

/** Open or closed polyline through a reactive list of Points.
 *
 *   path(start, opts?).to(p2).to(p3)   — fluent (preferred)
 *   new Path([p1, p2, p3], opts?)      — explicit array
 *
 *  Extension methods (`to`/`u`/`d`/`l`/`r`/`offset`/`along`) mutate in
 *  place and return `this`. The `d` attribute and all sampling methods
 *  react to point changes automatically. */
export class Path<O extends PathOpts = PathOpts> extends Shape<O> {
  private readonly _points: Cell<readonly Pointlike[]>;
  readonly closed: boolean;

  readonly length: ReadonlyCell<number>;
  /** Sample at `t ∈ [0, 1]`. Named to avoid shadowing the Box `at(u, v)`
   *  anchor — same symmetry as `tangentAt` / `normalAt` / `angleAt`. */
  readonly pointAt: (t: Arg<number>) => DerivedPoint;
  readonly atDistance: (d: Arg<number>) => DerivedPoint;
  readonly tangentAt: (t: Arg<number>) => DerivedPoint;
  readonly normalAt: (t: Arg<number>) => DerivedPoint;
  readonly angleAt: (t: Arg<number>) => ReadonlyCell<number>;

  constructor(start: Pointlike | readonly Pointlike[] = [], opts: O = {} as O) {
    const init: readonly Pointlike[] = isPoint(start) ? [start] : start;
    const points = cell<readonly Pointlike[]>(init);
    const closed = opts.closed ?? false;

    super(
      "path",
      () => {
        const ps = points.value;
        if (ps.length === 0) return box(0, 0, 0, 0);
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
        return box(xMin, yMin, xMax - xMin, yMax - yMin);
      },
      opts,
      {
        // First vertex — matches `path.pointAt(0)`. Override via `origin`
        // for a different pivot.
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
    this.pointAt = s.at;
    this.atDistance = s.atDistance;
    this.tangentAt = s.tangentAt;
    this.normalAt = s.normalAt;
    this.angleAt = s.angleAt;

    wireStroke(this, opts, closed, () => {
      this.attr(
        "d",
        cell.derived(() => {
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
    });
  }

  /** Untracked snapshot of the points list. */
  get points(): readonly Pointlike[] {
    return this._points.peek();
  }

  private get last(): Pointlike {
    const ps = this._points.peek();
    return ps[ps.length - 1];
  }

  private extend(p: Pointlike): this {
    this._points.value = [...this._points.peek(), p];
    return this;
  }

  to(p: Pointlike): this {
    return this.extend(p);
  }
  /** Step `n` up from the last vertex. */
  u(n: Arg<number>) {
    return this.extend(this.last.up(n));
  }
  /** Step `n` down from the last vertex. */
  d(n: Arg<number>) {
    return this.extend(this.last.down(n));
  }
  /** Step `n` left from the last vertex. */
  l(n: Arg<number>) {
    return this.extend(this.last.left(n));
  }
  /** Step `n` right from the last vertex. */
  r(n: Arg<number>) {
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
        cell.derived(() => Math.cos(a.value) * d.value),
        cell.derived(() => Math.sin(a.value) * d.value),
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

/** Start a fluent path at `start`. Chain `.to(p)` / `.u(n)` / `.d(n)`
 *  / `.l(n)` / `.r(n)` / `.offset(dx, dy)` / `.along(angle, dist)` and
 *  pass to `s(...)` to render. */
export const path = <const O extends PathOpts>(
  start: Pointlike,
  opts?: O,
): Path<O> => new Path<O>(start, opts);
