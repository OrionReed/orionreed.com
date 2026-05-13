// Lightweight observable handles into a tex-rendered formula.
//
//      const { a, b, c } = parts("a", "b", "c");
//      tex`${a} + ${b} = ${c}`
//
// Identity for morph is by *marker reference*, not name. Visuals
// (highlight, opacity, color) are signal-driven; color cascades
// through `marker.group` so coloring `v` colors its `expand`-ed
// children. `Part` implements `Boxlike`, so `eq.parts.a.center` etc.
// are usable Pointlikes.
//
// The Boxlike surface (x/y/w/h, center/top/bottom/left/right, at,
// area) is installed at module load via
// `delegate(Part.prototype, "box", Box)` — see `signals/delegate.ts`.
// Each Boxlike axis or anchor materializes lazily on first read and
// caches as an own-property, matching the framework's own pattern.
// The `declare`-only field declarations below give TS the same view.
//
// `PartMarker` carries two identity-level signals (`color`, `highlighted`)
// that cascade up the `group` chain to the root marker. Both are also
// readable from any `Part` via `part.highlighted` / `part.color` shims.
// `register(id)` opts a marker into the global prose-linking registry so
// `<md-tex sym="id">` can find and subscribe to it from outside a diagram.

import {
  effect,
  signal,
  type Signal,
  type ReadonlySignal,
} from "../core/signal";
import { toSig, type Arg } from "../core/arg";
import { Box as BoxStruct, type Box, type Boxlike } from "../signals/box";
import { delegate } from "../signals/delegate";
import type { Pointlike } from "../signals/vec";
import type { TexShape } from "./tex";

/** A part's content can be a literal string, a signal, or a thunk. */
export type PartContent = Arg<string>;

/** Module-level registry for prose-linking: `marker.register(id)` →
 *  `getMarker(id)` so `<md-tex sym="id">` can find the marker without
 *  a DOM query or diagram reference. */
const markerRegistry = new Map<string, Marker>();

export function getMarker(id: string): Marker | undefined {
  return markerRegistry.get(id);
}

/** Named visual identity: a `color` and a `highlighted` toggle that
 *  any code can subscribe to. Used directly for non-tex shapes (circles,
 *  arrows, annotations) as well as being the base for `PartMarker`.
 *
 *  Register with `marker.register("post:name")` and reference from prose
 *  via `<md-tex sym="post:name">` or `<md-marker sym="post:name">`. */
export class Marker {
  /** Per-identity color. Applied to any `<md-tex sym>` or `<md-marker sym>`
   *  that resolves to this marker. Set to drive shape fills/strokes in
   *  `scene()` via `effect(() => shape.attr("fill", m.color.value ?? ""))`. */
  readonly color: Signal<string | null> = signal<string | null>(null);

  /** Identity-level highlight toggle. Setting this `true` highlights every
   *  diagram part and prose element bound to this marker simultaneously. */
  readonly highlighted: Signal<boolean> = signal(false);

  /** Register in the global prose-linking registry under `id`. Returns
   *  `this` for chaining:
   *
   *      const ballMarker = new Marker().register("sim:ball");
   *      ballMarker.color.value = RED;
   *      effect(() => ball.attr("fill", ballMarker.highlighted.value ? RED : DEFAULT));
   */
  register(id: string): this {
    markerRegistry.set(id, this);
    return this;
  }
}

/** Walk to the root of a marker's `group` chain (the original marker
 *  that `with()` / `expand()` derived from). `highlighted` lives on
 *  the root so all derived instances share one toggle. */
const rootMarker = (m: PartMarker): PartMarker => {
  let cur = m;
  while (cur.group) cur = cur.group;
  return cur;
};

/** Walk the `marker.group` chain to find the first marker with a
 *  non-null color. This is what gives identity-level color: setting
 *  `v.color` on a parent marker tints `v` and every `v.expand({...})`
 *  child whose own color is null. */
const effectiveColor = (m: PartMarker): string | null => {
  for (let cur: PartMarker | null = m; cur; cur = cur.group) {
    const c = cur.color.value;
    if (c !== null) return c;
  }
  return null;
};

/** A named, addressable region of a TexShape. Implements `Boxlike`
 *  so `part.center`, `part.top`, etc. are Pointlikes in the TexShape's
 *  local frame (read-only — parts are template-bound). */
export class Part<N extends string = string> implements Boxlike {
  /** Toggle the default highlight visual (a translucent background
   *  tint). Authors can also drive their own visuals off this signal. */
  readonly highlighted: Signal<boolean> = signal(false);
  /** Opacity in [0, 1]. Wired to `el.style.opacity`. */
  readonly opacity: Signal<number> = signal(1);

  // The canonical Box surface — passed in by the host, written by the
  // host on re-measure. Boxlike fields below are delegated from this.
  readonly box: ReturnType<typeof BoxStruct.signal>;

  // Boxlike axes + anchors. `declare`-only — installed at runtime by
  // `delegate(Part.prototype, "box", Box)` below, declared here so TS
  // sees them without emitting field initializers (which would shadow
  // the prototype getters at runtime).
  declare readonly x: ReadonlySignal<number>;
  declare readonly y: ReadonlySignal<number>;
  declare readonly w: ReadonlySignal<number>;
  declare readonly h: ReadonlySignal<number>;
  declare readonly center: Pointlike;
  declare readonly top: Pointlike;
  declare readonly bottom: Pointlike;
  declare readonly left: Pointlike;
  declare readonly right: Pointlike;
  declare readonly at: (u: number, v: number) => Pointlike;
  /** Reactive area (lazy + cached as own-property). */
  declare readonly area: ReadonlySignal<number>;

  /** Current live MathML node carrying `class="minim-part-N"`, or
   *  `null` if the host failed to mount it. Set by `bind`. */
  el: HTMLElement | null = null;

  #disposers: Array<() => void> = [];

  constructor(
    readonly name: N,
    readonly content: ReadonlySignal<string>,
    box: ReturnType<typeof BoxStruct.signal>,
    /** The marker this Part was instantiated from. Morph identifies
     *  same-identity parts by reference equality on this. */
    readonly marker: PartMarker,
    readonly host: TexShape,
  ) {
    this.box = box;
  }

  /** @internal Wire reactive state to `el`'s inline styles. Called by
   *  the host once per (re-)mount; the previous binding's effects are
   *  torn down first. */
  bind(el: HTMLElement | null, highlightColor: string): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.el = el;
    if (!el) return;
    this.#disposers.push(
      effect(() => {
        const partHl     = this.highlighted.value;
        const identityHl = rootMarker(this.marker).highlighted.value;
        if (identityHl) {
          // Identity-level (prose hover or diagram animation writing to the
          // marker): tint with the marker's own color at ~13% alpha so the
          // background matches the symbol's color identity, not a generic
          // yellow. Falls back to the configured highlightColor if no color
          // is set on the marker.
          const color = effectiveColor(this.marker);
          el.style.backgroundColor = color ? `${color}22` : highlightColor;
        } else if (partHl) {
          // Per-instance (animation-level): use the diagram token color.
          el.style.backgroundColor = highlightColor;
        } else {
          el.style.backgroundColor = "transparent";
        }
      }),
      effect(() => {
        el.style.opacity = String(this.opacity.value);
      }),
      effect(() => {
        // Resolves through marker.group chain; empty string clears.
        el.style.color = effectiveColor(this.marker) ?? "";
      }),
    );
  }

  /** @internal Tear down all reactive bindings. */
  dispose(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.el = null;
  }
}

// Install the Box surface as passthrough getters on Part.prototype.
// `exclude: ["box"]` keeps the struct's `box` self-reference from
// shadowing our own `box` field at the type level (at runtime the
// own-property would win anyway, but excluding is cleaner).
delegate(Part.prototype, "box", BoxStruct, { exclude: ["box"] });

/** Marker emitted by `part(name, content)` and `parts({...})`. Only
 *  valid inside `tex\`…\`` template holes. Identity for morph is by
 *  marker reference; `group` threads parent-marker through derived
 *  markers so `v` and `v.expand({vx,vy,vz})` count as one identity
 *  (1↔3 morphs). `color` and `highlighted` are inherited from `Marker`
 *  and cascade through the `group` chain for the color and root-marker
 *  behaviour respectively. */
export class PartMarker<N extends string = string> extends Marker {
  /** Resolved content (literal strings normalize to a constant
   *  signal; real signals/thunks pass through). */
  readonly content: ReadonlySignal<string>;

  constructor(
    readonly name: N,
    source: PartContent,
    /** Parent marker for derivation chains (`null` for roots). */
    readonly group: PartMarker | null = null,
  ) {
    super();
    this.content = toSig(source) as ReadonlySignal<string>;
  }

  /** One-off content override for a single template, keeping the same
   *  identity. The new marker is a child of `this` (group = this), so
   *  morph still treats them as one identity AND color cascades —
   *  `a.color = RED` tints `a.with("2")` automatically. */
  with(content: PartContent): PartMarker<N> {
    return new PartMarker(this.name, content, this);
  }

  /** Expand into named child markers that share this marker's
   *  identity. Each child has its own name (addressable as
   *  `eq.parts.vx`) and its own content; morph treats them as
   *  components of `this` (1↔N fan-out / fan-in). Children inherit
   *  this marker's color via the `group` chain.
   *
   *      const v = part("v", "\\vec{v}");
   *      const { vx, vy, vz } = v.expand({ vx: "v_x", vy: "v_y", vz: "v_z" });
   *      // Coloring v also colors vx, vy, vz:
   *      v.color.value = RED;
   */
  expand<T extends Record<string, PartContent>>(
    spec: T,
  ): { readonly [K in keyof T & string]: PartMarker<K> } {
    const out: Record<string, PartMarker> = {};
    for (const k in spec) out[k] = new PartMarker(k, spec[k], this);
    return out as { readonly [K in keyof T & string]: PartMarker<K> };
  }
}

/** Tag a single sub-formula by name. Content defaults to the name
 *  itself for the common identity case (`part("a")` ≡ `part("a", "a")`). */
export function part<N extends string>(
  name: N,
  content: PartContent = name,
): PartMarker<N> {
  return new PartMarker(name, content);
}

/** Bulk factory. Three forms, freely mixable:
 *
 *      parts("a", "b", "c")                        // names; content = name
 *      parts({ x: "x_{\\min}", y: "y_{\\max}" })   // explicit content
 *      parts("a", "b", { x: "x_{\\min}" })         // mixed
 *
 *  Names flow into the result's keys so `tex\`${a} + ${b}\`` infers
 *  `TexShape<"a" | "b">`. */
export function parts<T extends readonly (string | Record<string, PartContent>)[]>(
  ...specs: T
): MarkersFromSpecs<T> {
  const out: Record<string, PartMarker> = {};
  for (const spec of specs) {
    if (typeof spec === "string") {
      out[spec] = new PartMarker(spec, spec);
    } else {
      for (const k in spec) out[k] = new PartMarker(k, spec[k]);
    }
  }
  return out as MarkersFromSpecs<T>;
}

type MarkersFromSpecs<T extends readonly (string | Record<string, PartContent>)[]> = {
  readonly [K in NameOf<T[number]>]: PartMarker<K>;
};
type NameOf<S> = S extends string
  ? S
  : S extends Record<infer K, PartContent>
    ? K & string
    : never;

/** Set the same color on N markers at once. Plain imperative: writes
 *  `color.value = c` on each. Use `null` to clear. Equivalent to a
 *  for-loop, just terser:
 *
 *      tint(RED, a, b, c);   // ≡ for (const m of [a,b,c]) m.color.value = RED;
 */
export function tint(
  color: string | null,
  ...markers: readonly PartMarker[]
): void {
  for (const m of markers) m.color.value = color;
}

/** Iterable in positional order, indexable by name. */
export type PartList<Names extends string = string> = readonly Part[] & {
  readonly [K in Names]: Part<K>;
};

// Silence unused-import warning — `Box` type is needed for the
// `BoxStruct.signal` return type but not directly referenced.
void (null as unknown as Box);
