import {
  Angle,
  Bounds,
  Heading,
  Path,
  Point,
  bounds,
  circleEdgeFrom,
  expandBounds,
  isHeading,
  midpoint,
  rectEdgeFrom,
  unionBounds,
} from "./geom";

// =====================================================================
// Render constants — the "1-bit" visual vocabulary.
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
  /** Approximate character width as a fraction of font-size (used for
   *  rough label bounds estimation since SVG can't measure text without
   *  layout). */
  charWidth: 0.6,
  /** Relative font size for sub/sup tspans. */
  subFontSize: "0.75em",
  arrowMarkerId: "draw-arrow",
  // refX=0 anchors the line endpoint at the arrowhead BASE (widest point)
  // so the line never exceeds the arrowhead's width visually. `round`
  // is the corner-rounding radius applied to all 3 vertices of the
  // triangle for an inked-pen feel rather than a perfect geometric tip.
  arrowMarker: { w: 10, h: 7, refX: 0, refY: 3.5, round: 0.9 },
  /** Default visual gap at each end of an arrow. */
  arrowGap: 4,
  /** Font size used for arrow labels. */
  arrowLabelSize: 11,
  /** Vertical offset of an arrow label above the line midpoint. */
  arrowLabelOffset: 4,
  /** Opacity used by `muted: true` across all primitives. */
  mutedOpacity: 0.5,
};

const NSS = 'vector-effect="non-scaling-stroke"';

function strokeAttrs(weight: number, muted?: boolean): string {
  const opacity = muted ? ` opacity="${C.mutedOpacity}"` : "";
  return `stroke="${C.stroke}" stroke-width="${weight}" ${NSS}${opacity}`;
}

function pickWeight(opts: { thin?: boolean }): number {
  return opts.thin ? C.thinWeight : C.weight;
}

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
  if (node.style.sub) a.push(`baseline-shift="sub" font-size="${C.subFontSize}"`);
  if (node.style.sup) a.push(`baseline-shift="super" font-size="${C.subFontSize}"`);
  return a.length ? `<tspan ${a.join(" ")}>${inner}</tspan>` : inner;
}

function renderContent(c: Content): string {
  return typeof c === "string" ? escapeXml(c) : renderTextNode(c);
}

function flattenText(node: TextPart): string {
  if (typeof node === "string") return node;
  return node.parts.map(flattenText).join("");
}

// =====================================================================
// Shape — pure geometric values. Each carries enough math to derive new
// shapes (`expand`, `contract`, `translate`) and to find an edge point
// from an external probe (`edgeFrom`). Render-time fields (corner) live
// on concrete subtypes where they semantically belong.
// =====================================================================

export interface Shape {
  readonly bounds: Bounds;
  /** Boundary point along the line from this shape's center toward `from`. */
  edgeFrom(from: Point): Point;
  expand(by: number): Shape;
  contract(by: number): Shape;
  translate(dx: number, dy: number): Shape;
}

export interface RectShape extends Shape {
  readonly corner: number;
  expand(by: number): RectShape;
  contract(by: number): RectShape;
  translate(dx: number, dy: number): RectShape;
}

export interface CircleShape extends Shape {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  expand(by: number): CircleShape;
  contract(by: number): CircleShape;
  translate(dx: number, dy: number): CircleShape;
}

export interface RowShape extends Shape {
  /** Geometry of the i-th cell as a Shape (no slot.aside/hide). */
  slot(i: number): RectShape;
}

export function rectShape(b: Bounds, corner: number = C.corner): RectShape {
  return {
    bounds: b,
    corner,
    edgeFrom: (from) => rectEdgeFrom(b, from),
    expand: (n) => rectShape(expandBounds(b, n), Math.max(0, corner + n)),
    contract: (n) => rectShape(expandBounds(b, -n), Math.max(0, corner - n)),
    translate: (dx, dy) =>
      rectShape(bounds(b.x + dx, b.y + dy, b.w, b.h), corner),
  };
}

export function circleShape(
  cx: number,
  cy: number,
  r: number,
): CircleShape {
  const b = bounds(cx - r, cy - r, 2 * r, 2 * r);
  return {
    bounds: b,
    cx,
    cy,
    radius: r,
    edgeFrom: (from) => circleEdgeFrom(cx, cy, r, from),
    expand: (n) => circleShape(cx, cy, Math.max(0, r + n)),
    contract: (n) => circleShape(cx, cy, Math.max(0, r - n)),
    translate: (dx, dy) => circleShape(cx + dx, cy + dy, r),
  };
}

function pointAsShape(p: Point): CircleShape {
  return circleShape(p.x, p.y, 0);
}

function isShape(x: unknown): x is Shape {
  return (
    typeof x === "object" &&
    x !== null &&
    "bounds" in x &&
    typeof (x as Shape).edgeFrom === "function"
  );
}

function isBounds(x: unknown): x is Bounds {
  return (
    typeof x === "object" &&
    x !== null &&
    "x" in x &&
    "y" in x &&
    "w" in x &&
    "h" in x &&
    typeof (x as Bounds).w === "number"
  );
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

interface DashGeom {
  dashSize: number;
  gapSize: number;
  N: number;
}

/**
 * Optical compensation factor for round caps. A round cap mathematically
 * extends `stroke-width / 2` past the path endpoint, but visually a
 * rounded shape looks SHORTER than its mathematical extent. We use this
 * factor (0..1) to subtract less than the full extension. ~0.5 by eye.
 */
const ROUND_CAP_OPTICAL = 0.5;

function computeDashGeom(
  length: number,
  mode: "open" | "closed",
  dashTarget: number = C.dash,
  gapTarget: number = C.gap,
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
      a0: number;
      a1: number;
    };

function segmentLength(s: Segment): number {
  if (s.type === "line") {
    const dx = s.p2.x - s.p1.x;
    const dy = s.p2.y - s.p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  return Math.abs(s.a1 - s.a0) * s.r;
}

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

function pathFromTo(
  segments: Segment[],
  segLengths: number[],
  start: number,
  end: number,
): string {
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

function lineToSegments(p1: Point, p2: Point): Segment[] {
  return [{ type: "line", p1, p2 }];
}

function polylineToSegments(points: readonly Point[]): Segment[] {
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
  return [
    { type: "arc", cx, cy, r, a0: 0, a1: HALF_PI },
    { type: "arc", cx, cy, r, a0: HALF_PI, a1: Math.PI },
    { type: "arc", cx, cy, r, a0: Math.PI, a1: 3 * HALF_PI },
    { type: "arc", cx, cy, r, a0: 3 * HALF_PI, a1: 2 * Math.PI },
  ];
}

/**
 * Build a triangle path for the arrowhead with all three corners rounded
 * by `r`. Each corner is cut back along its two edges by `r`; a quadratic
 * Bezier with the original sharp vertex as control point smooths the
 * join. Result is a filled shape with genuinely rounded corners.
 */
function buildArrowheadPath(): string {
  const m = C.arrowMarker;
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
  return `M ${c0.depart.x} ${c0.depart.y} L ${c1.approach.x} ${c1.approach.y} Q ${v1.x} ${v1.y} ${c1.depart.x} ${c1.depart.y} L ${c2.approach.x} ${c2.approach.y} Q ${v2.x} ${v2.y} ${c2.depart.x} ${c2.depart.y} L ${c0.approach.x} ${c0.approach.y} Q ${v0.x} ${v0.y} ${c0.depart.x} ${c0.depart.y} Z`;
}

const ARROWHEAD_PATH = buildArrowheadPath();
const ARROW_DEFS = `<defs><marker id="${C.arrowMarkerId}" markerWidth="${C.arrowMarker.w}" markerHeight="${C.arrowMarker.h}" refX="${C.arrowMarker.refX}" refY="${C.arrowMarker.refY}" orient="auto" markerUnits="userSpaceOnUse"><path d="${ARROWHEAD_PATH}" fill="${C.stroke}"/></marker></defs>`;

interface DashRenderOpts {
  mode: "open" | "closed";
  stroke: string;
  join?: string;
  cap?: "butt" | "round";
  weight?: number;
}

function renderDashedSegments(
  segments: Segment[],
  opts: DashRenderOpts,
): string {
  if (segments.length === 0) return "";

  const cap = opts.cap ?? "butt";
  const weight = opts.weight ?? C.weight;
  const join = opts.join ?? "";

  const segLengths = segments.map(segmentLength);
  const totalLen = segLengths.reduce((a, b) => a + b, 0);

  const ext = cap === "round" ? weight * ROUND_CAP_OPTICAL : 0;
  const dashTarget = Math.max(0.001, C.dash - ext);
  const gapTarget = C.gap + ext;

  const { dashSize, gapSize, N } = computeDashGeom(
    totalLen,
    opts.mode,
    dashTarget,
    gapTarget,
  );

  if (N === 0) return "";
  if (N === 1) {
    const d = pathFromTo(segments, segLengths, 0, totalLen);
    return `<path d="${d}" fill="none" ${opts.stroke} ${join} stroke-linecap="${cap}"/>`;
  }

  let svg = "";
  const period = dashSize + gapSize;
  for (let i = 0; i < N; i++) {
    const start = i * period;
    const end = start + dashSize;
    const d = pathFromTo(segments, segLengths, start, end);
    svg += `<path d="${d}" fill="none" ${opts.stroke} ${join} stroke-linecap="${cap}"/>`;
  }
  return svg;
}

// =====================================================================
// Scene entries & nodes — entries are the internal storage; nodes are
// the chainable handles returned to user code (Shape + visibility).
// =====================================================================

interface SceneEntry {
  shape: Shape;
  hidden: boolean;
  isAside: boolean;
  render(): string;
}

/**
 * A Shape plus chainable visibility controls. `aside()` excludes the
 * shape from scene bounds (so it doesn't expand the viewBox); `hide()`
 * does that AND skips rendering entirely. Both return `this` for
 * chaining: `s.rect(...).aside()` or `s.rect(...).hide()`.
 */
class SceneNode<S extends Shape = Shape> implements Shape {
  constructor(
    protected readonly inner: S,
    protected readonly entry: SceneEntry,
  ) {}

  get bounds(): Bounds {
    return this.inner.bounds;
  }
  edgeFrom(from: Point): Point {
    return this.inner.edgeFrom(from);
  }
  expand(by: number): Shape {
    return this.inner.expand(by);
  }
  contract(by: number): Shape {
    return this.inner.contract(by);
  }
  translate(dx: number, dy: number): Shape {
    return this.inner.translate(dx, dy);
  }

  hide(): this {
    this.entry.hidden = true;
    return this;
  }
  show(): this {
    this.entry.hidden = false;
    return this;
  }
  aside(): this {
    this.entry.isAside = true;
    return this;
  }
  get hidden(): boolean {
    return this.entry.hidden;
  }
  get isAside(): boolean {
    return this.entry.isAside;
  }
}

class RectNode extends SceneNode<RectShape> implements RectShape {
  get corner(): number {
    return this.inner.corner;
  }
  expand(by: number): RectShape {
    return this.inner.expand(by);
  }
  contract(by: number): RectShape {
    return this.inner.contract(by);
  }
  translate(dx: number, dy: number): RectShape {
    return this.inner.translate(dx, dy);
  }
}

class CircleNode extends SceneNode<CircleShape> implements CircleShape {
  get cx(): number {
    return this.inner.cx;
  }
  get cy(): number {
    return this.inner.cy;
  }
  get radius(): number {
    return this.inner.radius;
  }
  expand(by: number): CircleShape {
    return this.inner.expand(by);
  }
  contract(by: number): CircleShape {
    return this.inner.contract(by);
  }
  translate(dx: number, dy: number): CircleShape {
    return this.inner.translate(dx, dy);
  }
}

class RowNode extends SceneNode<RowShape> implements RowShape {
  slot(i: number): RectShape {
    return this.inner.slot(i);
  }
}

// =====================================================================
// Options — kept small and orthogonal.
// =====================================================================

interface CommonOpts {
  muted?: boolean;
  /** Use the thin weight instead of the main weight. */
  thin?: boolean;
}

export interface RectOpts extends CommonOpts {
  dashed?: boolean;
  /** Render as a filled block (no stroke). */
  fill?: boolean;
  /** Override corner radius (default `C.corner`, or the shape's own corner). */
  corner?: number;
  /** Stroke cap on dashed segments. Default "round". */
  cap?: "butt" | "round";
}

export interface CircleOpts extends CommonOpts {
  fill?: boolean;
  dashed?: boolean;
  cap?: "butt" | "round";
}

export interface LineOpts extends CommonOpts {
  dashed?: boolean;
  /**
   * Stroke cap. Default: "round" if both endpoints are Points (free pen
   * ends), "butt" if either is a Shape (intersection with a boundary).
   */
  cap?: "round" | "butt";
}

export interface PolylineOpts extends CommonOpts {
  dashed?: boolean;
  cap?: "round" | "butt";
  join?: "miter" | "round" | "bevel";
}

export interface ArrowOpts {
  label?: Content;
  /**
   * Visual gap between the arrow's extent and the source/target. The
   * library compensates internally for the arrowhead and round-cap
   * optical extension — you never need to know about either.
   * Default `C.arrowGap`.
   */
  gap?: number;
}

export interface LabelOpts {
  size?: number;
  anchor?: "start" | "middle" | "end";
  baseline?: "top" | "middle" | "bottom";
  /**
   * Rotation in radians. If omitted and the target point is a Heading,
   * defaults to `target.angle`. Pass `0` to force horizontal.
   */
  rotate?: Angle;
  bold?: boolean;
}

export interface RowItem {
  units: number;
  /** Style of the divider AFTER this item. The last item has no divider. */
  divider?: "solid" | "dashed";
}

export interface RowOpts {
  x: number;
  y: number;
  h: number;
  /** Multiplier for each item's `units`. */
  unitWidth?: number;
  /** Total width of the row (alternative to `unitWidth`). */
  width?: number;
}

// =====================================================================
// Scene — the only class. Owns the entries, computes bounds, renders.
// =====================================================================

export type Padding =
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

  // -----------------------------------------------------------------
  // Polymorphic primitives
  // -----------------------------------------------------------------

  rect(x: number, y: number, w: number, h: number, opts?: RectOpts): RectNode;
  rect(b: Bounds, opts?: RectOpts): RectNode;
  rect(s: Shape, opts?: RectOpts): RectNode;
  rect(
    a: number | Bounds | Shape,
    b?: number | RectOpts,
    c?: number,
    d?: number,
    e?: RectOpts,
  ): RectNode {
    let rx: number, ry: number, rw: number, rh: number;
    let opts: RectOpts;
    let inheritedCorner: number | undefined;

    if (typeof a === "number") {
      rx = a;
      ry = b as number;
      rw = c as number;
      rh = d as number;
      opts = e ?? {};
    } else if (isShape(a)) {
      rx = a.bounds.x;
      ry = a.bounds.y;
      rw = a.bounds.w;
      rh = a.bounds.h;
      opts = (b as RectOpts) ?? {};
      if ("corner" in a) inheritedCorner = (a as RectShape).corner;
    } else if (isBounds(a)) {
      rx = a.x;
      ry = a.y;
      rw = a.w;
      rh = a.h;
      opts = (b as RectOpts) ?? {};
    } else {
      throw new Error("rect: unrecognized argument");
    }

    const corner = opts.corner ?? inheritedCorner ?? C.corner;
    return this.attachRect(rx, ry, rw, rh, corner, opts);
  }

  private attachRect(
    x: number,
    y: number,
    w: number,
    h: number,
    corner: number,
    opts: RectOpts,
  ): RectNode {
    const inner = rectShape(bounds(x, y, w, h), corner);
    const entry: SceneEntry = {
      shape: inner,
      hidden: false,
      isAside: false,
      render: () => {
        if (opts.fill) {
          const opacity = opts.muted ? ` opacity="${C.mutedOpacity}"` : "";
          return `<path d="${rrPath(x, y, w, h, corner)}" fill="${C.stroke}"${opacity}/>`;
        }
        const weight = pickWeight(opts);
        const sw = strokeAttrs(weight, opts.muted);
        if (opts.dashed) {
          return renderDashedSegments(rrToSegments(x, y, w, h, corner), {
            mode: "closed",
            stroke: sw,
            cap: opts.cap ?? "round",
            weight,
          });
        }
        return `<path d="${rrPath(x, y, w, h, corner)}" fill="none" ${sw}/>`;
      },
    };
    this.entries.push(entry);
    return new RectNode(inner, entry);
  }

  circle(cx: number, cy: number, r: number, opts?: CircleOpts): CircleNode;
  circle(center: Point, r: number, opts?: CircleOpts): CircleNode;
  circle(c: CircleShape, opts?: CircleOpts): CircleNode;
  circle(
    a: number | Point | CircleShape,
    b?: number | CircleOpts,
    c?: number | CircleOpts,
    d?: CircleOpts,
  ): CircleNode {
    let cx: number, cy: number, r: number;
    let opts: CircleOpts;

    if (typeof a === "number") {
      cx = a;
      cy = b as number;
      r = c as number;
      opts = d ?? {};
    } else if ("radius" in a) {
      cx = a.cx;
      cy = a.cy;
      r = a.radius;
      opts = (b as CircleOpts) ?? {};
    } else {
      cx = a.x;
      cy = a.y;
      r = b as number;
      opts = (c as CircleOpts) ?? {};
    }
    return this.attachCircle(cx, cy, r, opts);
  }

  private attachCircle(
    cx: number,
    cy: number,
    r: number,
    opts: CircleOpts,
  ): CircleNode {
    const inner = circleShape(cx, cy, r);
    const entry: SceneEntry = {
      shape: inner,
      hidden: false,
      isAside: false,
      render: () => {
        const weight = pickWeight(opts);
        const sw = strokeAttrs(weight, opts.muted);
        if (opts.dashed && !opts.fill) {
          return renderDashedSegments(circleToSegments(cx, cy, r), {
            mode: "closed",
            stroke: sw,
            cap: opts.cap ?? "round",
            weight,
          });
        }
        const fill = opts.fill ? C.stroke : "none";
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${sw}/>`;
      },
    };
    this.entries.push(entry);
    return new CircleNode(inner, entry);
  }

  line(
    from: Point | Shape,
    to: Point | Shape,
    opts: LineOpts = {},
  ): SceneNode {
    const fromShape = isShape(from);
    const toShape = isShape(to);
    const cap = opts.cap ?? (fromShape || toShape ? "butt" : "round");

    const fromCenter = fromShape ? from.bounds.center : from;
    const toCenter = toShape ? to.bounds.center : to;
    const p1 = fromShape ? from.edgeFrom(toCenter) : from;
    const p2 = toShape ? to.edgeFrom(fromCenter) : to;

    const inner = pointPairShape(p1, p2);
    const entry: SceneEntry = {
      shape: inner,
      hidden: false,
      isAside: true,
      render: () => {
        const weight = pickWeight(opts);
        const sw = strokeAttrs(weight, opts.muted);
        if (opts.dashed) {
          return renderDashedSegments(lineToSegments(p1, p2), {
            mode: "open",
            stroke: sw,
            cap,
            weight,
          });
        }
        return `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" ${sw} stroke-linecap="${cap}"/>`;
      },
    };
    this.entries.push(entry);
    return new SceneNode(inner, entry);
  }

  /**
   * Connected line segments through a sequence of points (or a Path).
   * Drawn as a single SVG path so corners join cleanly.
   */
  polyline(
    points: readonly Point[] | Path,
    opts: PolylineOpts = {},
  ): SceneNode {
    const pts: readonly Point[] =
      "points" in points ? points.points : points;
    if (pts.length < 2) {
      const stub = pointAsShape(pts[0] ?? { x: 0, y: 0 });
      const entry: SceneEntry = {
        shape: stub,
        hidden: true,
        isAside: true,
        render: () => "",
      };
      this.entries.push(entry);
      return new SceneNode(stub, entry);
    }
    const cap = opts.cap ?? "round";
    const join = opts.join ?? "miter";

    const inner = pointsBoundsShape(pts);

    const d = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`)
      .join(" ");

    const entry: SceneEntry = {
      shape: inner,
      hidden: false,
      isAside: true,
      render: () => {
        const weight = pickWeight(opts);
        const sw = strokeAttrs(weight, opts.muted);
        if (opts.dashed) {
          return renderDashedSegments(polylineToSegments(pts), {
            mode: "open",
            stroke: sw,
            join: `stroke-linejoin="${join}"`,
            cap,
            weight,
          });
        }
        return `<path d="${d}" fill="none" ${sw} stroke-linecap="${cap}" stroke-linejoin="${join}"/>`;
      },
    };
    this.entries.push(entry);
    return new SceneNode(inner, entry);
  }

  /**
   * Arrow between two points or shapes. Endpoints (Point or Shape) are
   * uniformly inflated by `gap` (plus internal compensation for the
   * arrowhead and round-cap optical bias) and the arrow is drawn between
   * the resulting boundary points. Points are treated as zero-radius
   * circles so the same expand-and-clip logic applies to all inputs.
   */
  arrow(
    from: Point | Shape,
    to: Point | Shape,
    opts: ArrowOpts = {},
  ): SceneNode {
    const gap = opts.gap ?? C.arrowGap;
    const fromShape = isShape(from) ? from : pointAsShape(from);
    const toShape = isShape(to) ? to : pointAsShape(to);

    // FROM end uses a round cap which optically reads SHORTER than its
    // mathematical extent, so we push out by `gap + weight` (rather than
    // `gap + weight/2`) to land on a visual gap that feels symmetric to
    // the arrowhead end.
    const expandedFrom = fromShape.expand(gap + C.weight);
    // TO end's arrowhead extends `marker.w` forward of the line endpoint,
    // so subtracting that plus gap puts the visible tip `gap` units before
    // the target.
    const expandedTo = toShape.expand(gap + C.arrowMarker.w);

    const p1 = expandedFrom.edgeFrom(expandedTo.bounds.center);
    const p2 = expandedTo.edgeFrom(expandedFrom.bounds.center);

    const inner = pointPairShape(p1, p2);
    const entry: SceneEntry = {
      shape: inner,
      hidden: false,
      isAside: true,
      render: () => {
        const sw = strokeAttrs(C.weight);
        return `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" ${sw} stroke-linecap="round" marker-end="url(#${C.arrowMarkerId})"/>`;
      },
    };
    this.entries.push(entry);
    const node = new SceneNode(inner, entry);

    if (opts.label) {
      const m = midpoint(p1, p2);
      this.label(
        { x: m.x, y: m.y - C.arrowLabelOffset },
        opts.label,
        { size: C.arrowLabelSize },
      );
    }

    return node;
  }

  label(
    at: Point | Heading,
    content: Content,
    opts: LabelOpts = {},
  ): SceneNode {
    const size = opts.size ?? C.fontSize;
    const anchor = opts.anchor ?? "middle";
    const baseline =
      opts.baseline === "top"
        ? "hanging"
        : opts.baseline === "bottom"
          ? "alphabetic"
          : "central";
    // Default rotation: if target carries a tangent angle, use it.
    const rotateRad =
      opts.rotate ?? (isHeading(at) ? at.angle : 0);
    const rotateDeg = (rotateRad * 180) / Math.PI;
    const transform = rotateRad
      ? ` transform="rotate(${rotateDeg} ${at.x} ${at.y})"`
      : "";

    const approxText =
      typeof content === "string" ? content : flattenText(content);
    const w = size * Math.max(1, approxText.length) * C.charWidth;
    const inner = pointBoundsShape(at, w, size);

    const renderedText = opts.bold
      ? renderContent(content instanceof Text ? content.bold() : t(content).bold())
      : renderContent(content);

    const entry: SceneEntry = {
      shape: inner,
      hidden: false,
      isAside: true,
      render: () =>
        `<text x="${at.x}" y="${at.y}" font-family="${C.font}" font-size="${size}" fill="${C.stroke}" text-anchor="${anchor}" dominant-baseline="${baseline}"${transform}>${renderedText}</text>`,
    };
    this.entries.push(entry);
    return new SceneNode(inner, entry);
  }

  /**
   * A horizontal row of cells sharing a common boundary.
   * Outer boundary is one closed rounded path; inner dividers are
   * separate strokes so junctions render crisply.
   */
  row(items: RowItem[], opts: RowOpts): RowNode {
    const totalUnits = items.reduce((s, i) => s + i.units, 0);
    const unitWidth =
      opts.unitWidth ??
      (opts.width !== undefined
        ? opts.width / totalUnits
        : (() => {
            throw new Error("row: must provide `unitWidth` or `width`");
          })());
    const totalW = totalUnits * unitWidth;
    const slotWidths = items.map((i) => i.units * unitWidth);

    const slotXs: number[] = [];
    let cur = opts.x;
    for (const w of slotWidths) {
      slotXs.push(cur);
      cur += w;
    }

    const rowB = bounds(opts.x, opts.y, totalW, opts.h);
    const slots: RectShape[] = items.map((_, i) =>
      rectShape(bounds(slotXs[i], opts.y, slotWidths[i], opts.h)),
    );

    const inner: RowShape = {
      bounds: rowB,
      edgeFrom: (from) => rectEdgeFrom(rowB, from),
      expand: (n) => rectShape(expandBounds(rowB, n), C.corner + n),
      contract: (n) => rectShape(expandBounds(rowB, -n), Math.max(0, C.corner - n)),
      translate: (dx, dy) =>
        rectShape(bounds(rowB.x + dx, rowB.y + dy, rowB.w, rowB.h), C.corner),
      slot: (i) => slots[i],
    };

    const entry: SceneEntry = {
      shape: inner,
      hidden: false,
      isAside: false,
      render: () => {
        const sw = strokeAttrs(C.weight);
        const swThin = strokeAttrs(C.thinWeight);
        let svg = `<path d="${rrPath(opts.x, opts.y, totalW, opts.h, C.corner)}" fill="none" ${sw}/>`;
        for (let i = 1; i < items.length; i++) {
          const x = slotXs[i];
          const isDashed = items[i - 1].divider === "dashed";
          const top = { x, y: opts.y };
          const bot = { x, y: opts.y + opts.h };
          if (isDashed) {
            svg += renderDashedSegments(lineToSegments(top, bot), {
              mode: "open",
              stroke: swThin,
              cap: "round",
              weight: C.thinWeight,
            });
          } else {
            svg += `<line x1="${x}" y1="${opts.y}" x2="${x}" y2="${
              opts.y + opts.h
            }" ${sw} stroke-linecap="butt"/>`;
          }
        }
        return svg;
      },
    };
    this.entries.push(entry);
    return new RowNode(inner, entry);
  }

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------

  render(svgEl: SVGSVGElement): void {
    const contentBounds = this.entries
      .filter((e) => !e.hidden && !e.isAside)
      .map((e) => e.shape.bounds);

    const vb =
      contentBounds.length > 0
        ? unionBounds(...contentBounds)
        : bounds(0, 0, 0, 0);
    const padded = bounds(
      vb.x - this.padLeft,
      vb.y - this.padTop,
      vb.w + this.padLeft + this.padRight,
      vb.h + this.padTop + this.padBottom,
    );

    svgEl.setAttribute(
      "viewBox",
      `${padded.x} ${padded.y} ${padded.w} ${padded.h}`,
    );
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    // Set explicit width/height so the SVG has intrinsic dimensions
    // matching the viewBox. Otherwise some flex contexts fall back to
    // the SVG default 300x150 and the diagram renders smaller than authored.
    svgEl.setAttribute("width", String(padded.w));
    svgEl.setAttribute("height", String(padded.h));

    const body = this.entries
      .filter((e) => !e.hidden)
      .map((e) => e.render())
      .join("");
    svgEl.innerHTML = ARROW_DEFS + body;
  }
}

// =====================================================================
// Internal helpers — small shape factories used by primitives that
// don't have a "natural" geometric type (lines, polylines, labels).
// =====================================================================

/** Bounding box of a 2-point pair. */
function pointPairShape(p1: Point, p2: Point): Shape {
  const b = bounds(
    Math.min(p1.x, p2.x),
    Math.min(p1.y, p2.y),
    Math.abs(p2.x - p1.x),
    Math.abs(p2.y - p1.y),
  );
  return {
    bounds: b,
    edgeFrom: () => p1,
    expand: (n) => rectShape(expandBounds(b, n), 0),
    contract: (n) => rectShape(expandBounds(b, -n), 0),
    translate: (dx, dy) =>
      pointPairShape({ x: p1.x + dx, y: p1.y + dy }, { x: p2.x + dx, y: p2.y + dy }),
  };
}

function pointsBoundsShape(points: readonly Point[]): Shape {
  let xMin = Infinity,
    xMax = -Infinity,
    yMin = Infinity,
    yMax = -Infinity;
  for (const p of points) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  const b = bounds(xMin, yMin, xMax - xMin, yMax - yMin);
  return {
    bounds: b,
    edgeFrom: () => points[0],
    expand: (n) => rectShape(expandBounds(b, n), 0),
    contract: (n) => rectShape(expandBounds(b, -n), 0),
    translate: (dx, dy) =>
      pointsBoundsShape(points.map((p) => ({ x: p.x + dx, y: p.y + dy }))),
  };
}

function pointBoundsShape(p: Point, w: number, h: number): Shape {
  const b = bounds(p.x - w / 2, p.y - h / 2, w, h);
  return {
    bounds: b,
    edgeFrom: () => p,
    expand: (n) => rectShape(expandBounds(b, n), 0),
    contract: (n) => rectShape(expandBounds(b, -n), 0),
    translate: (dx, dy) =>
      pointBoundsShape({ x: p.x + dx, y: p.y + dy }, w, h),
  };
}
