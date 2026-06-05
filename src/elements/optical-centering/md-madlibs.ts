// md-madlibs.ts — typed mad-libs with EDITABLE templates over shared cells.
//
// Two panes, each an editable template (the pattern) + its rendered output.
// Placeholders declare typed holes: `{name}` is a `str` slot, `{#name}` an
// `int` slot. Both panes draw from ONE cell pool keyed by name, so a slot
// shared between templates is the same value — edit a control, either
// rendered output, or either template structure and everything stays in
// sync. That's slots-as-source plus an editable meta layer: the template
// string is itself parsed into structure, one level up from the values.
//
// Rendering is forward (interleave literals with each slot's formatted
// value); editing a rendered output is backward (parse segments back into
// the cells). The count is a typed int hole — a non-number in its place
// fails the codec and the count stays put.

import { effect, type Num, num, type Str, slot, str, template, type Writable } from "../../minim";
import { BaseElement, css } from "../base-element";

type Kind = "str" | "int";
interface Def {
  name: string;
  kind: Kind;
}

function parseMadlib(src: string): { literals: string[]; defs: Def[] } {
  const re = /\{(#?)([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const literals: string[] = [];
  const defs: Def[] = [];
  let last = 0;
  let m = re.exec(src);
  while (m !== null) {
    literals.push(src.slice(last, m.index));
    defs.push({ name: m[2]!, kind: m[1] === "#" ? "int" : "str" });
    last = m.index + m[0].length;
    m = re.exec(src);
  }
  literals.push(src.slice(last));
  return { literals, defs };
}

const TPL_A = "The {#count} {adjective} {animal} {verb} in the {place}.";
const TPL_B = "{animal} x{#count} STOP {adjective} STOP {verb} at {place}";

export class MdMadlibs extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 720px;
      font-family: inherit;
      color: var(--text-color);
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0 0 0.8rem;
      line-height: 1.4;
    }
    .panes {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    @media (max-width: 600px) {
      .panes {
        grid-template-columns: 1fr;
      }
    }
    .pane {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      padding: 0.6rem 0.7rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-color);
      min-width: 0;
    }
    .pane .row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.5rem;
    }
    .pane h3 {
      margin: 0;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-secondary);
    }
    .badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.66rem;
      color: var(--text-secondary);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      line-height: 1.45;
      padding: 0.4rem 0.5rem;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      background: var(--code-bg);
      color: var(--code-text);
      resize: vertical;
      min-height: 2.8rem;
    }
    textarea.tpl {
      color: var(--text-color);
      background: var(--bg-color);
    }
    .controls {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 0.6rem 0.85rem;
    }
    .ctrl {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      min-width: 0;
    }
    .ctrl label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-secondary);
    }
    .ctrl input[type="text"] {
      font: inherit;
      font-size: 0.9rem;
      padding: 0.3rem 0.45rem;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      background: var(--code-bg);
      color: var(--code-text);
      box-sizing: border-box;
      min-width: 0;
      width: 100%;
    }
    .ctrl .range-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }
    .ctrl input[type="range"] {
      flex: 1 1 auto;
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
      accent-color: var(--ink-fill, #5b8def);
    }
    .ctrl .count {
      flex: 0 0 auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9rem;
      min-width: 2ch;
      text-align: right;
    }
    input:focus,
    textarea:focus {
      outline: none;
      border-color: var(--text-color);
    }
  `;

  #pool = new Map<string, { kind: Kind; cell: Writable<Num> | Writable<Str> }>();
  #dyn: Array<() => void> = [];
  #srcA!: HTMLTextAreaElement;
  #srcB!: HTMLTextAreaElement;
  #outA!: HTMLTextAreaElement;
  #outB!: HTMLTextAreaElement;
  #textA!: Writable<Str>;
  #textB!: Writable<Str>;
  #controls!: HTMLDivElement;

  disconnectedCallback(): void {
    for (const d of this.#dyn) d();
    this.#dyn.length = 0;
  }

  #getOrCreate(def: Def): { kind: Kind; cell: Writable<Num> | Writable<Str> } {
    let e = this.#pool.get(def.name);
    if (!e || e.kind !== def.kind) {
      const cell = def.kind === "int" ? num(1) : str(def.name);
      e = { kind: def.kind, cell };
      this.#pool.set(def.name, e);
    }
    return e;
  }

  protected render(): void {
    for (const d of this.#dyn) d();
    this.#dyn.length = 0;
    this.shadow.replaceChildren();
    this.#pool.clear();

    // Pre-seed pleasant defaults for the starting templates.
    this.#pool.set("count", { kind: "int", cell: num(3) });
    this.#pool.set("adjective", { kind: "str", cell: str("happy") });
    this.#pool.set("animal", { kind: "str", cell: str("fox") });
    this.#pool.set("verb", { kind: "str", cell: str("danced") });
    this.#pool.set("place", { kind: "str", cell: str("garden") });

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Edit a control, either rendered line, or either TEMPLATE — every surface stays in sync. Both templates share the same typed cells by name; ‘{name}’ is a string hole, ‘{#name}’ a typed int hole. (Single-word fills round-trip; the count rejects non-numbers.)";
    this.shadow.append(hint);

    const panes = document.createElement("div");
    panes.className = "panes";
    this.shadow.append(panes);

    const mkPane = (
      title: string,
      tplSrc: string,
    ): { src: HTMLTextAreaElement; out: HTMLTextAreaElement } => {
      const pane = document.createElement("div");
      pane.className = "pane";

      const row1 = document.createElement("div");
      row1.className = "row";
      const h1 = document.createElement("h3");
      h1.textContent = `${title} · template`;
      const b1 = document.createElement("span");
      b1.className = "badge";
      b1.textContent = "{slot} parse";
      row1.append(h1, b1);
      const src = document.createElement("textarea");
      src.className = "tpl";
      src.spellcheck = false;
      src.rows = 2;
      src.value = tplSrc;

      const row2 = document.createElement("div");
      row2.className = "row";
      const h2 = document.createElement("h3");
      h2.textContent = `${title} · rendered`;
      row2.append(h2);
      const out = document.createElement("textarea");
      out.spellcheck = false;
      out.rows = 2;

      pane.append(row1, src, row2, out);
      panes.append(pane);
      return { src, out };
    };

    const a = mkPane("A", TPL_A);
    const b = mkPane("B", TPL_B);
    this.#srcA = a.src;
    this.#outA = a.out;
    this.#srcB = b.src;
    this.#outB = b.out;

    this.#srcA.addEventListener("input", () => this.#rebuild());
    this.#srcB.addEventListener("input", () => this.#rebuild());
    this.#outA.addEventListener("input", () => {
      this.#textA.value = this.#outA.value;
    });
    this.#outB.addEventListener("input", () => {
      this.#textB.value = this.#outB.value;
    });
    for (const out of [this.#outA, this.#outB]) {
      const cell = () => (out === this.#outA ? this.#textA : this.#textB);
      out.addEventListener("blur", () => {
        if (out.value !== cell().value) out.value = cell().value;
      });
    }

    this.#controls = document.createElement("div");
    this.#controls.className = "controls";
    this.shadow.append(this.#controls);

    this.#rebuild();
  }

  #buildText(src: string): Writable<Str> {
    const { literals, defs } = parseMadlib(src);
    const slots = defs.map(d => {
      const e = this.#getOrCreate(d);
      return e.kind === "int"
        ? slot.int(e.cell as Writable<Num>, d.name)
        : slot.str(e.cell as Writable<Str>, d.name);
    });
    return template(literals, slots);
  }

  #rebuild(): void {
    for (const d of this.#dyn) d();
    this.#dyn.length = 0;

    this.#textA = this.#buildText(this.#srcA.value);
    this.#textB = this.#buildText(this.#srcB.value);

    const bindOut = (out: HTMLTextAreaElement, text: Writable<Str>): void => {
      this.#dyn.push(
        effect(() => {
          const v = text.value;
          if (this.shadow.activeElement !== out && out.value !== v) out.value = v;
        }),
      );
    };
    bindOut(this.#outA, this.#textA);
    bindOut(this.#outB, this.#textB);

    // Controls: union of slot names across both templates, in first-seen order.
    const seen = new Set<string>();
    const order: Def[] = [];
    for (const src of [this.#srcA.value, this.#srcB.value]) {
      for (const d of parseMadlib(src).defs) {
        if (!seen.has(d.name)) {
          seen.add(d.name);
          order.push(d);
        }
      }
    }

    this.#controls.replaceChildren();
    for (const d of order) {
      const e = this.#getOrCreate(d);
      const wrap = document.createElement("div");
      wrap.className = "ctrl";
      const l = document.createElement("label");
      l.textContent = d.name;
      wrap.append(l);

      if (e.kind === "int") {
        const cell = e.cell as Writable<Num>;
        const rowEl = document.createElement("div");
        rowEl.className = "range-row";
        const input = document.createElement("input");
        input.type = "range";
        input.min = "0";
        input.max = "20";
        input.step = "1";
        const outSpan = document.createElement("span");
        outSpan.className = "count";
        input.addEventListener("input", () => {
          cell.value = Number(input.value);
        });
        this.#dyn.push(
          effect(() => {
            const v = Math.round(cell.value);
            outSpan.textContent = String(v);
            if (this.shadow.activeElement !== input && Number(input.value) !== v) {
              input.value = String(v);
            }
          }),
        );
        rowEl.append(input, outSpan);
        wrap.append(rowEl);
      } else {
        const cell = e.cell as Writable<Str>;
        const input = document.createElement("input");
        input.type = "text";
        input.spellcheck = false;
        input.addEventListener("input", () => {
          cell.value = input.value;
        });
        this.#dyn.push(
          effect(() => {
            const v = cell.value;
            if (this.shadow.activeElement !== input && input.value !== v) input.value = v;
          }),
        );
        wrap.append(input);
      }
      this.#controls.append(wrap);
    }
  }
}
