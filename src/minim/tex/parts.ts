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
 *  TexShape's local frame; `highlighted` and `opacity` are wired by
 *  the Part itself to its live MathML element so authors can drive
 *  per-part visuals reactively without reaching for the DOM.
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

  /** @internal Back-pointer to the host TexShape. Set by tex.ts at
   *  construction. Used by motion combinators (`pluck`, `morph`, …)
   *  to derive the part's parent-frame position. */
  // biome-ignore lint/style/noNonNullAssertion: assigned in tex.ts immediately after construction
  _host!: TexShape;

  /** Current live MathML node carrying `class="minim-part-N"`, or
   *  `null` if the host failed to mount it. Set by `bind`. */
  el: HTMLElement | null = null;

  /** Disposers for the per-el visual effects (highlighted → bg,
   *  opacity → style). Cleared and rebuilt on each `bind`. */
  #disposers: Array<() => void> = [];

  constructor(
    readonly name: N,
    /** Original LaTeX source for this sub-formula. Reactive: when the
     *  underlying signal changes, the parent TexShape re-renders. */
    readonly content: ReadonlySignal<string>,
    readonly aabb: ReadonlySignal<AABB>,
  ) {}

  /** @internal Wire the Part's reactive state (highlighted, opacity)
   *  to `el`'s inline styles. Call once after the live el is mounted,
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
 *  wrap content in `\class{minim-part-…}{…}`. */
export class PartMarker<N extends string = string> {
  /** Resolved content as a signal (literal strings normalize to a
   *  one-shot constant signal; real signals/thunks pass through). */
  readonly content: ReadonlySignal<string>;

  constructor(readonly name: N, source: PartContent) {
    this.content = toSig(source) as ReadonlySignal<string>;
  }

  /** One-off content override for a single template, keeping the same
   *  identity name. Useful when most equations agree on a part's
   *  rendering but one needs a tweak (e.g. `c.with("c²")`). */
  with(content: PartContent): PartMarker<N> {
    return new PartMarker(this.name, content);
  }
}

/** Tag a single sub-formula by name. Equivalent to
 *  `parts({ [name]: content })` but returns a single marker:
 *
 *      tex`${part("a", "x_{\\min}")} < ${part("b", "x_{\\max}")}`
 */
export function part<N extends string>(
  name: N,
  content: PartContent,
): PartMarker<N> {
  return new PartMarker(name, content);
}

/** Bulk factory: declare a set of named parts to share across multiple
 *  equations, retaining identity for `morph`. The returned record's
 *  keys preserve their literal types so `tex` can infer the union of
 *  available names:
 *
 *      const { a, b, c } = parts({ a: "a", b: "b", c: "c" });
 *      const eq1 = tex`${a} + ${b} = ${c}`;       // TexShape<"a"|"b"|"c">
 *      const eq2 = tex`(${a} + ${b})^2 = ${c}^2`; // same names
 *      yield* morph(eq1, eq2);                     // a, b, c ride
 */
export function parts<T extends Record<string, PartContent>>(
  spec: T,
): { readonly [K in keyof T & string]: PartMarker<K> } {
  const out: Record<string, PartMarker> = {};
  for (const k in spec) out[k] = new PartMarker(k, spec[k]);
  return out as { readonly [K in keyof T & string]: PartMarker<K> };
}

/** Iterable in positional order, indexable by name. The `Names`
 *  generic carries the union of declared part names so `eq.parts.a`
 *  is typed and `eq.parts.x` (undeclared) is a compile error. */
export type PartList<Names extends string = string> = readonly Part[] & {
  readonly [K in Names]: Part<K>;
};
