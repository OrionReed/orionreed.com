// md-unit-algebra.ts — units as composable values.
//
// `Unit` multiplication adds dimension vectors, so compound units are
// built, not enumerated. Multiply/divide by base units and watch the
// dimension, its physical name, and the matching named units fall out —
// `m ÷ s` becomes a velocity offering m/s, km/h, mph, kn; `kg·m ÷ s²`
// becomes a force offering N.

import { cell, effect } from "../../minim";
import { BaseElement, css } from "../base-element";
import {
  ampere,
  dimName,
  formatDim,
  kelvin,
  kilogram,
  meter,
  second,
  type Unit,
  unitsLike,
} from "./units";

const BASES = [
  { u: meter, sym: "m" },
  { u: kilogram, sym: "kg" },
  { u: second, sym: "s" },
  { u: ampere, sym: "A" },
  { u: kelvin, sym: "K" },
];

export class MdUnitAlgebra extends BaseElement {
  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      width: 100%;
      max-width: 560px;
      color: var(--text-color);
    }
    .controls {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 0.4rem;
      margin-bottom: 0.9rem;
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      align-items: stretch;
    }
    .col .base {
      text-align: center;
      font-weight: 600;
      font-size: 0.85rem;
      color: var(--text-secondary);
    }
    button {
      font: inherit;
      font-size: 0.85rem;
      padding: 0.25rem 0;
      border: 1px solid var(--border-color);
      border-radius: 5px;
      background: var(--bg-color);
      color: var(--text-color);
      cursor: pointer;
    }
    button:hover {
      border-color: #2f6df0;
    }
    .reset {
      width: 100%;
      margin-bottom: 0.9rem;
      color: var(--text-secondary);
    }
    .readout {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 0.9rem 1rem;
      background: var(--bg-color);
      text-align: center;
    }
    .dim {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1.7rem;
      font-weight: 600;
    }
    .name {
      margin-top: 0.2rem;
      font-size: 1rem;
      color: #2f6df0;
      min-height: 1.2em;
    }
    .name[data-unknown] {
      color: var(--text-secondary);
      font-style: italic;
    }
    .compat {
      margin-top: 0.6rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      justify-content: center;
      min-height: 1.4em;
    }
    .chip {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      padding: 0.1rem 0.45rem;
      border-radius: 999px;
      background: var(--code-bg);
      color: var(--text-secondary);
    }
    .hint {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin: 0.7rem 0 0;
      line-height: 1.4;
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

    const start = meter.div(meter); // dimensionless (factor 1, dim 0)
    const u = cell<Unit>(start);

    const controls = document.createElement("div");
    controls.className = "controls";
    for (const { u: base, sym } of BASES) {
      const col = document.createElement("div");
      col.className = "col";
      const head = document.createElement("div");
      head.className = "base";
      head.textContent = sym;
      const mul = document.createElement("button");
      mul.textContent = `× ${sym}`;
      mul.addEventListener("click", () => {
        u.value = u.value.times(base);
      });
      const div = document.createElement("button");
      div.textContent = `÷ ${sym}`;
      div.addEventListener("click", () => {
        u.value = u.value.div(base);
      });
      col.append(head, mul, div);
      controls.append(col);
    }

    const reset = document.createElement("button");
    reset.className = "reset";
    reset.textContent = "reset → dimensionless";
    reset.addEventListener("click", () => {
      u.value = start;
    });

    const readout = document.createElement("div");
    readout.className = "readout";
    const dim = document.createElement("div");
    dim.className = "dim";
    const name = document.createElement("div");
    name.className = "name";
    const compat = document.createElement("div");
    compat.className = "compat";
    readout.append(dim, name, compat);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "Composition is the algebra: × and ÷ add and subtract dimension vectors. Two quantities are interconvertible exactly when their dimensions match.";

    this.shadow.append(controls, reset, readout, hint);

    this.#disposers.push(
      effect(() => {
        const cur = u.value;
        dim.textContent = formatDim(cur.dim);
        const nm = dimName(cur);
        name.textContent = nm ?? "no named quantity";
        if (nm) name.removeAttribute("data-unknown");
        else name.setAttribute("data-unknown", "");
        compat.replaceChildren();
        for (const m of unitsLike(cur)) {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = m.symbol;
          compat.append(chip);
        }
      }),
    );
  }
}
