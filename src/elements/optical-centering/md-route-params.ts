// md-route-params.ts — a URL ⇄ typed params, with an editable PATTERN.
//
// Two levels of the same parse-string-into-structure mechanism:
//   - The pattern (`/users/#id/posts/:slug`) is parsed into literals + typed
//     holes — `:name` is a `str` slot, `#name` an `int` slot. Editing the
//     pattern rebuilds the route live (a meta layer over the value level).
//   - The route itself is a multi-parent `Str.lens`: forward renders the
//     URL, backward parses it back into the typed param cells.
// A persistent cell pool keyed by name means param VALUES survive a pattern
// edit (rename-free reshaping). `#id` is typed: a non-numeric id segment
// fails the codec and the previous id stays put.

import { effect, type Num, num, type Str, slot, str, template, type Writable } from "../../minim";
import { BaseElement, css } from "../base-element";

type Kind = "str" | "int";
interface Def {
  name: string;
  kind: Kind;
}

function parsePattern(src: string): { literals: string[]; defs: Def[] } {
  const re = /([:#])([A-Za-z_][A-Za-z0-9_]*)/g;
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

const PATTERN0 = "/users/#id/posts/:slug";

export class MdRouteParams extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 620px;
      font-family: inherit;
      color: var(--text-color);
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0 0 0.7rem;
      line-height: 1.4;
    }
    .bar {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      margin-bottom: 0.85rem;
    }
    .bar label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-secondary);
    }
    .bar input {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.95rem;
      padding: 0.45rem 0.6rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--code-bg);
      color: var(--code-text);
      box-sizing: border-box;
    }
    .bar.url input {
      border-color: var(--text-color);
    }
    .controls {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 0.7rem 0.9rem;
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
    .ctrl input {
      font: inherit;
      font-size: 0.9rem;
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      background: var(--code-bg);
      color: var(--code-text);
      box-sizing: border-box;
      min-width: 0;
      width: 100%;
    }
    .ctrl .kind {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.68rem;
      color: var(--text-secondary);
    }
    input:focus {
      outline: none;
      border-color: var(--text-color);
    }
  `;

  #pool = new Map<string, { kind: Kind; cell: Writable<Num> | Writable<Str> }>();
  #dyn: Array<() => void> = [];
  #text!: Writable<Str>;
  #urlInput!: HTMLInputElement;
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

    // Pre-seed pleasant defaults for the starting pattern.
    this.#pool.set("id", { kind: "int", cell: num(42) });
    this.#pool.set("slug", { kind: "str", cell: str("hello-world") });

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Edit the URL or the fields — the other follows. Or edit the PATTERN: ‘:name’ is a string hole, ‘#name’ a typed int hole. Adding, removing, or retyping a hole rebuilds the route live; param values persist by name.";
    this.shadow.append(hint);

    // ── editable pattern (the meta layer) ──
    const patBar = document.createElement("div");
    patBar.className = "bar";
    const patLabel = document.createElement("label");
    patLabel.textContent = "pattern";
    const patInput = document.createElement("input");
    patInput.type = "text";
    patInput.spellcheck = false;
    patInput.value = PATTERN0;
    patInput.addEventListener("input", () => this.#rebuild(patInput.value));
    patBar.append(patLabel, patInput);
    this.shadow.append(patBar);

    // ── URL bar (bound to the current text lens) ──
    const urlBar = document.createElement("div");
    urlBar.className = "bar url";
    const urlLabel = document.createElement("label");
    urlLabel.textContent = "url";
    this.#urlInput = document.createElement("input");
    this.#urlInput.type = "text";
    this.#urlInput.spellcheck = false;
    this.#urlInput.addEventListener("input", () => {
      this.#text.value = this.#urlInput.value;
    });
    this.#urlInput.addEventListener("blur", () => {
      if (this.#urlInput.value !== this.#text.value) this.#urlInput.value = this.#text.value;
    });
    urlBar.append(urlLabel, this.#urlInput);
    this.shadow.append(urlBar);

    // ── param controls (rebuilt on pattern change) ──
    this.#controls = document.createElement("div");
    this.#controls.className = "controls";
    this.shadow.append(this.#controls);

    this.#rebuild(PATTERN0);
  }

  #rebuild(patternSrc: string): void {
    for (const d of this.#dyn) d();
    this.#dyn.length = 0;

    const { literals, defs } = parsePattern(patternSrc);
    const slots = defs.map(d => {
      const e = this.#getOrCreate(d);
      return e.kind === "int"
        ? slot.int(e.cell as Writable<Num>, d.name)
        : slot.str(e.cell as Writable<Str>, d.name);
    });
    this.#text = template(literals, slots);

    this.#dyn.push(
      effect(() => {
        const v = this.#text.value;
        if (this.shadow.activeElement !== this.#urlInput && this.#urlInput.value !== v) {
          this.#urlInput.value = v;
        }
      }),
    );

    this.#controls.replaceChildren();
    for (const d of defs) {
      const e = this.#getOrCreate(d);
      const wrap = document.createElement("div");
      wrap.className = "ctrl";
      const l = document.createElement("label");
      l.textContent = d.name;
      const input = document.createElement("input");
      input.type = d.kind === "int" ? "number" : "text";
      input.spellcheck = false;
      const read = () =>
        d.kind === "int" ? String(Math.round(e.cell.value as number)) : String(e.cell.value);
      input.value = read();
      input.addEventListener("input", () => {
        if (d.kind === "int") {
          const n = Number(input.value);
          if (Number.isFinite(n)) (e.cell as Writable<Num>).value = n;
        } else {
          (e.cell as Writable<Str>).value = input.value;
        }
      });
      this.#dyn.push(
        effect(() => {
          const v = read();
          if (this.shadow.activeElement !== input && input.value !== v) input.value = v;
        }),
      );
      const k = document.createElement("span");
      k.className = "kind";
      k.textContent = d.kind === "int" ? `#${d.name} — int` : `:${d.name} — str`;
      wrap.append(l, input, k);
      this.#controls.append(wrap);
    }
  }
}
