import {
  computed,
  effect,
  signal,
  Signal,
  type ReadonlySignal,
} from "../core/signal";
import { toSig, type Arg, type ResolveSig } from "../core/arg";
import {
  Bounds,
  aabb,
  aabbEdgeFrom,
  unionAABB,
  type AABB,
} from "./bounds";
import type { Vec } from "../core/vec";
import {
  compose,
  invert,
  isIdentity,
  multiply,
  toString as matrixToString,
  transformAABB,
  type Matrix2D,
} from "./matrix";
import {
  DerivedPoint,
  Point,
  pt,
  toPoint,
  type Pointlike,
  type ResolveVec,
} from "./point";
import type { Animator } from "../core/anim";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** A stroke segment — line or arc. Used by `Shape.segments()` to drive
 *  dashed rendering; subclasses override to expose their geometry. */
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

/** Construction-time options shared by every Shape. Animatable props
 *  accept `Arg<T>` (value / Signal / thunk) — Points satisfy
 *  `Arg<Vec>` directly because they extend `Signal<Vec>`.
 *
 *  `origin` is the local-frame point about which `rotate` and `scale`
 *  are applied. Subclasses pick sensible defaults (circle's center,
 *  rect's bbox center, …); groups default to `(0, 0)`.
 *
 *  `aside` excludes this shape from its parent's children-union bounds
 *  (and transitively from auto-fit) — for decorative overlays that
 *  shouldn't extend the diagram's natural extent. */
export interface ShapeOpts {
  translate?: Arg<Vec>;
  rotate?: Arg<number>;
  scale?: Arg<Vec>;
  origin?: Arg<Vec>;
  opacity?: Arg<number>;
  aside?: boolean;
}

type Lookup<O, K extends keyof ShapeOpts> = K extends keyof O ? O[K] : undefined;

/** Wide-form escape hatch — sidesteps invariant generic mismatches
 *  caused by the conditional prop types. Reach for this when you need
 *  to accept shapes with readonly props alongside default-writable
 *  ones (e.g. heterogeneous parent/child collections). For the common
 *  case prefer `Shape` and let the type system catch mismatches. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyShape = Shape<any>;

/** The animatable props a Shape exposes as `Signal`-backed fields. */
export type AnimatableKey = "translate" | "rotate" | "scale" | "origin" | "opacity";

type AnimatableValue<K extends AnimatableKey> =
  K extends "translate" | "scale" | "origin" ? Vec : number;

/** Constrain to "any object with these animatable props writable."
 *  Combinable via union — `Writable<"translate" | "opacity">` requires
 *  both props writable. Use for helpers that animate specific props
 *  but should still accept shapes whose *other* props are readonly. */
export type Writable<K extends AnimatableKey> = {
  readonly [P in K]: Signal<AnimatableValue<P>>;
};

/** Universal scene-graph node. Wraps an SVG `<g>` (transform + opacity
 *  + children); subclasses add an intrinsic SVG element and geometry-
 *  specific vocabulary. A bare `new Shape()` is a group.
 *
 *  Generic over `O` so each animatable prop's type tracks the user's
 *  input — `computed(...)` → readonly field (writes are compile errors),
 *  value/Signal → writable. Plain `Shape` (no generic) resolves to
 *  writable-everywhere; see `Writable<K>` for the in-between case. */
export class Shape<O extends ShapeOpts = ShapeOpts> {
  readonly el: SVGGElement;
  readonly intrinsic?: SVGElement;

  readonly translate: ResolveVec<Lookup<O, "translate">>;
  readonly rotate: ResolveSig<Lookup<O, "rotate">, number>;
  readonly scale: ResolveVec<Lookup<O, "scale">>;
  readonly origin: ResolveVec<Lookup<O, "origin">>;
  readonly opacity: ResolveSig<Lookup<O, "opacity">, number>;
  /** Local-frame AABB. Lazy — only evaluates when read, so a diagram
   *  that never calls `s.fit()` / `connect` / layout helpers pays
   *  nothing for bounds. For groups it's the union of non-aside
   *  children's bounds composed through each child's transform. */
  readonly bounds: Bounds;
  /** Composed `translate × pivoted-rotate × pivoted-scale`, pivoting
   *  around `origin` (decoupled from `bounds`, so transforms don't
   *  trigger bounds evaluation). */
  readonly transform: ReadonlySignal<Matrix2D>;
  readonly aside: boolean;

  protected disposers: (() => void)[] = [];

  private readonly _children = signal<readonly AnyShape[]>([]);
  readonly children: ReadonlySignal<readonly AnyShape[]> = this._children;

  #parent: AnyShape | null = null;
  get parent(): AnyShape | null { return this.#parent; }

  constructor(
    intrinsicType?: string,
    boundsFn?: () => AABB,
    opts: O = {} as O,
    /** Subclass-supplied per-prop defaults — e.g. Circle wires
     *  `origin: () => center.value`. Kept off `O` so the field types
     *  stay driven by user input only. */
    defaults: ShapeOpts = {},
  ) {
    this.el = document.createElementNS(SVG_NS, "g") as SVGGElement;
    // Use CSS transforms (set below) instead of the SVG `transform`
    // attribute — the GPU-composited path is significantly faster for
    // large numbers of animating shapes. Pin transform-origin to the
    // SVG userspace origin so our composed matrix's pivot math stays
    // correct (browsers vary on the SVG default).
    this.el.style.transformOrigin = "0 0";
    if (intrinsicType) {
      this.intrinsic = document.createElementNS(SVG_NS, intrinsicType);
      this.el.appendChild(this.intrinsic);
    }

    // Cast aligns the field's conditional type with the wider return —
    // runtime is unchanged either way.
    type CastVec<K extends keyof ShapeOpts> = ResolveVec<Lookup<O, K>>;
    type CastNum<K extends keyof ShapeOpts> = ResolveSig<Lookup<O, K>, number>;
    this.translate = toPoint(opts.translate ?? defaults.translate, { x: 0, y: 0 }) as CastVec<"translate">;
    this.rotate = toSig(opts.rotate ?? defaults.rotate, 0) as CastNum<"rotate">;
    this.scale = toPoint(opts.scale ?? defaults.scale, { x: 1, y: 1 }) as CastVec<"scale">;
    this.origin = toPoint(opts.origin ?? defaults.origin, { x: 0, y: 0 }) as CastVec<"origin">;
    this.opacity = toSig(opts.opacity ?? defaults.opacity, 1) as CastNum<"opacity">;
    this.aside = opts.aside ?? defaults.aside ?? false;

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

    this.transform = computed(() => {
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
        const m = this.transform.value;
        this.el.style.transform = isIdentity(m) ? "" : matrixToString(m);
      }),
      effect(() => {
        this.el.setAttribute("opacity", String(this.opacity.value));
      }),
    );
  }

  /** Analytic perimeter point in the direction of `toward`. Default
   *  is AABB-edge math; tighter shapes (Circle, Rect) override. */
  boundary(toward: Pointlike): DerivedPoint {
    return new DerivedPoint(() =>
      aabbEdgeFrom(this.bounds.value, toward.value),
    );
  }

  /** Stroke segments — used by dashed rendering. Default is the
   *  bounding rect (4 sides, no corners). */
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

  /** Sugar for `track(effect(fn))` — runs reactively, torn down with
   *  the shape. */
  effect(fn: () => void): void {
    this.disposers.push(effect(fn));
  }

  // ── DOM events ──────────────────────────────────────────────────────

  /** Subscribe to a DOM event on this shape's element. Returns a
   *  disposer that detaches the listener; cleanup is also automatic
   *  when the shape disposes. */
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

  /** Reactive signal that increments on each emit of `name`, carrying
   *  the latest event. Lazy: the underlying listener is installed on
   *  first call (per name). */
  onSignal(name: string): ReadonlySignal<{ count: number; last: Event | undefined }> {
    if (!this._eventSignals) this._eventSignals = new Map();
    const cached = this._eventSignals.get(name);
    if (cached) return cached;
    const sig = signal({ count: 0, last: undefined as Event | undefined });
    this._eventSignals.set(name, sig);
    this.on(name, (e) => {
      sig.value = { count: sig.peek().count + 1, last: e };
    });
    return sig;
  }

  /** Generator that yields frames until the next emit of `name`. */
  *until(name: string): Animator {
    const sig = this.onSignal(name);
    const start = sig.peek().count;
    while (sig.value.count === start) yield;
  }

  /** Convert client-space coordinates (e.g. `evt.clientX/clientY`) to
   *  this shape's local frame via `getScreenCTM`. */
  toLocal(evt: { clientX: number; clientY: number }): Vec {
    const target = (this.intrinsic ?? this.el) as SVGGraphicsElement;
    const ctm = target.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    return {
      x: evt.clientX * inv.a + evt.clientY * inv.c + inv.e,
      y: evt.clientX * inv.b + evt.clientY * inv.d + inv.f,
    };
  }

  private _eventSignals?: Map<
    string,
    Signal<{ count: number; last: Event | undefined }>
  >;

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

// ── Cross-frame helpers ─────────────────────────────────────────────

/** AABB of `shape` in the scene-root frame. Reactive in any shape's
 *  transform along the parent chain. */
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
 *  `connect`/`arrow` calls that span subtrees with different transforms. */
export function boundsIn(
  shape: AnyShape,
  observer: AnyShape,
): ReadonlySignal<AABB> {
  return computed(() => {
    let mShape = shape.transform.value;
    for (let p = shape.parent; p; p = p.parent) {
      mShape = multiply(p.transform.value, mShape);
    }
    let mObs = observer.transform.value;
    for (let p = observer.parent; p; p = p.parent) {
      mObs = multiply(p.transform.value, mObs);
    }
    // shape-local → observer-local = inv(observer→root) ⋅ shape→root
    return transformAABB(multiply(invert(mObs), mShape), shape.bounds.value);
  });
}

/** Wire `handle` for pointer-drag — every move while pressed calls
 *  `onDrag(local)` with the current pointer position in `handle`'s
 *  local coordinate frame. Captures the pointer so drags continue
 *  outside the handle's bounds. Returns a disposer. */
export function draggable(
  handle: AnyShape,
  onDrag: (local: Vec) => void,
): () => void {
  let dragging = false;
  let pointerId = -1;
  const offs: Array<() => void> = [];
  offs.push(handle.on("pointerdown", (e) => {
    const pe = e as PointerEvent;
    dragging = true;
    pointerId = pe.pointerId;
    handle.el.setPointerCapture(pointerId);
    onDrag(handle.toLocal(pe));
  }));
  offs.push(handle.on("pointermove", (e) => {
    if (!dragging) return;
    onDrag(handle.toLocal(e as PointerEvent));
  }));
  const stop = () => {
    if (dragging && pointerId !== -1) {
      try { handle.el.releasePointerCapture(pointerId); } catch { /* ok */ }
    }
    dragging = false;
    pointerId = -1;
  };
  offs.push(handle.on("pointerup", stop));
  offs.push(handle.on("pointercancel", stop));
  return () => offs.forEach((d) => d());
}
