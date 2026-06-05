// md-flags.ts — Unix file permissions as ONE packed int, five ways.
//
// `flags(...9 names)` is a single `Cell<number>`. Bit i carries value 2^i,
// ordered so the packed integer IS the chmod value. Five synced surfaces
// over that one cell:
//   - a 3×3 checkbox grid — each box a `flag()` bit lens (a real Bool lens
//     that sets/clears its bit in the packed value);
//   - per-row "all" toggles — `Tri.allOf([...the row's bits])`, all/none/
//     mixed, broadcasting to the triad;
//   - octal (755), symbolic (rwxr-xr--), and raw binary (111101101) fields,
//     each a format/parse view bound straight to `perms.value`.
// Edit any surface and the other four update — bireactivity over an integer.

import { type Bool, effect, flags, Tri, type Writable } from "../../minim";
import { BaseElement, css } from "../base-element";

// Bit layout (high → low): ur uw ux | gr gw gx | or ow ox.
// Listed low → high so bit i = 2^i and the packed int equals the octal mask.
const ORDER = ["ox", "ow", "or", "gx", "gw", "gr", "ux", "uw", "ur"] as const;
type FlagName = (typeof ORDER)[number];

const ROWS: ReadonlyArray<{ label: string; bits: readonly [FlagName, FlagName, FlagName] }> = [
  { label: "owner", bits: ["ur", "uw", "ux"] },
  { label: "group", bits: ["gr", "gw", "gx"] },
  { label: "other", bits: ["or", "ow", "ox"] },
];

const LETTERS = "rwxrwxrwx";

const toOctal = (n: number): string => (n & 0o777).toString(8).padStart(3, "0");
const parseOctal = (s: string): number | undefined =>
  /^[0-7]{1,3}$/.test(s.trim()) ? Number.parseInt(s.trim(), 8) : undefined;

const toBinary = (n: number): string => (n & 0o777).toString(2).padStart(9, "0");
const parseBinary = (s: string): number | undefined =>
  /^[01]{1,9}$/.test(s.trim()) ? Number.parseInt(s.trim(), 2) : undefined;

const toSymbolic = (n: number): string => {
  let out = "";
  for (let k = 0; k < 9; k++) out += (n >> (8 - k)) & 1 ? LETTERS[k] : "-";
  return out;
};
const parseSymbolic = (s: string): number | undefined => {
  const t = s.trim();
  if (t.length !== 9) return undefined;
  let n = 0;
  for (let k = 0; k < 9; k++) if (t[k] !== "-") n |= 1 << (8 - k);
  return n;
};

export class MdFlags extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 560px;
      font-family: inherit;
      color: var(--text-color);
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0 0 0.9rem;
      line-height: 1.4;
    }
    .card {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1rem;
      padding: 0.9rem 1.1rem;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background: var(--bg-color);
    }
    table {
      border-collapse: collapse;
      margin: 0 auto;
    }
    th,
    td {
      padding: 0.3rem 0.7rem;
      text-align: center;
      font-size: 0.85rem;
    }
    th {
      font-weight: 600;
      color: var(--text-secondary);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    td.rowlabel {
      text-align: right;
      font-weight: 600;
    }
    td.allcol {
      border-left: 1px dashed var(--border-color);
    }
    input[type="checkbox"] {
      width: 17px;
      height: 17px;
      cursor: pointer;
      accent-color: var(--ink-fill, #5b8def);
      margin: 0;
    }
    .fields {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 0.7rem 0.9rem;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      min-width: 0;
    }
    .field label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-secondary);
    }
    .field input {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1rem;
      letter-spacing: 0.08em;
      padding: 0.4rem 0.55rem;
      border: 1px solid var(--border-color);
      border-radius: 5px;
      background: var(--code-bg);
      color: var(--code-text);
      box-sizing: border-box;
      min-width: 0;
      width: 100%;
    }
    .field input.bad {
      border-color: #e05a5a;
    }
    .field input:focus {
      outline: none;
      border-color: var(--text-color);
    }
  `;

  #disposers: Array<() => void> = [];

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
  }

  protected render(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.shadow.replaceChildren();

    const perms = flags(...ORDER);
    perms.value = 0o755;

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "One packed integer, five editors. Tick a permission, drag a row's “all”, or type an octal / symbolic / binary value — every surface re-derives from the same Flags cell. Each checkbox is a real bit lens; each row is a Tri all/none/mixed aggregate.";
    this.shadow.append(hint);

    const card = document.createElement("div");
    card.className = "card";
    this.shadow.append(card);

    // ── 3×3 grid of bit lenses + per-row Tri toggles ──
    const table = document.createElement("table");
    const thead = document.createElement("tr");
    for (const h of ["", "r", "w", "x", "all"]) {
      const th = document.createElement("th");
      th.textContent = h;
      if (h === "all") th.className = "allcol";
      thead.append(th);
    }
    table.append(thead);

    const bindCheckbox = (cb: HTMLInputElement, cell: Writable<Bool>): void => {
      cb.addEventListener("change", () => {
        cell.value = cb.checked;
      });
      this.#disposers.push(
        effect(() => {
          const v = cell.value;
          if (cb.checked !== v) cb.checked = v;
          cb.indeterminate = false;
        }),
      );
    };

    for (const row of ROWS) {
      const tr = document.createElement("tr");
      const label = document.createElement("td");
      label.className = "rowlabel";
      label.textContent = row.label;
      tr.append(label);

      for (const name of row.bits) {
        const td = document.createElement("td");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        bindCheckbox(cb, perms.flag(name));
        td.append(cb);
        tr.append(td);
      }

      // Tri all/none/mixed over the row's three bits.
      const allTd = document.createElement("td");
      allTd.className = "allcol";
      const allCb = document.createElement("input");
      allCb.type = "checkbox";
      const tri = Tri.allOf(row.bits.map(n => perms.flag(n)));
      allCb.addEventListener("change", () => {
        tri.value = allCb.checked;
      });
      this.#disposers.push(
        effect(() => {
          const v = tri.value;
          allCb.checked = v === true;
          allCb.indeterminate = v === "mixed";
        }),
      );
      allTd.append(allCb);
      tr.append(allTd);
      table.append(tr);
    }
    card.append(table);

    // ── octal / symbolic / binary fields ──
    const fields = document.createElement("div");
    fields.className = "fields";
    card.append(fields);

    const field = (
      name: string,
      read: () => string,
      parseInput: (s: string) => number | undefined,
    ): void => {
      const wrap = document.createElement("div");
      wrap.className = "field";
      const l = document.createElement("label");
      l.textContent = name;
      const input = document.createElement("input");
      input.spellcheck = false;
      input.autocomplete = "off";
      input.value = read();
      input.addEventListener("input", () => {
        const n = parseInput(input.value);
        if (n === undefined) {
          input.classList.add("bad");
        } else {
          input.classList.remove("bad");
          perms.value = n & 0o777;
        }
      });
      input.addEventListener("blur", () => {
        input.classList.remove("bad");
        input.value = read();
      });
      this.#disposers.push(
        effect(() => {
          const v = read();
          if (this.shadow.activeElement !== input && input.value !== v) input.value = v;
        }),
      );
      wrap.append(l, input);
      fields.append(wrap);
    };

    field("octal", () => toOctal(perms.value), parseOctal);
    field("symbolic", () => toSymbolic(perms.value), parseSymbolic);
    field("binary", () => toBinary(perms.value), parseBinary);
  }
}
