// Prose-linking element for plain (non-math) text.
//
// Same signal wiring as <md-tex sym="...">, but renders no math — the
// text content stays in the prose font. Use for full words or phrases;
// use <md-tex> for symbols that should render in the math font.
//
//      The <md-marker sym="sim:ball">ball</md-marker> has kinetic energy
//      <md-tex sym="sim:v">v^2</md-tex>.

import { effect } from "../core/signal";
import { hover, getMarker } from "../core/marker";

export class MdMarker extends HTMLElement {
  #disposers: Array<() => void> = [];

  connectedCallback(): void {
    const id = this.getAttribute("sym");
    if (!id) return;
    const m = getMarker(id);
    if (!m) return;

    this.style.borderRadius = "2px";
    this.style.transition = "background-color 120ms ease-out";
    this.style.cursor = "default";

    this.#disposers.push(
      hover(this, m),
      effect(() => { this.style.color = m.color.value ?? ""; }),
      effect(() => {
        const color = m.color.value;
        this.style.backgroundColor =
          m.active.value && color
            ? `color-mix(in srgb, ${color} 15%, transparent)`
            : "";
      }),
    );
  }

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
  }

  static define(): void {
    customElements.define("md-marker", this);
  }
}
