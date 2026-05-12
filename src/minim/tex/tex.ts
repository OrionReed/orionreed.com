// LaTeX → MathML shape, rendered via Temml.
//
// One `tex\`…\`` template = one `Shape` = one `<foreignObject>`
// containing browser-rendered MathML. Synchronous at construction:
// we render the source, mount it in a hidden measurement div, read
// back the overall size and per-part bounding rects, then mount the
// same MathML inside the SVG foreignObject.
//
// Parts (named via `part(name, content)` interpolation) are
// lightweight handles — see `parts.ts`. Per-character primitives
// would be wrong: a glyph isn't an addressable concept; a labeled
// sub-formula is.

import temml from "temml";
import { signal, type ReadonlySignal, type Signal } from "../core/signal";
import { Shape, type ShapeOpts } from "../scene/shape";
import { aabb, type AABB } from "../scene/box";
import { tokens } from "../shapes/tokens";
import { Part, PartMarker, type PartList } from "./parts";

/** Anything legal in a `tex\`…\`` interpolation slot. Strings splice
 *  through to the LaTeX source verbatim; PartMarkers wrap content in
 *  `\class{minim-part-N}{…}` so we can re-find them post-render. */
export type TexInterp = string | PartMarker;

export interface TexOpts extends ShapeOpts {
  /** Font size in user units. Defaults to `tokens.fontSize`. */
  size?: number;
  /** Font family. Defaults to `tokens.mathFont`. */
  font?: string;
  /** Background tint applied while a part's `highlighted` signal is
   *  true. Default: `tokens.tex.highlightColor`. */
  highlightColor?: string;
}

interface PartMeta {
  name: string;
  className: string;
  content: string;
}

/** Class on the rendered `<mrow>` for `part(name, …)`. Naming by the
 *  user-supplied `name` (rather than by template position) is
 *  deliberate: morph matches parts across two TexShapes by name, and
 *  using the same class on both sides means we can re-find a part in
 *  any cloned subtree without juggling separate per-shape index maps. */
const partClass = (name: string): string => `minim-part-${name}`;

const buildSource = (
  strings: readonly string[],
  values: readonly TexInterp[],
  meta: PartMeta[],
): string => {
  let src = "";
  const seen = new Set<string>();
  for (let i = 0; i < strings.length; i++) {
    src += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v instanceof PartMarker) {
        if (seen.has(v.name)) {
          throw new Error(
            `tex: duplicate part name "${v.name}" — names must be unique within a single template`,
          );
        }
        seen.add(v.name);
        const className = partClass(v.name);
        meta.push({ name: v.name, className, content: v.content });
        src += `\\class{${className}}{${v.content}}`;
      } else {
        src += v;
      }
    }
  }
  return src;
};

/** CSS for the wrapper div that hosts the rendered `<math>`. Same in
 *  the hidden measurement node and the live foreignObject child, so
 *  measured offsets and live offsets agree byte-for-byte. */
const wrapperCss = (fontSize: number, fontFamily: string): string =>
  [
    `font-family:${fontFamily}`,
    `font-size:${fontSize}px`,
    `color:${tokens.stroke}`,
    "line-height:1",
    "white-space:nowrap",
    "padding:0",
    "margin:0",
    "display:inline-block",
  ].join(";");

/** Apply our preferred math styling directly to the rendered `<math>`
 *  element. Browsers (especially Chromium) don't reliably inherit
 *  `font-family` for MathML rendering, and MathML radical/fraction
 *  thickness is read from the font's OpenType MATH table — so the
 *  font *has* to be set on the element itself for the surd glyph
 *  and vinculum to come from a font with a real MATH table. We
 *  deliberately don't touch `display`: MathML Core only honors
 *  `inline math` / `block math`, and overriding it can break
 *  layout. */
const styleMathRoot = (
  mathEl: HTMLElement,
  fontSize: number,
  fontFamily: string,
): void => {
  mathEl.style.fontFamily = fontFamily;
  mathEl.style.fontSize = `${fontSize}px`;
  mathEl.style.color = tokens.stroke;
  mathEl.style.lineHeight = "1";
  mathEl.style.fontStyle = "normal";
  mathEl.style.fontWeight = "normal";
};

/** Force a part's `<msup>` (and friends) to lay out the same regardless
 *  of ambient context — only the overall *size* should change with
 *  scriptlevel, never the internal proportions. There are two
 *  context-dependent properties we have to neutralize:
 *
 *   • `math-shift`: `<msqrt>` and other constructs cascade
 *     `math-shift: compact` (TeX's "cramped" style), which shifts
 *     superscripts by `superscriptShiftUpCramped` instead of
 *     `superscriptShiftUp` — typically 1–3px in New CM Math.
 *
 *   • `math-style`:  `<mfrac>` cascades `math-style: compact` to
 *     its children, which uses tighter script-spacing constants from
 *     the OpenType MATH table (smaller superscript elevation,
 *     smaller fraction-bar gaps, etc.). Without this, `a^2` inside
 *     a fraction has its exponent sitting markedly closer to the
 *     base than `a^2` at top-level — so when morph rides it from
 *     top-level into a fraction, the matched mrow's *aspect ratio*
 *     changes (width and height scale by different amounts), which
 *     reads as a vertical "stretch" at hand-off.
 *
 *  Setting both to `normal` makes the matched fragment render with
 *  the same internal proportions in every ambient context, so all
 *  that's left for `morph` to bridge is a single uniform scale
 *  factor. Both properties are inherited, so they propagate to the
 *  mrow's descendants (`<msup>`, `<mfrac>` etc.) automatically. */
const stabilizePart = (el: HTMLElement): void => {
  el.style.setProperty("math-shift", "normal");
  el.style.setProperty("math-style", "normal");
  el.style.borderRadius = `${tokens.tex.highlightCorner}px`;
  el.style.transition = `background-color ${tokens.tex.highlightDurationMs}ms ease-out`;
};

const measureMathML = (
  mathml: string,
  fontSize: number,
  fontFamily: string,
): { width: number; height: number; rects: Map<string, AABB> } => {
  const div = document.createElement("div");
  div.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;" +
    wrapperCss(fontSize, fontFamily);
  div.innerHTML = mathml;
  const mathEl = div.querySelector("math") as HTMLElement | null;
  if (mathEl) styleMathRoot(mathEl, fontSize, fontFamily);
  // Measure with the same `math-shift: normal` override that the live
  // tree will use, so part bounds reflect what the user sees.
  div
    .querySelectorAll<HTMLElement>("[class*='minim-part-']")
    .forEach(stabilizePart);
  document.body.appendChild(div);
  try {
    const root = (mathEl ?? (div.firstElementChild as HTMLElement) ?? div);
    const rootRect = root.getBoundingClientRect();
    // Anchor part rects to the *wrapper* (= the inline-block `div`,
    // which sits at (0,0) of the live foreignObject), not the math
    // element. With `<mfrac>` and other constructs the math content
    // can overflow its line-box vertically — math's BCR top sits
    // *above* the wrapper's BCR top — so a math-relative aabb would
    // be off by that overflow when used for analytical positioning.
    // Wrapper-relative makes `aabb.tl` exactly the matched mrow's
    // position in shape-local frame (since shape-local = fO-local =
    // wrapper-local), so `morph` can derive screen positions as
    // `shape.translate + aabb.tl` without knowing math's
    // intra-wrapper offset. Width/height keep using the math BCR so
    // the foreignObject is sized to math content, not the line-box.
    const wrapperRect = div.getBoundingClientRect();
    const rects = new Map<string, AABB>();
    div.querySelectorAll<HTMLElement>("[class*='minim-part-']").forEach(
      (el) => {
        const cls = Array.from(el.classList).find((c) =>
          c.startsWith("minim-part-"),
        );
        if (!cls) return;
        const r = el.getBoundingClientRect();
        rects.set(
          cls,
          aabb(
            r.left - wrapperRect.left,
            r.top - wrapperRect.top,
            r.width,
            r.height,
          ),
        );
      },
    );
    return { width: rootRect.width, height: rootRect.height, rects };
  } finally {
    document.body.removeChild(div);
  }
};

/** Generator-driven LaTeX shape. Parts are addressable by name:
 *
 *      const eq = s(tex`${part("a", "x_{\\min}")} < ${part("b", "x_{\\max}")}`);
 *      yield* highlight(eq.parts.a);
 *      eq.add(brace(eq.parts.b));
 *      yield* morph(eq, eq2, 0.6);
 */
export class TexShape extends Shape {
  readonly parts: PartList;
  /** Width in local-frame user units (matches the rendered MathML
   *  bounding rect). */
  readonly width: ReadonlySignal<number>;
  /** Height in local-frame user units. */
  readonly height: ReadonlySignal<number>;

  /** @internal — names → Part, used by `highlight(name)` sugar and by
   *  motion combinators that match parts across two TexShapes. */
  readonly _byName: Record<string, Part>;

  /** @internal — resolved font/size, kept so `morph` can build matching
   *  ghost shapes without re-parsing opts. */
  readonly _fontSize: number;
  readonly _fontFamily: string;

  constructor(
    strings: TemplateStringsArray | readonly string[],
    values: readonly TexInterp[],
    opts: TexOpts = {},
  ) {
    const fontSize = opts.size ?? tokens.fontSize;
    const fontFamily = opts.font ?? tokens.mathFont;
    const highlightColor = opts.highlightColor ?? tokens.tex.highlightColor;

    const meta: PartMeta[] = [];
    const source = buildSource(strings, values, meta);
    let mathml: string;
    try {
      mathml = temml.renderToString(source, {
        trust: true,
        displayMode: false,
        strict: false,
        throwOnError: false,
      });
    } catch (e) {
      mathml = `<span style="color:#c33;font:13px monospace">${
        (e as Error).message
      }</span>`;
    }

    const measured = measureMathML(mathml, fontSize, fontFamily);
    const w = signal(measured.width);
    const h = signal(measured.height);

    super(
      "foreignObject",
      () => aabb(0, 0, w.value, h.value),
      opts,
      { origin: () => ({ x: w.value / 2, y: h.value / 2 }) },
    );

    this.width = w;
    this.height = h;
    this._fontSize = fontSize;
    this._fontFamily = fontFamily;

    const fo = this.intrinsic as SVGForeignObjectElement;
    fo.setAttribute("x", "0");
    fo.setAttribute("y", "0");
    fo.style.overflow = "visible";
    this.attr("width", w);
    this.attr("height", h);

    // Inline-block wrapper matches the measurement div setup so the
    // `<math>` lands at the same TL within its container in both
    // contexts — measurements and live-render agree.
    const inner = document.createElement("div");
    inner.style.cssText = wrapperCss(fontSize, fontFamily);
    inner.innerHTML = mathml;
    const mathEl = inner.querySelector("math") as HTMLElement | null;
    if (mathEl) styleMathRoot(mathEl, fontSize, fontFamily);
    fo.appendChild(inner);

    const list: Part[] = [];
    const byName: Record<string, Part> = {};
    /** Writable handles to each part's bounds, kept here so we can
     *  refresh them once webfonts have actually loaded — see the
     *  `document.fonts.ready` block below. */
    const aabbWriters: Array<{ className: string; sig: Signal<AABB> }> = [];
    for (const m of meta) {
      const r = measured.rects.get(m.className) ?? aabb(0, 0, 0, 0);
      const liveEl = inner.querySelector<HTMLElement>(`.${m.className}`);
      if (liveEl) stabilizePart(liveEl);
      const aabbSig = signal(r);
      aabbWriters.push({ className: m.className, sig: aabbSig });
      const p = new Part(m.name, m.content, aabbSig, liveEl);
      list.push(p);
      byName[m.name] = p;
      if (liveEl) {
        this.effect(() => {
          liveEl.style.backgroundColor = p.highlighted.value
            ? highlightColor
            : "transparent";
        });
        this.effect(() => {
          liveEl.style.opacity = String(p.opacity.value);
        });
      }
    }
    this._byName = byName;
    const out = list.slice() as Part[] & Record<string, Part>;
    for (const k in byName) (out as Record<string, Part>)[k] = byName[k];
    this.parts = out as unknown as PartList;

    // Refresh bounds after webfonts have settled. The synchronous
    // measurement above runs before `New CM Math` (loaded from a CDN
    // via @font-face) is necessarily ready, so it can fall back to
    // browser-default math metrics — which differ from the live
    // render's metrics once the real font arrives. The analytical
    // `morph` reads `Part.aabb` directly (no live BCR), so a stale
    // measurement shows up as a position pop on first morph. One
    // re-measure on `document.fonts.ready` closes this race; the
    // signal write is a no-op if metrics happen to match.
    const fonts = (document as { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      void fonts.ready.then(() => {
        const fresh = measureMathML(mathml, fontSize, fontFamily);
        if (fresh.width !== w.peek()) w.value = fresh.width;
        if (fresh.height !== h.peek()) h.value = fresh.height;
        for (const { className, sig } of aabbWriters) {
          const r = fresh.rects.get(className);
          if (!r) continue;
          const cur = sig.peek();
          if (
            r.x !== cur.x ||
            r.y !== cur.y ||
            r.w !== cur.w ||
            r.h !== cur.h
          ) {
            sig.value = r;
          }
        }
      });
    }
  }

  /** Sugar: `eq.highlight("a")` → `eq.parts.a.highlighted.value = true`. */
  highlight(name: string, on = true): void {
    const p = this._byName[name];
    if (p) p.highlighted.value = on;
  }
}

const isTemplateStrings = (v: unknown): v is TemplateStringsArray =>
  Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "raw");

/** `tex\`…\`` — render a LaTeX formula via Temml.
 *
 *  Use `${part(name, content)}` interpolations to mark addressable
 *  sub-formulas. Plain string interpolations splice through verbatim.
 *  Position with `eq.translate.value = ...`.
 *
 *      tex`x_{\min} < x_{\max}`
 *      tex`${part("a", "x_{\min}")} < ${part("b", "x_{\max}")}`
 *      tex({ size: 18 })`E = mc^2`
 */
export function tex(
  strings: TemplateStringsArray,
  ...values: TexInterp[]
): TexShape;
export function tex(
  opts: TexOpts,
): (strings: TemplateStringsArray, ...values: TexInterp[]) => TexShape;
export function tex(
  ...args: unknown[]
):
  | TexShape
  | ((strings: TemplateStringsArray, ...values: TexInterp[]) => TexShape) {
  if (isTemplateStrings(args[0])) {
    const [strings, ...values] = args as [
      TemplateStringsArray,
      ...TexInterp[],
    ];
    return new TexShape(strings, values);
  }
  const opts = args[0] as TexOpts;
  return (strings: TemplateStringsArray, ...values: TexInterp[]) =>
    new TexShape(strings, values, opts);
}
