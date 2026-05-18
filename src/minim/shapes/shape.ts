import {suspend, type Animator} from "@minim/core";
import {
  signal, computed, effect, Signal, derived,
  Vec, Num, Transform, Box,
  compose, multiply, matrixToString, transformBox, transformPoint,
  type VecValue, type BoxValue, type Matrix2DValue, type Val,
  mean, BoxMath, value,
} from "@minim/signals";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Stroke segment — line or arc. Subclasses override `segments()` to
 *  expose geometry to the dashed renderer. */
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

/** Construction options shared by every Shape. Each prop accepts
 *  `Val<T>` (literal / Signal / thunk). `aside` excludes from
 *  parent's bounds. */
export interface ShapeOpts {
  translate?: Val<VecValue>;
  rotate?: Val<number>;
  scale?: Val<VecValue>;
  origin?: Val<VecValue>;
  opacity?: Val<number>;
  aside?: boolean;
}

/** Wide-form escape hatch for heterogeneous shape collections. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyShape = Shape<any>;

export type AnimatableKey =
  | "translate"
  | "rotate"
  | "scale"
  | "origin"
  | "opacity";

type AnimatableField<K extends AnimatableKey> =
  K extends "translate" | "scale" | "origin" ? Vec : Num;

/** Anything carrying the listed animatable axes (Shape, Part, mock,
 *  derived). Combinable via union — `Has<"translate" | "opacity">`.
 *  The field is `readonly` (you can't reassign it) but the *cell* at
 *  the field is writable via its `.value` setter. */
export type Has<K extends AnimatableKey> = {
  readonly [P in K]: AnimatableField<P>;
};

/** Universal scene-graph node. Wraps an SVG `<g>` (transform + opacity
 *  + children); subclasses add an intrinsic element and geometry. A
 *  bare `new Shape()` is a group. Animatable state lives in
 *  `this.transform: Transform`. Field aliases (`translate`, `rotate`,
 *  …) forward to the transform's nested signals — same reference.
 *
 *  Reach into `shape.box.x` / `shape.box.center` for box-local axes &
 *  cardinals. Shape's own `center`/`top`/…/`at(u,v)` differ: they
 *  return *parent-frame* points (post-transform), and writing to them
 *  adjusts `translate` so the anchor lands at the new position. */
export class Shape<O extends ShapeOpts = ShapeOpts> {
  readonly el: SVGGElement;
  readonly intrinsic?: SVGElement;

  readonly transform: Transform;
  readonly translate: Vec;
  readonly rotate: Num;
  readonly scale: Vec;
  readonly origin: Vec;
  readonly opacity: Num;

  /** Composed local-frame matrix: `T(t) T(p) R(r) S(s) T(-p)`. */
  readonly localFrame: Signal<Matrix2DValue>;

  /** Cumulative scene-root frame: `parent.worldFrame × localFrame`. */
  readonly worldFrame: Signal<Matrix2DValue>;

  /** Local-frame Box. Use `shape.box.x`, `.center`, `.at(u,v)`, etc.
   *  for box-local geometry. */
  readonly box: Box;

  /** Lens-backed parent-frame anchors. Reads return post-transform
   *  position; writes shift `translate` by the delta. Distinct from
   *  `shape.box.center` (local frame) — these track visual position. */
  get center(): Vec { return this.#anchor("center", 0.5, 0.5); }
  get top(): Vec    { return this.#anchor("top",    0.5, 0); }
  get bottom(): Vec { return this.#anchor("bottom", 0.5, 1); }
  get left(): Vec   { return this.#anchor("left",   0,   0.5); }
  get right(): Vec  { return this.#anchor("right",  1,   0.5); }
  at(u: number, v: number): Vec { return this.#makeAnchor(u, v); }

  readonly aside: boolean;

  protected disposers: (() => void)[] = [];

  private readonly _children = signal<readonly AnyShape[]>([]);
  readonly children: Signal<readonly AnyShape[]> = this._children;

  #parent: AnyShape | null = null;
  get parent(): AnyShape | null { return this.#parent; }

  constructor(
    intrinsicType?: string,
    boxFn?: () => BoxValue,
    opts: O = {} as O,
    /** Subclass per-prop defaults (kept off `O` so call-site types stay
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

    this.transform = new Transform();
    // Per-field bind via Val<T>. Each axis accepts plain/signal/thunk.
    const setField = <T>(target: Signal<T>, src: Val<T> | undefined): void => {
      if (src !== undefined) target.bind(src);
    };
    setField(this.transform.translate, opts.translate ?? defaults.translate ?? { x: 0, y: 0 });
    setField(this.transform.rotate,    opts.rotate    ?? defaults.rotate    ?? 0);
    setField(this.transform.scale,     opts.scale     ?? defaults.scale     ?? { x: 1, y: 1 });
    setField(this.transform.origin,    opts.origin    ?? defaults.origin    ?? { x: 0, y: 0 });
    setField(this.transform.opacity,   opts.opacity   ?? defaults.opacity   ?? 1);

    this.translate = this.transform.translate;
    this.rotate = this.transform.rotate;
    this.scale = this.transform.scale;
    this.origin = this.transform.origin;
    this.opacity = this.transform.opacity;
    this.aside = opts.aside ?? defaults.aside ?? false;

    // Group default: union of non-aside children's boxes, each composed
    // through its localFrame. `derived(Box, ...)` returns a Computed
    // wearing Box's surface (cardinals, x/y/w/h field lenses, ...).
    const boxSig = derived(Box,
      boxFn ??
        (() => {
          const cs = this._children.value
            .filter((c) => !c.aside)
            .map((c) => transformBox(c.localFrame.value, c.box.value));
          return cs.length ? BoxMath.union(...cs) : { x: 0, y: 0, w: 0, h: 0 };
        }),
    );

    this.box = boxSig;

    // Local frame: composed matrix from per-field signals. Identity
    // short-circuit avoids reading `origin` for no-transform groups.
    const tr = this.transform;
    this.localFrame = computed(() => {
      const t = tr.translate.value;
      const r = tr.rotate.value;
      const sc = tr.scale.value;
      if (t.x === 0 && t.y === 0 && r === 0 && sc.x === 1 && sc.y === 1) {
        return compose(t, r, sc, { x: 0, y: 0 });
      }
      return compose(t, r, sc, tr.origin.value);
    });

    // World frame: cumulative through ancestors. Re-parenting is NOT
    // reactive (parent ref is plain); rebuild manually if needed.
    this.worldFrame = computed(() => {
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

  /** Perimeter point toward `target` (parent frame, so connectors land
   *  on the visual edge after translate/rotate/scale). Default = Box
   *  edge math; tighter shapes (Circle, Rect) override. */
  boundary(toward: Vec): Vec {
    return derived(Vec, () =>
      BoxMath.edgeFrom(
        transformBox(this.localFrame.value, this.box.value),
        toward.value,
      ),
    );
  }

  // ── Lazy anchor construction ────────────────────────────────────────

  #makeAnchor(u: number, v: number): Vec {
    const boxSig = this.box;
    const lf = this.localFrame;
    const tr = this.transform;
    return derived(
      Vec,
      () => {
        const b = boxSig.value;
        return transformPoint(lf.value, { x: b.x + u * b.w, y: b.y + v * b.h });
      },
      (target) => {
        const b = boxSig.peek();
        const local = { x: b.x + u * b.w, y: b.y + v * b.h };
        const currentWorld = transformPoint(lf.peek(), local);
        const tNow = tr.translate.peek();
        tr.translate.value = {
          x: tNow.x + (target.x - currentWorld.x),
          y: tNow.y + (target.y - currentWorld.y),
        };
      },
    );
  }

  #anchor(name: string, u: number, v: number): Vec {
    const val = this.#makeAnchor(u, v);
    Object.defineProperty(this, name, {
      value: val, writable: false, configurable: false, enumerable: false,
    });
    return val;
  }

  /** Stroke segments — used by the dashed renderer. Default = bounding rect. */
  segments(): Segment[] {
    const b = this.box.value;
    return [
      { type: "line", from: { x: b.x, y: b.y }, to: { x: b.x + b.w, y: b.y } },
      { type: "line", from: { x: b.x + b.w, y: b.y }, to: { x: b.x + b.w, y: b.y + b.h } },
      { type: "line", from: { x: b.x + b.w, y: b.y + b.h }, to: { x: b.x, y: b.y + b.h } },
      { type: "line", from: { x: b.x, y: b.y + b.h }, to: { x: b.x, y: b.y } },
    ];
  }

  /** Bind one SVG attribute; static value sets once, reactive runs as effect. */
  attr(
    name: string,
    val: Val<string | number>,
    target: "intrinsic" | "wrapper" = "intrinsic",
  ): void {
    const el = target === "intrinsic" && this.intrinsic ? this.intrinsic : this.el;
    if (val instanceof Signal || typeof val === "function") {
      this.disposers.push(
        effect(() => el.setAttribute(name, String(value(val)))),
      );
    } else {
      el.setAttribute(name, String(val));
    }
  }

  /** Register a disposer to run on `dispose()`. */
  track(dispose: () => void): void { this.disposers.push(dispose); }

  /** Reactive effect torn down with the shape. */
  effect(fn: () => void): void { this.disposers.push(effect(fn)); }

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
// group rigidly. Generic `mean(...sigs)` is in `signals/values/`;
// these are shape-specific sugar.

/** Centroid of shapes' translates, as a writable Vec. Accepts anything
 *  with a writable `.translate: Vec` (Shape, mock, derived). */
export function centroid(...shapes: { translate: Vec }[]): Vec {
  return mean(...shapes.map((s) => s.translate));
}

/** Mean rotation as a writable Num. */
export function meanRotation(...shapes: { rotate: Num }[]): Num {
  return mean(...shapes.map((s) => s.rotate));
}

/** Mean scale as a writable Vec. */
export function meanScale(...shapes: { scale: Vec }[]): Vec {
  return mean(...shapes.map((s) => s.scale));
}
