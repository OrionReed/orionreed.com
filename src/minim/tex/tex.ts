// LaTeX → MathML shape, rendered via Temml.

import temml from "temml";
import { signal, Box, type Signal, type BoxValue } from "@minim/signals";
import { Shape, type ShapeOpts, tokens } from "@minim/shapes";
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
  /** "inline" (default) for inline-math style, "block" for display
   *  style — bigger fractions, sums with limits above/below, and
   *  multi-line constructs (`\begin{align}`, `\begin{pmatrix}`, …)
   *  rendered properly. Equivalent to Temml's `displayMode`. */
  display?: "inline" | "block";
}

/** Extract the union of part names from a tuple of interpolation
 *  values. Plain strings contribute nothing; `PartMarker<N>`s
 *  contribute their literal name `N`. */
export type NamesOf<V extends readonly TexInterp[]> = V extends readonly (
  | infer U
)[]
  ? U extends PartMarker<infer N>
    ? N
    : never
  : never;

/** Class on the rendered `<mrow>` — used to re-find Parts in any
 *  cloned subtree without per-shape index maps. */
const partClass = (name: string): string => `minim-part-${name}`;

/** Build the LaTeX source + PartMarker list in one pass. Reads
 *  `strings.raw` so authors can write single-backslash LaTeX
 *  (`\frac{...}`) without JS eating `\f`, `\t`, etc. */
const compileTemplate = (
  strings: TemplateStringsArray | readonly string[],
  values: readonly TexInterp[],
): { source: string; markers: PartMarker[] } => {
  const chunks = (strings as TemplateStringsArray).raw ?? strings;
  let source = "";
  const markers: PartMarker[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < chunks.length; i++) {
    source += chunks[i];
    if (i >= values.length) continue;
    const v = values[i];
    if (v instanceof PartMarker) {
      if (seen.has(v.name)) {
        throw new Error(
          `tex: duplicate part name "${v.name}" — names must be unique within a single template`,
        );
      }
      seen.add(v.name);
      markers.push(v);
      source += `\\class{${partClass(v.name)}}{${v.content.peek()}}`;
    } else {
      source += v;
    }
  }
  return { source, markers };
};

const renderToMathML = (source: string, displayMode: boolean): string => {
  try {
    return temml.renderToString(source, {
      trust: true,
      displayMode,
      strict: false,
      throwOnError: false,
    });
  } catch (e) {
    return `<span style="color:#c33;font:13px monospace">${
      (e as Error).message
    }</span>`;
  }
};

/** Wrapper CSS — identical between the hidden measurement div and
 *  the live foreignObject child, so measured and live offsets agree
 *  byte-for-byte. */
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

/** Apply font styles directly to the `<math>` element. Browsers
 *  don't reliably inherit `font-family` for MathML, and radical/
 *  fraction thickness comes from the font's OpenType MATH table —
 *  so the font has to live on `<math>` itself for surd and vinculum
 *  to be drawn correctly. Don't touch `display`: MathML Core only
 *  honors `inline math` / `block math`. */
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

/** Force a part's internal layout to be context-independent. `<msqrt>`
 *  cascades `math-shift: compact` (cramped style: superscripts shift
 *  ~1–3px less); `<mfrac>` cascades `math-style: compact` (tighter
 *  script spacing). Setting both to `normal` on the part means a
 *  matched mrow renders the same regardless of ambient context, so
 *  morph rides it with a single scale factor — no visible pop at
 *  hand-off. Inherited, so propagates to descendants automatically. */
const stabilizePart = (el: HTMLElement): void => {
  el.style.setProperty("math-shift", "normal");
  el.style.setProperty("math-style", "normal");
  el.style.borderRadius = `${tokens.tex.highlightCorner}px`;
  el.style.transition = `background-color ${tokens.tex.highlightDurationMs}ms ease-out`;
};

interface Measurement {
  width: number;
  height: number;
  rects: Map<string, BoxValue>;
}

const measureMathML = (
  mathml: string,
  fontSize: number,
  fontFamily: string,
): Measurement => {
  const div = document.createElement("div");
  div.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;" +
    wrapperCss(fontSize, fontFamily);
  div.innerHTML = mathml;
  const mathEl = div.querySelector("math") as HTMLElement | null;
  if (mathEl) styleMathRoot(mathEl, fontSize, fontFamily);
  div
    .querySelectorAll<HTMLElement>("[class*='minim-part-']")
    .forEach(stabilizePart);
  document.body.appendChild(div);
  try {
    const root = mathEl ?? (div.firstElementChild as HTMLElement) ?? div;
    const rootRect = root.getBoundingClientRect();
    // Anchor part rects to the wrapper (the foreignObject's (0,0)),
    // not to `<math>` — `<mfrac>` can overflow its line-box upward,
    // so math-relative bounds would be off by that overflow.
    const wrapperRect = div.getBoundingClientRect();
    const rects = new Map<string, BoxValue>();
    div.querySelectorAll<HTMLElement>("[class*='minim-part-']").forEach((el) => {
      const cls = Array.from(el.classList).find((c) =>
        c.startsWith("minim-part-"),
      );
      if (!cls) return;
      const r = el.getBoundingClientRect();
      rects.set(cls, {
        x: r.left - wrapperRect.left,
        y: r.top - wrapperRect.top,
        w: r.width,
        h: r.height,
      });
    });
    return { width: rootRect.width, height: rootRect.height, rects };
  } finally {
    document.body.removeChild(div);
  }
};

/** A LaTeX-rendered shape with addressable Parts. See `tex` (factory)
 *  and `parts.ts` (Part / PartMarker). */
export class TexShape<Names extends string = string> extends Shape {
  readonly parts: PartList<Names>;
  /** Width in local-frame user units (matches the rendered MathML
   *  bounding rect). */
  readonly width: Signal<number>;
  /** Height in local-frame user units. */
  readonly height: Signal<number>;

  constructor(
    strings: TemplateStringsArray | readonly string[],
    values: readonly TexInterp[],
    opts: TexOpts = {},
  ) {
    const fontSize = opts.size ?? tokens.tex.size;
    const fontFamily = opts.font ?? tokens.mathFont;
    const highlightColor = opts.highlightColor ?? tokens.tex.highlightColor;
    const displayMode = opts.display === "block";

    const { source, markers } = compileTemplate(strings, values);
    const initialMathml = renderToMathML(source, displayMode);
    const measured = measureMathML(initialMathml, fontSize, fontFamily);
    const w = signal(measured.width);
    const h = signal(measured.height);

    super(
      "foreignObject",
      () => ({ x: 0, y: 0, w: w.value, h: h.value }),
      opts,
      { origin: () => ({ x: w.value / 2, y: h.value / 2 }) },
    );

    this.width = w;
    this.height = h;

    const fo = this.intrinsic as SVGForeignObjectElement;
    fo.setAttribute("x", "0");
    fo.setAttribute("y", "0");
    fo.style.overflow = "visible";
    this.attr("width", w);
    this.attr("height", h);

    // Inline-block wrapper, same CSS as the measurement div.
    const wrapper = document.createElement("div");
    wrapper.style.cssText = wrapperCss(fontSize, fontFamily);
    fo.appendChild(wrapper);

    // Parts are built up front; `mountInto` populates the wrapper
    // and binds each Part to its live el. `boxWriters` holds the
    // writable handles to each part's bounds for re-measure.
    const list: Part[] = [];
    const boxWriters = new Map<string, Box>();
    for (const m of markers) {
      const cls = partClass(m.name);
      const boxSig = new Box(measured.rects.get(cls) ?? { x: 0, y: 0, w: 0, h: 0 });
      boxWriters.set(cls, boxSig);
      list.push(new Part(m.name, m.content, boxSig, m, this as TexShape));
    }
    this.parts = buildPartList(list);

    /** Render `mathml` into the wrapper, push fresh bounds, rebind
     *  parts. `bounds` lets the initial mount skip re-measuring. */
    const mountInto = (mathml: string, bounds?: Measurement): void => {
      wrapper.innerHTML = mathml;
      const m = wrapper.querySelector("math") as HTMLElement | null;
      if (m) styleMathRoot(m, fontSize, fontFamily);
      wrapper
        .querySelectorAll<HTMLElement>("[class*='minim-part-']")
        .forEach(stabilizePart);

      const fresh = bounds ?? measureMathML(mathml, fontSize, fontFamily);
      if (fresh.width !== w.peek()) w.value = fresh.width;
      if (fresh.height !== h.peek()) h.value = fresh.height;
      for (const p of list) {
        const cls = partClass(p.name);
        const r = fresh.rects.get(cls);
        const sig = boxWriters.get(cls);
        if (r && sig) {
          const cur = sig.peek();
          if (r.x !== cur.x || r.y !== cur.y || r.w !== cur.w || r.h !== cur.h)
            sig.value = r;
        }
        p.bind(wrapper.querySelector(`.${cls}`), highlightColor);
      }
    };

    mountInto(initialMathml, measured);

    let firstRun = true;
    this.effect(() => {
      for (const m of markers) void m.content.value; // track
      if (firstRun) {
        firstRun = false;
        return;
      }
      const next = compileTemplate(strings, values);
      mountInto(renderToMathML(next.source, displayMode));
    });

    // Re-measure once webfonts have loaded — `New CM Math` ships from
    // a CDN, and synchronous measurement uses fallback metrics until
    // it arrives. Without this, the first morph pops by 1–3px.
    const fonts = (document as { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      void fonts.ready.then(() => {
        const cur = compileTemplate(strings, values);
        const fresh = measureMathML(
          renderToMathML(cur.source, displayMode),
          fontSize,
          fontFamily,
        );
        if (fresh.width !== w.peek()) w.value = fresh.width;
        if (fresh.height !== h.peek()) h.value = fresh.height;
        for (const [cls, sig] of boxWriters) {
          const r = fresh.rects.get(cls);
          if (!r) continue;
          const c = sig.peek();
          if (r.x !== c.x || r.y !== c.y || r.w !== c.w || r.h !== c.h)
            sig.value = r;
        }
      });
    }

    this.track(() => {
      for (const p of list) p.dispose();
    });
  }

  /** Sugar: `eq.highlight("a")` → `eq.parts.a.highlighted.value = true`. */
  highlight(name: Names, on = true): void {
    const p = (this.parts as Record<string, Part>)[name];
    if (p) p.highlighted.value = on;
  }
}

/** Positional array with named keys attached — iterates in template
 *  order, indexable by name. */
const buildPartList = <Names extends string>(
  list: readonly Part[],
): PartList<Names> => {
  const out = list.slice() as Part[] & Record<string, Part>;
  for (const p of list) (out as Record<string, Part>)[p.name] = p;
  return out as unknown as PartList<Names>;
};

const isTemplateStrings = (v: unknown): v is TemplateStringsArray =>
  Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "raw");

/** Render a LaTeX formula via Temml. Three forms:
 *
 *      tex`E = mc^2`                              // direct, default size
 *      tex(28)`E = mc^2`                          // size-only shorthand
 *      tex({ size: 28, display: "block" })`...`   // full options
 *
 *  Single-backslash LaTeX works directly — we read `strings.raw`, so
 *  `\frac`, `\dot`, etc. aren't eaten by JS's `\f`/`\t` escapes. */
export function tex<V extends readonly TexInterp[]>(
  strings: TemplateStringsArray,
  ...values: V
): TexShape<NamesOf<V>>;
export function tex(
  opts: TexOpts | number,
): <V extends readonly TexInterp[]>(
  strings: TemplateStringsArray,
  ...values: V
) => TexShape<NamesOf<V>>;
export function tex(...args: unknown[]): unknown {
  if (isTemplateStrings(args[0])) {
    const [strings, ...values] = args as [
      TemplateStringsArray,
      ...TexInterp[],
    ];
    return new TexShape(strings, values);
  }
  const opts: TexOpts =
    typeof args[0] === "number" ? { size: args[0] } : (args[0] as TexOpts);
  return (strings: TemplateStringsArray, ...values: TexInterp[]) =>
    new TexShape(strings, values, opts);
}
