import { effect, signal, type ReadonlySignal, type Signal } from "./signal";
import { bounds, unionBounds, type Bounds, type Point } from "../elements/geom";

export const SVG_NS = "http://www.w3.org/2000/svg";

export type PivotKey =
  | "center"
  | "tl"
  | "tr"
  | "bl"
  | "br"
  | "top"
  | "bottom"
  | "left"
  | "right";
export type Pivot = Point | PivotKey;

/**
 * Universal scene-graph node. Every shape is wrapped in an SVG `<g>`
 * (transforms compose via group inheritance). A shape may have an
 * intrinsic SVG element inside the wrapper (`<line>`, `<rect>`, etc.)
 * and/or child shapes — children sit alongside the intrinsic and
 * inherit the wrapper's transform and opacity.
 *
 * "Group" is just `new Shape()` with no intrinsic — an empty container
 * that bundles children for transform inheritance and lifecycle.
 *
 * Custom shapes are typically a free function that constructs a Shape
 * with an intrinsic type and binds the SVG attrs that matter for its
 * geometry.
 */
export class Shape {
  /** Wrapper `<g>` — owns the transform, opacity, and children. */
  readonly el: SVGGElement;
  /** Optional intrinsic — `<line>`, `<rect>`, etc. */
  readonly intrinsic?: SVGElement;

  /** Animatable common props as plain preact signals. */
  readonly translate: Signal<Point> = signal({ x: 0, y: 0 });
  readonly rotate: Signal<number> = signal(0);
  readonly scale: Signal<Point> = signal({ x: 1, y: 1 });
  readonly pivot: Signal<Pivot> = signal<Pivot>("center");
  readonly opacity: Signal<number> = signal(1);

  private _bounds: Signal<Bounds> = signal<Bounds>(bounds(0, 0, 0, 0));
  readonly bounds: ReadonlySignal<Bounds> = this._bounds;

  protected disposers: (() => void)[] = [];
  private children: Shape[] = [];
  private childrenVersion = signal(0);
  private boundsDisposer?: () => void;

  constructor(intrinsicType?: string) {
    this.el = document.createElementNS(SVG_NS, "g") as SVGGElement;
    if (intrinsicType) {
      this.intrinsic = document.createElementNS(SVG_NS, intrinsicType);
      this.el.appendChild(this.intrinsic);
    }

    this.disposers.push(
      effect(() => {
        const t = composeTransform(
          this.translate.value,
          this.rotate.value,
          this.scale.value,
          resolvePivot(this.pivot.value, this._bounds.value),
        );
        this.el.setAttribute("transform", t);
      }),
    );

    this.disposers.push(
      effect(() => {
        this.el.setAttribute("opacity", String(this.opacity.value));
      }),
    );

    // Default bounds = union of children. Subclasses with intrinsic
    // geometry should call `setBounds(...)` to override.
    this.setBounds(() => {
      this.childrenVersion.value;
      const bs = this.children.map((c) => c.bounds.value);
      return bs.length ? unionBounds(...bs) : bounds(0, 0, 0, 0);
    });
  }

  /**
   * Bind one SVG attribute reactively. Lands on the intrinsic by
   * default, or the wrapper if there is no intrinsic. Pass
   * `target: "wrapper"` to force the `<g>`.
   */
  attr(
    name: string,
    value: () => string | number,
    target: "intrinsic" | "wrapper" = "intrinsic",
  ): void {
    const el =
      target === "intrinsic" && this.intrinsic ? this.intrinsic : this.el;
    this.disposers.push(
      effect(() => {
        el.setAttribute(name, String(value()));
      }),
    );
  }

  /** Drive the bounds memo. Replaces any prior bounds source. */
  setBounds(fn: () => Bounds): void {
    if (this.boundsDisposer) {
      this.boundsDisposer();
      const i = this.disposers.indexOf(this.boundsDisposer);
      if (i >= 0) this.disposers.splice(i, 1);
    }
    const dispose = effect(() => {
      this._bounds.value = fn();
    });
    this.boundsDisposer = dispose;
    this.disposers.push(dispose);
  }

  /** Track an arbitrary disposer to run on dispose. */
  track(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  add<T extends Shape>(child: T): T {
    this.children.push(child);
    this.el.appendChild(child.el);
    this.childrenVersion.value += 1;
    return child;
  }

  remove(child: Shape): void {
    const i = this.children.indexOf(child);
    if (i < 0) return;
    this.children.splice(i, 1);
    child.dispose();
    this.childrenVersion.value += 1;
  }

  clear(): void {
    this.children.forEach((c) => c.dispose());
    this.children = [];
    this.childrenVersion.value += 1;
  }

  dispose(): void {
    this.children.forEach((c) => c.dispose());
    this.children = [];
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.el.remove();
  }
}

function resolvePivot(pivot: Pivot, b: Bounds): Point {
  if (typeof pivot !== "string") return pivot;
  switch (pivot) {
    case "tl":
      return { x: b.x, y: b.y };
    case "tr":
      return { x: b.x + b.w, y: b.y };
    case "bl":
      return { x: b.x, y: b.y + b.h };
    case "br":
      return { x: b.x + b.w, y: b.y + b.h };
    case "top":
      return { x: b.x + b.w / 2, y: b.y };
    case "bottom":
      return { x: b.x + b.w / 2, y: b.y + b.h };
    case "left":
      return { x: b.x, y: b.y + b.h / 2 };
    case "right":
      return { x: b.x + b.w, y: b.y + b.h / 2 };
    case "center":
    default:
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }
}

function composeTransform(
  t: Point,
  r: number,
  s: Point,
  pivot: Point,
): string {
  const parts: string[] = [];
  if (t.x !== 0 || t.y !== 0) parts.push(`translate(${t.x} ${t.y})`);
  const hasRot = r !== 0;
  const hasScale = s.x !== 1 || s.y !== 1;
  if (hasRot || hasScale) {
    parts.push(`translate(${pivot.x} ${pivot.y})`);
    if (hasRot) parts.push(`rotate(${(r * 180) / Math.PI})`);
    if (hasScale) parts.push(`scale(${s.x} ${s.y})`);
    parts.push(`translate(${-pivot.x} ${-pivot.y})`);
  }
  return parts.join(" ");
}
