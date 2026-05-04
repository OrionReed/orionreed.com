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
  polar,
  rectEdgeFrom,
  unionBounds,
} from "./geom";

// Stroke weights are in CSS pixels (non-scaling); other constants are
// in scene units.
const C = {
  stroke: "var(--text-color)",
  weight: 2,
  thinWeight: 1.5,
  corner: 2,
  dash: 4,
  gap: 3,
  font: "'New CM', monospace",
  fontSize: 14,
  charWidth: 0.6, // approximate, for rough label bounds (SVG can't measure)
  subFontSize: "0.75em",
  arrowMarkerId: "draw-arrow",
  // refX=0 anchors the line at the arrowhead BASE (widest point), so the
  // line never visually exceeds the head. `round` rounds all 3 vertices
  // for an inked-pen feel.
  arrowMarker: { w: 10, h: 7, refX: 0, refY: 3.5, round: 0.9 },
  arrowGap: 4,
  arrowLabelSize: 11,
  arrowLabelOffset: 4,
  mutedOpacity: 0.5,
};

const NSS = 'vector-effect="non-scaling-stroke"';

// Resolve effective opacity: explicit `opacity` wins over `muted`. Returns
// undefined when fully opaque so we can omit the attribute.
function resolveOpacity(opts: {
  muted?: boolean;
  opacity?: number;
}): number | undefined {
  if (opts.opacity !== undefined) return opts.opacity;
  if (opts.muted) return C.mutedOpacity;
  return undefined;
}

function strokeAttrs(weight: number, opts: CommonOpts = {}): string {
  const o = resolveOpacity(opts);
  const opAttr = o !== undefined ? ` opacity="${o}"` : "";
  return `stroke="${C.stroke}" stroke-width="${weight}" ${NSS}${opAttr}`;
}

function pickWeight(opts: { thin?: boolean }): number {
  return opts.thin ? C.thinWeight : C.weight;
}

// Chainable rich text composed of nested styled spans.

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

// Pure geometric values. `edgeFrom` returns the boundary point along
// the ray from the shape's center toward `from`.

export interface Shape {
  readonly bounds: Bounds;
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

// Round caps mathematically extend by stroke-width/2 but visually read
// SHORTER than that. This factor (0..1) compensates; 0.5 by eye.
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

// Uniform abstraction for walking line + arc shapes and rendering dash
// positions as explicit <path> commands. Sidesteps browser
// stroke-dasharray quirks for pixel-perfect dashing.

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

// Pie wedge with a hole. M outer-start → A outer-arc → L inward →
// A inner-arc-reversed → Z. Sweep flags encode SVG-y-down rotation.
function annularSectorPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: Angle,
  a1: Angle,
): string {
  const span = Math.abs(a1 - a0);
  const largeArc = span > Math.PI ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  const back = sweep ? 0 : 1;
  const o0 = polar(cx, cy, rOuter, a0);
  const o1 = polar(cx, cy, rOuter, a1);
  const i1 = polar(cx, cy, rInner, a1);
  const i0 = polar(cx, cy, rInner, a0);
  return `M ${o0.x},${o0.y} A ${rOuter},${rOuter} 0 ${largeArc} ${sweep} ${o1.x},${o1.y} L ${i1.x},${i1.y} A ${rInner},${rInner} 0 ${largeArc} ${back} ${i0.x},${i0.y} Z`;
}

// Triangle with all three vertices rounded via quadratic beziers (the
// sharp corner becomes the control point). Filled shape, genuinely round.
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

interface SceneEntry {
  shape: Shape;
  hidden: boolean;
  isAside: boolean;
  render(): string;
}

// `aside()` excludes from scene bounds (no viewBox expansion); `hide()`
// does that AND skips render. Both return `this` for chaining.
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

interface CommonOpts {
  muted?: boolean;
  thin?: boolean;
  /** 0..1. Overrides `muted`. Omit / 1 = fully opaque. */
  opacity?: number;
}

// true → fill with C.stroke. string → fill with that color (e.g. an Ink).
// false/omitted → no fill.
export type Fill = boolean | string;

export interface RectOpts extends CommonOpts {
  dashed?: boolean;
  fill?: Fill;
  corner?: number;
  cap?: "butt" | "round";
}

export interface CircleOpts extends CommonOpts {
  fill?: Fill;
  dashed?: boolean;
  cap?: "butt" | "round";
}

export interface AnnularSectorOpts extends CommonOpts {
  fill?: Fill;
}

export interface LineOpts extends CommonOpts {
  dashed?: boolean;
  // Default: "round" for free Point ends, "butt" when intersecting a Shape.
  cap?: "round" | "butt";
}

export interface PolylineOpts extends CommonOpts {
  dashed?: boolean;
  cap?: "round" | "butt";
  join?: "miter" | "round" | "bevel";
}

export interface ArrowOpts {
  label?: Content;
  // Visual gap at each end. Internal compensation handles arrowhead width
  // and round-cap optical bias — caller doesn't need to know about either.
  gap?: number;
}

export interface LabelOpts {
  size?: number;
  anchor?: "start" | "middle" | "end";
  baseline?: "top" | "middle" | "bottom";
  // Radians. If omitted and the target is a Heading, defaults to its angle.
  rotate?: Angle;
  bold?: boolean;
  muted?: boolean;
  /** 0..1. Overrides `muted`. Omit / 1 = fully opaque. */
  opacity?: number;
}

export interface RowItem {
  units: number;
  // Style of the divider AFTER this item. Last item has no divider.
  divider?: "solid" | "dashed";
}

export interface RowOpts {
  x: number;
  y: number;
  h: number;
  unitWidth?: number;
  width?: number;
}

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

export interface SceneSize {
  /** Width of the user coordinate system the caller draws into. */
  w: number;
  /** Height of the user coordinate system the caller draws into. */
  h: number;
}

export class Scene {
  private entries: SceneEntry[] = [];
  private padTop: number;
  private padBottom: number;
  private padLeft: number;
  private padRight: number;
  private size?: SceneSize;

  constructor(opts: { padding?: Padding; size?: SceneSize } = {}) {
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
    this.size = opts.size;
  }

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
          const fill = typeof opts.fill === "string" ? opts.fill : C.stroke;
          // Inline style (not fill="") because SVG attributes don't
          // recurse var()/calc() inside nested CSS functions.
          const o = resolveOpacity(opts);
          const opacity = o !== undefined ? `;opacity:${o}` : "";
          return `<path d="${rrPath(x, y, w, h, corner)}" style="fill:${fill}${opacity}"/>`;
        }
        const weight = pickWeight(opts);
        const sw = strokeAttrs(weight, opts);
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
        const sw = strokeAttrs(weight, opts);
        if (opts.dashed && !opts.fill) {
          return renderDashedSegments(circleToSegments(cx, cy, r), {
            mode: "closed",
            stroke: sw,
            cap: opts.cap ?? "round",
            weight,
          });
        }
        const fill = opts.fill
          ? typeof opts.fill === "string"
            ? opts.fill
            : C.stroke
          : "none";
        const o = resolveOpacity(opts);
        const fillStyle = o !== undefined ? `fill:${fill};opacity:${o}` : `fill:${fill}`;
        return `<circle cx="${cx}" cy="${cy}" r="${r}" style="${fillStyle}" ${sw}/>`;
      },
    };
    this.entries.push(entry);
    return new CircleNode(inner, entry);
  }

  // Pie wedge with a hole. Aside by default — typically rendered next to
  // a containing circle outline that drives viewBox bounds.
  annularSector(
    cx: number,
    cy: number,
    rOuter: number,
    rInner: number,
    a0: Angle,
    a1: Angle,
    opts: AnnularSectorOpts = {},
  ): SceneNode {
    const d = annularSectorPath(cx, cy, rOuter, rInner, a0, a1);
    const inner = pointBoundsShape({ x: cx, y: cy }, 2 * rOuter, 2 * rOuter);
    const entry: SceneEntry = {
      shape: inner,
      hidden: false,
      isAside: true,
      render: () => {
        if (opts.fill) {
          const fill = typeof opts.fill === "string" ? opts.fill : C.stroke;
          const o = resolveOpacity(opts);
          const opacity = o !== undefined ? `;opacity:${o}` : "";
          return `<path d="${d}" style="fill:${fill}${opacity}"/>`;
        }
        const weight = pickWeight(opts);
        const sw = strokeAttrs(weight, opts);
        return `<path d="${d}" fill="none" ${sw}/>`;
      },
    };
    this.entries.push(entry);
    return new SceneNode(inner, entry);
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
        const sw = strokeAttrs(weight, opts);
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
        const sw = strokeAttrs(weight, opts);
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

  // Endpoints are treated as zero-radius circles so the same
  // expand-and-clip logic works for both Point and Shape inputs.
  arrow(
    from: Point | Shape,
    to: Point | Shape,
    opts: ArrowOpts = {},
  ): SceneNode {
    const gap = opts.gap ?? C.arrowGap;
    const fromShape = isShape(from) ? from : pointAsShape(from);
    const toShape = isShape(to) ? to : pointAsShape(to);

    // From end has a round cap that optically reads SHORTER than its
    // mathematical extent, so push out by gap + weight (not gap + weight/2)
    // so the visual gap matches the arrowhead end.
    const expandedFrom = fromShape.expand(gap + C.weight);
    // Arrowhead extends marker.w past the line endpoint; subtract that.
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
    const rotateRad = opts.rotate ?? (isHeading(at) ? at.angle : 0);
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

    const o = resolveOpacity(opts);
    const opacityAttr = o !== undefined ? ` opacity="${o}"` : "";

    const entry: SceneEntry = {
      shape: inner,
      hidden: false,
      isAside: true,
      render: () =>
        `<text x="${at.x}" y="${at.y}" font-family="${C.font}" font-size="${size}" fill="${C.stroke}" text-anchor="${anchor}" dominant-baseline="${baseline}"${transform}${opacityAttr}>${renderedText}</text>`,
    };
    this.entries.push(entry);
    return new SceneNode(inner, entry);
  }

  // Horizontal row of cells. Outer boundary is one closed rounded path;
  // inner dividers are separate strokes so corners render crisply.
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

  render(svgEl: SVGSVGElement): void {
    // When `size` is set, the viewBox is fixed to [0..w, 0..h] (plus
    // padding); content positions are caller's responsibility, and the
    // viewBox no longer jitters as shapes appear/disappear during animation.
    // When omitted, fall back to auto-fitting the union of non-aside
    // content bounds.
    const vb = this.size
      ? bounds(0, 0, this.size.w, this.size.h)
      : (() => {
          const contentBounds = this.entries
            .filter((e) => !e.hidden && !e.isAside)
            .map((e) => e.shape.bounds);
          return contentBounds.length > 0
            ? unionBounds(...contentBounds)
            : bounds(0, 0, 0, 0);
        })();
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
    // Set explicit width/height so flex contexts don't fall back to
    // SVG's default 300x150.
    svgEl.setAttribute("width", String(padded.w));
    svgEl.setAttribute("height", String(padded.h));

    const body = this.entries
      .filter((e) => !e.hidden)
      .map((e) => e.render())
      .join("");
    svgEl.innerHTML = ARROW_DEFS + body;
  }
}

// Shape factories for primitives that don't have a "natural" geometric
// type (lines, polylines, labels). Bounds-only; expand returns a rect.

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
