// Lightweight observable handles into a tex-rendered formula.
//
//      const { a, b, c } = parts("a", "b", "c");
//      tex`${a} + ${b} = ${c}`
//
// Identity for morph is by *marker reference*, not name. Visuals
// (highlight, opacity, color) are signal-driven; color cascades
// through `marker.group` so coloring `v` colors its `expand`-ed
// children. `Part` implements `Box`, so `eq.parts.a.center` etc.
// are usable Pointlikes.

import {
  effect,
  signal,
  type Signal,
  type ReadonlySignal,
} from "../core/signal";
import { toSig, type Arg } from "../core/arg";
import { type AABB, type Box, makeBox } from "../scene/box";
import type { Pointlike } from "../scene/point";
import type { TexShape } from "./tex";

/** A part's content can be a literal string, a signal, or a thunk. */
export type PartContent = Arg<string>;

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

/** A named, addressable region of a TexShape. Implements `Box` so
 *  `part.center`, `part.top`, etc. are Pointlikes in the TexShape's
 *  local frame (read-only — parts are template-bound). */
export class Part<N extends string = string> implements Box {
  /** Toggle the default highlight visual (a translucent background
   *  tint). Authors can also drive their own visuals off this signal. */
  readonly highlighted: Signal<boolean> = signal(false);
  /** Opacity in [0, 1]. Wired to `el.style.opacity`. */
  readonly opacity: Signal<number> = signal(1);

  // Box interface — derived from `aabb` via `makeBox`.
  readonly x: ReadonlySignal<number>;
  readonly y: ReadonlySignal<number>;
  readonly w: ReadonlySignal<number>;
  readonly h: ReadonlySignal<number>;
  readonly center: Pointlike;
  readonly top: Pointlike;
  readonly bottom: Pointlike;
  readonly left: Pointlike;
  readonly right: Pointlike;
  readonly at: (u: number, v: number) => Pointlike;

  /** Current live MathML node carrying `class="minim-part-N"`, or
   *  `null` if the host failed to mount it. Set by `bind`. */
  el: HTMLElement | null = null;

  #disposers: Array<() => void> = [];

  constructor(
    readonly name: N,
    readonly content: ReadonlySignal<string>,
    readonly aabb: ReadonlySignal<AABB>,
    /** The marker this Part was instantiated from. Morph identifies
     *  same-identity parts by reference equality on this. */
    readonly marker: PartMarker,
    readonly host: TexShape,
  ) {
    const b = makeBox(aabb);
    this.x = b.x;
    this.y = b.y;
    this.w = b.w;
    this.h = b.h;
    this.center = b.center;
    this.top = b.top;
    this.bottom = b.bottom;
    this.left = b.left;
    this.right = b.right;
    this.at = b.at;
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
        el.style.backgroundColor = this.highlighted.value
          ? highlightColor
          : "transparent";
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

/** Marker emitted by `part(name, content)` and `parts({...})`. Only
 *  valid inside `tex\`…\`` template holes. Identity for morph is by
 *  marker reference; `group` threads parent-marker through derived
 *  markers so `v` and `v.expand({vx,vy,vz})` count as one identity
 *  (1↔3 morphs). `color` is per-marker and cascades to children. */
export class PartMarker<N extends string = string> {
  /** Resolved content (literal strings normalize to a constant
   *  signal; real signals/thunks pass through). */
  readonly content: ReadonlySignal<string>;

  /** Per-identity color override. `null` (default) walks up to the
   *  parent marker, eventually falling back to inherited (no inline
   *  style). Set this to color every Part instantiated from this
   *  marker, in any TexShape, retroactively. */
  readonly color: Signal<string | null> = signal<string | null>(null);

  constructor(
    readonly name: N,
    source: PartContent,
    /** Parent marker for derivation chains (`null` for roots). */
    readonly group: PartMarker | null = null,
  ) {
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
