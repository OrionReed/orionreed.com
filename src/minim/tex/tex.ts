// LaTeX → MathML shape, rendered via Temml.
//
// One `tex\`…\`` template = one `Shape` = one `<foreignObject>`
// containing browser-rendered MathML. Synchronous at construction:
// we render the source, mount it in a hidden measurement div, read
// back the overall size and per-part bounding rects, then mount the
// same MathML inside the SVG foreignObject.
//
// Parts (named via `part(name, content)` or `parts({...})`) are
// lightweight handles — see `parts.ts`. Per-character primitives
// would be wrong: a glyph isn't an addressable concept; a labeled
// sub-formula is.
//
// Names flow through the type system: `tex`${a} + ${b}`` returns a
// `TexShape<"a"|"b">`, and `eq.parts.a` is typed; `eq.parts.x` is a
// TS error.

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
  /** "inline" (default) for inline-math style, "block" for display
   *  style — bigger fractions, sums with limits above/below, and
   *  multi-line constructs (`\begin{align}`, `\begin{pmatrix}`, …)
   *  rendered properly. Equivalent to KaTeX/Temml's `displayMode`. */
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

/** Class on the rendered `<mrow>` for `part(name, …)`. Naming by the
 *  user-supplied name (rather than by template position) is what lets
 *  `morph` match parts across two TexShapes by name and re-find them
 *  in any cloned subtree without juggling per-shape index maps. */
const partClass = (name: string): string => `minim-part-${name}`;

/** Single-pass walk over the template: emits the LaTeX source string
 *  and the list of unique-name PartMarkers in template order.
 *
 *  Reads from `strings.raw` when available (the standard tagged-
 *  template form) so authors can write `\frac{a}{b}` directly — JS
 *  template literals would otherwise process `\f` as form-feed,
 *  `\t` as tab, etc. Falls back to the cooked form if `compileTemplate`
 *  is called with a plain `string[]` (programmatic use, internal
 *  re-renders). Same idiom as `String.raw\`…\``. */
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
 *  `inline math` / `block math`, and overriding it can break layout. */
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

interface Measurement {
  width: number;
  height: number;
  rects: Map<string, AABB>;
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
  // Apply the same `math-shift: normal` override the live tree uses —
  // part bounds should reflect what the user sees.
  div
    .querySelectorAll<HTMLElement>("[class*='minim-part-']")
    .forEach(stabilizePart);
  document.body.appendChild(div);
  try {
    const root = mathEl ?? (div.firstElementChild as HTMLElement) ?? div;
    const rootRect = root.getBoundingClientRect();
    // Anchor part rects to the *wrapper* (= the inline-block `div`,
    // which sits at (0,0) of the live foreignObject), not the math
    // element. With `<mfrac>` the math content can overflow its
    // line-box vertically — math's BCR top sits *above* the wrapper's
    // BCR top — so a math-relative aabb would be off by that overflow
    // when used for analytical positioning. Wrapper-relative makes
    // `aabb.tl` exactly the matched mrow's position in shape-local
    // frame.
    const wrapperRect = div.getBoundingClientRect();
    const rects = new Map<string, AABB>();
    div.querySelectorAll<HTMLElement>("[class*='minim-part-']").forEach((el) => {
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
    });
    return { width: rootRect.width, height: rootRect.height, rects };
  } finally {
    document.body.removeChild(div);
  }
};

/** Generator-driven LaTeX shape. Parts are addressable by name:
 *
 *      const { a, b } = parts({ a: "x_{\\min}", b: "x_{\\max}" });
 *      const eq = s(tex`${a} < ${b}`);          // TexShape<"a"|"b">
 *      yield* highlight(eq.parts.a);
 *      eq.add(brace(eq.parts.b));
 *      yield* morph(eq, eq2, 0.6);
 */
export class TexShape<Names extends string = string> extends Shape {
  readonly parts: PartList<Names>;
  /** Width in local-frame user units (matches the rendered MathML
   *  bounding rect). */
  readonly width: ReadonlySignal<number>;
  /** Height in local-frame user units. */
  readonly height: ReadonlySignal<number>;

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
      () => aabb(0, 0, w.value, h.value),
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

    // Inline-block wrapper matches the measurement div setup so the
    // `<math>` lands at the same TL within its container in both
    // contexts — measurements and live-render agree.
    const wrapper = document.createElement("div");
    wrapper.style.cssText = wrapperCss(fontSize, fontFamily);
    fo.appendChild(wrapper);

    // Build Parts up-front; `mountInto` then populates the wrapper
    // and binds each Part to its newly-mounted live element.
    const list: Part[] = [];
    /** Writable handles to each part's bounds, so `mountInto` and the
     *  webfont-ready re-measure can push fresh values. */
    const aabbWriters = new Map<string, Signal<AABB>>();
    for (const m of markers) {
      const cls = partClass(m.name);
      const aabbSig = signal(measured.rects.get(cls) ?? aabb(0, 0, 0, 0));
      aabbWriters.set(cls, aabbSig);
      list.push(new Part(m.name, m.content, aabbSig, m, this as TexShape));
    }
    this.parts = buildPartList(list);

    /** Render the current source into `wrapper`, re-find each Part's
     *  live element, push fresh bounds, and rebind visual effects.
     *  Used for the initial mount and for reactive content updates.
     *  `bounds` is optional: pass it when you've already measured (so
     *  we don't re-measure the same source twice). */
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
        const sig = aabbWriters.get(cls);
        if (r && sig) {
          const cur = sig.peek();
          if (r.x !== cur.x || r.y !== cur.y || r.w !== cur.w || r.h !== cur.h)
            sig.value = r;
        }
        p.bind(wrapper.querySelector(`.${cls}`), highlightColor);
      }
    };

    mountInto(initialMathml, measured);

    // Reactive re-render: when any signal-content changes, recompile,
    // re-render, remount. Effect's first run only subscribes (no
    // remount work); subsequent runs do the work.
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

    // Refresh bounds after webfonts have settled. The synchronous
    // measurement above runs before `New CM Math` (loaded from a CDN
    // via @font-face) is necessarily ready, so it can fall back to
    // browser-default math metrics. The analytical `morph` reads
    // `Part.aabb` directly (no live BCR), so a stale measurement
    // shows up as a position pop on first morph. One re-measure on
    // `document.fonts.ready` closes this race.
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
        for (const [cls, sig] of aabbWriters) {
          const r = fresh.rects.get(cls);
          if (!r) continue;
          const c = sig.peek();
          if (r.x !== c.x || r.y !== c.y || r.w !== c.w || r.h !== c.h)
            sig.value = r;
        }
      });
    }

    // Tear down per-Part disposers when the host shape is disposed.
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

/** Combine a positional array and named record into a single
 *  `PartList<Names>`. `Object.assign` keeps the array's iteration
 *  protocol intact while attaching named properties. */
const buildPartList = <Names extends string>(
  list: readonly Part[],
): PartList<Names> => {
  const out = list.slice() as Part[] & Record<string, Part>;
  for (const p of list) (out as Record<string, Part>)[p.name] = p;
  return out as unknown as PartList<Names>;
};

const isTemplateStrings = (v: unknown): v is TemplateStringsArray =>
  Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "raw");

/** `tex\`…\`` — render a LaTeX formula via Temml.
 *
 *  Use `${part(name, content)}` or markers from `parts({...})` in
 *  template holes to mark addressable sub-formulas. Plain strings
 *  splice through verbatim. Position with `eq.translate.value = ...`.
 *
 *  Backslashes in the template work as authors expect: `tex\`\frac{a}{b}\``
 *  renders a fraction. (Internally we read `strings.raw` so JS's
 *  control-character escapes — `\f`, `\t`, etc. — don't eat your
 *  LaTeX commands.) Interpolated values are normal JS strings, so
 *  `parts({ a: "x_{\\min}" })` keeps the usual JS-string `\\` for
 *  one literal backslash.
 *
 *  Three forms:
 *
 *      tex`E = mc^2`                         // direct, default size
 *      const eq = tex(28); eq`E = mc^2`      // size-only shorthand
 *      tex({ size: 28, display: "block" })`...`  // full options
 *
 *  And with parts:
 *
 *      const { a, b } = parts("a", "b");
 *      tex`${a} < ${b}`                      // TexShape<"a" | "b">
 */
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
  // Number shorthand: `tex(28)` ≡ `tex({ size: 28 })`. Saves the
  // options-object boilerplate when size is the only thing being
  // overridden (the common case for "give this diagram bigger math").
  const opts =
    typeof args[0] === "number"
      ? ({ size: args[0] } as TexOpts)
      : (args[0] as TexOpts);
  return (strings: TemplateStringsArray, ...values: TexInterp[]) =>
    new TexShape(strings, values, opts);
}
