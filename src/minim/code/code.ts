// CodeShape — a monospace code substrate.
//
// A `Part` is a single-line span, absolutely positioned with reactive
// `position` / `opacity` / `rotation` and an optional `key`. A
// `CodeShape` is a flat list of parts at `(col·charW, row·lineH)` — no
// line containers, no flow layout; monospace makes layout pure
// multiplication. Animation is just writes to part signals.
//
// Substrate ops: `cut` (split a part at offsets), `uncut` (merge
// contiguous same-row parts), `group(key)` (parts sharing a key — a
// multi-line region).
//
// Syntax colour: CSS Custom Highlights over Ranges in part text nodes.
// `paint()` tokenises each row and routes typed tokens to the
// containing part — independent of cut structure.

import type { Animator, Easing } from "@minim/core";
import { Shape, type ShapeOpts } from "@minim/shapes";
import {
  derive,
  effect,
  type Num as NumSignal,
  num,
  readNow,
  type Signal,
  signal,
  type Val,
  type Vec,
  vec,
  type Writable,
} from "@minim/signals";
import { morph } from "./morph";
import { tokenize } from "./tokenize";

export interface CodeOpts extends ShapeOpts {
  /** Font size in user units. Default 14. */
  size?: number;
  /** Monospace font stack. */
  font?: string;
  /** Prism language id. Default `"typescript"`. */
  language?: string;
}

const DEFAULT_FONT = "ui-monospace, SFMono-Regular, Menlo, 'Cascadia Code', monospace";

const partCss = "position:absolute;left:0;top:0;white-space:pre;will-change:transform";

/** A single-line span placed absolutely; `position` / `opacity` /
 *  `rotation` are animatable signals. */
export class Part {
  readonly el: HTMLSpanElement;
  /** Current text. Use `setText` to update (instant). */
  text: string;
  /** Top-left in user units. */
  readonly position: Writable<Vec>;
  /** [0..1]. */
  readonly opacity: Writable<NumSignal>;
  /** Radians around the part's centre. */
  readonly rotation: Writable<NumSignal>;
  /** Optional identity tag; shared keys form a `c.group(key)`. */
  key?: string;
  #disposers: Array<() => void> = [];

  constructor(text: string, x: number, y: number, key?: string) {
    this.text = text;
    this.key = key;
    this.position = vec(x, y);
    this.opacity = num(1);
    this.rotation = num(0);

    this.el = document.createElement("span");
    this.el.style.cssText = partCss;
    this.el.textContent = text;

    this.#disposers.push(
      effect(() => {
        const p = this.position.value;
        const r = this.rotation.value;
        this.el.style.transform =
          r === 0
            ? `translate(${p.x}px, ${p.y}px)`
            : `translate(${p.x}px, ${p.y}px) rotate(${r}rad)`;
      }),
      effect(() => {
        this.el.style.opacity = String(this.opacity.value);
      }),
    );
  }

  /** Instant text update (text itself doesn't tween — animate around it). */
  setText(t: string): void {
    if (this.text === t) return;
    this.text = t;
    this.el.textContent = t;
  }

  dispose(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.el.remove();
  }
}

/** Measure monospace metrics for `(family, size)`. One-off per shape. */
function measureFont(size: number, family: string): { w: number; h: number } {
  const div = document.createElement("div");
  div.style.cssText =
    `position:absolute;visibility:hidden;left:-9999px;top:0;` +
    `font-family:${family};font-size:${size}px;line-height:1.4;white-space:pre`;
  div.textContent = "M";
  document.body.appendChild(div);
  const w = div.offsetWidth;
  const h = div.offsetHeight;
  document.body.removeChild(div);
  return { w, h };
}

/** A Shape rendering monospace source code as a list of `Part`s. */
export class CodeShape extends Shape {
  readonly source: Writable<Signal<string>>;
  readonly width: Writable<Signal<number>>;
  readonly height: Writable<Signal<number>>;
  readonly language: string;
  /** Host wrapper (`position: relative`) for the absolute parts. */
  readonly wrapper: HTMLDivElement;
  /** Flat parts list; morph re-sorts by (row, col) on completion. */
  readonly parts: Part[] = [];
  /** Monospace char width and line height in CSS pixels. */
  readonly charW: number;
  readonly lineH: number;

  /** When true, the auto-rebuild effect bails — morph owns the parts. */
  #inMorph = false;
  /** Syntax Ranges we own; cleared each `paint`. Other CSS.highlights
   *  buckets (user highlights) survive repaints. */
  readonly #syntaxRanges: Range[] = [];

  constructor(initial: Val<string>, opts: CodeOpts = {}) {
    const fontSize = opts.size ?? 14;
    const fontFamily = opts.font ?? DEFAULT_FONT;
    const language = opts.language ?? "typescript";
    const { w: charW, h: lineH } = measureFont(fontSize, fontFamily);
    const initialStr = readNow(initial);

    const lines = initialStr.split("\n");
    const initW = lines.reduce((a, l) => Math.max(a, l.length), 0) * charW;
    const initH = lines.length * lineH;
    const w = signal(initW);
    const h = signal(initH);

    super("foreignObject", () => ({ x: 0, y: 0, w: w.value, h: h.value }), opts, {
      origin: derive(() => ({ x: w.value / 2, y: h.value / 2 })),
    });

    this.width = w;
    this.height = h;
    this.language = language;
    this.source = signal(initialStr);
    this.charW = charW;
    this.lineH = lineH;

    const fo = this.intrinsic as SVGForeignObjectElement;
    fo.setAttribute("x", "0");
    fo.setAttribute("y", "0");
    fo.setAttribute("overflow", "visible");
    fo.style.overflow = "visible";
    this.attrs({ width: w, height: h });

    this.wrapper = document.createElement("div");
    this.wrapper.style.cssText = [
      "position:relative",
      `font-family:${fontFamily}`,
      `font-size:${fontSize}px`,
      `line-height:${lineH}px`,
      "padding:0",
      "margin:0",
      "color:var(--text-color)",
    ].join(";");
    fo.appendChild(this.wrapper);

    this.#render(initialStr);

    this.disposers.push(
      effect(() => {
        const src = this.source.value;
        if (this.#inMorph) return;
        this.#render(src);
      }),
      () => this.#clearSyntaxRanges(),
      () => {
        for (const p of this.parts) p.dispose();
      },
    );
  }

  /** Full rebuild: one part per source line at (0, row·lineH). Runs on
   *  mount and external `source` writes; morph bypasses via `#inMorph`. */
  #render(src: string): void {
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    const lines = src.split("\n");
    for (let r = 0; r < lines.length; r++) {
      const part = new Part(lines[r], 0, r * this.lineH);
      this.wrapper.appendChild(part.el);
      this.parts.push(part);
    }
    this.#syncSize();
    this.paint();
  }

  /** Reflect the parts' extents into `width` / `height` (absolute children
   *  don't size their parent; these drive the foreignObject attrs). */
  #syncSize(): void {
    let maxW = 0;
    let maxH = 0;
    for (const p of this.parts) {
      const pos = p.position.peek();
      const right = pos.x + p.text.length * this.charW;
      const bottom = pos.y + this.lineH;
      if (right > maxW) maxW = right;
      if (bottom > maxH) maxH = bottom;
    }
    if (maxW !== this.width.peek()) this.width.value = maxW;
    if (maxH !== this.height.peek()) this.height.value = maxH;
  }

  /** Paint syntax highlights: tokenise each row's joined text, route
   *  each typed token to a Range in its containing part. Re-entrant
   *  (clears prior syntax Ranges; leaves other buckets untouched). */
  paint(): void {
    this.#clearSyntaxRanges();
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;

    const byRow = new Map<number, Part[]>();
    for (const p of this.parts) {
      const r = Math.round(p.position.peek().y / this.lineH);
      const arr = byRow.get(r);
      if (arr) arr.push(p);
      else byRow.set(r, [p]);
    }

    for (const parts of byRow.values()) {
      parts.sort((a, b) => a.position.peek().x - b.position.peek().x);
      const fullText = parts.map(p => p.text).join("");
      const tokens = tokenize(fullText, this.language);
      const starts: number[] = [];
      let off = 0;
      for (const p of parts) {
        starts.push(off);
        off += p.text.length;
      }

      let pos = 0;
      for (const tok of tokens) {
        const len = tok.text.length;
        if (tok.type !== "" && len > 0 && !tok.text.includes("\n")) {
          for (let i = 0; i < parts.length; i++) {
            const start = starts[i];
            const end = start + parts[i].text.length;
            if (pos >= start && pos + len <= end) {
              const tn = parts[i].el.firstChild;
              if (tn && tn.nodeType === Node.TEXT_NODE) {
                try {
                  const r = new Range();
                  r.setStart(tn as Text, pos - start);
                  r.setEnd(tn as Text, pos - start + len);
                  let h = CSS.highlights.get(tok.type);
                  if (h === undefined) {
                    h = new Highlight();
                    CSS.highlights.set(tok.type, h);
                  }
                  h.add(r);
                  this.#syntaxRanges.push(r);
                } catch {
                  // Skip on bad offsets.
                }
              }
              break;
            }
          }
        }
        pos += len;
      }
    }
  }

  #clearSyntaxRanges(): void {
    if (this.#syntaxRanges.length === 0) return;
    if (typeof CSS !== "undefined" && "highlights" in CSS) {
      for (const r of this.#syntaxRanges) {
        for (const [, h] of CSS.highlights as unknown as Map<string, Highlight>) {
          h.delete(r);
        }
      }
    }
    this.#syntaxRanges.length = 0;
  }

  /** Split `part` at char offsets into N+1 same-row sub-parts (0 and
   *  `text.length` implicit). Sub-parts inherit `part.key`; returned
   *  left-to-right. */
  cut(part: Part, offsets: readonly number[]): Part[] {
    const idx = this.parts.indexOf(part);
    if (idx < 0) throw new Error("cut: part not in this CodeShape");
    const sorted = [...new Set(offsets)]
      .sort((a, b) => a - b)
      .filter(o => o > 0 && o < part.text.length);
    if (sorted.length === 0) return [part];
    const bounds = [0, ...sorted, part.text.length];
    const pos = part.position.peek();
    const subs: Part[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const start = bounds[i];
      const end = bounds[i + 1];
      const sub = new Part(
        part.text.slice(start, end),
        pos.x + start * this.charW,
        pos.y,
        part.key,
      );
      this.wrapper.appendChild(sub.el);
      subs.push(sub);
    }
    this.parts.splice(idx, 1, ...subs);
    part.dispose();
    this.paint();
    return subs;
  }

  /** Merge same-row contiguous `parts` into one (inherits the leftmost's
   *  key). Single part is a no-op; empty throws. */
  uncut(parts: readonly Part[]): Part {
    if (parts.length === 0) throw new Error("uncut: no parts");
    if (parts.length === 1) return parts[0];
    const sorted = [...parts].sort((a, b) => a.position.peek().x - b.position.peek().x);
    const text = sorted.map(p => p.text).join("");
    const pos = sorted[0].position.peek();
    const merged = new Part(text, pos.x, pos.y, sorted[0].key);
    this.wrapper.appendChild(merged.el);
    const firstIdx = this.parts.indexOf(sorted[0]);
    for (const p of sorted) {
      const i = this.parts.indexOf(p);
      if (i >= 0) this.parts.splice(i, 1);
      p.dispose();
    }
    this.parts.splice(firstIdx >= 0 ? firstIdx : this.parts.length, 0, merged);
    this.paint();
    return merged;
  }

  /** All parts sharing `key`. Returns a fresh array. */
  group(key: string): Part[] {
    return this.parts.filter(p => p.key === key);
  }

  /** Animate from current source to `target`. See `morph.ts`. */
  morphTo(target: string, dur: number, ease?: Easing): Animator<void> {
    return morph(this, target, dur, ease);
  }

  /** @internal Morph's on-completion commit: set `source` (rebuild
   *  suppressed), re-sort parts row/col, refresh size + highlights. */
  _finalize(src: string): void {
    this.#inMorph = true;
    try {
      this.source.value = src;
    } finally {
      this.#inMorph = false;
    }
    this.parts.sort((a, b) => {
      const pa = a.position.peek();
      const pb = b.position.peek();
      return pa.y - pb.y || pa.x - pb.x;
    });
    this.#syncSize();
    this.paint();
  }
}

/** Factory: `code("source", { language: "typescript", size: 14 })`. */
export const code = (source: Val<string>, opts?: CodeOpts): CodeShape =>
  new CodeShape(source, opts);

/** Prism token-class colours via CSS Custom Highlights. Drop into a
 *  `Diagram.styles` block so the rules reach the shadow root. */
export const codeStyles = `
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
