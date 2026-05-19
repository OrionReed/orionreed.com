// CodeShape — source code as a reactive Shape with a `source: Signal<string>`
// as the source of truth.
//
// Layout: the wrapper holds one `<span class="minim-code-line">` per
// line of source (display: block, width: max-content). Each line element
// holds either plain text (steady state — paintable via CSS Custom
// Highlights) or, during morph, inline-block spans for token-level
// edits within the line. Line additions and deletions animate the line
// element's height; inline edits animate span widths inside the line.
//
// Why line-elements: an inline-block span with multi-line content has
// its baseline at the bottom margin edge per spec, which deforms the
// surrounding layout during animation. Keeping each source line in its
// own element sidesteps the problem entirely — multi-line changes are
// line additions/removals, not multi-line inline-blocks.

import {effect, signal, type Signal, type Val, value} from "@minim/signals";
import {Shape, type ShapeOpts} from "@minim/shapes";
import {type Animator, type Easing} from "@minim/core";
import {morph, getAttachedTokens} from "./morph";
import {tokenize, type Token} from "./tokenize";

export interface CodeOpts extends ShapeOpts {
  /** Font size in user units. Default 14. */
  size?: number;
  /** Monospace font stack. */
  font?: string;
  /** Prism language id. Default `"typescript"`. */
  language?: string;
}

/** Class stamped on every per-line container in the wrapper. Morph
 *  finds existing lines by class and adds/removes/modifies them in
 *  place. */
export const LINE_CLASS = "minim-code-line";

const DEFAULT_FONT =
  "ui-monospace, SFMono-Regular, Menlo, 'Cascadia Code', monospace";

const wrapperCss = (fontSize: number, fontFamily: string): string =>
  [
    `font-family:${fontFamily}`,
    `font-size:${fontSize}px`,
    "line-height:1.4",
    "padding:0",
    "margin:0",
    "position:relative",
    "display:inline-block",
    "color:var(--text-color)",
  ].join(";");

const lineCssText =
  "display:block;width:max-content;min-height:1.4em;white-space:pre";

/** Build a line element holding `text`. White-space is preserved
 *  (`white-space: pre`) and the element is sized to its content. */
export function makeLineEl(text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = LINE_CLASS;
  el.style.cssText = lineCssText;
  el.textContent = text;
  return el;
}

/** Measure rendered plain text offscreen; used to seed the foreignObject
 *  size on construction without a paint-flash. Builds a full
 *  line-element wrapper so the measurement matches the live render. */
const measure = (
  text: string,
  fontSize: number,
  fontFamily: string,
): {w: number; h: number} => {
  const div = document.createElement("div");
  div.style.cssText = `position:absolute;left:-99999px;top:0;visibility:hidden;${wrapperCss(fontSize, fontFamily)}`;
  for (const line of text.split("\n")) div.appendChild(makeLineEl(line));
  document.body.appendChild(div);
  try {
    return {w: div.offsetWidth, h: div.offsetHeight};
  } finally {
    document.body.removeChild(div);
  }
};

/** A Shape rendering source code. Writable `source` signal drives both
 *  the static view (direct writes re-render plain text) and the
 *  animated view (`morphTo` runs the line-aware diff). */
export class CodeShape extends Shape {
  readonly source: Signal<string>;
  readonly width: Signal<number>;
  readonly height: Signal<number>;
  readonly language: string;
  /** Live wrapper inside the foreignObject. Children are line elements
   *  (each `<span class="minim-code-line">`). */
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
    fo.setAttribute("overflow", "visible");
    fo.style.overflow = "visible";
    this.attr("width", w);
    this.attr("height", h);

    this.wrapper = document.createElement("div");
    this.wrapper.style.cssText = wrapperCss(fontSize, fontFamily);
    fo.appendChild(this.wrapper);

    // Initial mount via #render so line elements + highlights are set up.
    this.#render(initialStr);

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

  /** Plain-text re-render: rebuild line elements, remeasure, push
   *  sizes, re-paint syntax-colour highlights. */
  #render(src: string): void {
    while (this.wrapper.firstChild) this.wrapper.removeChild(this.wrapper.firstChild);
    for (const line of src.split("\n")) {
      this.wrapper.appendChild(makeLineEl(line));
    }
    const nw = this.wrapper.offsetWidth;
    const nh = this.wrapper.offsetHeight;
    if (nw !== this.width.peek()) this.width.value = nw;
    if (nh !== this.height.peek()) this.height.value = nh;
    this.#paintHighlights();
  }

  /** Walk every line element and register Range-based syntax
   *  highlights. Each line falls into one of three shapes:
   *
   *   - Plain text (steady state, or whole-line insert/delete during
   *     morph): single text node child, re-tokenize the line text.
   *   - Morph-modified: element children carry their original Token[]
   *     metadata (via the off-DOM WeakMap in `morph.ts`); paint from
   *     that to preserve function-name etc. classifications that
   *     fragment-context re-tokenization would lose.
   *   - User-wrapped: external code (e.g. `pluck` in a demo) wrapped
   *     a token in a span. Children have no attached tokens, so we
   *     re-tokenize the joined text and route each typed range to the
   *     text node that contains it. Without this branch the line
   *     loses all colour the moment any descendant span appears.
   *
   *  Custom Highlights are rendered through the element's render
   *  pipeline in modern browsers, so they fade with element opacity. */
  #paintHighlights(): void {
    this.#clearHighlights();
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;

    for (const lineEl of this.wrapper.querySelectorAll<HTMLElement>(`.${LINE_CLASS}`)) {
      let hasMorphTokens = false;
      for (const child of Array.from(lineEl.children)) {
        if (getAttachedTokens(child)) {
          hasMorphTokens = true;
          break;
        }
      }
      if (hasMorphTokens) {
        for (const child of Array.from(lineEl.children)) {
          const tokens = getAttachedTokens(child);
          if (!tokens) continue;
          const tn = child.firstChild;
          if (tn && tn.nodeType === Node.TEXT_NODE) {
            this.#paintTokensOnTextNode(tn as Text, tokens);
          }
        }
      } else {
        this.#paintLineFromFullText(lineEl);
      }
    }
  }

  /** Steady-state / user-wrapped highlight painter. Tokenizes the
   *  line's joined text once, then maps each token's [start, end) back
   *  to the descendant text node that fully contains it. Tokens that
   *  straddle node boundaries (rare — would require the wrap to cut
   *  through a Prism token) are skipped rather than partially painted. */
  #paintLineFromFullText(lineEl: HTMLElement): void {
    const textNodes: Text[] = [];
    const starts: number[] = [];
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    let off = 0;
    let n = walker.nextNode();
    while (n) {
      const t = n as Text;
      textNodes.push(t);
      starts.push(off);
      off += (t.textContent ?? "").length;
      n = walker.nextNode();
    }
    if (textNodes.length === 0) return;

    const tokens = tokenize(lineEl.textContent ?? "", this.language);
    let pos = 0;
    for (const tok of tokens) {
      const len = tok.text.length;
      if (tok.type !== "" && len > 0 && !tok.text.includes("\n")) {
        for (let i = 0; i < textNodes.length; i++) {
          const start = starts[i];
          const end = start + (textNodes[i].textContent ?? "").length;
          if (pos >= start && pos + len <= end) {
            try {
              const r = new Range();
              r.setStart(textNodes[i], pos - start);
              r.setEnd(textNodes[i], pos - start + len);
              let h = CSS.highlights.get(tok.type);
              if (h === undefined) {
                h = new Highlight();
                CSS.highlights.set(tok.type, h);
              }
              h.add(r);
              this.#highlightRanges.push(r);
            } catch {
              // Defensive: Range setting can throw on weird offsets.
            }
            break;
          }
        }
      }
      pos += len;
    }
  }

  /** Add a Range per typed token to the global `CSS.highlights`
   *  registry under its type name, with offsets walking through
   *  `tokens` against `textNode`. */
  #paintTokensOnTextNode(textNode: Text, tokens: readonly Token[]): void {
    let offset = 0;
    for (const tok of tokens) {
      if (tok.type !== "" && !tok.text.includes("\n")) {
        try {
          const r = new Range();
          r.setStart(textNode, offset);
          r.setEnd(textNode, offset + tok.text.length);
          let h = CSS.highlights.get(tok.type);
          if (h === undefined) {
            h = new Highlight();
            CSS.highlights.set(tok.type, h);
          }
          h.add(r);
          this.#highlightRanges.push(r);
        } catch {
          // Range setting can throw if offset is OOB; be safe.
        }
      }
      offset += tok.text.length;
    }
  }

  /** @internal Used by `morph` to re-paint highlights mid-flight after
   *  rebuilding the line structure. Matched + inserted + deleted lines
   *  hold plain text and get coloured; modified lines (which now hold
   *  morph spans) are skipped. */
  _repaintHighlights(): void {
    this.#paintHighlights();
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

  /** Animate from the current source to `target` via line-aware diff +
   *  surgical-cut morph. See `morph.ts`. */
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
