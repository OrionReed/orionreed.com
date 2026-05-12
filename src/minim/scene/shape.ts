import {
  computed,
  effect,
  signal,
  Signal,
  type ReadonlySignal,
} from "../core/signal";
import { toSig, type Arg, type ResolveSig } from "../core/arg";
import {
  aabb,
  aabbEdgeFrom,
  unionAABB,
  type AABB,
  type Box,
} from "./box";
import type { Vec } from "../core/vec";
import {
  compose,
  invert,
  multiply,
  toString as matrixToString,
  transformAABB,
  transformPoint,
  type Matrix2D,
} from "./matrix";
import {
  DerivedPoint,
  Point,
  lensPoint,
  pt,
  toPoint,
  type Pointlike,
  type ResolveVec,
} from "./point";
import { suspend, type Animator } from "../core/anim";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** A stroke segment — line or arc. Subclasses override `segments()`
 *  to expose their geometry to the dashed renderer. */
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

/** Construction options shared by every Shape.
 *
 *  - Animatable props accept `Arg<T>` (value / Signal / thunk).
 *  - `origin` is the local-frame pivot for `rotate` / `scale`;
 *    subclasses pick sensible defaults.
 *  - `aside` excludes this shape from its parent's bounds (and
 *    auto-fit) — for decorative overlays. */
export interface ShapeOpts {
  translate?: Arg<Vec>;
  rotate?: Arg<number>;
  scale?: Arg<Vec>;
  origin?: Arg<Vec>;
  opacity?: Arg<number>;
  aside?: boolean;
}

type Lookup<O, K extends keyof ShapeOpts> = K extends keyof O
  ? O[K]
  : undefined;

/** Wide-form escape hatch for heterogeneous shape collections — sidesteps
 *  the conditional-prop generic. Prefer `Shape` or `Writable<K>` when
 *  you can. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyShape = Shape<any>;

export type AnimatableKey =
  | "translate"
  | "rotate"
  | "scale"
  | "origin"
  | "opacity";

/** Resolved field type per animatable prop. */
type AnimatableField<K extends AnimatableKey> = K extends
  | "translate"
  | "scale"
  | "origin"
  ? Point
  : Signal<number>;

/** "Any shape whose listed props are writable." Combinable via union —
 *  use in helpers that animate specific props but should still accept
 *  shapes with other props readonly. */
export type Writable<K extends AnimatableKey> = {
  readonly [P in K]: AnimatableField<P>;
};

/** Universal scene-graph node. Wraps an SVG `<g>` (transform + opacity
 *  + children); subclasses add an intrinsic element and geometry.
 *  A bare `new Shape()` is a group.
 *
 *  Generic over `O` so user-supplied prop types flow through — a
 *  `computed` field becomes readonly (writes are compile errors),
 *  Signal/value stays writable. Plain `Shape` is writable everywhere;
 *  for the mixed case see `Writable<K>`. */
export class Shape<O extends ShapeOpts = ShapeOpts> implements Box {
  readonly el: SVGGElement;
  readonly intrinsic?: SVGElement;

  readonly translate: ResolveVec<Lookup<O, "translate">>;
  readonly rotate: ResolveSig<Lookup<O, "rotate">, number>;
  readonly scale: ResolveVec<Lookup<O, "scale">>;
  readonly origin: ResolveVec<Lookup<O, "origin">>;
  readonly opacity: ResolveSig<Lookup<O, "opacity">, number>;

  // ── Box interface ────────────────────────────────────────────────────
  /** Local-frame AABB Signal; source-of-truth for the scalar fields
   *  below. For groups, the union of non-aside children's AABBs (each
   *  composed through its transform). */
  readonly aabb: ReadonlySignal<AABB>;
  readonly x: ReadonlySignal<number>;
  readonly y: ReadonlySignal<number>;
  readonly w: ReadonlySignal<number>;
  readonly h: ReadonlySignal<number>;

  /** Writable parent-frame anchor: reads return the post-transform
   *  position (so connectors and labels track translate/rotate/scale);
   *  writes shift `translate` so the anchor lands at the target. Writes
   *  fail if `translate` is readonly. */
  readonly center: Point;
  readonly top: Point;
  readonly bottom: Point;
  readonly left: Point;
  readonly right: Point;
  at: (u: number, v: number) => Point;

  /** Composed `translate × pivoted-rotate × pivoted-scale`. Decoupled
   *  from `aabb` so transforms don't trigger AABB recomputation. */
  readonly transform: ReadonlySignal<Matrix2D>;
  readonly aside: boolean;

  protected disposers: (() => void)[] = [];

  private readonly _children = signal<readonly AnyShape[]>([]);
  readonly children: ReadonlySignal<readonly AnyShape[]> = this._children;

  #parent: AnyShape | null = null;
  get parent(): AnyShape | null {
    return this.#parent;
  }

  constructor(
    intrinsicType?: string,
    aabbFn?: () => AABB,
    opts: O = {} as O,
    /** Subclass per-prop defaults (kept off `O` so the field types
     *  stay driven by user input only). */
    defaults: ShapeOpts = {},
  ) {
    this.el = document.createElementNS(SVG_NS, "g") as SVGGElement;
    // CSS transforms (vs SVG `transform`) hit the GPU composite path —
    // significantly faster for many animating shapes. Pin
    // transform-origin to the SVG userspace origin so our composed
    // pivot math is correct (browser defaults vary).
    this.el.style.transformOrigin = "0 0";
    if (intrinsicType) {
      this.intrinsic = document.createElementNS(SVG_NS, intrinsicType);
      this.el.appendChild(this.intrinsic);
    }

    // Cast narrows the field type from `toPoint`'s wider return; the
    // runtime is unchanged.
    type CastVec<K extends keyof ShapeOpts> = ResolveVec<Lookup<O, K>>;
    type CastNum<K extends keyof ShapeOpts> = ResolveSig<Lookup<O, K>, number>;
    this.translate = toPoint(opts.translate ?? defaults.translate, {
      x: 0,
      y: 0,
    }) as CastVec<"translate">;
    this.rotate = toSig(opts.rotate ?? defaults.rotate, 0) as CastNum<"rotate">;
    this.scale = toPoint(opts.scale ?? defaults.scale, {
      x: 1,
      y: 1,
    }) as CastVec<"scale">;
    this.origin = toPoint(opts.origin ?? defaults.origin, {
      x: 0,
      y: 0,
    }) as CastVec<"origin">;
    this.opacity = toSig(
      opts.opacity ?? defaults.opacity,
      1,
    ) as CastNum<"opacity">;
    this.aside = opts.aside ?? defaults.aside ?? false;

    // Group default: union of non-aside children's AABBs, each composed
    // through its transform. Lazy — `this._children` is read on access.
    const aabbSig = computed(
      aabbFn ??
        (() => {
          const cs = this._children.value
            .filter((c) => !c.aside)
            .map((c) => transformAABB(c.transform.value, c.aabb.value));
          return cs.length ? unionAABB(...cs) : aabb(0, 0, 0, 0);
        }),
    );
    this.aabb = aabbSig;
    this.x = computed(() => aabbSig.value.x);
    this.y = computed(() => aabbSig.value.y);
    this.w = computed(() => aabbSig.value.w);
    this.h = computed(() => aabbSig.value.h);

    this.transform = computed(() => {
      const t = this.translate.value;
      const r = this.rotate.value;
      const sc = this.scale.value;
      if (t.x === 0 && t.y === 0 && r === 0 && sc.x === 1 && sc.y === 1) {
        return compose(t, r, sc, { x: 0, y: 0 });
      }
      return compose(t, r, sc, this.origin.value);
    });

    // Lens-backed writable anchors. Reads project the local AABB anchor
    // through `transform` (post-transform parent-frame). Writes shift
    // `translate` by (target - currentWorldAnchor) — exact under any
    // rotation/scale, since `translate` is purely additive after the
    // linear part of the compose. Writes assume `translate` is writable;
    // if a caller passed a `computed` translate, the assignment throws.
    const makeAnchor = (u: number, v: number): Point =>
      lensPoint(
        () => {
          const b = aabbSig.value;
          return transformPoint(this.transform.value, {
            x: b.x + u * b.w,
            y: b.y + v * b.h,
          });
        },
        (target) => {
          const b = aabbSig.peek();
          const local = { x: b.x + u * b.w, y: b.y + v * b.h };
          const currentWorld = transformPoint(this.transform.peek(), local);
          const tNow = this.translate.peek();
          (this.translate as Signal<Vec>).value = {
            x: tNow.x + (target.x - currentWorld.x),
            y: tNow.y + (target.y - currentWorld.y),
          };
        },
      );
    this.at = makeAnchor;
    this.center = makeAnchor(0.5, 0.5);
    this.top = makeAnchor(0.5, 0);
    this.bottom = makeAnchor(0.5, 1);
    this.left = makeAnchor(0, 0.5);
    this.right = makeAnchor(1, 0.5);

    this.disposers.push(
      effect(() => {
        this.el.style.transform = matrixToString(this.transform.value);
      }),
      effect(() => {
        this.el.style.opacity = String(this.opacity.value);
      }),
    );
  }

  /** Perimeter point in the direction of `toward`. In parent-frame, so
   *  it matches the new anchor reads: connectors land on the visual
   *  edge after translate/rotate/scale. Default is AABB-edge math;
   *  tighter shapes (Circle, Rect) override. */
  boundary(toward: Pointlike): DerivedPoint {
    return new DerivedPoint(() =>
      aabbEdgeFrom(
        transformAABB(this.transform.value, this.aabb.value),
        toward.value,
      ),
    );
  }

  /** Stroke segments — used by the dashed renderer. Default is the
   *  bounding rect. */
  segments(): Segment[] {
    const b = this.aabb.value;
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

  /** Bind one SVG attribute. Static value sets once; Signal/thunk
   *  runs as a reactive effect. */
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

  /** Subscribe to a DOM event on the wrapper `<g>`. Returns a disposer;
   *  also auto-detaches on shape dispose. */
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

  /** Wake on the next `name` event; resume with the event. Use
   *  `const evt = yield* s.until("click")` to receive the typed event,
   *  or `yield s.until("click")` to ignore it. */
  until(name: string): Animator<Event> {
    return suspend<Event>((wake) => {
      const handler = (e: Event) => wake(e);
      return this.on(name, handler, { once: true });
    });
  }

  /** Map client-space coords (e.g. `evt.clientX/clientY`) into this
   *  shape's local frame via `getScreenCTM`. */
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

/** `shape`'s AABB in the scene-root frame. */
export function aabbInRoot(shape: AnyShape): ReadonlySignal<AABB> {
  return computed(() => {
    let m = shape.transform.value;
    let p = shape.parent;
    while (p) {
      m = multiply(p.transform.value, m);
      p = p.parent;
    }
    return transformAABB(m, shape.aabb.value);
  });
}

/** `shape`'s AABB in `observer`'s local frame. */
export function aabbIn(
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
    return transformAABB(multiply(invert(mObs), mShape), shape.aabb.value);
  });
}
