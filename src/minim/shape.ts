import {
  computed,
  effect,
  signal,
  Signal,
  toSig,
  type Arg,
  type ReadonlySignal,
  type ResolveSig,
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

/** Look up an opts key, returning `undefined` when the key is absent
 *  from the inferred opts type (e.g., the user didn't pass that prop). */
type Lookup<O, K extends keyof ShapeOpts> = K extends keyof O ? O[K] : undefined;

/** "A shape with any opts" — used wherever the specific generic
 *  doesn't matter (parent references, children collections, free
 *  helpers). Avoids variance mismatches caused by the conditional
 *  prop types. Reach for this only when you genuinely need to accept
 *  shapes with readonly props alongside default-writable ones; for the
 *  common case prefer `Shape` (writable everywhere) and let the type
 *  system reject mismatched callers at the boundary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyShape = Shape<any>;

/** The five animatable props a Shape exposes as `Signal`-backed fields. */
export type AnimatableKey = "translate" | "rotate" | "scale" | "origin" | "opacity";

/** Underlying value type for each animatable prop. */
type AnimatableValue<K extends AnimatableKey> =
  K extends "translate" | "scale" | "origin" ? Vec : number;

/** Constrain a value to "any object with these animatable shape props
 *  in writable form." Combinable via union — e.g.
 *  `Writable<"translate" | "opacity">` produces an intersection-shaped
 *  type with both props writable.
 *
 *  Use for helpers that animate specific props but should accept any
 *  shape — including ones with *other* props bound to a `computed(...)`
 *  or thunk. Compare to plain `Shape`, which requires every animatable
 *  prop to be writable. */
export type Writable<K extends AnimatableKey> = {
  readonly [P in K]: Signal<AnimatableValue<P>>;
};

/** Universal scene-graph node. Wraps an SVG `<g>` (transform + opacity
 *  + children); concrete subclasses add an intrinsic SVG element and
 *  geometry-specific vocabulary. A bare `new Shape()` is a group.
 *
 *  Generic over its options so each animatable prop's type tracks the
 *  user's input: a `computed(...)` produces a `ReadonlySignal` field
 *  (animations on it become compile errors), a value/Signal produces
 *  a writable `Signal` field.
 *
 *  Most user code uses the bare `Shape` type alias (no generic args)
 *  which resolves to writable-everywhere. Helpers that should also
 *  accept shapes with one or more readonly props can use
 *  `Writable<"opacity">` (or a union of keys) to constrain just the
 *  props they touch. `AnyShape` is the wide-form escape hatch for
 *  helpers that don't write at all. */
export class Shape<O extends ShapeOpts = ShapeOpts> {
  readonly el: SVGGElement;
  readonly intrinsic?: SVGElement;

  readonly translate: ResolveSig<Lookup<O, "translate">, Vec>;
  readonly rotate: ResolveSig<Lookup<O, "rotate">, number>;
  readonly scale: ResolveSig<Lookup<O, "scale">, Vec>;
  /** Absolute local-frame point about which `rotate`/`scale` are
   *  applied. Defaults set per-shape (circle center, rect bbox center,
   *  …) by the relevant factory; groups default to `(0, 0)`. */
  readonly origin: ResolveSig<Lookup<O, "origin">, Vec>;
  readonly opacity: ResolveSig<Lookup<O, "opacity">, number>;
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
   *  array) so reads track via the standard Signal contract.
   *
   *  `AnyShape` (= `Shape<any>`) sidesteps the per-instance generic so
   *  collections-of-mixed-children type cleanly. */
  private readonly _children = signal<readonly AnyShape[]>([]);
  readonly children: ReadonlySignal<readonly AnyShape[]> = this._children;

  /** Parent shape — set by `add`, cleared by `remove`. Null at the
   *  root (or for un-mounted shapes). Walking up via `.parent` gives
   *  the chain of frames between this shape and the scene root. */
  #parent: AnyShape | null = null;
  get parent(): AnyShape | null { return this.#parent; }

  constructor(
    intrinsicType?: string,
    boundsFn?: () => AABB,
    opts: O = {} as O,
    /** Subclass-supplied defaults for animatable props. Used when the
     *  user didn't pass that key in `opts` — e.g. Circle wires
     *  `origin: () => center.value` so its rotation pivots on its
     *  center by default. Kept off the public `O` typing so the field
     *  type stays driven by user input only.  */
    defaults: ShapeOpts = {},
  ) {
    this.el = document.createElementNS(SVG_NS, "g") as SVGGElement;
    if (intrinsicType) {
      this.intrinsic = document.createElementNS(SVG_NS, intrinsicType);
      this.el.appendChild(this.intrinsic);
    }

    // `toSig` returns whatever the input was at runtime (a fresh writable,
    // the user's Signal, or a Computed for thunks). The cast aligns the
    // field's conditional type — runtime semantics are unchanged.
    type Cast<K extends keyof ShapeOpts, T> = ResolveSig<Lookup<O, K>, T>;
    this.translate = toSig(opts.translate ?? defaults.translate, { x: 0, y: 0 }) as Cast<"translate", Vec>;
    this.rotate = toSig(opts.rotate ?? defaults.rotate, 0) as Cast<"rotate", number>;
    this.scale = toSig(opts.scale ?? defaults.scale, { x: 1, y: 1 }) as Cast<"scale", Vec>;
    this.origin = toSig(opts.origin ?? defaults.origin, { x: 0, y: 0 }) as Cast<"origin", Vec>;
    this.opacity = toSig(opts.opacity ?? defaults.opacity, 1) as Cast<"opacity", number>;
    this.aside = opts.aside ?? defaults.aside ?? false;

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

  add<T extends AnyShape>(child: T): T;
  add<T extends AnyShape[]>(...children: T): T;
  add(...children: AnyShape[]): AnyShape | AnyShape[] {
    for (const child of children) {
      this.el.appendChild(child.el);
      // Same-class private access — JS private fields are class-private,
      // and `this: Shape<O>` is assignable to AnyShape via the generic.
      child.#parent = this;
    }
    if (children.length > 0) {
      this._children.value = [...this._children.peek(), ...children];
    }
    return children.length === 1 ? children[0] : children;
  }

  remove(...toRemove: AnyShape[]): void {
    if (toRemove.length === 0) return;
    const removeSet = new Set<AnyShape>(toRemove);
    const next: AnyShape[] = [];
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
export function boundsInRoot(shape: AnyShape): ReadonlySignal<AABB> {
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
  shape: AnyShape,
  observer: AnyShape,
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
