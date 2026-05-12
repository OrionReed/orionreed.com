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
import { signal, type ReadonlySignal } from "../core/signal";
import { Shape, type ShapeOpts } from "../scene/shape";
import { aabb, type AABB } from "../scene/bounds";
import { tokens } from "../shapes/tokens";
import { Part, PartMarker, type PartList } from "./parts";

/** Anything legal in a `tex\`…\`` interpolation slot. Strings splice
 *  through to the LaTeX source verbatim; PartMarkers wrap content in
 *  `\class{minim-part-N}{…}` so we can re-find them post-render. */
export type TexInterp = string | PartMarker;

export interface TexOpts extends ShapeOpts {
  /** Font size in user units. Defaults to `tokens.fontSize`. */
  size?: number;
  /** Font family. Defaults to `tokens.font` (matches Label). */
  font?: string;
  /** Background tint applied while a part's `highlighted` signal is
   *  true. Default: warm yellow at low alpha. */
  highlightColor?: string;
}

interface PartMeta {
  name: string;
  className: string;
  content: string;
}

const buildSource = (
  strings: readonly string[],
  values: readonly TexInterp[],
  meta: PartMeta[],
): string => {
  let src = "";
  let idx = 0;
  for (let i = 0; i < strings.length; i++) {
    src += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v instanceof PartMarker) {
        const className = `minim-part-${idx++}`;
        meta.push({ name: v.name, className, content: v.content });
        src += `\\class{${className}}{${v.content}}`;
      } else {
        src += v;
      }
    }
  }
  return src;
};

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

const measureMathML = (
  mathml: string,
  fontSize: number,
  fontFamily: string,
): { width: number; height: number; rects: Map<string, AABB> } => {
  const div = document.createElement("div");
  div.style.cssText = [
    "position:absolute",
    "left:-99999px",
    "top:0",
    "visibility:hidden",
    `font-family:${fontFamily}`,
    `font-size:${fontSize}px`,
    "line-height:1",
    "white-space:nowrap",
    "padding:0",
    "margin:0",
    "display:inline-block",
  ].join(";");
  div.innerHTML = mathml;
  const mathEl = div.querySelector("math") as HTMLElement | null;
  if (mathEl) styleMathRoot(mathEl, fontSize, fontFamily);
  document.body.appendChild(div);
  try {
    const root = (mathEl ?? (div.firstElementChild as HTMLElement) ?? div);
    const rootRect = root.getBoundingClientRect();
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
            r.left - rootRect.left,
            r.top - rootRect.top,
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
    const highlightColor =
      opts.highlightColor ?? "rgba(255, 220, 80, 0.45)";

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
    inner.style.fontFamily = fontFamily;
    inner.style.fontSize = `${fontSize}px`;
    inner.style.lineHeight = "1";
    inner.style.color = tokens.stroke;
    inner.style.whiteSpace = "nowrap";
    inner.style.display = "inline-block";
    inner.style.padding = "0";
    inner.style.margin = "0";
    inner.innerHTML = mathml;
    const mathEl = inner.querySelector("math") as HTMLElement | null;
    if (mathEl) styleMathRoot(mathEl, fontSize, fontFamily);
    fo.appendChild(inner);

    const list: Part[] = [];
    const byName: Record<string, Part> = {};
    for (const m of meta) {
      const r = measured.rects.get(m.className) ?? aabb(0, 0, 0, 0);
      const liveEl = inner.querySelector<HTMLElement>(`.${m.className}`);
      if (liveEl) {
        liveEl.style.borderRadius = "2px";
        liveEl.style.transition = "background-color 120ms ease-out";
      }
      const p = new Part(m.name, m.content, signal(r), liveEl);
      list.push(p);
      byName[m.name] = p;
      if (liveEl) {
        this.effect(() => {
          liveEl.style.backgroundColor = p.highlighted.value
            ? highlightColor
            : "transparent";
        });
      }
    }
    this._byName = byName;
    const out = list.slice() as Part[] & Record<string, Part>;
    for (const k in byName) (out as Record<string, Part>)[k] = byName[k];
    this.parts = out as unknown as PartList;
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
