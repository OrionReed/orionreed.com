// CodeShape — a monospace code substrate.
//
// One concept: a `Part` is a single-line span absolutely-positioned in
// the wrapper, with reactive `position` (Vec), `opacity` (Num), and
// `rotation` (Num), plus an optional `key` for identity.
//
// A `CodeShape` is a flat list of parts. No "line element" container,
// no flow layout — every part sits at `(col·charW, row·lineH)` via a
// CSS transform. Monospace means layout is pure multiplication.
//
// Three operations on the substrate:
//   `cut(part, [offsets])` — split a part at character offsets into
//                            N+1 sub-parts on the same row.
//   `uncut(parts)`         — merge adjacent same-row contiguous parts
//                            back into one.
//   `group(key)`           — query: all parts sharing `key`.
//
// Animation is just writes to part signals (`part.position.to(...)`,
// `part.opacity.to(...)`). A multi-line region is a group of parts
// sharing a key; "animate the region" broadcasts writes to all members.
//
// Syntax colour is CSS Custom Highlights painted over Range objects
// inside part text nodes. `paint()` tokenises each row's joined text
// and routes typed tokens to the part containing them. Independent of
// part structure — adding cuts doesn't change the colours.

import { type Animator, type Easing } from "@minim/core";
import { Shape, type ShapeOpts } from "@minim/shapes";
import {
  effect,
  type Num as NumSignal,
  num,
  type Signal,
  signal,
  type Val,
  type Vec,
  value,
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

/** A single-line span placed absolutely. Position, opacity, and rotation
 *  are signals — write or `.to(...)` them to move/fade/spin. */
export class Part {
  readonly el: HTMLSpanElement;
  /** Current text content. Use `setText` to update (instant). */
  text: string;
  /** Top-left in user units. Animatable via `.to(targetVec, dur)`. */
  readonly position: Writable<Vec>;
  /** [0..1]. Animatable. */
  readonly opacity: Writable<NumSignal>;
  /** Radians around the part's centre. Animatable. */
  readonly rotation: Writable<NumSignal>;
  /** Optional identity tag. Multiple parts can share a key (multi-line
   *  regions); `c.group(key)` returns the group. */
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

  /** Instant text update — for reactive content, animate around it
   *  rather than tweening text itself. */
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
  readonly source: Signal<string>;
  readonly width: Signal<number>;
  readonly height: Signal<number>;
  readonly language: string;
  /** Wrapper that hosts all parts. `position: relative` so parts'
   *  `position: absolute` resolves against it. */
  readonly wrapper: HTMLDivElement;
  /** Flat parts list. Order isn't load-bearing (positions are signals);
   *  morph re-sorts by (row, col) on completion for indexability. */
  readonly parts: Part[] = [];
  /** Monospace char width and line height in CSS pixels. */
  readonly charW: number;
  readonly lineH: number;

  /** When true, the auto-rebuild effect bails — morph owns the parts. */
  #inMorph = false;
  /** Syntax-highlight Ranges we own; cleared on each `paint`. User-
   *  added highlight Ranges in other CSS.highlights buckets aren't
   *  tracked here and survive repaints. */
  readonly #syntaxRanges: Range[] = [];

  constructor(initial: Val<string>, opts: CodeOpts = {}) {
    const fontSize = opts.size ?? 14;
    const fontFamily = opts.font ?? DEFAULT_FONT;
    const language = opts.language ?? "typescript";
    const { w: charW, h: lineH } = measureFont(fontSize, fontFamily);
    const initialStr = value(initial);

    const lines = initialStr.split("\n");
    const initW = lines.reduce((a, l) => Math.max(a, l.length), 0) * charW;
    const initH = lines.length * lineH;
    const w = signal(initW);
    const h = signal(initH);

    super("foreignObject", () => ({ x: 0, y: 0, w: w.value, h: h.value }), opts, {
      origin: () => ({ x: w.value / 2, y: h.value / 2 }),
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

  /** Full rebuild — dispose existing parts, create one per source line
   *  at (0, row·lineH). Triggered on initial mount and any external
   *  write to `source`; morph bypasses this via `#inMorph`. */
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

  /** Recompute wrapper width/height from the parts' bounding extents.
   *  Absolute children don't contribute to parent size naturally, so we
   *  reflect the extents into the `width` / `height` signals (which
   *  drive the foreignObject's attributes). */
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

  /** Paint syntax-colour highlights. Groups parts by row, tokenises
   *  the joined text of each row, routes each typed token to a Range
   *  in the part text node that contains it. Re-entrant — clears prior
   *  syntax Ranges first; user-added highlights in other buckets
   *  (pulse, underline) are untouched. */
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
                  // Defensive: skip on weird offsets.
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

  /** Split `part` at character offsets into N+1 sub-parts on the same
   *  row. Offsets are 0-based char positions within `part.text`; 0 and
   *  `text.length` are implicit. Sub-parts inherit `part.key`; re-key
   *  any of them after if you want different identities. Returns the
   *  sub-parts in left-to-right order. */
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

  /** Merge `parts` (must be on the same row, contiguous in column
   *  order — each part's right edge equals the next's left edge) back
   *  into a single part. The merged part inherits the leftmost's key.
   *  No-op for a single part; throws for empty input. */
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

  /** @internal — morph calls this on completion to commit `src` to
   *  the source signal (with the auto-rebuild effect suppressed),
   *  sort parts back into row/col order for indexable lookup, and
   *  refresh size + highlights. */
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

/** Styling for Prism token classes via CSS Custom Highlights. Drop
 *  into a `Diagram.styles` block via the `css` tag so the rules land
 *  in the Diagram's shadow root where the wrapper lives. */
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
