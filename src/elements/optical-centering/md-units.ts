// md-units.ts — N-way live unit converter built on the `Unit` algebra.
//
// One canonical SI-base cell per category; every unit field is a lens
// `si.lens(fromBase, toBase)` onto it. Edit ANY field and the bwd writes
// the pivot, so every sibling re-derives — no master field, no swap
// button. Temperature shows the affine case; Speed/Area/Volume the
// compound case; Data/Angle ride the same machinery via tag dimensions.

import { effect, type Num, num, type Writable } from "../../minim";
import { BaseElement, css } from "../base-element";
import { CATEGORIES } from "./units";

function fmt(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1e7 || a < 1e-4) {
    return x
      .toExponential(4)
      .replace(/(\.\d*?)0+e/, "$1e")
      .replace(/\.e/, "e");
  }
  return Number.parseFloat(x.toPrecision(7)).toString();
}

export class MdUnits extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 720px;
      color: var(--text-color);
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin-bottom: 0.8rem;
    }
    .tab {
      font: inherit;
      font-size: 0.8rem;
      padding: 0.25rem 0.65rem;
      border: 1px solid var(--border-color);
      border-radius: 999px;
      background: var(--bg-color);
      color: var(--text-secondary);
      cursor: pointer;
    }
    .tab[data-active] {
      background: #2f6df0;
      border-color: #2f6df0;
      color: #fff;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 0.5rem;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.55rem;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-color);
    }
    .lab {
      display: flex;
      flex-direction: column;
      min-width: 3.4rem;
    }
    .sym {
      font-weight: 600;
      font-size: 0.9rem;
    }
    .nm {
      font-size: 0.65rem;
      color: var(--text-secondary);
    }
    input {
      flex: 1;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9rem;
      text-align: right;
      padding: 0.25rem 0.4rem;
      background: var(--code-bg);
      color: var(--code-text);
      border: 1px solid var(--border-color);
      border-radius: 4px;
    }
    input:focus {
      outline: none;
      border-color: #2f6df0;
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0.7rem 0 0;
      line-height: 1.4;
    }
  `;

  #disposers: Array<() => void> = [];
  #tabs: HTMLButtonElement[] = [];

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
  }

  protected render(): void {
    this.shadow.replaceChildren();
    this.#tabs = [];

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    const grid = document.createElement("div");
    grid.className = "grid";

    CATEGORIES.forEach((cat, i) => {
      const b = document.createElement("button");
      b.className = "tab";
      b.textContent = cat.label;
      b.addEventListener("click", () => this.#select(i, grid));
      this.#tabs.push(b);
      tabs.append(b);
    });

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Every field is a lens onto one canonical SI-base cell — edit any one and the rest follow. Temperature is affine (offset, not just scale); speed/area/volume are compound units composed from the bases.";

    this.shadow.append(tabs, grid, hint);
    this.#select(0, grid);
  }

  #select(idx: number, grid: HTMLDivElement): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
    this.#tabs.forEach((t, i) => {
      if (i === idx) t.setAttribute("data-active", "");
      else t.removeAttribute("data-active");
    });

    const cat = CATEGORIES[idx]!;
    const si: Writable<Num> = num(cat.units[0]!.toBase(1));
    grid.replaceChildren();

    for (const u of cat.units) {
      const field = si.lens(
        (b: number) => u.fromBase(b),
        (v: number) => u.toBase(v),
      ) as Writable<Num>;

      const row = document.createElement("div");
      row.className = "row";
      const lab = document.createElement("div");
      lab.className = "lab";
      const sym = document.createElement("span");
      sym.className = "sym";
      sym.textContent = u.symbol;
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = u.name;
      lab.append(sym, nm);

      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.spellcheck = false;
      input.autocomplete = "off";

      input.addEventListener("input", () => {
        const v = Number.parseFloat(input.value);
        if (Number.isFinite(v)) field.value = v;
      });
      input.addEventListener("blur", () => {
        input.value = fmt(field.value);
      });

      row.append(lab, input);
      grid.append(row);

      this.#disposers.push(
        effect(() => {
          const v = fmt(field.value);
          if (this.shadow.activeElement === input) return;
          if (input.value !== v) input.value = v;
        }),
      );
    }
  }
}
