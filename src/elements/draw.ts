import {
  Bounds,
  EdgeDir,
  Point,
  boundsEdge,
  circleEdgeFrom,
  expandBounds,
  midpoint,
  pt,
  rectEdgeFrom,
  unionBounds,
} from "./geom";

// =====================================================================
// Render constants — these are the "1-bit" visual vocabulary.
// Stroke is non-scaling so weight is in CSS pixels regardless of viewBox.
// Other constants (corner, dash, fontSize) are in scene units; for best
// results, choose scene coordinates close to the rendered pixel size.
// =====================================================================

const C = {
  stroke: "var(--text-color)",
  weight: 2,
  /** Half-thickness used for softer marks: dashed subdivisions, leaders, etc. */
  thinWeight: 1.5,
  corner: 2,
  dash: 4,
  gap: 3,
  font: "'New CM', monospace",
  fontSize: 14,
  arrowMarkerId: "draw-arrow",
  // refX=0 anchors the line endpoint at the arrowhead BASE (widest point)
  // so the line never exceeds the arrowhead's width visually. `round`
  // is the corner-rounding radius applied to all 3 vertices of the
  // triangle for an inked-pen feel rather than a perfect geometric tip.
  arrowMarker: { w: 10, h: 7, refX: 0, refY: 3.5, round: 0.9 },
  /** Default visual gap at each end of an arrow. */
  arrowGap: 4,
  /** Opacity used by `muted: true` across all primitives. */
  mutedOpacity: 0.5,
};

const NSS = 'vector-effect="non-scaling-stroke"';

// =====================================================================
// Text — chainable rich text composed of nested styled spans.
// =====================================================================

interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  muted?: boolean;
  sub?: boolean;
  sup?: boolean;
}

export type TextPart = string | Text;

export class Text {
  constructor(
    public parts: TextPart[],
    public style: TextStyle = {},
  ) {}

  bold(): Text {
    return new Text(this.parts, { ...this.style, bold: true });
  }
  italic(): Text {
    return new Text(this.parts, { ...this.style, italic: true });
  }
  muted(): Text {
    return new Text(this.parts, { ...this.style, muted: true });
  }
  sub(...parts: TextPart[]): Text {
    return new Text([this, new Text(parts, { sub: true })]);
  }
  sup(...parts: TextPart[]): Text {
    return new Text([this, new Text(parts, { sup: true })]);
  }
}

export function t(...parts: TextPart[]): Text {
  return new Text(parts);
}

export type Content = string | Text;

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTextNode(node: TextPart): string {
  if (typeof node === "string") return escapeXml(node);
  const inner = node.parts.map(renderTextNode).join("");
  const a: string[] = [];
  if (node.style.bold) a.push('font-weight="700"');
  if (node.style.italic) a.push('font-style="italic"');
  if (node.style.muted) a.push(`opacity="${C.mutedOpacity}"`);
  if (node.style.sub) a.push('baseline-shift="sub" font-size="0.75em"');
  if (node.style.sup) a.push('baseline-shift="super" font-size="0.75em"');
  return a.length ? `<tspan ${a.join(" ")}>${inner}</tspan>` : inner;
}

function renderContent(c: Content): string {
  return typeof c === "string" ? escapeXml(c) : renderTextNode(c);
}

// =====================================================================
// Path & dash math — rounded rect + corner-snapping dashed outline.
// =====================================================================

function rrPath(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) {
    return `M${x},${y} h${w} v${h} h${-w} Z`;
  }
  const rx = Math.min(r, w / 2, h / 2);
  return [
    `M ${x + rx},${y}`,
    `H ${x + w - rx}`,
    `A ${rx},${rx} 0 0 1 ${x + w},${y + rx}`,
    `V ${y + h - rx}`,
    `A ${rx},${rx} 0 0 1 ${x + w - rx},${y + h}`,
    `H ${x + rx}`,
    `A ${rx},${rx} 0 0 1 ${x},${y + h - rx}`,
    `V ${y + rx}`,
    `A ${rx},${rx} 0 0 1 ${x + rx},${y}`,
    "Z",
  ].join(" ");
}

/**
 * Compute dash geometry for a path of `length`. Dashes are kept at a
 * CONSTANT visible size (`C.dash`); only gaps stretch to fit. The dash
 * count is snapped to the integer that makes the resulting gap closest
 * to `C.gap`.
 *
 * `mode='open'`: path starts AND ends with a full dash.
 *   Layout = N dashes + (N-1) gaps.
 * `mode='closed'`: pattern wraps cleanly across the start/end seam.
 *   Layout = N dashes + N gaps.
 *
 * Returns `{ dashSize, gapSize, N }`. If the path is too short to fit a
 * dashed pattern with constant size, returns N=1 and a single dash that
 * fills the whole length (a solid stroke).
 */
interface DashGeom {
  dashSize: number;
  gapSize: number;
  N: number;
}

/**
 * Optical compensation factor for round caps. A round cap mathematically
 * extends `stroke-width / 2` past the path endpoint, but visually a
 * rounded shape looks SHORTER than its mathematical extent. We use this
 * factor (0..1) to subtract less than the full extension. 0 = no
 * compensation (treat caps as full mathematical extent), 1 = ignore
 * caps entirely. ~0.5 feels right by eye.
 */
const ROUND_CAP_OPTICAL = 0.5;

function computeDashGeom(
  length: number,
  mode: "open" | "closed",
  dashTarget: number = C.dash,
  gapTarget: number = C.gap
): DashGeom {
  const origDash = dashTarget;
  const origGap = gapTarget;
  const origPeriod = origDash + origGap;

  if (length <= 0) return { dashSize: 0, gapSize: 0, N: 0 };

  if (mode === "open") {
    let N = Math.max(2, Math.round((length + origGap) / origPeriod));
    let gapSize = (length - N * origDash) / (N - 1);
    while (gapSize < 0 && N > 2) {
      N--;
      gapSize = (length - N * origDash) / (N - 1);
    }
    if (length < 2 * origDash || gapSize < 0) {
      // Too short for two full dashes — render as a single solid stroke.
      return { dashSize: length, gapSize: 0, N: 1 };
    }
    return { dashSize: origDash, gapSize, N };
  }

  // closed
  let N = Math.max(1, Math.round(length / origPeriod));
  let gapSize = length / N - origDash;
  while (gapSize < 0 && N > 1) {
    N--;
    gapSize = length / N - origDash;
  }
  if (gapSize < 0) {
    return { dashSize: length, gapSize: 0, N: 1 };
  }
  return { dashSize: origDash, gapSize, N };
}

// =====================================================================
// Path Segments — uniform abstraction for walking arbitrary shapes
// (straight edges or circular arcs) and rendering dash positions as
// explicit SVG path commands. Avoids browser stroke-dasharray rendering
// entirely for pixel-perfect control.
// =====================================================================

type Segment =
  | { type: "line"; p1: Point; p2: Point }
  | {
      type: "arc";
      cx: number;
      cy: number;
      r: number;
      a0: number; // start angle (radians)
      a1: number; // end angle (radians); a1 > a0 for CW (in SVG y-down)
    };

function segmentLength(s: Segment): number {
  if (s.type === "line") {
    const dx = s.p2.x - s.p1.x;
    const dy = s.p2.y - s.p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  return Math.abs(s.a1 - s.a0) * s.r;
}

/** Point at fraction t in [0,1] along the segment. */
function pointAtT(s: Segment, t: number): Point {
  if (s.type === "line") {
    return {
      x: s.p1.x + (s.p2.x - s.p1.x) * t,
      y: s.p1.y + (s.p2.y - s.p1.y) * t,
    };
  }
  const a = s.a0 + (s.a1 - s.a0) * t;
  return { x: s.cx + s.r * Math.cos(a), y: s.cy + s.r * Math.sin(a) };
}

/**
 * Build SVG path-data for the portion of `segments` from `start` to `end`
 * (both expressed as cumulative distance from the start of segments[0]).
 * Inserts an `M` at the start, then `L`/`A` commands as it walks.
 */
function pathFromTo(
  segments: Segment[],
  segLengths: number[],
  start: number,
  end: number,
): string {
  // Find which segment `start` falls into.
  let i = 0;
  let pos = 0;
  while (i < segments.length && pos + segLengths[i] < start) {
    pos += segLengths[i];
    i++;
  }
  if (i >= segments.length) return "";

  const tStart = (start - pos) / segLengths[i];
  const startPt = pointAtT(segments[i], tStart);
  let d = `M ${startPt.x},${startPt.y}`;

  let remaining = end - start;
  // First segment: go from tStart to either tStart + remaining/segLen or 1.
  let curT = tStart;

  while (remaining > 0 && i < segments.length) {
    const seg = segments[i];
    const segLen = segLengths[i];
    const lenLeftInSeg = (1 - curT) * segLen;

    if (remaining <= lenLeftInSeg) {
      const endT = curT + remaining / segLen;
      const endPt = pointAtT(seg, endT);
      if (seg.type === "line") {
        d += ` L ${endPt.x},${endPt.y}`;
      } else {
        const sweepAngle = (seg.a1 - seg.a0) * (endT - curT);
        const largeArc = Math.abs(sweepAngle) > Math.PI ? 1 : 0;
        const sweepFlag = sweepAngle > 0 ? 1 : 0;
        d += ` A ${seg.r},${seg.r} 0 ${largeArc} ${sweepFlag} ${endPt.x},${endPt.y}`;
      }
      remaining = 0;
      break;
    }

    // Consume the rest of this segment, move to next.
    const segEndPt = pointAtT(seg, 1);
    if (seg.type === "line") {
      d += ` L ${segEndPt.x},${segEndPt.y}`;
    } else {
      const sweepAngle = (seg.a1 - seg.a0) * (1 - curT);
      const largeArc = Math.abs(sweepAngle) > Math.PI ? 1 : 0;
      const sweepFlag = sweepAngle > 0 ? 1 : 0;
      d += ` A ${seg.r},${seg.r} 0 ${largeArc} ${sweepFlag} ${segEndPt.x},${segEndPt.y}`;
    }
    remaining -= lenLeftInSeg;
    i++;
    curT = 0;
  }

  return d;
}

// Build segment lists for the standard primitives.

function lineToSegments(p1: Point, p2: Point): Segment[] {
  return [{ type: "line", p1, p2 }];
}

function polylineToSegments(points: Point[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segs.push({ type: "line", p1: points[i], p2: points[i + 1] });
  }
  return segs;
}

const HALF_PI = Math.PI / 2;

function rrToSegments(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): Segment[] {
  const rx = Math.min(r, w / 2, h / 2);
  if (rx <= 0) {
    return [
      { type: "line", p1: { x, y }, p2: { x: x + w, y } },
      { type: "line", p1: { x: x + w, y }, p2: { x: x + w, y: y + h } },
      { type: "line", p1: { x: x + w, y: y + h }, p2: { x, y: y + h } },
      { type: "line", p1: { x, y: y + h }, p2: { x, y } },
    ];
  }
  return [
    { type: "line", p1: { x: x + rx, y }, p2: { x: x + w - rx, y } },
    { type: "arc", cx: x + w - rx, cy: y + rx, r: rx, a0: -HALF_PI, a1: 0 },
    {
      type: "line",
      p1: { x: x + w, y: y + rx },
      p2: { x: x + w, y: y + h - rx },
    },
    { type: "arc", cx: x + w - rx, cy: y + h - rx, r: rx, a0: 0, a1: HALF_PI },
    {
      type: "line",
      p1: { x: x + w - rx, y: y + h },
      p2: { x: x + rx, y: y + h },
    },
    {
      type: "arc",
      cx: x + rx,
      cy: y + h - rx,
      r: rx,
      a0: HALF_PI,
      a1: Math.PI,
    },
    { type: "line", p1: { x, y: y + h - rx }, p2: { x, y: y + rx } },
    {
      type: "arc",
      cx: x + rx,
      cy: y + rx,
      r: rx,
      a0: Math.PI,
      a1: 3 * HALF_PI,
    },
  ];
}

function circleToSegments(cx: number, cy: number, r: number): Segment[] {
  // Split into quarter-arcs so individual dashes never need to span more
  // than 90° of arc (which keeps SVG arc command unambiguous).
  return [
    { type: "arc", cx, cy, r, a0: 0, a1: HALF_PI },
    { type: "arc", cx, cy, r, a0: HALF_PI, a1: Math.PI },
    { type: "arc", cx, cy, r, a0: Math.PI, a1: 3 * HALF_PI },
    { type: "arc", cx, cy, r, a0: 3 * HALF_PI, a1: 2 * Math.PI },
  ];
}

/**
 * Render a sequence of segments as a dashed stroke composed of explicit
 * <path> elements (one per dash). When `cap === "round"`, the dash
 * path-length is shrunk and gap path-length is grown so that the
 * VISUAL dash (including round caps) still measures `C.dash` and the
 * visual gap still measures `C.gap`, with optical compensation
 * (rounded ends look shorter than their mathematical extent).
 */
function renderDashedSegments(
  segments: Segment[],
  mode: "open" | "closed",
  strokeAttrs: string,
  joinAttr: string,
  cap: "butt" | "round" = "butt",
  weight: number = C.weight
): string {
  if (segments.length === 0) return "";

  const segLengths = segments.map(segmentLength);
  const totalLen = segLengths.reduce((a, b) => a + b, 0);

  // For round caps, account for optical extension. Round caps add
  // weight/2 mathematically at each end, but visually appear shorter.
  // Net subtraction per dash = 2*(weight/2)*ROUND_CAP_OPTICAL = weight*K.
  const ext = cap === "round" ? weight * ROUND_CAP_OPTICAL : 0;
  const dashTarget = Math.max(0.001, C.dash - ext);
  const gapTarget = C.gap + ext;

  const { dashSize, gapSize, N } = computeDashGeom(
    totalLen,
    mode,
    dashTarget,
    gapTarget
  );

  if (N === 0) return "";
  if (N === 1) {
    // Solid: draw the entire path as a single SVG path
    const d = pathFromTo(segments, segLengths, 0, totalLen);
    return `<path d="${d}" fill="none" ${strokeAttrs} ${joinAttr} stroke-linecap="${cap}"/>`;
  }

  let svg = "";
  const period = dashSize + gapSize;
  for (let i = 0; i < N; i++) {
    const start = i * period;
    const end = start + dashSize;
    const d = pathFromTo(segments, segLengths, start, end);
    svg += `<path d="${d}" fill="none" ${strokeAttrs} ${joinAttr} stroke-linecap="${cap}"/>`;
  }
  return svg;
}

// =====================================================================
// Shape — public handle returned by Scene methods.
// =====================================================================

export interface Shape {
  readonly bounds: Bounds;
  /** Point on the shape in the given cardinal/diagonal direction. */
  edge(dir: EdgeDir): Point;
  /**
   * Boundary point along a line from `from` toward this shape.
   * `pad` virtually inflates the shape by N units before clipping —
   * useful for arrows that should land outside the shape with a gap.
   */
  clipFrom(from: Point, pad?: number): Point;
}

export interface RowShape extends Shape {
  /** Handle for the i-th cell in the row. */
  slot(i: number): Shape;
}

/**
 * Build a Shape from a rect's geometry. Not attached to any Scene —
 * useful as a layout reference (e.g. clipping a line to an external
 * element's bounds).
 */
export function rectShape(bounds: Bounds): Shape {
  return {
    bounds,
    edge: (dir) => boundsEdge(bounds, dir),
    clipFrom: (from, pad = 0) =>
      rectEdgeFrom(pad ? expandBounds(bounds, pad) : bounds, from),
  };
}

/** Build a Shape from a circle's geometry. */
export function circleShape(cx: number, cy: number, r: number): Shape {
  const bounds: Bounds = { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
  return {
    bounds,
    edge: (dir) => circleEdgeFrom(cx, cy, r, boundsEdge(bounds, dir)),
    clipFrom: (from, pad = 0) => circleEdgeFrom(cx, cy, r + pad, from),
  };
}

interface SceneEntry {
  shape: Shape;
  aside: boolean;
  render(): string;
}

// =====================================================================
// Options — kept small and orthogonal.
// =====================================================================

export interface RectOpts {
  dashed?: boolean;
  /** Filled (no stroke). For outlined+filled, draw a solid then an outline. */
  solid?: boolean;
  muted?: boolean;
  /** Use the thin weight instead of the main weight. */
  thin?: boolean;
  /** Override corner radius (default `C.corner`). Pass 0 for square corners. */
  corner?: number;
  /** Stroke cap on dashed segments. Default "butt". */
  cap?: "butt" | "round";
}

export interface CircleOpts {
  solid?: boolean;
  muted?: boolean;
  thin?: boolean;
  dashed?: boolean;
  /** Stroke cap on dashed segments. Default "butt". */
  cap?: "butt" | "round";
}

export interface LineOpts {
  dashed?: boolean;
  muted?: boolean;
  thin?: boolean;
  /**
   * Stroke cap. Default: "round" if both endpoints are Points (free pen
   * ends), "butt" if either is a Shape (intersection with another
   * shape's boundary). Override explicitly when needed.
   */
  cap?: "round" | "butt";
}

export interface PolylineOpts {
  dashed?: boolean;
  muted?: boolean;
  thin?: boolean;
  /** Stroke cap at the start and end of the path. Default "round". */
  cap?: "round" | "butt";
  /** How internal corners are joined. Default "miter". */
  join?: "miter" | "round" | "bevel";
}

export interface ArrowOpts {
  label?: Content;
  /**
   * Visual gap between the arrow's extent and the source/target.
   * Applied symmetrically at both ends; the lib compensates internally
   * for the arrowhead so you never need to know about its size.
   * Default `C.arrowGap`.
   */
  gap?: number;
}

export interface LabelOpts {
  size?: number;
  anchor?: "start" | "middle" | "end";
  baseline?: "top" | "middle" | "bottom";
  /** Rotation in degrees, around the anchor point. */
  rotate?: number;
  /**
   * Whether this label should count towards scene bounds.
   * Default false — labels are aside by default so the *content*
   * drives centering, not the labels around it.
   */
  bounds?: boolean;
}

export interface RowItem {
  units: number;
  /** Style of the divider AFTER this item. Default: "solid". The last item has no divider. */
  divider?: "solid" | "dashed";
}

export interface RowOpts {
  x: number;
  y: number;
  h: number;
  unitWidth: number;
  dashed?: boolean;
}

// =====================================================================
// Scene — the only class. Owns the entries, computes bounds, renders.
// =====================================================================

type Padding =
  | number
  | {
      x?: number;
      y?: number;
      top?: number;
      bottom?: number;
      left?: number;
      right?: number;
    };

export class Scene {
  private entries: SceneEntry[] = [];
  private padTop: number;
  private padBottom: number;
  private padLeft: number;
  private padRight: number;

  constructor(opts: { padding?: Padding } = {}) {
    if (typeof opts.padding === "number") {
      this.padTop =
        this.padBottom =
        this.padLeft =
        this.padRight =
          opts.padding;
    } else {
      const p = opts.padding ?? {};
      this.padTop = p.top ?? p.y ?? 20;
      this.padBottom = p.bottom ?? p.y ?? 20;
      this.padLeft = p.left ?? p.x ?? 20;
      this.padRight = p.right ?? p.x ?? 20;
    }
  }

  /** Mark a previously-added shape as aside (excluded from bounds). */
  aside(shape: Shape): void {
    const e = this.entries.find((x) => x.shape === shape);
    if (e) e.aside = true;
  }

  // -----------------------------------------------------------------
  // Primitives
  // -----------------------------------------------------------------

  /**
   * Draw a dashed outline around an existing shape with a consistent gap.
   * Corner radius is matched to the inner shape so the gap is uniform
   * along straight edges AND around corners.
   */
  outline(
    shape: Shape,
    opts: {
      offset?: number;
      dashed?: boolean;
      corner?: number;
      cap?: "butt" | "round";
      thin?: boolean;
    } = {},
  ): Shape {
    const offset = opts.offset ?? 4;
    const baseCorner = opts.corner ?? C.corner;
    const b = expandBounds(shape.bounds, offset);
    return this.rect(b.x, b.y, b.w, b.h, {
      dashed: opts.dashed ?? true,
      corner: baseCorner + offset,
      cap: opts.cap,
      thin: opts.thin,
    });
  }

  rect(x: number, y: number, w: number, h: number, opts: RectOpts = {}): Shape {
    const bounds: Bounds = { x, y, w, h };
    const corner = opts.corner ?? C.corner;
    const shape: Shape = {
      bounds,
      edge: (dir) => boundsEdge(bounds, dir),
      clipFrom: (from, pad = 0) =>
        rectEdgeFrom(pad ? expandBounds(bounds, pad) : bounds, from),
    };
    return this.add(shape, () => {
      const opacity = opts.muted ? ` opacity="${C.mutedOpacity}"` : "";
      const weight = opts.thin ? C.thinWeight : C.weight;
      if (opts.solid) {
        // Filled blocks have no stroke — adjacent solids tile cleanly.
        return `<path d="${rrPath(x, y, w, h, corner)}" fill="${C.stroke}"${opacity}/>`;
      }
      if (opts.dashed) {
        // Render each dash as an explicit path along the rect perimeter.
        const segs = rrToSegments(x, y, w, h, corner);
        const sw = `stroke="${C.stroke}" stroke-width="${weight}" ${NSS}${opacity}`;
        return renderDashedSegments(segs, "closed", sw, "", opts.cap ?? "round", weight);
      }
      return `<path d="${rrPath(x, y, w, h, corner)}" fill="none" stroke="${C.stroke}" stroke-width="${weight}" ${NSS}${opacity}/>`;
    });
  }

  circle(cx: number, cy: number, r: number, opts: CircleOpts = {}): Shape {
    const bounds: Bounds = { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
    const shape: Shape = {
      bounds,
      edge: (dir) => circleEdgeFrom(cx, cy, r, boundsEdge(bounds, dir)),
      clipFrom: (from, pad = 0) => circleEdgeFrom(cx, cy, r + pad, from),
    };
    return this.add(shape, () => {
      const fill = opts.solid ? C.stroke : "none";
      const opacity = opts.muted ? ` opacity="${C.mutedOpacity}"` : "";
      const weight = opts.thin ? C.thinWeight : C.weight;
      if (opts.dashed && !opts.solid) {
        const segs = circleToSegments(cx, cy, r);
        const sw = `stroke="${C.stroke}" stroke-width="${weight}" ${NSS}${opacity}`;
        return renderDashedSegments(segs, "closed", sw, "", opts.cap ?? "round", weight);
      }
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${C.stroke}" stroke-width="${weight}" ${NSS}${opacity}/>`;
    });
  }

  line(from: Point | Shape, to: Point | Shape, opts: LineOpts = {}): void {
    const fromShape = isShape(from);
    const toShape = isShape(to);
    const cap = opts.cap ?? (fromShape || toShape ? "butt" : "round");

    const fromCenter = fromShape ? from.edge("center") : from;
    const toCenter = toShape ? to.edge("center") : to;
    const p1 = fromShape ? from.clipFrom(toCenter) : from;
    const p2 = toShape ? to.clipFrom(fromCenter) : to;

    const bounds = lineBounds(p1, p2);
    const shape: Shape = {
      bounds,
      edge: (dir) => boundsEdge(bounds, dir),
      clipFrom: () => p1,
    };
    this.add(
      shape,
      () => {
        const opacity = opts.muted ? ` opacity="${C.mutedOpacity}"` : "";
        const weight = opts.thin ? C.thinWeight : C.weight;
        if (opts.dashed) {
          const segs = lineToSegments(p1, p2);
          const sw = `stroke="${C.stroke}" stroke-width="${weight}" ${NSS}${opacity}`;
          return renderDashedSegments(segs, "open", sw, "", cap, weight);
        }
        return `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${C.stroke}" stroke-width="${weight}" stroke-linecap="${cap}" ${NSS}${opacity}/>`;
      },
      true,
    );
  }

  /**
   * Connected line segments through a sequence of points, drawn as a
   * single path so corners join cleanly (no cap artifacts at bends).
   */
  polyline(points: Point[], opts: PolylineOpts = {}): void {
    if (points.length < 2) return;
    const cap = opts.cap ?? "round";
    const join = opts.join ?? "miter";

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const bounds: Bounds = { x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin };

    const shape: Shape = {
      bounds,
      edge: (dir) => boundsEdge(bounds, dir),
      clipFrom: () => points[0],
    };

    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`)
      .join(" ");

    this.add(
      shape,
      () => {
        const opacity = opts.muted ? ` opacity="${C.mutedOpacity}"` : "";
        const weight = opts.thin ? C.thinWeight : C.weight;
        if (opts.dashed) {
          const segs = polylineToSegments(points);
          const sw = `stroke="${C.stroke}" stroke-width="${weight}" ${NSS}${opacity}`;
          return renderDashedSegments(
            segs,
            "open",
            sw,
            `stroke-linejoin="${join}"`,
            cap,
            weight,
          );
        }
        return `<path d="${d}" fill="none" stroke="${C.stroke}" stroke-width="${weight}" stroke-linecap="${cap}" stroke-linejoin="${join}" ${NSS}${opacity}/>`;
      },
      true,
    );
  }

  /**
   * Arrow between two points or two shapes.
   * If a Shape is passed, the endpoint is clipped to its boundary
   * (virtually inflated by `pad`). For Point endpoints the line is
   * shortened by `pad` along its direction so the arrowhead lands
   * with a clean visual gap.
   */
  arrow(from: Point | Shape, to: Point | Shape, opts: ArrowOpts = {}): void {
    const gap = opts.gap ?? C.arrowGap;
    // FROM end uses a round cap. Mathematically the cap extends
    // `weight/2` past the line endpoint, but because rounded shapes
    // optically appear shorter than their bounds, the back visually
    // reads as closer to the source than the target tip does to the
    // target. We push the endpoint farther out to compensate, landing
    // on a visual gap that feels symmetric to the arrowhead end.
    const padFrom = gap + C.weight;
    // The arrowhead extends `marker.w` forward of the line endpoint,
    // so we shift the endpoint back by that much PLUS the gap so the
    // visible tip ends `gap` units before the target.
    const padTo = gap + C.arrowMarker.w;

    const fromCenter = isShape(from) ? from.edge("center") : from;
    const toCenter = isShape(to) ? to.edge("center") : to;
    let p1 = isShape(from) ? from.clipFrom(toCenter, padFrom) : from;
    let p2 = isShape(to) ? to.clipFrom(fromCenter, padTo) : to;

    // For Point endpoints, shrink line along its direction by the corresponding pad.
    if (!isShape(from) || !isShape(to)) {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > padFrom + padTo) {
        const ux = dx / d;
        const uy = dy / d;
        if (!isShape(from) && padFrom > 0)
          p1 = { x: p1.x + ux * padFrom, y: p1.y + uy * padFrom };
        if (!isShape(to) && padTo > 0)
          p2 = { x: p2.x - ux * padTo, y: p2.y - uy * padTo };
      }
    }

    const bounds = lineBounds(p1, p2);
    const shape: Shape = {
      bounds,
      edge: (dir) => boundsEdge(bounds, dir),
      clipFrom: () => p1,
    };
    this.add(
      shape,
      () => {
        // Round cap so the FROM end has a pen-tip; the TO end is hidden
        // behind the arrowhead marker so cap style is invisible there.
        let svg = `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${C.stroke}" stroke-width="${C.weight}" stroke-linecap="round" ${NSS} marker-end="url(#${C.arrowMarkerId})"/>`;
        if (opts.label) {
          const m = midpoint(p1, p2);
          svg += `<text x="${m.x}" y="${
            m.y - 4
          }" font-family="${C.font}" font-size="11" fill="${
            C.stroke
          }" text-anchor="middle">${renderContent(opts.label)}</text>`;
        }
        return svg;
      },
      true,
    );
  }

  label(p: Point, content: Content, opts: LabelOpts = {}): Shape {
    const size = opts.size ?? C.fontSize;
    const anchor = opts.anchor ?? "middle";
    const baseline =
      opts.baseline === "top"
        ? "hanging"
        : opts.baseline === "bottom"
          ? "alphabetic"
          : "central";
    const transform = opts.rotate
      ? ` transform="rotate(${opts.rotate} ${p.x} ${p.y})"`
      : "";

    // Approximate bounds — labels are aside by default so this only
    // matters if the caller opts in via { bounds: true }.
    const approxText =
      typeof content === "string" ? content : flattenText(content);
    const w = size * Math.max(1, approxText.length) * 0.6;
    const bounds: Bounds = { x: p.x - w / 2, y: p.y - size / 2, w, h: size };

    const shape: Shape = {
      bounds,
      edge: () => p,
      clipFrom: () => p,
    };
    return this.add(
      shape,
      () =>
        `<text x="${p.x}" y="${p.y}" font-family="${C.font}" font-size="${size}" fill="${C.stroke}" text-anchor="${anchor}" dominant-baseline="${baseline}"${transform}>${renderContent(content)}</text>`,
      !opts.bounds,
    );
  }

  /**
   * A horizontal row of cells sharing a common boundary.
   * Outer boundary is one closed rounded path; inner dividers are
   * separate lines that cross it — corners look crisp at junctions.
   */
  row(items: RowItem[], opts: RowOpts): RowShape {
    const totalUnits = items.reduce((s, i) => s + i.units, 0);
    const totalW = totalUnits * opts.unitWidth;
    const slotWidths = items.map((i) => i.units * opts.unitWidth);

    const slotXs: number[] = [];
    let cur = opts.x;
    for (const w of slotWidths) {
      slotXs.push(cur);
      cur += w;
    }

    const bounds: Bounds = { x: opts.x, y: opts.y, w: totalW, h: opts.h };
    const slots: Shape[] = items.map((_, i) => {
      const slotBounds: Bounds = {
        x: slotXs[i],
        y: opts.y,
        w: slotWidths[i],
        h: opts.h,
      };
      return {
        bounds: slotBounds,
        edge: (dir) => boundsEdge(slotBounds, dir),
        clipFrom: (from, pad = 0) =>
          rectEdgeFrom(pad ? expandBounds(slotBounds, pad) : slotBounds, from),
      };
    });

    const shape: RowShape = {
      bounds,
      edge: (dir) => boundsEdge(bounds, dir),
      clipFrom: (from, pad = 0) =>
        rectEdgeFrom(pad ? expandBounds(bounds, pad) : bounds, from),
      slot: (i) => slots[i],
    };

    return this.add(shape, () => {
      const sw = `stroke="${C.stroke}" stroke-width="${C.weight}" ${NSS}`;
      // Dashed dividers are "soft" subdivisions and use thin weight so
      // they read as a less-emphatic boundary than the outer or solid
      // dividers (which use the main weight).
      const swThin = `stroke="${C.stroke}" stroke-width="${C.thinWeight}" ${NSS}`;

      // Outer boundary
      let svg: string;
      if (opts.dashed) {
        const segs = rrToSegments(opts.x, opts.y, totalW, opts.h, C.corner);
        svg = renderDashedSegments(segs, "closed", sw, "");
      } else {
        svg = `<path d="${rrPath(opts.x, opts.y, totalW, opts.h, C.corner)}" fill="none" ${sw}/>`;
      }
      // Inner dividers
      for (let i = 1; i < items.length; i++) {
        const x = slotXs[i];
        const isDashed = items[i - 1].divider === "dashed";
        const top = pt(x, opts.y);
        const bot = pt(x, opts.y + opts.h);
        if (isDashed) {
          svg += renderDashedSegments(
            lineToSegments(top, bot),
            "open",
            swThin,
            "",
            "round",
            C.thinWeight,
          );
        } else {
          svg += `<line x1="${x}" y1="${opts.y}" x2="${x}" y2="${
            opts.y + opts.h
          }" ${sw} stroke-linecap="butt"/>`;
        }
      }
      return svg;
    });
  }

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------

  render(svgEl: SVGSVGElement): void {
    const contentBounds = this.entries
      .filter((e) => !e.aside)
      .map((e) => e.shape.bounds);

    const vb =
      contentBounds.length > 0
        ? unionBounds(...contentBounds)
        : { x: 0, y: 0, w: 0, h: 0 };
    const padded: Bounds = {
      x: vb.x - this.padLeft,
      y: vb.y - this.padTop,
      w: vb.w + this.padLeft + this.padRight,
      h: vb.h + this.padTop + this.padBottom,
    };

    svgEl.setAttribute(
      "viewBox",
      `${padded.x} ${padded.y} ${padded.w} ${padded.h}`,
    );
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    // Set explicit width/height so the SVG has intrinsic dimensions
    // matching the viewBox. Otherwise some layout contexts (e.g. flex
    // containers without a definite width) fall back to the SVG default
    // 300x150, making the diagram render smaller than authored.
    svgEl.setAttribute("width", String(padded.w));
    svgEl.setAttribute("height", String(padded.h));

    const m = C.arrowMarker;
    // Build a triangle path with corners rounded by `r`. Each corner is
    // cut back by `r` along its two edges; a quadratic Bezier with the
    // original sharp vertex as control point smooths the join. Result
    // is a filled arrowhead with all three corners genuinely rounded.
    const r = m.round;
    const v0 = { x: 0, y: 0 };
    const v1 = { x: m.w, y: m.refY };
    const v2 = { x: 0, y: m.h };
    const corner = (v: Point, prev: Point, next: Point) => {
      const dPrev = Math.sqrt((prev.x - v.x) ** 2 + (prev.y - v.y) ** 2);
      const dNext = Math.sqrt((next.x - v.x) ** 2 + (next.y - v.y) ** 2);
      return {
        approach: {
          x: v.x + (r * (prev.x - v.x)) / dPrev,
          y: v.y + (r * (prev.y - v.y)) / dPrev,
        },
        depart: {
          x: v.x + (r * (next.x - v.x)) / dNext,
          y: v.y + (r * (next.y - v.y)) / dNext,
        },
      };
    };
    const c0 = corner(v0, v2, v1);
    const c1 = corner(v1, v0, v2);
    const c2 = corner(v2, v1, v0);
    const arrowD = `M ${c0.depart.x} ${c0.depart.y} L ${c1.approach.x} ${c1.approach.y} Q ${v1.x} ${v1.y} ${c1.depart.x} ${c1.depart.y} L ${c2.approach.x} ${c2.approach.y} Q ${v2.x} ${v2.y} ${c2.depart.x} ${c2.depart.y} L ${c0.approach.x} ${c0.approach.y} Q ${v0.x} ${v0.y} ${c0.depart.x} ${c0.depart.y} Z`;
    const defs = `<defs><marker id="${C.arrowMarkerId}" markerWidth="${m.w}" markerHeight="${m.h}" refX="${m.refX}" refY="${m.refY}" orient="auto" markerUnits="userSpaceOnUse"><path d="${arrowD}" fill="${C.stroke}"/></marker></defs>`;

    svgEl.innerHTML = defs + this.entries.map((e) => e.render()).join("");
  }

  // -----------------------------------------------------------------

  private add<T extends Shape>(
    shape: T,
    render: () => string,
    aside = false,
  ): T {
    this.entries.push({ shape, render, aside });
    return shape;
  }
}

// =====================================================================
// Helpers
// =====================================================================

function lineBounds(p1: Point, p2: Point): Bounds {
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y),
  };
}

function isShape(x: Point | Shape): x is Shape {
  return typeof (x as Shape).edge === "function";
}

function flattenText(node: TextPart): string {
  if (typeof node === "string") return node;
  return node.parts.map(flattenText).join("");
}
