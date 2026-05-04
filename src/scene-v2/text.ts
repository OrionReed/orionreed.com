// Chainable rich text composed of nested styled spans, ported from v1's
// draw.ts. Pure values; no DOM. Used by `label()` to set tspan content.

interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  muted?: boolean;
  sub?: boolean;
  sup?: boolean;
}

export type TextPart = string | Text;

export class Text {
  constructor(
    public parts: TextPart[],
    public style: TextStyle = {},
  ) {}

  bold(): Text {
    return new Text(this.parts, { ...this.style, bold: true });
  }
  italic(): Text {
    return new Text(this.parts, { ...this.style, italic: true });
  }
  muted(): Text {
    return new Text(this.parts, { ...this.style, muted: true });
  }
  sub(...parts: TextPart[]): Text {
    return new Text([this, new Text(parts, { sub: true })]);
  }
  sup(...parts: TextPart[]): Text {
    return new Text([this, new Text(parts, { sup: true })]);
  }
}

export type Content = string | Text;

export function t(...parts: TextPart[]): Text {
  return new Text(parts);
}

const SUB_FONT_SIZE = "0.75em";
const MUTED_OPACITY = 0.5;

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTextNode(node: TextPart): string {
  if (typeof node === "string") return escapeXml(node);
  const inner = node.parts.map(renderTextNode).join("");
  const a: string[] = [];
  if (node.style.bold) a.push('font-weight="700"');
  if (node.style.italic) a.push('font-style="italic"');
  if (node.style.muted) a.push(`opacity="${MUTED_OPACITY}"`);
  if (node.style.sub)
    a.push(`baseline-shift="sub" font-size="${SUB_FONT_SIZE}"`);
  if (node.style.sup)
    a.push(`baseline-shift="super" font-size="${SUB_FONT_SIZE}"`);
  return a.length ? `<tspan ${a.join(" ")}>${inner}</tspan>` : inner;
}

export function renderContent(c: Content): string {
  return typeof c === "string" ? escapeXml(c) : renderTextNode(c);
}

/** Plain-text flatten of `c` — useful for approximating label widths. */
export function flattenText(c: Content): string {
  if (typeof c === "string") return c;
  const walk = (n: TextPart): string =>
    typeof n === "string" ? n : n.parts.map(walk).join("");
  return walk(c);
}

/**
 * Math notation shorthand: `math("x", "min")` → italic-x with italic
 * subscript-min. Skip the second arg for a plain italic identifier.
 */
export function math(base: string, sub?: string): Text {
  const b = t(base).italic();
  return sub ? b.sub(t(sub).italic()) : b;
}
