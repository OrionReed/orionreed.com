import {
  cell,
  effect,
  type Cell,
  type ReadonlyCell,
} from "../core";
import { Signal } from "../core/signal";
import { toSig, type Arg, type ResolveSig } from "../core/arg";
import {
  Box as BoxStruct,
  box,
  boxEdgeFrom,
  unionBox,
  type Box,
  type Boxlike,
} from "../signals/box";
import {
  compose,
  multiply,
  toString as matrixToString,
  transformBox,
  transformPoint,
  type Matrix2D,
} from "../signals/matrix";
import { mean } from "../signals/aggregates";
import {
  Vec,
  pt,
  type V,
  type DerivedPoint,
  type Point,
  type Pointlike,
  type ResolveVec,
} from "../signals/vec";
import { struct, type WriteOf } from "../signals/struct";
import { suspend, type Animator } from "../core/anim";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Stroke segment — line or arc. Subclasses override `segments()` to
 *  expose geometry to the dashed renderer. */
export type Segment =
  | { type: "line"; from: Pointlike; to: Pointlike }
  | {
      type: "arc";
      cx: () => number;
      cy: () => number;
      r: () => number;
      a0: () => number;
      a1: () => number;
    };

// ── Transform: the animatable surface as a single struct ─────────────
//
// Every Shape's animatable state lives in one `Reactive<Transform>`.
// `.nested({translate, scale, origin: Vec})` puts every field in its
// own per-field signal (full SoA), so per-axis writes are isolated and
// `shape.transform.to(target, dur)` tweens the whole pose.

export type Transform = {
  translate: V;
  rotate: number;
  scale: V;
  origin: V;
  opacity: number;
};

const TR_DEFAULTS: Transform = {
  translate: { x: 0, y: 0 },
  rotate: 0,
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  opacity: 1,
};

export const Transform = struct<Transform>("Transform", TR_DEFAULTS)
  .equals(
    (a, b) =>
      a.translate.x === b.translate.x &&
      a.translate.y === b.translate.y &&
      a.rotate === b.rotate &&
      a.scale.x === b.scale.x &&
      a.scale.y === b.scale.y &&
      a.origin.x === b.origin.x &&
      a.origin.y === b.origin.y &&
      a.opacity === b.opacity,
  )
  .nested({ translate: Vec, scale: Vec, origin: Vec })
  .ops({
    /** Component-wise lerp; enables `shape.transform.to(target, dur)`. */
    lerp: (a, b: Transform, t: number): Transform => ({
      translate: {
        x: a.translate.x + (b.translate.x - a.translate.x) * t,
        y: a.translate.y + (b.translate.y - a.translate.y) * t,
      },
      rotate: a.rotate + (b.rotate - a.rotate) * t,
      scale: {
        x: a.scale.x + (b.scale.x - a.scale.x) * t,
        y: a.scale.y + (b.scale.y - a.scale.y) * t,
      },
      origin: {
        x: a.origin.x + (b.origin.x - a.origin.x) * t,
        y: a.origin.y + (b.origin.y - a.origin.y) * t,
      },
      opacity: a.opacity + (b.opacity - a.opacity) * t,
    }),
  })
  .build();

/** Construction options shared by every Shape. Each prop accepts
 *  `Arg<T>` (literal / Signal / thunk / matching Reactive — adopted
 *  by the Transform's per-field signal). `aside` excludes from
 *  parent's bounds. */
export interface ShapeOpts {
  translate?: Arg<V>;
  rotate?: Arg<number>;
  scale?: Arg<V>;
  origin?: Arg<V>;
  opacity?: Arg<number>;
  aside?: boolean;
}

type Lookup<O, K extends keyof ShapeOpts> = K extends keyof O
  ? O[K]
  : undefined;

/** Wide-form escape hatch for heterogeneous shape collections. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyShape = Shape<any>;

export type AnimatableKey =
  | "translate"
  | "rotate"
  | "scale"
  | "origin"
  | "opacity";

type AnimatableField<K extends AnimatableKey> = K extends
  | "translate"
  | "scale"
  | "origin"
  ? Point
  : Cell<number>;

/** "Any shape whose listed props are writable." Combinable via union. */
export type Writable<K extends AnimatableKey> = {
  readonly [P in K]: AnimatableField<P>;
};

/** Universal scene-graph node. Wraps an SVG `<g>` (transform + opacity
 *  + children); subclasses add an intrinsic element and geometry. A
 *  bare `new Shape()` is a group.
 *
 *  Animatable state lives in `this.transform: Reactive<Transform>`.
 *  Field aliases (`translate`, `rotate`, …) forward to the transform's
 *  nested signals — same reference, no extra allocation. */
export class Shape<O extends ShapeOpts = ShapeOpts> implements Boxlike {
  readonly el: SVGGElement;
  readonly intrinsic?: SVGElement;

  /** Animatable surface: a single `Reactive<Transform>`. Tween whole
   *  pose with `shape.transform.to(target, dur)`. Field signals are
   *  smart-adopted from `opts`: pass a `pt` and `transform.translate`
   *  IS that signal (two-way share); pass a `computed` and the field
   *  becomes the derived flavor. */
  readonly transform: WriteOf<typeof Transform>;

  // Field aliases — direct references to transform's nested signals.
  // Casts narrow per-prop based on user input flavor (the type contract
  // in `_type-tests.ts`).
  readonly translate: ResolveVec<Lookup<O, "translate">>;
  readonly rotate: ResolveSig<Lookup<O, "rotate">, number>;
  readonly scale: ResolveVec<Lookup<O, "scale">>;
  readonly origin: ResolveVec<Lookup<O, "origin">>;
  readonly opacity: ResolveSig<Lookup<O, "opacity">, number>;

  /** Composed local-frame matrix: `T(t) T(p) R(r) S(s) T(-p)`. Recomputes
   *  when any animatable prop changes. */
  readonly localFrame: ReadonlyCell<Matrix2D>;

  /** Cumulative scene-root frame: `parent.worldFrame × localFrame`.
   *  Reactive — when any ancestor's localFrame updates, this recomputes.
   *  Use `shape.box.in(shape.worldFrame)` for cross-frame Box queries. */
  readonly worldFrame: ReadonlyCell<Matrix2D>;

  // ── Boxlike interface ───────────────────────────────────────────────
  //
  // Source-of-truth: `box` (local-frame Box). `x/y/w/h` are eager
  // axis projections so subclasses (Rect) can override with sources.
  // Cardinals (`center`, `top`, …) build lazily on first access.

  readonly box: ReadonlyCell<Box>;
  readonly x: ReadonlyCell<number>;
  readonly y: ReadonlyCell<number>;
  readonly w: ReadonlyCell<number>;
  readonly h: ReadonlyCell<number>;

  /** Lens-backed cardinal anchors. Reads return parent-frame post-
   *  transform position (so connectors track the visual edge); writes
   *  shift `translate` by (target - currentWorldAnchor). Cached as
   *  own-property on first access. */
  get center(): Point { return this.#anchor("center", 0.5, 0.5); }
  get top(): Point    { return this.#anchor("top",    0.5, 0); }
  get bottom(): Point { return this.#anchor("bottom", 0.5, 1); }
  get left(): Point   { return this.#anchor("left",   0,   0.5); }
  get right(): Point  { return this.#anchor("right",  1,   0.5); }
  /** Reactive Point at normalized fraction `(u, v)` in parent frame. */
  at(u: number, v: number): Point { return this.#makeAnchor(u, v); }

  readonly aside: boolean;

  protected disposers: (() => void)[] = [];

  private readonly _children = cell<readonly AnyShape[]>([]);
  readonly children: ReadonlyCell<readonly AnyShape[]> = this._children;

  #parent: AnyShape | null = null;
  get parent(): AnyShape | null {
    return this.#parent;
  }

  constructor(
    intrinsicType?: string,
    boxFn?: () => Box,
    opts: O = {} as O,
    /** Subclass per-prop defaults (kept off `O` so field types stay
     *  driven by user input only). */
    defaults: ShapeOpts = {},
  ) {
    this.el = document.createElementNS(SVG_NS, "g") as SVGGElement;
    // CSS transforms (vs SVG `transform`) hit the GPU composite path.
    // Pin transform-origin to the SVG userspace origin so our composed
    // pivot math is correct (browser defaults vary).
    this.el.style.transformOrigin = "0 0";
    if (intrinsicType) {
      this.intrinsic = document.createElementNS(SVG_NS, intrinsicType);
      this.el.appendChild(this.intrinsic);
    }

    // Build Transform via smart adoption — each field input flows
    // through `.nested()`'s adoption (literal → fresh signal; matching
    // Reactive → adopt; Signal/computed/thunk → wrap).
    this.transform = Transform.signal({
      translate: opts.translate ?? defaults.translate ?? { x: 0, y: 0 },
      rotate: opts.rotate ?? defaults.rotate ?? 0,
      scale: opts.scale ?? defaults.scale ?? { x: 1, y: 1 },
      origin: opts.origin ?? defaults.origin ?? { x: 0, y: 0 },
      opacity: opts.opacity ?? defaults.opacity ?? 1,
    });

    // Field aliases — direct references; reads bypass the prototype.
    type CastVec<K extends keyof ShapeOpts> = ResolveVec<Lookup<O, K>>;
    type CastNum<K extends keyof ShapeOpts> = ResolveSig<Lookup<O, K>, number>;
    this.translate = this.transform.translate as CastVec<"translate">;
    this.rotate = this.transform.rotate as CastNum<"rotate">;
    this.scale = this.transform.scale as CastVec<"scale">;
    this.origin = this.transform.origin as CastVec<"origin">;
    this.opacity = this.transform.opacity as CastNum<"opacity">;
    this.aside = opts.aside ?? defaults.aside ?? false;

    // Group default: union of non-aside children's boxes, each composed
    // through its localFrame. Built as Reactive<Box> for axis access.
    const boxSig = BoxStruct.derived(
      boxFn ??
        (() => {
          const cs = this._children.value
            .filter((c) => !c.aside)
            .map((c) => transformBox(c.localFrame.value, c.box.value));
          return cs.length ? unionBox(...cs) : box(0, 0, 0, 0);
        }),
    );
    this.box = boxSig as ReadonlyCell<Box>;
    this.x = boxSig.x;
    this.y = boxSig.y;
    this.w = boxSig.w;
    this.h = boxSig.h;

    // Local frame: composed matrix from per-field signals. The
    // identity short-circuit avoids touching `origin` when there's no
    // pivoted op — saves a per-frame read for huge no-transform groups.
    const tr = this.transform;
    this.localFrame = cell.derived(() => {
      const t = tr.translate.value;
      const r = tr.rotate.value;
      const sc = tr.scale.value;
      if (t.x === 0 && t.y === 0 && r === 0 && sc.x === 1 && sc.y === 1) {
        return compose(t, r, sc, { x: 0, y: 0 });
      }
      return compose(t, r, sc, tr.origin.value);
    });

    // World frame: cumulative through ancestors. Reads parent.worldFrame
    // reactively, so any ancestor's transform change propagates here.
    // Re-parenting is NOT reactive (parent ref is plain); rebuild the
    // cell via `boxIn(...)` if you need that.
    this.worldFrame = cell.derived(() => {
      const local = this.localFrame.value;
      const p = this.#parent;
      return p ? multiply(p.worldFrame.value, local) : local;
    });

    this.disposers.push(
      effect(() => {
        this.el.style.transform = matrixToString(this.localFrame.value);
      }),
      effect(() => {
        this.el.style.opacity = String(this.opacity.value);
      }),
    );
  }

  /** Perimeter point in the direction of `toward` (parent frame, so
   *  connectors land on the visual edge after translate/rotate/scale).
   *  Default is Box-edge math; tighter shapes (Circle, Rect) override. */
  boundary(toward: Pointlike): DerivedPoint {
    return Vec.derived(() =>
      boxEdgeFrom(
        transformBox(this.localFrame.value, this.box.value),
        toward.value,
      ),
    );
  }

  // ── Lazy anchor construction ────────────────────────────────────────

  #makeAnchor(u: number, v: number): Point {
    const boxSig = this.box;
    const lf = this.localFrame;
    const tr = this.transform;
    return Vec.lens(
      () => {
        const b = boxSig.value;
        return transformPoint(lf.value, {
          x: b.x + u * b.w,
          y: b.y + v * b.h,
        });
      },
      (target) => {
        const b = boxSig.peek();
        const local = { x: b.x + u * b.w, y: b.y + v * b.h };
        const currentWorld = transformPoint(lf.peek(), local);
        const tNow = tr.translate.peek();
        (tr.translate as Cell<V>).value = {
          x: tNow.x + (target.x - currentWorld.x),
          y: tNow.y + (target.y - currentWorld.y),
        };
      },
    );
  }

  #anchor(name: string, u: number, v: number): Point {
    const val = this.#makeAnchor(u, v);
    Object.defineProperty(this, name, {
      value: val,
      writable: false,
      configurable: false,
      enumerable: false,
    });
    return val;
  }

  /** Stroke segments — used by the dashed renderer. Default = bounding rect. */
  segments(): Segment[] {
    const b = this.box.value;
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

  /** Bind one SVG attribute; static value sets once, reactive runs as effect. */
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

  /** Register a disposer to run on `dispose()`. */
  track(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  /** Reactive effect torn down with the shape. */
  effect(fn: () => void): void {
    this.disposers.push(effect(fn));
  }

  // ── DOM events ──────────────────────────────────────────────────────

  on(
    name: string,
    handler: (e: Event) => void,
    opts?: AddEventListenerOptions,
  ): () => void {
    const el = this.el;
    el.addEventListener(name, handler, opts);
    const dispose = () => el.removeEventListener(name, handler, opts);
    this.disposers.push(dispose);
    return dispose;
  }

  /** Wake on the next `name` event; resume with the event. */
  until(name: string): Animator<Event> {
    return suspend<Event>((wake) => {
      const handler = (e: Event) => wake(e);
      return this.on(name, handler, { once: true });
    });
  }

  /** Map client-space coords into this shape's local frame via `getScreenCTM`. */
  toLocal(evt: { clientX: number; clientY: number }): V {
    const target = (this.intrinsic ?? this.el) as SVGGraphicsElement;
    const ctm = target.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    return {
      x: evt.clientX * inv.a + evt.clientY * inv.c + inv.e,
      y: evt.clientX * inv.b + evt.clientY * inv.d + inv.f,
    };
  }

  add<T extends AnyShape>(child: T): T;
  add<T extends AnyShape[]>(...children: T): T;
  add(...children: AnyShape[]): AnyShape | AnyShape[] {
    for (const child of children) {
      this.el.appendChild(child.el);
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

// ── Aggregates over multiple shapes ─────────────────────────────────
//
// Each is a writable view via `mean`: tween the result to move the
// group rigidly. Generic `mean(...sigs)` is in `signals/aggregates.ts`;
// these are shape-specific sugar (one-liners over the right field).

/** Centroid of N shapes' translates, as a writable Point. */
export function centroid(...shapes: Writable<"translate">[]): Point {
  return mean(...shapes.map((s) => s.translate)) as Point;
}

/** Mean rotation as a writable signal; writes rotate every shape by the same delta. */
export function meanRotation(
  ...shapes: Writable<"rotate">[]
): Cell<number> {
  return mean(...shapes.map((s) => s.rotate));
}

/** Mean scale as a writable Point. */
export function meanScale(...shapes: Writable<"scale">[]): Point {
  return mean(...shapes.map((s) => s.scale)) as Point;
}
