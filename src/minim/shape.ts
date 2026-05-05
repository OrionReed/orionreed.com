import {
  bindArg,
  computed,
  effect,
  signal,
  Signal,
  toSig,
  type Arg,
  type ReadonlySignal,
} from "./signal";
import {
  Bounds,
  aabb,
  aabbEdgeFrom,
  unionAABB,
  type AABB,
  type Vec,
} from "./bounds";
import {
  compose,
  invert,
  isIdentity,
  multiply,
  toString as matrixToString,
  transformAABB,
  type Matrix2D,
} from "./matrix";
import { Point, pt } from "./point";
import type { Segment } from "./dashed";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Construction-time options for any Shape. Animatable props accept
 *  `Arg<T>`: a value, Signal, or thunk. For derived inputs, pass a
 *  function — it'll be wrapped in `computed(...)` at construction.
 *
 *  `origin` is an absolute local-frame `Vec`: the point about which
 *  this shape's `rotate` and `scale` are applied. Each shape factory
 *  picks a sensible default (a circle's center, a rect's bbox-center,
 *  a line's midpoint, …); groups default to `(0, 0)`. Override to
 *  rotate/scale around an authored point or to bind reactively to
 *  another shape's anchor.
 *
 *  `aside` excludes this shape from its parent's children-union default
 *  bounds (and so transitively from auto-fit). Its own `bounds` is
 *  unaffected — useful for decorative overlays (highlights, halos)
 *  that shouldn't extend the diagram's natural extent. */
export interface ShapeOpts {
  translate?: Arg<Vec>;
  rotate?: Arg<number>;
  scale?: Arg<Vec>;
  origin?: Arg<Vec>;
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
  /** Absolute local-frame point about which `rotate`/`scale` are
   *  applied. Defaults set per-shape (circle center, rect bbox center,
   *  …) by the relevant factory; groups default to `(0, 0)`. */
  readonly origin: Signal<Vec>;
  readonly opacity: Signal<number>;
  /** Local-frame AABB. For shapes with intrinsic geometry (Rect,
   *  Circle, …) this is the geometry directly. For groups it's the
   *  union of children's bounds *transformed by their own transforms*
   *  — i.e. children contribute their footprint expressed in this
   *  group's frame, so the union is meaningful for layout/fit.
   *
   *  Lazy: only evaluates when something reads it. Drawing a diagram
   *  that never queries bounds (no `s.fit()`, no `connect`/`arrow`,
   *  no layout helpers) costs nothing. */
  readonly bounds: Bounds;
  /** Composed `translate × pivoted-rotate × pivoted-scale` matrix.
   *  Pivots around `origin` (an absolute local-frame Vec, decoupled
   *  from `bounds`). */
  readonly transform: ReadonlySignal<Matrix2D>;
  readonly aside: boolean;

  protected disposers: (() => void)[] = [];

  /** Reactive list of children. External code can subscribe to
   *  structural changes; internal mutation goes through `add`/`remove`/
   *  `clear`. The list is updated immutably (each mutation writes a new
   *  array) so reads track via the standard Signal contract. */
  private readonly _children = signal<readonly Shape[]>([]);
  readonly children: ReadonlySignal<readonly Shape[]> = this._children;

  /** Parent shape — set by `add`, cleared by `remove`. Null at the
   *  root (or for un-mounted shapes). Walking up via `.parent` gives
   *  the chain of frames between this shape and the scene root. */
  #parent: Shape | null = null;
  get parent(): Shape | null { return this.#parent; }

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
    this.origin = bindArg(opts.origin, { x: 0, y: 0 });
    this.opacity = bindArg(opts.opacity, 1);
    this.aside = opts.aside ?? false;

    // Bounds: explicit fn from a subclass, else union of non-aside
    // children's bounds *expressed in this shape's frame* — each
    // child's local AABB is transformed by its own matrix before the
    // union, so the result is a meaningful local-frame footprint.
    this.bounds = new Bounds(
      computed(
        boundsFn ??
          (() => {
            const bs = this._children.value
              .filter((c) => !c.aside)
              .map((c) => transformAABB(c.transform.value, c.bounds.value));
            return bs.length ? unionAABB(...bs) : aabb(0, 0, 0, 0);
          }),
      ),
    );

    // Composed transform matrix. Pivots around `origin` — an absolute
    // local-frame point — so transform doesn't read `bounds`. Bounds
    // stays lazy; a diagram that never queries bounds pays nothing.
    this.transform = computed(() => {
      const t = this.translate.value;
      const r = this.rotate.value;
      const sc = this.scale.value;
      if (t.x === 0 && t.y === 0 && r === 0 && sc.x === 1 && sc.y === 1) {
        return compose(t, r, sc, { x: 0, y: 0 });
      }
      return compose(t, r, sc, this.origin.value);
    });

    // Emit the SVG transform attribute. Identity → empty string (no
    // attribute), keeping the DOM minimal.
    this.disposers.push(
      effect(() => {
        const m = this.transform.value;
        this.el.setAttribute("transform", isIdentity(m) ? "" : matrixToString(m));
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

  /** Bind one SVG attribute. Static value sets once; Signal or thunk
   *  sets up a reactive effect. */
  attr(
    name: string,
    value: Arg<string | number>,
    target: "intrinsic" | "wrapper" = "intrinsic",
  ): void {
    const el =
      target === "intrinsic" && this.intrinsic ? this.intrinsic : this.el;
    if (value instanceof Signal || typeof value === "function") {
      const sig = toSig(value);
      this.disposers.push(
        effect(() => el.setAttribute(name, String(sig.value))),
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
      this.el.appendChild(child.el);
      child.#parent = this;
    }
    if (children.length > 0) {
      this._children.value = [...this._children.peek(), ...children];
    }
    return children.length === 1 ? children[0] : children;
  }

  remove(...toRemove: Shape[]): void {
    if (toRemove.length === 0) return;
    const removeSet = new Set<Shape>(toRemove);
    const next: Shape[] = [];
    for (const c of this._children.peek()) {
      if (removeSet.has(c)) c.dispose();
      else next.push(c);
    }
    if (next.length !== this._children.peek().length) {
      this._children.value = next;
    }
  }

  clear(): void {
    const cs = this._children.peek();
    if (cs.length === 0) return;
    cs.forEach((c) => c.dispose());
    this._children.value = [];
  }

  dispose(): void {
    this._children.peek().forEach((c) => c.dispose());
    this._children.value = [];
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.#parent = null;
    this.el.remove();
  }
}

// ── Cross-frame helpers ─────────────────────────────────────────────

/** AABB of `shape` expressed in the scene-root frame. Walks up the
 *  parent chain composing transforms. Reactive in any shape's
 *  transform along the path. */
export function boundsInRoot(shape: Shape): ReadonlySignal<AABB> {
  return computed(() => {
    let m = shape.transform.value;
    let p = shape.parent;
    while (p) {
      m = multiply(p.transform.value, m);
      p = p.parent;
    }
    return transformAABB(m, shape.bounds.value);
  });
}

/** AABB of `shape` expressed in `observer`'s local frame. Useful for
 *  `connect`/`arrow` calls that span subtrees with different
 *  transforms — convert both endpoints to a common frame first. */
export function boundsIn(
  shape: Shape,
  observer: Shape,
): ReadonlySignal<AABB> {
  return computed(() => {
    // Compose shape → root.
    let mShape = shape.transform.value;
    for (let p = shape.parent; p; p = p.parent) {
      mShape = multiply(p.transform.value, mShape);
    }
    // Compose observer → root.
    let mObs = observer.transform.value;
    for (let p = observer.parent; p; p = p.parent) {
      mObs = multiply(p.transform.value, mObs);
    }
    // shape's local → observer's local = inv(observer→root) ⋅ shape→root.
    return transformAABB(multiply(invert(mObs), mShape), shape.bounds.value);
  });
}
