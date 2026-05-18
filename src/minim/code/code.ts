// CodeShape — tokenized source code rendered inside a `<foreignObject>`,
// with a reactive `source` signal as the source of truth.
//
// Architecture mirrors `tex`: one Shape, one foreignObject, one wrapper
// `<div>` holding tokenized HTML. Tokens are `<span>`s carrying both
// Prism's standard class ("token keyword") and a `minim-code-token`
// marker class so morph can find them. Each token also carries a
// `data-key` for diff matching.
//
// Direct writes to `code.source` re-render synchronously (no animation).
// `code.morphTo(target, dur)` writes the source AND animates a
// token-level diff between old and new layouts — see `morph.ts`.

import {effect, signal, type Signal, type Val, value} from "@minim/signals";
import {Shape, type ShapeOpts} from "@minim/shapes";
import {type Animator, type Easing} from "@minim/core";
import {tokenize, type Token} from "./tokenize";
import {morph as morphTokens} from "./morph";

export interface CodeOpts extends ShapeOpts {
  /** Font size in user units. Default 14. */
  size?: number;
  /** Monospace font stack. */
  font?: string;
  /** Prism language id. Default `"typescript"`. */
  language?: string;
}

/** Class stamped on every token span for morph's `querySelectorAll`. */
export const TOKEN_CLASS = "minim-code-token";

const DEFAULT_FONT =
  "ui-monospace, SFMono-Regular, Menlo, 'Cascadia Code', monospace";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Build the inner HTML for a token sequence. Typed tokens become
 *  `<span class="minim-code-token token TYPE">`; untyped runs (whitespace
 *  / plain text) splice through as raw text. `white-space: pre` on the
 *  wrapper preserves newlines and indentation. */
export const renderHTML = (toks: readonly Token[]): string => {
  let out = "";
  for (const t of toks) {
    if (t.type) {
      const k = `${t.type}:${esc(t.text)}`;
      out += `<span class="${TOKEN_CLASS} token ${t.type}" data-tok-key="${k}">${esc(t.text)}</span>`;
    } else {
      out += esc(t.text);
    }
  }
  return out;
};

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

/** Measure rendered HTML offscreen; returns the wrapper's box size in
 *  the same font/CSS regime the live wrapper will use. Avoids a flash
 *  by sizing the foreignObject correctly before first paint. */
const measure = (html: string, fontSize: number, fontFamily: string): {w: number; h: number} => {
  const div = document.createElement("div");
  div.style.cssText = `position:absolute;left:-99999px;top:0;visibility:hidden;${wrapperCss(fontSize, fontFamily)}`;
  div.innerHTML = html;
  document.body.appendChild(div);
  try {
    return {w: div.offsetWidth, h: div.offsetHeight};
  } finally {
    document.body.removeChild(div);
  }
};

/** A Shape rendering syntax-highlighted source via Prism. `source` is
 *  the writable source of truth; direct writes re-render synchronously,
 *  `.morphTo(target, dur)` writes and animates the transition. */
export class CodeShape extends Shape {
  readonly source: Signal<string>;
  readonly width: Signal<number>;
  readonly height: Signal<number>;
  readonly language: string;
  /** Live HTML wrapper inside the foreignObject. Token spans are direct
   *  children; morph reads `wrapper.querySelectorAll(".minim-code-token")`. */
  readonly wrapper: HTMLDivElement;

  /** When true, `source` writes are made by morph itself and the
   *  auto-rerender effect skips work (morph owns the DOM swap). */
  #inMorph = false;

  constructor(initial: Val<string>, opts: CodeOpts = {}) {
    const fontSize = opts.size ?? 14;
    const fontFamily = opts.font ?? DEFAULT_FONT;
    const language = opts.language ?? "typescript";

    const initialStr = value(initial);
    const initialHtml = renderHTML(tokenize(initialStr, language));
    const {w: w0, h: h0} = measure(initialHtml, fontSize, fontFamily);

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
    fo.style.overflow = "visible";
    this.attr("width", w);
    this.attr("height", h);

    this.wrapper = document.createElement("div");
    this.wrapper.style.cssText = wrapperCss(fontSize, fontFamily);
    this.wrapper.innerHTML = initialHtml;
    fo.appendChild(this.wrapper);

    // Direct source writes re-render. Morph sets the flag to suppress
    // this so it can manage the DOM swap itself.
    this.disposers.push(
      effect(() => {
        const src = this.source.value;
        if (this.#inMorph) return;
        this.#render(src);
      }),
    );

    // If `initial` was reactive, bind one-way.
    if (initial !== initialStr && typeof initial !== "string") {
      this.disposers.push(this.source.bind(initial));
    }
  }

  /** Re-tokenize + replace innerHTML + remeasure. */
  #render(src: string): void {
    this.wrapper.innerHTML = renderHTML(tokenize(src, this.language));
    const nw = this.wrapper.offsetWidth;
    const nh = this.wrapper.offsetHeight;
    if (nw !== this.width.peek()) this.width.value = nw;
    if (nh !== this.height.peek()) this.height.value = nh;
  }

  /** Animate from the current source to `target`. Matched tokens move
   *  from their old position to their new position; added tokens fade
   *  in; removed tokens fade out in place. */
  morphTo(target: string, dur: number, ease?: Easing): Animator<void> {
    return morphTokens(this, target, dur, ease);
  }

  /** @internal Used by `morph` to write the source without triggering
   *  the auto-rerender effect (morph manages the swap itself). Also
   *  performs the swap so layout is settled before morph snapshots. */
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

/** Default Prism-token CSS. Drop into your `Diagram.styles` (via the
 *  `css` tag) so token spans render with theme colours. Uses
 *  `--prettylights-*` vars if present (set globally by `md-syntax.css`)
 *  and falls back to GitHub-ish hex values otherwise. */
export const codeStyles = `
  .minim-code-token.token { color: inherit; }
  .minim-code-token.keyword,
  .minim-code-token.rule { color: var(--prettylights-keyword, #cf222e); }
  .minim-code-token.string,
  .minim-code-token.attr-value { color: var(--prettylights-string, #0a3069); }
  .minim-code-token.comment,
  .minim-code-token.prolog,
  .minim-code-token.doctype,
  .minim-code-token.cdata { color: var(--prettylights-comment, #59636e); }
  .minim-code-token.function,
  .minim-code-token.class-name,
  .minim-code-token.entity,
  .minim-code-token.selector { color: var(--prettylights-entity, #6639ba); }
  .minim-code-token.tag,
  .minim-code-token.boolean,
  .minim-code-token.property,
  .minim-code-token.symbol { color: var(--prettylights-entity-tag, #0550ae); }
  .minim-code-token.constant,
  .minim-code-token.attr-name,
  .minim-code-token.builtin,
  .minim-code-token.char,
  .minim-code-token.operator { color: var(--prettylights-constant, #0550ae); }
  .minim-code-token.number,
  .minim-code-token.punctuation,
  .minim-code-token.atrule { color: var(--prettylights-fg, inherit); }
  .minim-code-token.variable { color: var(--prettylights-variable, #953800); }
  .minim-code-token.regex { color: var(--prettylights-string-regexp, #116329); font-weight: bold; }
`;
