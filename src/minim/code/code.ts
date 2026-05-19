// CodeShape — source code as a reactive Shape with a `source:
// Signal<string>` as the source of truth.
//
// Layout: the wrapper holds one `<span class="minim-code-line">` per
// source line (display: block, width: max-content). A line in steady
// state contains a single text node; during morph a Kept-with-changes
// line contains coalesced `minim-code-{del,ins,match}` spans instead,
// and Lost/Gained lines are plain-text line elements animating
// width/height/opacity from natural to zero (or back). Layout is purely
// one-line-per-element — no multi-line `inline-block`s, which would
// trigger the spec's baseline-to-bottom-margin rule and deform flow.
//
// Highlighting: one paint path. For each line element, the painter
// either reconstructs a logical text view from `minim-code-{del,ins,
// match}` children (during morph: "old text" = del+match in document
// order, "new text" = ins+match) and tokenizes each view, OR — when the
// line has no morph children — tokenizes the line's full text. Each
// typed token becomes a Range in the matching descendant text node,
// registered with CSS Custom Highlights under its token-type name.
// Same path handles steady state, morph state, and any external
// wrapping (e.g. a demo `pluck` that wraps a token in its own span).

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

/** Class stamped on every per-line container. */
export const LINE_CLASS = "minim-code-line";

const CLASS_DEL = "minim-code-del";
const CLASS_INS = "minim-code-ins";
const CLASS_MATCH = "minim-code-match";

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

/** Build a line element holding `text`. White-space preserved
 *  (`white-space: pre`), sized to content. */
export function makeLineEl(text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = LINE_CLASS;
  el.style.cssText = lineCssText;
  el.textContent = text;
  return el;
}

/** Offscreen measure for initial foreignObject sizing — avoids a
 *  first-paint flash. */
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
  /** Live wrapper inside the foreignObject; children are line elements. */
  readonly wrapper: HTMLDivElement;

  /** When true, the auto-render effect bails — morph owns the DOM. */
  #inMorph = false;
  /** Ranges this instance has registered in `CSS.highlights`. */
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

    this.#render(initialStr);

    this.disposers.push(
      effect(() => {
        const src = this.source.value;
        if (this.#inMorph) return;
        this.#render(src);
      }),
      () => this.#clearHighlights(),
    );
  }

  /** Full rebuild — wipe wrapper, recreate plain line elements, push
   *  fresh dimensions, repaint. Used on initial mount and on external
   *  writes to `source`. Morph manages its own DOM swap and skips this. */
  #render(src: string): void {
    while (this.wrapper.firstChild) this.wrapper.removeChild(this.wrapper.firstChild);
    for (const line of src.split("\n")) this.wrapper.appendChild(makeLineEl(line));
    const nw = this.wrapper.offsetWidth;
    const nh = this.wrapper.offsetHeight;
    if (nw !== this.width.peek()) this.width.value = nw;
    if (nh !== this.height.peek()) this.height.value = nh;
    this.#paint();
  }

  /** Single paint path. For each line, derive zero, one, or two
   *  "fragment views" from its children and paint each as a contiguous
   *  text span: tokenize the joined text, route each typed token to
   *  the descendant text node containing it. */
  #paint(): void {
    this.#clearHighlights();
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;

    for (const lineEl of this.wrapper.querySelectorAll<HTMLElement>(`.${LINE_CLASS}`)) {
      const oldChildren: HTMLElement[] = [];
      const newChildren: HTMLElement[] = [];
      let hasMorph = false;
      for (const child of Array.from(lineEl.children) as HTMLElement[]) {
        const cl = child.classList;
        if (cl.contains(CLASS_DEL)) { oldChildren.push(child); hasMorph = true; }
        else if (cl.contains(CLASS_INS)) { newChildren.push(child); hasMorph = true; }
        else if (cl.contains(CLASS_MATCH)) { oldChildren.push(child); newChildren.push(child); hasMorph = true; }
      }
      if (hasMorph) {
        this.#paintFragment(oldChildren);
        this.#paintFragment(newChildren);
      } else {
        this.#paintFragment([lineEl]);
      }
    }
  }

  /** Tokenize the joined text of the given roots and register a Range
   *  per typed token in the descendant text node that contains it.
   *  Tokens straddling node boundaries (would require a wrap to cut
   *  through a Prism token) are skipped rather than partially painted. */
  #paintFragment(roots: readonly HTMLElement[]): void {
    if (roots.length === 0) return;
    const textNodes: Text[] = [];
    const starts: number[] = [];
    let off = 0;
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode();
      while (n) {
        const t = n as Text;
        textNodes.push(t);
        starts.push(off);
        off += (t.textContent ?? "").length;
        n = walker.nextNode();
      }
    }
    if (textNodes.length === 0) return;

    const fullText = textNodes.map((t) => t.textContent ?? "").join("");
    const tokens = tokenize(fullText, this.language);

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
              // Defensive: setting Range can throw on weird offsets.
            }
            break;
          }
        }
      }
      pos += len;
    }
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

  /** Animate from the current source to `target`. See `morph.ts`. */
  morphTo(target: string, dur: number, ease?: Easing): Animator<void> {
    return morph(this, target, dur, ease);
  }

  /** @internal Repaint highlights against the current DOM. Used by
   *  morph (after rebuild + at finalize) and by external code that
   *  mutates the wrapper (e.g. a demo `pluck` that wraps a token). */
  _repaint(): void {
    this.#paint();
  }

  /** @internal Commit `src` to the source signal with the auto-render
   *  effect suppressed (caller has already brought the DOM into the
   *  target state), re-measure, repaint. */
  _finalize(src: string): void {
    this.#inMorph = true;
    try {
      this.source.value = src;
    } finally {
      this.#inMorph = false;
    }
    const nw = this.wrapper.offsetWidth;
    const nh = this.wrapper.offsetHeight;
    if (nw !== this.width.peek()) this.width.value = nw;
    if (nh !== this.height.peek()) this.height.value = nh;
    this.#paint();
  }
}

/** Factory: `code("source", { language: "typescript", size: 14 })`. */
export const code = (source: Val<string>, opts?: CodeOpts): CodeShape =>
  new CodeShape(source, opts);

/** Styling for Prism token classes (Custom Highlights, painted per
 *  Range) and morph del/ins span colours. Drop into a `Diagram.styles`
 *  block via the `css` tag so the rules land in the Diagram's shadow
 *  root, where the wrapper lives. */
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
