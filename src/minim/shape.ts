import {
  bindArg,
  computed,
  effect,
  signal,
  Signal,
  type Arg,
} from "./signal";
import {
  Bounds,
  Pivot,
  aabb,
  aabbEdgeFrom,
  unionAABB,
  type AABB,
  type Vec,
} from "./bounds";
import { Point, pt } from "./point";
import type { Segment } from "./dashed";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Construction-time options for any Shape. Animatable props accept
 *  `Arg<T>`: a value (set once) or a Signal (caller owns it — animations
 *  write through). For derived inputs, wrap in `computed(() => ...)`.
 *
 *  `aside` excludes this shape from its parent's children-union default
 *  bounds (and so transitively from auto-fit). Its own `bounds` is
 *  unaffected — useful for decorative overlays (highlights, halos)
 *  that shouldn't extend the diagram's natural extent. */
export interface ShapeOpts {
  translate?: Arg<Vec>;
  rotate?: Arg<number>;
  scale?: Arg<Vec>;
  pivot?: Arg<Pivot>;
  opacity?: Arg<number>;
  aside?: boolean;
}

/** Universal scene-graph node. Wraps an SVG `<g>` (transform + opacity
 *  + children); concrete subclasses add an intrinsic SVG element and
 *  geometry-specific vocabulary. A bare `new Shape()` is a group. */
export class Shape {
  readonly el: SVGGElement;
  readonly intrinsic?: SVGElement;

  readonly translate: Signal<Vec>;
  readonly rotate: Signal<number>;
  readonly scale: Signal<Vec>;
  readonly pivot: Signal<Pivot>;
  readonly opacity: Signal<number>;
  readonly bounds: Bounds;
  readonly aside: boolean;

  protected disposers: (() => void)[] = [];
  private children: Shape[] = [];
  private childrenVersion = signal(0);

  constructor(
    intrinsicType?: string,
    boundsFn?: () => AABB,
    opts: ShapeOpts = {},
  ) {
    this.el = document.createElementNS(SVG_NS, "g") as SVGGElement;
    if (intrinsicType) {
      this.intrinsic = document.createElementNS(SVG_NS, intrinsicType);
      this.el.appendChild(this.intrinsic);
    }

    this.translate = bindArg(opts.translate, { x: 0, y: 0 });
    this.rotate = bindArg(opts.rotate, 0);
    this.scale = bindArg(opts.scale, { x: 1, y: 1 });
    this.pivot = bindArg(opts.pivot, Pivot.CENTER);
    this.opacity = bindArg(opts.opacity, 1);
    this.aside = opts.aside ?? false;

    // Bounds: explicit fn from a subclass, else union of non-aside
    // children — aside shapes don't contribute to layout/fit.
    this.bounds = new Bounds(
      computed(
        boundsFn ??
          (() => {
            this.childrenVersion.value;
            const bs = this.children
              .filter((c) => !c.aside)
              .map((c) => c.bounds.value);
            return bs.length ? unionAABB(...bs) : aabb(0, 0, 0, 0);
          }),
      ),
    );

    // Transform: short-circuit identity to avoid forcing the bounds memo.
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

    this.disposers.push(
      effect(() => {
        this.el.setAttribute("opacity", String(this.opacity.value));
      }),
    );
  }

  /** Analytic perimeter point in the direction of `toward`. Default:
   *  AABB-edge math. Subclasses with tighter geometry override. */
  boundary(toward: Point): Point {
    const proj = computed(() => aabbEdgeFrom(this.bounds.value, toward.value));
    return new Point(
      computed(() => proj.value.x),
      computed(() => proj.value.y),
    );
  }

  /** Segments composing this shape's stroke path — used by dashed
   *  rendering. Default: the bounding rect (4 lines, no corners). */
  segments(): Segment[] {
    const b = this.bounds.value;
    const tl = pt(b.x, b.y);
    const tr = pt(b.x + b.w, b.y);
    const br = pt(b.x + b.w, b.y + b.h);
    const bl = pt(b.x, b.y + b.h);
    return [
      { type: "line", from: tl, to: tr },
      { type: "line", from: tr, to: br },
      { type: "line", from: br, to: bl },
      { type: "line", from: bl, to: tl },
    ];
  }

  /** Bind one SVG attribute. Static value sets once; Signal sets up a
   *  reactive effect. For derived attrs, pass `computed(() => ...)`. */
  attr(
    name: string,
    value: Arg<string | number>,
    target: "intrinsic" | "wrapper" = "intrinsic",
  ): void {
    const el =
      target === "intrinsic" && this.intrinsic ? this.intrinsic : this.el;
    if (value instanceof Signal) {
      this.disposers.push(
        effect(() => el.setAttribute(name, String(value.value))),
      );
    } else {
      el.setAttribute(name, String(value));
    }
  }

  track(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  /** Create a tracked effect — the body runs reactively, and the
   *  effect is torn down with the shape. Sugar for `track(effect(fn))`. */
  effect(fn: () => void): void {
    this.disposers.push(effect(fn));
  }

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

function resolvePivot(p: Pivot, b: AABB): Vec {
  return { x: b.x + p.x * b.w, y: b.y + p.y * b.h };
}

function composeTransform(t: Vec, r: number, s: Vec, pivot: Vec): string {
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
