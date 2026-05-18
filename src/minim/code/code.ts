// CodeShape — source code as a reactive Shape with a `source: Signal<string>`
// as the source of truth.
//
// Default rendering: plain text in a `<foreignObject>`/`<div>` wrapper.
// No spans for syntax highlighting (that lands later via CSS Custom
// Highlights painted on Range objects — same approach the existing
// `md-syntax.ts` already uses, can be lifted in).
//
// Animation: `code.morphTo(target, dur)` runs a token-level diff and
// surgically cuts the wrapper's text into inline-block spans only where
// edits happen. See `morph.ts`.

import {effect, signal, type Signal, type Val, value} from "@minim/signals";
import {Shape, type ShapeOpts} from "@minim/shapes";
import {type Animator, type Easing} from "@minim/core";
import {morph} from "./morph";
import {tokenize} from "./tokenize";

export interface CodeOpts extends ShapeOpts {
  /** Font size in user units. Default 14. */
  size?: number;
  /** Monospace font stack. */
  font?: string;
  /** Prism language id. Default `"typescript"`. */
  language?: string;
}

/** Class stamped on every span that morph creates surgically. Demos /
 *  consumers can target `.minim-code-del` / `.minim-code-ins` separately
 *  if they want to style the in-flight states. */
export const TOKEN_CLASS = "minim-code-tok";

const DEFAULT_FONT =
  "ui-monospace, SFMono-Regular, Menlo, 'Cascadia Code', monospace";

const wrapperCss = (fontSize: number, fontFamily: string): string =>
  [
    `font-family:${fontFamily}`,
    `font-size:${fontSize}px`,
    "line-height:1.4",
    "white-space:pre",
    "padding:0",
    "margin:0",
    "position:relative",
    "display:inline-block",
    "color:var(--text-color)",
  ].join(";");

/** Measure rendered plain text offscreen; used to seed the foreignObject
 *  size on construction without a paint-flash. */
const measure = (
  text: string,
  fontSize: number,
  fontFamily: string,
): {w: number; h: number} => {
  const div = document.createElement("div");
  div.style.cssText = `position:absolute;left:-99999px;top:0;visibility:hidden;${wrapperCss(fontSize, fontFamily)}`;
  div.textContent = text;
  document.body.appendChild(div);
  try {
    return {w: div.offsetWidth, h: div.offsetHeight};
  } finally {
    document.body.removeChild(div);
  }
};

/** A Shape rendering source code. Writable `source` signal drives both
 *  the static view (direct writes re-render plain text) and the
 *  animated view (`morphTo` runs the surgical diff). */
export class CodeShape extends Shape {
  readonly source: Signal<string>;
  readonly width: Signal<number>;
  readonly height: Signal<number>;
  readonly language: string;
  readonly wrapper: HTMLDivElement;

  /** When true, the auto-rerender effect bails out — morph manages the
   *  DOM swap itself and only commits to `source` at the end. */
  #inMorph = false;

  /** Ranges currently registered into the global `CSS.highlights`
   *  registry for syntax colouring. We track them per-instance so
   *  cleanup / re-paint can target exactly the ranges this CodeShape
   *  added, without touching other CodeShapes' ranges. */
  readonly #highlightRanges: Range[] = [];

  constructor(initial: Val<string>, opts: CodeOpts = {}) {
    const fontSize = opts.size ?? 14;
    const fontFamily = opts.font ?? DEFAULT_FONT;
    const language = opts.language ?? "typescript";

    const initialStr = value(initial);
    const {w: w0, h: h0} = measure(initialStr, fontSize, fontFamily);

    const w = signal(w0);
    const h = signal(h0);

    super(
      "foreignObject",
      () => ({x: 0, y: 0, w: w.value, h: h.value}),
      opts,
      {origin: () => ({x: w.value / 2, y: h.value / 2})},
    );

    this.width = w;
    this.height = h;
    this.language = language;
    this.source = signal(initialStr);

    const fo = this.intrinsic as SVGForeignObjectElement;
    fo.setAttribute("x", "0");
    fo.setAttribute("y", "0");
    // Both flavours of overflow:visible — Chromium honours the SVG
    // attribute over the CSS one. Spans in mid-morph that extend past
    // the FO bounds should still render.
    fo.setAttribute("overflow", "visible");
    fo.style.overflow = "visible";
    this.attr("width", w);
    this.attr("height", h);

    this.wrapper = document.createElement("div");
    this.wrapper.style.cssText = wrapperCss(fontSize, fontFamily);
    this.wrapper.textContent = initialStr;
    fo.appendChild(this.wrapper);

    // Direct writes to `source` re-render synchronously. Morph sets
    // the flag to skip this and own the DOM swap itself.
    this.disposers.push(
      effect(() => {
        const src = this.source.value;
        if (this.#inMorph) return;
        this.#render(src);
      }),
      () => this.#clearHighlights(),
    );
  }

  /** Plain-text re-render: replace wrapper text, remeasure, push sizes,
   *  re-paint syntax-colour highlights. */
  #render(src: string): void {
    this.wrapper.textContent = src;
    const nw = this.wrapper.offsetWidth;
    const nh = this.wrapper.offsetHeight;
    if (nw !== this.width.peek()) this.width.value = nw;
    if (nh !== this.height.peek()) this.height.value = nh;
    this.#paintHighlights(src);
  }

  /** Tokenize `src` and register a Range for each typed token into the
   *  global `CSS.highlights` registry under the token's type name. The
   *  shadow stylesheet's `::highlight(keyword)` rules then paint colour
   *  over those ranges without mutating the DOM. Old ranges from a
   *  previous render are cleared first. */
  #paintHighlights(src: string): void {
    this.#clearHighlights();
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const textNode = this.wrapper.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;

    let pos = 0;
    for (const tok of tokenize(src, this.language)) {
      if (tok.type !== "") {
        const r = new Range();
        try {
          r.setStart(textNode, pos);
          r.setEnd(textNode, pos + tok.text.length);
          let h = CSS.highlights.get(tok.type);
          if (h === undefined) {
            h = new Highlight();
            CSS.highlights.set(tok.type, h);
          }
          h.add(r);
          this.#highlightRanges.push(r);
        } catch {
          // setStart/setEnd can throw if the offset is out of bounds —
          // shouldn't happen with our concatenated text, but be safe.
        }
      }
      pos += tok.text.length;
    }
  }

  /** @internal Used by `morph` to wipe highlights before the wrapper's
   *  DOM is restructured (so old Ranges don't paint over the morph
   *  spans at stale positions). Re-painted by the next `#render`. */
  _clearHighlights(): void {
    this.#clearHighlights();
  }

  #clearHighlights(): void {
    if (this.#highlightRanges.length === 0) return;
    if (typeof CSS !== "undefined" && "highlights" in CSS) {
      for (const r of this.#highlightRanges) {
        for (const [, h] of CSS.highlights as unknown as Map<string, Highlight>) {
          h.delete(r);
        }
      }
    }
    this.#highlightRanges.length = 0;
  }

  /** Animate from the current source to `target` via token-level diff
   *  + surgical-cut morph. See `morph.ts`. */
  morphTo(target: string, dur: number, ease?: Easing): Animator<void> {
    return morph(this, target, dur, ease);
  }

  /** @internal Used by `morph` to commit the new source at completion
   *  while suppressing the auto-rerender effect. */
  _setSourceAndRender(src: string): void {
    this.#inMorph = true;
    try {
      this.source.value = src;
      this.#render(src);
    } finally {
      this.#inMorph = false;
    }
  }
}

/** Factory: `code("source", { language: "typescript", size: 14 })`. */
export const code = (source: Val<string>, opts?: CodeOpts): CodeShape =>
  new CodeShape(source, opts);

/** Styling for syntax-colour highlights (via CSS Custom Highlights —
 *  ranges painted by Prism token type) and for morph delete/insert
 *  spans during animation. Drop into a `Diagram.styles` block via the
 *  `css` tag so the rules land in the Diagram's shadow root, where
 *  the CodeShape's wrapper lives. */
export const codeStyles = `
  .minim-code-del { color: var(--prettylights-deleted-text, inherit); }
  .minim-code-ins { color: var(--prettylights-inserted-text, inherit); }

  /* Syntax colours via CSS Custom Highlights. Token type names match
     Prism's standard classification. Fallback hex matches GitHub's
     light theme; pages that set --prettylights-* (e.g. md-syntax.css)
     get their dark/light dual theme automatically. */
  ::highlight(keyword),
  ::highlight(rule) { color: var(--prettylights-keyword, #cf222e); }
  ::highlight(string),
  ::highlight(attr-value) { color: var(--prettylights-string, #0a3069); }
  ::highlight(comment),
  ::highlight(prolog),
  ::highlight(doctype),
  ::highlight(cdata) { color: var(--prettylights-comment, #59636e); }
  ::highlight(function),
  ::highlight(class-name),
  ::highlight(entity),
  ::highlight(selector) { color: var(--prettylights-entity, #6639ba); }
  ::highlight(tag),
  ::highlight(boolean),
  ::highlight(property),
  ::highlight(symbol) { color: var(--prettylights-entity-tag, #0550ae); }
  ::highlight(constant),
  ::highlight(attr-name),
  ::highlight(builtin),
  ::highlight(char),
  ::highlight(operator) { color: var(--prettylights-constant, #0550ae); }
  ::highlight(variable) { color: var(--prettylights-variable, #953800); }
  ::highlight(regex) { color: var(--prettylights-string-regexp, #116329); }
`;
