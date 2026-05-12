// Lightweight observable handles into a tex-rendered formula.
//
// A `Part` is *not* a Shape — it's a `bounds` signal plus a
// `highlighted` toggle, sharing the parent TexShape's single
// `<foreignObject>` rendering. This keeps per-glyph cost out of the
// scene graph: marking N named parts allocates N small objects, not
// N Shapes.
//
// Parts are produced by interpolating `part(name, content)` into a
// `tex\`…\`` template. The tag wraps each marker in `\class{…}{…}`
// so we can re-find the rendered MathML node and measure its bbox.

import { signal, type Signal, type ReadonlySignal } from "../core/signal";
import type { AABB } from "../scene/bounds";

/** A named, addressable region of a TexShape. `bounds` is in the
 *  parent TexShape's local frame; `highlighted` and `opacity` are
 *  wired by the parent TexShape to the live MathML element so authors
 *  can drive per-part visuals reactively without reaching for the
 *  DOM. */
export class Part {
  /** Toggle to flash the default highlight visual (a translucent
   *  background tint). Authors can also drive their own visuals off
   *  this signal. */
  readonly highlighted: Signal<boolean>;
  /** Opacity in [0, 1]. The parent TexShape wires this to
   *  `el.style.opacity`, so per-part fades compose with `stagger` /
   *  `signal.to` like any other minim animation — no per-part
   *  animation primitives required. */
  readonly opacity: Signal<number>;

  constructor(
    readonly name: string,
    /** Original LaTeX source for this sub-formula, recovered from the
     *  `part(name, content)` interpolation. Lets `morph` render a
     *  free-standing ghost without re-parsing the parent template. */
    readonly content: string,
    readonly bounds: ReadonlySignal<AABB>,
    /** @internal — live MathML element inside the foreignObject.
     *  Used by `morph`, `writeParts`, and the highlight effect.
     *  `null` when the renderer couldn't locate the rendered node. */
    readonly el: HTMLElement | null = null,
  ) {
    this.highlighted = signal(false);
    this.opacity = signal(1);
  }
}

/** Marker emitted by `part(name, content)` interpolation. Only valid
 *  inside `tex\`…\`` template holes; the tag picks these up to wrap
 *  content in `\class{minim-part-…}{…}`. */
export class PartMarker {
  constructor(
    readonly name: string,
    readonly content: string,
  ) {}
}

/** Tag a sub-formula by name inside a `tex\`…\`` template:
 *
 *      tex`${part("a", "x_{\\min}")} < ${part("b", "x_{\\max}")}`
 *
 *  The resulting parts are addressable as `eq.parts.a`, `eq.parts.b`,
 *  or positionally as `eq.parts[0]`, `eq.parts[1]`. */
export const part = (name: string, content: string): PartMarker =>
  new PartMarker(name, content);

/** Iterable in positional order, indexable by name. */
export type PartList = readonly Part[] & { readonly [name: string]: Part };
