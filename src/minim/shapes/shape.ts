import { type Animator, suspend } from "@minim/core";
import {
  Box,
  BoxMath,
  centroidLens,
  compose,
  derive,
  effect,
  type Inner,
  lazy,
  type Matrix,
  meanLens,
  Num,
  readNow,
  Cell,
  cell,
  toMatrixString,
  transformBox,
  transformPoint,
  type Val,
  Vec,
  type Writable,
} from "@minim/signals";
import { dashedPath } from "./dashed";
import { tokens } from "./tokens";

type VecValue = Inner<Vec>;

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Stroke segment for the dashed renderer; override `segments()`. */
export type Segment =
  | { type: "line"; from: VecValue; to: VecValue }
  | {
      type: "arc";
      cx: () => number;
      cy: () => number;
      r: () => number;
      a0: () => number;
      a1: () => number;
    };

/** Shared Shape opts; each prop accepts `Val<T>`. `aside` excludes
 *  from parent bounds. */
export interface ShapeOpts {
  translate?: Val<VecValue>;
  rotate?: Val<number>;
  scale?: Val<VecValue>;
  origin?: Val<VecValue>;
  opacity?: Val<number>;
  aside?: boolean;
}

/** Stroked-shape opts. `fill: true` → stroke color; string → that
 *  color; omitted → no fill. */
export interface CommonOpts extends ShapeOpts {
  stroke?: Val<string>;
  strokeWidth?: Val<number>;
  thin?: boolean;
  dashed?: boolean;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
  fill?: Val<string> | true;
}

/** Wide-form escape hatch for heterogeneous shape collections. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape
export type AnyShape = Shape<any>;

export type AnimatableKey = "translate" | "rotate" | "scale" | "origin" | "opacity";

type AnimatableField<K extends AnimatableKey> = K extends "translate" | "scale" | "origin"
  ? Writable<Vec>
  : Writable<Num>;

/** Anything carrying the listed animatable axes. Combine via union. */
export type Has<K extends AnimatableKey> = {
  readonly [P in K]: AnimatableField<P>;
};

/** Scene-graph node wrapping an SVG `<g>`. `translate`, `rotate`,
 *  `scale`, `origin`, `opacity` are independent writable cells; the
 *  composed `localFrame` matrix is a derived view. `center`/`top`/…
 *  /`at(u,v)` return parent-frame points (writes adjust `translate`);
 *  `shape.box.center` is local-frame. */
export class Shape<O extends ShapeOpts = ShapeOpts> {
  readonly el: SVGGElement;
  readonly intrinsic?: SVGElement;

  readonly translate: Writable<Vec>;
  readonly rotate: Writable<Num>;
  readonly scale: Writable<Vec>;
  readonly origin: Writable<Vec>;
  readonly opacity: Writable<Num>;

  /** Composed local-frame matrix: `T(t) T(p) R(r) S(s) T(-p)`. */
  readonly localFrame: Cell<Inner<Matrix>>;

  /** Local-frame box; reach into `.x`, `.center`, `.at(u,v)`, etc. */
  readonly box: Box;

  /** Lens-backed parent-frame anchors; writes shift `translate`. */
  get center(): Writable<Vec> {
    return lazy(this, "center", () => this.#makeAnchor(0.5, 0.5));
  }
  get top(): Writable<Vec> {
    return lazy(this, "top", () => this.#makeAnchor(0.5, 0));
  }
  get bottom(): Writable<Vec> {
    return lazy(this, "bottom", () => this.#makeAnchor(0.5, 1));
  }
  get left(): Writable<Vec> {
    return lazy(this, "left", () => this.#makeAnchor(0, 0.5));
  }
  get right(): Writable<Vec> {
    return lazy(this, "right", () => this.#makeAnchor(1, 0.5));
  }
  at(u: number, v: number): Writable<Vec> {
    return this.#makeAnchor(u, v);
  }

  readonly aside: boolean;

  protected disposers: (() => void)[] = [];

  // Cell (not array) so the default group `boxFn` re-unions on add/remove.
  private readonly _children = cell<readonly AnyShape[]>([]);

  /** Back-link set by `add()`; cleared by `dispose()`. Non-reactive. */
  parent: AnyShape | null = null;

  constructor(
    intrinsicType?: keyof SVGElementTagNameMap,
    boxFn?: () => Inner<Box>,
    opts: O = {} as O,
    /** Subclass per-prop defaults (kept off `O`). */
    defaults: ShapeOpts = {},
  ) {
    this.el = document.createElementNS(SVG_NS, "g");
    // CSS `transform` (vs SVG `transform`) hits the GPU composite path.
    // Pin origin to userspace 0,0 so composed pivot math is correct.
    this.el.style.transformOrigin = "0 0";
    if (intrinsicType) {
      this.intrinsic = document.createElementNS(SVG_NS, intrinsicType);
      this.el.appendChild(this.intrinsic);
    }

    // Each animatable axis held directly via liftAnimatable; localFrame
    // is the derived matrix below.
    this.translate = liftAnimatable(
      opts.translate ?? defaults.translate ?? { x: 0, y: 0 },
      Vec,
      this.disposers,
    );
    this.rotate = liftAnimatable(opts.rotate ?? defaults.rotate ?? 0, Num, this.disposers);
    this.scale = liftAnimatable(
      opts.scale ?? defaults.scale ?? { x: 1, y: 1 },
      Vec,
      this.disposers,
    );
    this.origin = liftAnimatable(
      opts.origin ?? defaults.origin ?? { x: 0, y: 0 },
      Vec,
      this.disposers,
    );
    this.opacity = liftAnimatable(opts.opacity ?? defaults.opacity ?? 1, Num, this.disposers);
    this.aside = opts.aside ?? defaults.aside ?? false;

    // Group default: union of non-aside children's boxes through localFrame.
    const boxSig = Box.derive(
      boxFn ??
        (() => {
          const cs = this._children.value
            .filter(c => !c.aside)
            .map(c => transformBox(c.localFrame.value, c.box.value));
          return cs.length ? BoxMath.union(...cs) : { x: 0, y: 0, w: 0, h: 0 };
        }),
    );

    this.box = boxSig;

    // Identity short-circuit avoids reading `origin` on no-transform groups.
    this.localFrame = derive(() => {
      const t = this.translate.value;
      const r = this.rotate.value;
      const sc = this.scale.value;
      if (t.x === 0 && t.y === 0 && r === 0 && sc.x === 1 && sc.y === 1) {
        return compose(t, r, sc, { x: 0, y: 0 });
      }
      return compose(t, r, sc, this.origin.value);
    });

    this.disposers.push(
      effect(() => {
        this.el.style.transform = toMatrixString(this.localFrame.value);
        this.el.style.opacity = String(this.opacity.value);
      }),
    );
  }

  /** Parent-frame perimeter point toward `target`; tighter shapes override. */
  boundary(toward: Vec): Vec {
    return Vec.derive(() =>
      BoxMath.edgeFrom(transformBox(this.localFrame.value, this.box.value), toward.value),
    );
  }

  #makeAnchor(u: number, v: number): Writable<Vec> {
    // Reads box/localFrame/translate; writes only translate, shifted by the
    // world-space delta so the anchor lands at target (anchor-drag = translate).
    return Vec.lens(
      [this.box, this.localFrame, this.translate] as const,
      vals => {
        const [b, m] = vals;
        return transformPoint(m, { x: b.x + u * b.w, y: b.y + v * b.h });
      },
      (target, vals) => {
        const [b, m, tNow] = vals;
        const local = { x: b.x + u * b.w, y: b.y + v * b.h };
        const currentWorld = transformPoint(m, local);
        return [
          undefined,
          undefined,
          {
            x: tNow.x + (target.x - currentWorld.x),
            y: tNow.y + (target.y - currentWorld.y),
          },
        ];
      },
    );
  }

  /** Stroke segments for the dashed renderer; default = bounding rect. */
  segments(): Segment[] {
    const b = this.box.value;
    return [
      { type: "line", from: { x: b.x, y: b.y }, to: { x: b.x + b.w, y: b.y } },
      { type: "line", from: { x: b.x + b.w, y: b.y }, to: { x: b.x + b.w, y: b.y + b.h } },
      { type: "line", from: { x: b.x + b.w, y: b.y + b.h }, to: { x: b.x, y: b.y + b.h } },
      { type: "line", from: { x: b.x, y: b.y + b.h }, to: { x: b.x, y: b.y } },
    ];
  }

  /** Bind one SVG attribute; static sets once, reactive runs as effect. */
  attr(
    name: string,
    val: Val<string | number>,
    target: "intrinsic" | "wrapper" = "intrinsic",
  ): void {
    const el = target === "intrinsic" && this.intrinsic ? this.intrinsic : this.el;
    if (val instanceof Cell || typeof val === "function") {
      this.disposers.push(effect(() => el.setAttribute(name, String(readNow(val)))));
    } else {
      el.setAttribute(name, String(val));
    }
  }

  /** Bind several attributes at once — `this.attrs({ cx, cy, r })`. */
  attrs(
    map: Record<string, Val<string | number>>,
    target: "intrinsic" | "wrapper" = "intrinsic",
  ): void {
    for (const k in map) this.attr(k, map[k], target);
  }

  /** Wire stroke / fill / dashed for a stroked shape. `nativeAttrs`
   *  binds the shape's native geometry (e.g. `{cx, cy, r}` for circle);
   *  it's skipped when `opts.dashed` since the intrinsic is then a
   *  `<path>` whose `d` is driven by `segments()`. */
  stroke(
    opts: CommonOpts,
    closed: boolean,
    nativeAttrs?: Record<string, Val<string | number>>,
  ): void {
    if (opts.dashed) {
      const cap = opts.cap ?? "round";
      this.attr("stroke-linecap", cap);
      // Resolve strokeWidth at construction; dash geometry assumes
      // a static weight (capExtension is baked into the path string).
      const w =
        opts.strokeWidth === undefined
          ? opts.thin
            ? tokens.thinWeight
            : tokens.weight
          : readNow(opts.strokeWidth);
      const capExt = cap === "round" ? w : 0;
      this.attr(
        "d",
        derive(() => dashedPath(this.segments(), { closed, capExtension: capExt })),
      );
    } else if (nativeAttrs) {
      this.attrs(nativeAttrs);
    }

    this.attr("stroke", opts.stroke ?? tokens.stroke);
    this.attr("stroke-width", opts.strokeWidth ?? (opts.thin ? tokens.thinWeight : tokens.weight));
    this.attr("vector-effect", "non-scaling-stroke");
    if (opts.cap) this.attr("stroke-linecap", opts.cap);
    if (opts.join) this.attr("stroke-linejoin", opts.join);

    if (opts.fill === undefined) this.attr("fill", "none");
    else if (opts.fill === true) this.attr("fill", tokens.stroke);
    else this.attr("fill", opts.fill);
  }

  /** Register a disposer to run on `dispose()`. */
  track(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  /** Reactive effect torn down with the shape. */
  effect(fn: () => void): void {
    this.disposers.push(effect(fn));
  }

  on(name: string, handler: (e: Event) => void, opts?: AddEventListenerOptions): () => void {
    const el = this.el;
    el.addEventListener(name, handler, opts);
    const dispose = () => el.removeEventListener(name, handler, opts);
    this.disposers.push(dispose);
    return dispose;
  }

  /** Wake on the next `name` event; resume with the event. */
  until(name: string): Animator<Event> {
    return suspend<Event>(wake => {
      const handler = (e: Event) => wake(e);
      return this.on(name, handler, { once: true });
    });
  }

  /** Map client coords into this shape's local frame. */
  toLocal(evt: { clientX: number; clientY: number }): VecValue {
    const target = (this.intrinsic ?? this.el) as SVGGraphicsElement;
    const ctm = target.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    return {
      x: evt.clientX * inv.a + evt.clientY * inv.c + inv.e,
      y: evt.clientX * inv.b + evt.clientY * inv.d + inv.f,
    };
  }

  /** Map client coords into the SVG root's frame; stable under rotation
   *  (unlike `toLocal`). Returns `(0, 0)` when detached. */
  toWorld(evt: { clientX: number; clientY: number }): VecValue {
    const root = this.svgRoot;
    const ctm = root?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    return {
      x: evt.clientX * inv.a + evt.clientY * inv.c + inv.e,
      y: evt.clientX * inv.b + evt.clientY * inv.d + inv.f,
    };
  }

  /** Nearest enclosing `<svg>` root, or `null` if this shape isn't mounted
   *  under one. Used by drag helpers that need world-space cursor coords. */
  get svgRoot(): SVGSVGElement | null {
    let walker: Element | null = this.el;
    while (walker) {
      if (walker.namespaceURI === SVG_NS && walker.tagName === "svg") {
        return walker as SVGSVGElement;
      }
      walker = walker.parentElement;
    }
    return null;
  }

  add<T extends AnyShape>(child: T): T;
  add<T extends AnyShape[]>(...children: T): T;
  add(...children: AnyShape[]): AnyShape | AnyShape[] {
    for (const child of children) {
      this.el.appendChild(child.el);
      child.parent = this;
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
    cs.forEach(c => c.dispose());
    this._children.value = [];
  }

  dispose(): void {
    this._children.peek().forEach(c => c.dispose());
    this._children.value = [];
    this.disposers.forEach(d => d());
    this.disposers = [];
    this.parent = null;
    this.el.remove();
  }
}

// Sugar over the N-input aggregate lenses: read the mean, write the delta
// evenly to all members.

/** Writable centroid of shapes' translates. */
export function centroid(...shapes: { translate: Writable<Vec> }[]): Writable<Vec> {
  return centroidLens(shapes.map(s => s.translate));
}

/** Writable mean rotation. */
export function meanRotation(...shapes: { rotate: Writable<Num> }[]): Writable<Num> {
  return meanLens(
    Num,
    shapes.map(s => s.rotate),
  );
}

/** Writable mean scale. */
export function meanScale(...shapes: { scale: Writable<Vec> }[]): Writable<Vec> {
  return meanLens(
    Vec,
    shapes.map(s => s.scale),
  );
}

/** Lift a `Val<T>` to a `Writable<Cls<T>>` for Shape's animatable surface.
 *  Writable passes through; literal seeds a cell; signal/thunk drives it via
 *  a disposer-tracked effect. The library's only effect-driven RO mirror,
 *  tolerated because the surface must stay writable for tween/drag/write. */
function liftAnimatable<T, C extends Cell<T>>(
  src: Val<T>,
  Cls: new (v?: T) => C,
  disposers: (() => void)[],
): Writable<C> {
  if (src instanceof Cls) return src as Writable<C>;
  const target = new Cls() as Writable<C>;
  if (src instanceof Cell || typeof src === "function") {
    disposers.push(
      effect(() => {
        target.value = readNow(src) as Inner<C>;
      }),
    );
  } else {
    target.value = src as Inner<C>;
  }
  return target;
}
