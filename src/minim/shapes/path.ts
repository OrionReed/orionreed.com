import {
  computed,
  signal,
  toSig,
  type Arg,
  type ReadonlySignal,
  type Signal,
} from "../core";
import {
  Shape,
  DerivedPoint,
  aabb,
  isPoint,
  type Pointlike,
  type Segment,
} from "../scene";
import { applyOpts, setupDashed, type CommonOpts } from "./common";

export interface PathOpts extends CommonOpts {
  closed?: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Geometry sampler over a reactive list of Points. `pts` is tracked
 *  by every computed, so mutating the list re-runs sampling. */
function sampler(pts: Signal<readonly Pointlike[]>) {
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

  const sampleAt = (ds: ReadonlySignal<number>): DerivedPoint =>
    new DerivedPoint(() => {
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
    return sampleAt(computed(() => clamp01(ts.value) * length.value));
  };

  /** Sample at absolute arc-length (px from start). */
  const atDistance = (d: Arg<number>): DerivedPoint => sampleAt(toSig(d));

  const tangentAt = (t: Arg<number>): DerivedPoint => {
    const ts = toSig(t);
    return new DerivedPoint(() => {
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

  const angleAt = (t: Arg<number>): ReadonlySignal<number> => {
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
 *  Extension methods (`to`/`up`/`down`/`left`/`right`/`offset`/`along`)
 *  mutate in place and return `this`. The `d` attribute and all
 *  sampling methods react to point changes automatically. */
export class Path<O extends PathOpts = PathOpts> extends Shape<O> {
  private readonly _points: Signal<readonly Pointlike[]>;
  readonly closed: boolean;

  readonly length: ReadonlySignal<number>;
  readonly at: (t: Arg<number>) => DerivedPoint;
  readonly atDistance: (d: Arg<number>) => DerivedPoint;
  readonly tangentAt: (t: Arg<number>) => DerivedPoint;
  readonly normalAt: (t: Arg<number>) => DerivedPoint;
  readonly angleAt: (t: Arg<number>) => ReadonlySignal<number>;

  constructor(start: Pointlike | readonly Pointlike[] = [], opts: O = {} as O) {
    const init: readonly Pointlike[] = isPoint(start) ? [start] : start;
    const points = signal<readonly Pointlike[]>(init);
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
        // First vertex — matches `path.at(0)`. Override via `origin`
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
    this.at = s.at;
    this.atDistance = s.atDistance;
    this.tangentAt = s.tangentAt;
    this.normalAt = s.normalAt;
    this.angleAt = s.angleAt;

    // Dashed paths get `d` from `setupDashed` instead.
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

/** Start a fluent path at `start`. Chain `.to(p)`/`.up(n)`/etc. and
 *  pass to `s(...)` to render. */
export const path = <const O extends PathOpts>(
  start: Pointlike,
  opts?: O,
): Path<O> => new Path<O>(start, opts);
