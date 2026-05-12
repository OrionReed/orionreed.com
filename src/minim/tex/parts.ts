// Lightweight observable handles into a tex-rendered formula.
//
// A `Part` is *not* a Shape — it's an `aabb` signal plus per-part
// reactive state (highlighted, opacity), sharing the parent
// TexShape's single `<foreignObject>` rendering. This keeps per-glyph
// cost out of the scene graph: marking N named parts allocates N
// small objects, not N Shapes.
//
// Authoring surface:
//
//      const { a, b, c } = parts({ a: "a", b: "b", c: "c" });
//      tex`${a} + ${b} = ${c}`
//
// Or, for one-offs:
//
//      tex`${part("a", "x_{\\min}")} < ${part("b", "x_{\\max}")}`
//
// Content can be a signal, in which case the equation re-renders on
// change. Names flow into the `TexShape` type so `eq.parts.a` is
// statically typed and `eq.parts.x` is a TS error.

import { effect, signal, type Signal, type ReadonlySignal } from "../core/signal";
import { toSig, type Arg } from "../core/arg";
import type { AABB } from "../scene/box";
import type { TexShape } from "./tex";

/** A part's content can be a literal string, a signal, or a thunk. */
export type PartContent = Arg<string>;

/** A named, addressable region of a TexShape. `aabb` is in the parent
 *  TexShape's local frame; `highlighted`, `opacity`, and `color` are
 *  wired by the Part itself to its live MathML element so authors can
 *  drive per-part visuals reactively without reaching for the DOM.
 *
 *  `marker` is a back-pointer to the `PartMarker` that birthed this
 *  Part: same marker across two TexShapes means "same identity" for
 *  morph (regardless of name). Markers in a derivation chain
 *  (`marker.group`) let morph fan out 1↔N when the same identity is
 *  expressed as one symbol in one form and many in another.
 *
 *  Visual-binding lifecycle: tex.ts calls `bind` once per (re-)render
 *  with the freshly-mounted MathML node. `bind` tears down any
 *  previous effects, points `el` at the new node, and creates new
 *  effects against it. `dispose` (called when the host TexShape goes
 *  away) tears them down for good. */
export class Part<N extends string = string> {
  /** Toggle the default highlight visual (a translucent background
   *  tint). Authors can also drive their own visuals off this signal. */
  readonly highlighted: Signal<boolean> = signal(false);
  /** Opacity in [0, 1]. Wired to `el.style.opacity` whenever a live
   *  el is bound, so per-part fades compose with the rest of minim's
   *  animation primitives. */
  readonly opacity: Signal<number> = signal(1);
  /** Per-part text color override. `null` (default) leaves the inherited
   *  color from `tokens.stroke`. Useful for showing correspondence
   *  across forms ("the red letter on the left becomes these red
   *  letters on the right"). */
  readonly color: Signal<string | null> = signal<string | null>(null);

  /** Current live MathML node carrying `class="minim-part-N"`, or
   *  `null` if the host failed to mount it. Set by `bind`. */
  el: HTMLElement | null = null;

  /** Disposers for the per-el visual effects. Cleared and rebuilt on
   *  each `bind`. */
  #disposers: Array<() => void> = [];

  constructor(
    readonly name: N,
    /** Original LaTeX source for this sub-formula. Reactive: when the
     *  underlying signal changes, the parent TexShape re-renders. */
    readonly content: ReadonlySignal<string>,
    readonly aabb: ReadonlySignal<AABB>,
    /** The PartMarker this Part was instantiated from. Morph uses
     *  this (and `marker.group`) to identify same-identity parts
     *  across TexShapes — including 1↔N expansions. */
    readonly marker: PartMarker,
    /** The host TexShape. Set at construction (Part can't exist
     *  without one). Used by motion combinators (`pluck`, `morph`,
     *  `partPose`, …) to derive parent-frame coordinates. */
    readonly host: TexShape,
  ) {}

  /** @internal Wire reactive state (highlighted, opacity, color) to
   *  `el`'s inline styles. Call once after the live el is mounted,
   *  and again after any reactive content re-render that replaces
   *  the el. Tears down previous effects first so we never have two
   *  effects fighting over the same node. */
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
        // Empty string clears the inline style (revert to inherited).
        el.style.color = this.color.value ?? "";
      }),
    );
  }

  /** @internal Tear down all reactive bindings. Called by the host
   *  TexShape on dispose. */
  dispose(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.el = null;
  }
}

/** Marker emitted by `part(name, content)` and `parts({...})`. Only
 *  valid inside `tex\`…\`` template holes — the tag picks these up to
 *  wrap content in `\class{minim-part-…}{…}`.
 *
 *  Identity for morph is by *marker reference* (not by name). Two
 *  Parts in different TexShapes share identity iff their markers are
 *  the same instance. The `group` field threads a parent-marker
 *  reference through derived markers so morph treats `v` (one symbol)
 *  and `{vx, vy, vz}` (three symbols) as 1↔3 components of the same
 *  identity — see `derived` below. */
export class PartMarker<N extends string = string> {
  /** Resolved content as a signal (literal strings normalize to a
   *  one-shot constant signal; real signals/thunks pass through). */
  readonly content: ReadonlySignal<string>;

  constructor(
    readonly name: N,
    source: PartContent,
    /** Parent marker for derivation chains (`null` for roots). When
     *  set, morph treats this marker and its parent (and other
     *  siblings) as components of one identity, enabling 1↔N fan-out
     *  / fan-in animations. */
    readonly group: PartMarker | null = null,
  ) {
    this.content = toSig(source) as ReadonlySignal<string>;
  }

  /** One-off content override for a single template, keeping the same
   *  identity (same name, same group). Useful when most equations
   *  agree on a part's rendering but one needs a tweak (e.g.
   *  `c.with("c²")`) or when a single value gets substituted in
   *  (`a.with("2")` for a concrete-number form). */
  with(content: PartContent): PartMarker<N> {
    return new PartMarker(this.name, content, this.group);
  }

  /** Expand this marker into named child markers that share its
   *  identity for morph purposes. Each child has its own name (so it's
   *  individually addressable as `eq.parts.vx`, `eq.parts.vy`, …) and
   *  its own content, but morph treats them as components of this
   *  marker. Morphing between an equation containing `this` and one
   *  containing the children fans out 1→N (source fades in place, N
   *  riders emerge from its position and slide to their respective
   *  slots) — and the reverse direction folds N→1.
   *
   *      const v = part("v", "\\vec{v}");
   *      const { vx, vy, vz } = v.expand({
   *        vx: "v_x", vy: "v_y", vz: "v_z",
   *      });
   *      const sym  = tex`${v}`;
   *      const comp = tex`(${vx}, ${vy}, ${vz})`;
   *      yield* morph(sym, comp);   // v fans out into vx, vy, vz
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
 *  itself for the common identity case (`part("a")` ≡ `part("a", "a")`):
 *
 *      tex`${part("a")} + ${part("b")} = ${part("c")}`
 *      tex`${part("min", "x_{\\min}")} < ${part("max", "x_{\\max}")}`
 */
export function part<N extends string>(
  name: N,
  content: PartContent = name,
): PartMarker<N> {
  return new PartMarker(name, content);
}

/** Bulk factory: declare a set of named parts to share across multiple
 *  equations, retaining identity for `morph`. Three forms, freely
 *  mixable so the common "name == content" case stays terse:
 *
 *      parts("a", "b", "c")                        // names; content = name
 *      parts({ x: "x_{\\min}", y: "y_{\\max}" })   // explicit content
 *      parts("a", "b", { x: "x_{\\min}" })         // mixed: a, b default; x custom
 *
 *  Names flow into the result's keys so `tex`${a} + ${b}`` infers
 *  `TexShape<"a" | "b">` and `eq.parts.x` is a TS error. */
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

/** Type-level union of marker keys produced by a `parts(...specs)`
 *  call. String specs contribute their literal name; object specs
 *  contribute their own keys. */
type MarkersFromSpecs<T extends readonly (string | Record<string, PartContent>)[]> = {
  readonly [K in NameOf<T[number]>]: PartMarker<K>;
};
type NameOf<S> = S extends string
  ? S
  : S extends Record<infer K, PartContent>
    ? K & string
    : never;

/** Iterable in positional order, indexable by name. The `Names`
 *  generic carries the union of declared part names so `eq.parts.a`
 *  is typed and `eq.parts.x` (undeclared) is a compile error. */
export type PartList<Names extends string = string> = readonly Part[] & {
  readonly [K in Names]: Part<K>;
};
