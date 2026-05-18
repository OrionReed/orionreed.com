import { num,derived, computed, signal, Vec, type Signal, type Val} from "@minim/signals";
import {Shape, type Segment} from "./shape";
import {wireStroke, type CommonOpts} from "./common";

export interface PathOpts extends CommonOpts {
  closed?: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Geometry sampler over a reactive list of Points. `pts` is tracked
 *  by every computed, so mutating the list re-runs sampling. */
function sampler(pts: Signal<readonly Vec[]>) {
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

  const length: Signal<number> = computed(() => {
    const lens = cumLen.value;
    return lens[lens.length - 1] ?? 0;
  });

  /** Locate by arc-length `d` (px), clamped to `[0, total]`. */
  const locateAt = (d: number, points: readonly Vec[]) => {
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

  const sampleAt = (ds: Signal<number>): Vec =>
    derived(Vec, () => {
      const points = pts.value;
      if (points.length === 0) return { x: 0, y: 0 };
      if (points.length === 1) return points[0].value;
      const { i, segT } = locateAt(ds.value, points);
      const a = points[i].value;
      const b = points[i + 1].value;
      return { x: a.x + (b.x - a.x) * segT, y: a.y + (b.y - a.y) * segT };
    });

  const at = (t: Val<number>): Vec => {
    const ts = num(t);
    return sampleAt(computed(() => clamp01(ts.value) * length.value));
  };

  /** Sample at absolute arc-length (px from start). */
  const atDistance = (d: Val<number>): Vec => sampleAt(num(d));

  const tangentAt = (t: Val<number>): Vec => {
    const ts = num(t);
    return derived(Vec, () => {
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

  const normalAt = (t: Val<number>): Vec => tangentAt(t).perp();

  const angleAt = (t: Val<number>): Signal<number> => {
    const tan = tangentAt(t);
    return computed(() => Math.atan2(tan.y.value, tan.x.value));
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
  private readonly _points: Signal<readonly Vec[]>;
  readonly closed: boolean;

  readonly length: Signal<number>;
  /** Sample at `t ∈ [0, 1]`. Named to avoid shadowing the Box `at(u, v)`
   *  anchor — same symmetry as `tangentAt` / `normalAt` / `angleAt`. */
  readonly pointAt: (t: Val<number>) => Vec;
  readonly atDistance: (d: Val<number>) => Vec;
  readonly tangentAt: (t: Val<number>) => Vec;
  readonly normalAt: (t: Val<number>) => Vec;
  readonly angleAt: (t: Val<number>) => Signal<number>;

  constructor(start: Vec | readonly Vec[] = [], opts: O = {} as O) {
    const init: readonly Vec[] = start instanceof Vec ? [start] : start;
    const points = signal<readonly Vec[]>(init);
    const closed = opts.closed ?? false;

    super(
      "path",
      () => {
        const ps = points.value;
        if (ps.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
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
        return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };
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
    });
  }

  /** Untracked snapshot of the points list. */
  get points(): readonly Vec[] {
    return this._points.peek();
  }

  private get last(): Vec {
    const ps = this._points.peek();
    return ps[ps.length - 1];
  }

  private extend(p: Vec): this {
    this._points.value = [...this._points.peek(), p];
    return this;
  }

  to(p: Vec): this {
    return this.extend(p);
  }
  /** Step `n` up from the last vertex. */
  u(n: Val<number>) {
    return this.extend(this.last.up(n));
  }
  /** Step `n` down from the last vertex. */
  d(n: Val<number>) {
    return this.extend(this.last.down(n));
  }
  /** Step `n` left from the last vertex. */
  l(n: Val<number>) {
    return this.extend(this.last.left(n));
  }
  /** Step `n` right from the last vertex. */
  r(n: Val<number>) {
    return this.extend(this.last.right(n));
  }
  offset(dx: Val<number>, dy: Val<number>) {
    return this.extend(this.last.offset(dx, dy));
  }
  /** Walk `dist` at `angle` (radians, y-down). */
  along(angle: Val<number>, dist: Val<number>) {
    const a = num(angle);
    const d = num(dist);
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
      segs.push({ type: "line", from: ps[i].value, to: ps[i + 1].value });
    }
    if (this.closed && ps.length > 1) {
      segs.push({ type: "line", from: ps[ps.length - 1].value, to: ps[0].value });
    }
    return segs;
  }
}

/** Start a fluent path at `start`. Chain `.to(p)` / `.u(n)` / `.d(n)`
 *  / `.l(n)` / `.r(n)` / `.offset(dx, dy)` / `.along(angle, dist)` and
 *  pass to `s(...)` to render. */
export const path = <const O extends PathOpts>(
  start: Vec,
  opts?: O,
): Path<O> => new Path<O>(start, opts);
