import { computed, effect, signal, type ReadonlySignal, type Signal } from "./signal";
import { bounds, unionBounds, type Bounds, type Vec } from "./bounds";
import { Point } from "./point";

export const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Pivot expressed as a normalized coordinate within the shape's bounds:
 * `{ x: 0, y: 0 }` is top-left, `{ x: 1, y: 1 }` is bottom-right,
 * `{ x: 0.5, y: 0.5 }` is center. Off-axis values (e.g. `{ x: 0.25, y: 0.5 }`)
 * are valid — no string-enum gating.
 *
 * The `Pivot` namespace exposes named common values:
 *   `Pivot.TL`, `Pivot.CENTER`, etc.
 */
export interface Pivot {
  x: number;
  y: number;
}

export const Pivot = Object.freeze({
  TL: { x: 0, y: 0 } as Pivot,
  TR: { x: 1, y: 0 } as Pivot,
  BL: { x: 0, y: 1 } as Pivot,
  BR: { x: 1, y: 1 } as Pivot,
  TOP: { x: 0.5, y: 0 } as Pivot,
  BOTTOM: { x: 0.5, y: 1 } as Pivot,
  LEFT: { x: 0, y: 0.5 } as Pivot,
  RIGHT: { x: 1, y: 0.5 } as Pivot,
  CENTER: { x: 0.5, y: 0.5 } as Pivot,
});

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
  readonly translate: Signal<Vec> = signal({ x: 0, y: 0 });
  readonly rotate: Signal<number> = signal(0);
  readonly scale: Signal<Vec> = signal({ x: 1, y: 1 });
  readonly pivot: Signal<Pivot> = signal<Pivot>(Pivot.CENTER);
  readonly opacity: Signal<number> = signal(1);

  /** Bounds memo — set at construction via `boundsFn`, or defaults to
   *  the union of children's bounds. Lazy: only computes when read. */
  readonly bounds: ReadonlySignal<Bounds>;

  /** Anchors — reactive Points derived from bounds. Allocated eagerly
   *  in the constructor; cheap (each is two thunks). Use for relative
   *  positioning: `s(line(boxA.right, boxB.left))`. */
  readonly tl: Point;
  readonly tr: Point;
  readonly bl: Point;
  readonly br: Point;
  readonly top: Point;
  readonly bottom: Point;
  readonly left: Point;
  readonly right: Point;
  readonly center: Point;

  protected disposers: (() => void)[] = [];
  private children: Shape[] = [];
  private childrenVersion = signal(0);

  constructor(intrinsicType?: string, boundsFn?: () => Bounds) {
    this.el = document.createElementNS(SVG_NS, "g") as SVGGElement;
    if (intrinsicType) {
      this.intrinsic = document.createElementNS(SVG_NS, intrinsicType);
      this.el.appendChild(this.intrinsic);
    }

    // Bounds: explicit fn from a shape factory, or the children-union
    // default (used by groups and any shape with no own geometry).
    this.bounds = computed(
      boundsFn ??
        (() => {
          this.childrenVersion.value;
          const bs = this.children.map((c) => c.bounds.value);
          return bs.length ? unionBounds(...bs) : bounds(0, 0, 0, 0);
        }),
    );

    // Anchors. Each is a reactive Point reading from `bounds`. Two
    // thunks per anchor; total ~18 thunks per shape. Negligible at
    // diagram scale.
    this.tl = this.anchor(Pivot.TL);
    this.tr = this.anchor(Pivot.TR);
    this.bl = this.anchor(Pivot.BL);
    this.br = this.anchor(Pivot.BR);
    this.top = this.anchor(Pivot.TOP);
    this.bottom = this.anchor(Pivot.BOTTOM);
    this.left = this.anchor(Pivot.LEFT);
    this.right = this.anchor(Pivot.RIGHT);
    this.center = this.anchor(Pivot.CENTER);

    // Transform effect: short-circuit when identity so we don't read
    // bounds (and thus don't force the bounds memo to evaluate).
    this.disposers.push(
      effect(() => {
        const t = this.translate.value;
        const r = this.rotate.value;
        const sc = this.scale.value;
        if (t.x === 0 && t.y === 0 && r === 0 && sc.x === 1 && sc.y === 1) {
          this.el.setAttribute("transform", "");
          return;
        }
        const pivot = resolvePivot(this.pivot.value, this.bounds.value);
        this.el.setAttribute("transform", composeTransform(t, r, sc, pivot));
      }),
    );

    // Opacity effect on the wrapper. Always set up; user mutates
    // `shape.opacity.value` (directly or via fadeIn/tween/bindOpacity).
    this.disposers.push(
      effect(() => {
        this.el.setAttribute("opacity", String(this.opacity.value));
      }),
    );
  }

  /**
   * Bind one SVG attribute. Pass a function for reactive bindings (an
   * effect re-runs whenever its tracked signals change), or a plain
   * value for one-time set (no effect — saves a closure).
   *
   * Lands on the intrinsic by default, or the wrapper if there is no
   * intrinsic. Pass `target: "wrapper"` to force the `<g>`.
   */
  attr(
    name: string,
    value: string | number | (() => string | number),
    target: "intrinsic" | "wrapper" = "intrinsic",
  ): void {
    const el =
      target === "intrinsic" && this.intrinsic ? this.intrinsic : this.el;
    if (typeof value === "function") {
      this.disposers.push(
        effect(() => {
          el.setAttribute(name, String(value()));
        }),
      );
    } else {
      el.setAttribute(name, String(value));
    }
  }

  /** Track an arbitrary disposer to run on dispose. */
  track(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  /**
   * Reactively bind opacity to a function. Writes to `shape.opacity`
   * each time the function's tracked signals change.
   *
   * Note: don't combine with `fadeIn`/`fadeOut`/`tween(shape.opacity, ...)`
   * on the same shape — they all write to `shape.opacity` and will fight.
   * For animatable opacity that also depends on outside state, wrap the
   * shape in a group and bind the group's opacity instead.
   */
  bindOpacity(fn: () => number): this {
    this.track(
      effect(() => {
        this.opacity.value = fn();
      }),
    );
    return this;
  }

  /** Arbitrary-position anchor — normalized 0..1 within bounds. The
   *  named getters (`tl`, `center`, etc.) cover the common cases; use
   *  this for off-axis anchors like `{ x: 0.25, y: 0.5 }`. Each call
   *  allocates a fresh Point (cheap, two thunks). */
  anchor(at: Pivot): Point {
    return new Point(
      () => {
        const b = this.bounds.value;
        return b.x + at.x * b.w;
      },
      () => {
        const b = this.bounds.value;
        return b.y + at.y * b.h;
      },
    );
  }

  // ── Children ────────────────────────────────────────────────────────

  /** Add one or more child shapes. Single arg returns the child;
   *  multi-arg returns the tuple. */
  add<T extends Shape>(child: T): T;
  add<T extends Shape[]>(...children: T): T;
  add(...children: Shape[]): Shape | Shape[] {
    for (const child of children) {
      this.children.push(child);
      this.el.appendChild(child.el);
    }
    if (children.length > 0) this.childrenVersion.value += 1;
    return children.length === 1 ? children[0] : children;
  }

  /** Remove and dispose one or more child shapes. */
  remove(...toRemove: Shape[]): void {
    let changed = false;
    for (const child of toRemove) {
      const i = this.children.indexOf(child);
      if (i < 0) continue;
      this.children.splice(i, 1);
      child.dispose();
      changed = true;
    }
    if (changed) this.childrenVersion.value += 1;
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

function resolvePivot(p: Pivot, b: Bounds): Vec {
  return { x: b.x + p.x * b.w, y: b.y + p.y * b.h };
}

function composeTransform(
  t: Vec,
  r: number,
  s: Vec,
  pivot: Vec,
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
