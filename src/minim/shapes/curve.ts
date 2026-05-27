// curve.ts — reactive piecewise curve with line + elliptic-arc segments.
//
// Path's sibling: when polylines aren't enough. Each segment renders as
// an SVG `d` chunk (native `L` for lines, `A` for elliptic arcs — the
// browser draws the actual arc, not a sampled approximation) and
// samples in closed form (`pointAt`, `tangentAt`). Arc-length per
// segment is exact for lines, 16-sample for ellipse arcs (visually
// indistinguishable from exact at typical aspect ratios).
//
// Two construction modes share one class:
//   • Static — pass an array. `curve()` / fluent `.to(p)` / `.ellipseArc(...)`.
//   • Reactive — pass a builder fn. Segments recompute when deps change;
//     fluent methods aren't available (the builder owns the list).
// The `ellipse(center, a, b, rotation?)` factory uses the reactive form
// so all four parameters accept `Val<>`.

import {
  derive,
  type Inner,
  reader,
  readNow,
  type Signal,
  signal,
  type Val,
  Vec,
  type Writable,
} from "@minim/signals";
import { type CommonOpts, Shape } from "./shape";

type V = Inner<Vec>;

export interface CurveOpts extends CommonOpts {
  closed?: boolean;
}

/** Single piece of a curve. Each carries the data it needs to render
 *  as one SVG path command and to sample by local parametric `s ∈ [0,1]`. */
export type CurveSegment =
  | { kind: "line"; from: V; to: V }
  | {
      kind: "ellipseArc";
      /** Centre of the (possibly rotated) ellipse. */
      center: V;
      /** Semi-axes along the rotated frame. */
      a: number;
      b: number;
      /** Rotation of the ellipse's major axis from +x, in radians. */
      rotation: number;
      /** Start / end parameter angles in the rotated frame, radians. */
      a0: number;
      a1: number;
    };

const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ARC_SAMPLES = 16;

/** Endpoint of a segment at local s ∈ [0, 1]. Closed-form. */
function sampleSegment(seg: CurveSegment, s: number): V {
  if (seg.kind === "line") {
    return {
      x: seg.from.x + (seg.to.x - seg.from.x) * s,
      y: seg.from.y + (seg.to.y - seg.from.y) * s,
    };
  }
  const t = seg.a0 + (seg.a1 - seg.a0) * s;
  const cosT = Math.cos(t);
  const sinT = Math.sin(t);
  const cosR = Math.cos(seg.rotation);
  const sinR = Math.sin(seg.rotation);
  return {
    x: seg.center.x + seg.a * cosT * cosR - seg.b * sinT * sinR,
    y: seg.center.y + seg.a * cosT * sinR + seg.b * sinT * cosR,
  };
}

/** Unit tangent at local s. Closed-form derivative of `sampleSegment`. */
function tangentSegment(seg: CurveSegment, s: number): V {
  if (seg.kind === "line") {
    const dx = seg.to.x - seg.from.x;
    const dy = seg.to.y - seg.from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }
  const t = seg.a0 + (seg.a1 - seg.a0) * s;
  const cosT = Math.cos(t);
  const sinT = Math.sin(t);
  const cosR = Math.cos(seg.rotation);
  const sinR = Math.sin(seg.rotation);
  let dx = -seg.a * sinT * cosR - seg.b * cosT * sinR;
  let dy = -seg.a * sinT * sinR + seg.b * cosT * cosR;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  return { x: dx, y: dy };
}

/** Arc length of one segment. Exact for lines, 16-sample for ellipse arcs. */
function segmentLength(seg: CurveSegment): number {
  if (seg.kind === "line") {
    return Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y);
  }
  const N = ARC_SAMPLES;
  let acc = 0;
  let prev = sampleSegment(seg, 0);
  for (let i = 1; i <= N; i++) {
    const p = sampleSegment(seg, i / N);
    acc += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return acc;
}

/** SVG `d` chunk for one segment. Ellipse arcs spanning more than π
 *  are split at the midpoint so SVG's `large-arc-flag` stays unambiguous. */
function segmentD(seg: CurveSegment): string {
  if (seg.kind === "line") {
    return `L ${seg.to.x} ${seg.to.y}`;
  }
  const { a, b, rotation, a0, a1 } = seg;
  const sweep = a1 >= a0 ? 1 : 0;
  const span = Math.abs(a1 - a0);
  const rotDeg = (rotation * 180) / Math.PI;
  if (span <= Math.PI + 1e-9) {
    const large = span > Math.PI ? 1 : 0;
    const end = sampleSegment(seg, 1);
    return `A ${a} ${b} ${rotDeg} ${large} ${sweep} ${end.x} ${end.y}`;
  }
  const mid = sampleSegment(seg, 0.5);
  const end = sampleSegment(seg, 1);
  return (
    `A ${a} ${b} ${rotDeg} 0 ${sweep} ${mid.x} ${mid.y} ` +
    `A ${a} ${b} ${rotDeg} 0 ${sweep} ${end.x} ${end.y}`
  );
}

function segmentStart(seg: CurveSegment): V {
  return seg.kind === "line" ? seg.from : sampleSegment(seg, 0);
}

/** Initialiser: static array (writable, fluent) or reactive builder
 *  (computed, immutable). */
export type CurveInit = readonly CurveSegment[] | (() => readonly CurveSegment[]);

/** Piecewise curve with line and ellipse-arc segments. */
export class Curve<O extends CurveOpts = CurveOpts> extends Shape<O> {
  private readonly _segments: Signal<readonly CurveSegment[]>;
  /** True if segments are reactive (computed); fluent methods then no-op. */
  private readonly _reactive: boolean;
  readonly closed: boolean;
  readonly length: Signal<number>;

  constructor(init: CurveInit = [], opts: O = {} as O) {
    const reactive = typeof init === "function";
    const segs: Signal<readonly CurveSegment[]> = reactive
      ? derive(init)
      : signal<readonly CurveSegment[]>(init);
    const closed = opts.closed ?? false;

    const cumLen = derive(() => {
      const arr = segs.value;
      const out = [0];
      for (let i = 0; i < arr.length; i++) {
        out.push(out[i] + segmentLength(arr[i]));
      }
      return out;
    });
    const total = derive(() => {
      const c = cumLen.value;
      return c[c.length - 1] ?? 0;
    });

    super(
      "path",
      () => {
        const arr = segs.value;
        if (arr.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
        let xMin = Infinity,
          yMin = Infinity,
          xMax = -Infinity,
          yMax = -Infinity;
        for (const seg of arr) {
          const N = seg.kind === "line" ? 1 : ARC_SAMPLES;
          for (let i = 0; i <= N; i++) {
            const p = sampleSegment(seg, i / N);
            if (p.x < xMin) xMin = p.x;
            if (p.y < yMin) yMin = p.y;
            if (p.x > xMax) xMax = p.x;
            if (p.y > yMax) yMax = p.y;
          }
        }
        return { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };
      },
      opts,
      {
        origin: derive(() => {
          const arr = segs.value;
          return arr.length > 0 ? segmentStart(arr[0]) : { x: 0, y: 0 };
        }),
      },
    );

    this._segments = segs;
    this._reactive = reactive;
    this.closed = closed;
    this.length = total;

    this.stroke(opts, closed, {
      d: derive(() => {
        const arr = segs.value;
        if (arr.length === 0) return "";
        const start = segmentStart(arr[0]);
        const parts: string[] = [`M ${start.x} ${start.y}`];
        for (const seg of arr) parts.push(segmentD(seg));
        if (closed) parts.push("Z");
        return parts.join(" ");
      }),
    });
  }

  /** Untracked snapshot of the segment list. */
  get segs(): readonly CurveSegment[] {
    return this._segments.peek();
  }

  /** Override Shape's default (bounding-rect) for the dashed renderer.
   *  Lines pass through; circular ellipse-arcs (`a ≈ b`, rotation ≈ 0)
   *  become native arcs; non-circular ellipse-arcs tessellate into line
   *  segments so the dasher still has something to chew on. */
  override segments(): import("./shape").Segment[] {
    const arr = this._segments.value;
    const out: import("./shape").Segment[] = [];
    for (const seg of arr) {
      if (seg.kind === "line") {
        out.push({ type: "line", from: seg.from, to: seg.to });
      } else if (Math.abs(seg.a - seg.b) < 1e-6 && Math.abs(seg.rotation) < 1e-6) {
        const cx = seg.center.x;
        const cy = seg.center.y;
        const r = seg.a;
        const a0 = seg.a0;
        const a1 = seg.a1;
        out.push({
          type: "arc",
          cx: () => cx,
          cy: () => cy,
          r: () => r,
          a0: () => a0,
          a1: () => a1,
        });
      } else {
        // Non-circular ellipse: tessellate into a polyline.
        const N = 64;
        let prev = sampleSegment(seg, 0);
        for (let i = 1; i <= N; i++) {
          const p = sampleSegment(seg, i / N);
          out.push({ type: "line", from: prev, to: p });
          prev = p;
        }
      }
    }
    return out;
  }

  /** Sample at `t ∈ [0, 1]` along arc length. */
  pointAt(t: Val<number>): Vec {
    const ts = reader(t);
    return Vec.derive(() => {
      const arr = this._segments.value;
      if (arr.length === 0) return { x: 0, y: 0 };
      const target = clamp01(ts()) * this.length.value;
      let acc = 0;
      for (const seg of arr) {
        const segLen = segmentLength(seg);
        if (target <= acc + segLen || seg === arr[arr.length - 1]) {
          const s = segLen > 0 ? (target - acc) / segLen : 0;
          return sampleSegment(seg, s);
        }
        acc += segLen;
      }
      return sampleSegment(arr[arr.length - 1], 1);
    });
  }

  /** Unit tangent at `t ∈ [0, 1]`. */
  tangentAt(t: Val<number>): Vec {
    const ts = reader(t);
    return Vec.derive(() => {
      const arr = this._segments.value;
      if (arr.length === 0) return { x: 1, y: 0 };
      const target = clamp01(ts()) * this.length.value;
      let acc = 0;
      for (const seg of arr) {
        const segLen = segmentLength(seg);
        if (target <= acc + segLen || seg === arr[arr.length - 1]) {
          const s = segLen > 0 ? (target - acc) / segLen : 0;
          return tangentSegment(seg, s);
        }
        acc += segLen;
      }
      return tangentSegment(arr[arr.length - 1], 1);
    });
  }

  // ── Fluent extension (static init only) ──────────────────────────

  private push(seg: CurveSegment): this {
    if (this._reactive) {
      throw new Error("Curve(builder): fluent .to/.ellipseArc unavailable on reactive curves");
    }
    // _segments is a writable signal in this branch.
    (this._segments as Writable<Signal<readonly CurveSegment[]>>).value = [
      ...this._segments.peek(),
      seg,
    ];
    return this;
  }

  private get last(): V | undefined {
    const arr = this._segments.peek();
    if (arr.length === 0) return undefined;
    return sampleSegment(arr[arr.length - 1], 1);
  }

  /** Append a line segment to `p`. */
  to(p: V): this {
    const from = this.last ?? { x: 0, y: 0 };
    return this.push({ kind: "line", from, to: p });
  }

  /** Append an elliptic-arc segment. `a0`, `a1` are parametric angles
   *  in the ellipse's rotated frame. */
  ellipseArc(center: V, a: number, b: number, rotation: number, a0: number, a1: number): this {
    return this.push({ kind: "ellipseArc", center, a, b, rotation, a0, a1 });
  }
}

/** Start a piecewise curve. Static (fluent) or reactive (builder fn).
 *
 *   curve().to(p1).to(p2)           — open polyline
 *   curve([...segments])            — explicit segment array
 *   curve(() => buildSegments())    — reactive; segments recompute on deps */
export function curve<const O extends CurveOpts>(init?: CurveInit, opts?: O): Curve<O> {
  return new Curve<O>(init ?? [], opts);
}

/** A closed ellipse centred at `center` with semi-axes `a, b` and
 *  optional `rotation` (radians). All four args accept `Val<>`, so the
 *  ellipse re-renders when any input changes. */
export function ellipse<O extends CurveOpts>(
  center: Val<V>,
  a: Val<number>,
  b: Val<number>,
  rotation: Val<number> = 0,
  opts?: O,
): Curve<O> {
  const o = { ...(opts ?? ({} as O)), closed: true };
  return new Curve<O>(
    () => [
      {
        kind: "ellipseArc",
        center: readNow(center),
        a: readNow(a),
        b: readNow(b),
        rotation: readNow(rotation),
        a0: 0,
        a1: TAU,
      },
    ],
    o,
  );
}
