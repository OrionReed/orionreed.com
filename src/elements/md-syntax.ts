import { Prism } from "prism-esm";
import { loader as JsLoader } from "prism-esm/components/prism-javascript.js";
import { loader as TsLoader } from "prism-esm/components/prism-typescript.js";
import { loader as CssLoader } from "prism-esm/components/prism-css.js";

// Forked from https://github.com/andreruffert/syntax-highlight-element

const prism = new Prism();
JsLoader(prism);
TsLoader(prism);
CssLoader(prism);

/**
 * Create & register the token `Highlight`'s in the `CSS.highlights` registry.
 * This enables the use of `::highlight(tokenType)` in CSS to style them.
 */
function setupTokenHighlights() {
  /**
   * https://prismjs.com/tokens.html#standard-tokens
   */
  for (const tokenType of [
    // Standard tokens
    "atrule",
    "attr-name",
    "attr-value",
    "bold",
    "boolean",
    "builtin",
    "cdata",
    "char",
    "class-name",
    "comment",
    "constant",
    "deleted",
    "doctype",
    "entity",
    "function",
    "important",
    "inserted",
    "italic",
    "keyword",
    "namespace",
    "number",
    "operator",
    "prolog",
    "property",
    "punctuation",
    "regex",
    "rule",
    "selector",
    "string",
    "symbol",
    "tag",
    "url",
  ]) {
    CSS.highlights.set(tokenType, new Highlight());
  }
}

interface TokenHighlight {
  tokenType: string;
  range: Range;
}

interface PrismToken {
  type?: string;
  content: string | PrismToken[];
  length: number;
}

/**
 *
 * @param text - The text to tokenize.
 * @param language - The syntax language grammar.
 * @returns An array of flattened prismjs tokens.
 */
function tokenize(text: string, language: string): PrismToken[] {
  const lang = prism.languages[language] || undefined;
  const tokens = prism.tokenize(text, lang);
  return tokens.flatMap(getFlatToken);
}

/**
 * Flatten tokens for e.g. html attributes etc.
 * @param token - A prismjs token object.
 */
function getFlatToken(token: any): PrismToken | PrismToken[] {
  if (typeof token?.content === "string") {
    return token;
  }

  if (Array.isArray(token.content)) {
    const insideTokens = token.content.flatMap((x: any) =>
      typeof x === "string"
        ? { type: token.type, content: x, length: x.length }
        : x
    );
    return insideTokens.flatMap(getFlatToken);
  }

  return token;
}

// Can't extend BaseElement because of Highlight API <> Shadow DOM challenges
export class MdSyntax extends HTMLElement {
  static tagName = "md-syntax";

  static async define() {
    if (!CSS.highlights) {
      console.info("CSS Custom Highlight API not supported");
      return;
    }

    if (!customElements.get(this.tagName)) {
      setupTokenHighlights();
      customElements.define(this.tagName, MdSyntax);
    }
    return MdSyntax;
  }

  #internals: ElementInternals;
  #highlights = new Set<TokenHighlight>();

  get language() {
    return this.getAttribute("lang") || "plaintext";
  }

  constructor() {
    super();
    this.#internals = this.attachInternals();
    this.#internals.role = "code";
  }

  connectedCallback() {
    // Make focusable via keyboard navigation
    if (!this.hasAttribute("tabindex")) {
      this.setAttribute("tabindex", "0");
    }
    this.paint();
  }

  disconnectedCallback() {
    this.clear();
  }

  paint() {
    const originalText = this.innerText;
    const trimmedText = originalText.trim();

    // Normalize whitespace: replace multiple consecutive empty lines with at most one empty line
    const normalizedText = trimmedText.replace(/\n\s*\n\s*\n+/g, "\n\n");

    if (normalizedText !== originalText) {
      this.textContent = normalizedText;
    }

    const tokens = tokenize(normalizedText, this.language);
    const firstChild = this.firstChild;

    if (!firstChild) return;

    let pos = 0;
    for (const token of tokens) {
      if (token.type) {
        const range = new Range();
        range.setStart(firstChild, pos);
        range.setEnd(firstChild, pos + token.length);

        CSS.highlights.get(token.type)?.add(range);
        this.#highlights.add({ tokenType: token.type, range });
      }
      pos += token.length;
    }
  }

  clear() {
    for (const { tokenType, range } of this.#highlights) {
      CSS.highlights.get(tokenType)?.delete(range);
    }
    this.#highlights.clear();
  }

  update() {
    this.clear();
    this.paint();
  }
}
