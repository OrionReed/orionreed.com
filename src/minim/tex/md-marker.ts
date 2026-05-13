// Prose-linking element for plain (non-math) text.
//
// Identical signal wiring to <md-tex sym="...">, but renders no math —
// the text content is left as-is in the prose font. Use this for full
// words or phrases; use <md-tex> for math symbols that should render
// in the math font.
//
//      <md-marker sym="sim:ball">ball</md-marker>
//      <md-marker sym="sim:mass">mass</md-marker>
//
// On connect: subscribes to marker.color (text color) and
// marker.highlighted (background tint). Mouseenter/leave writes back
// to marker.highlighted, so hovering here highlights all diagram parts
// and <md-tex> elements sharing the same marker — and vice versa.

import { effect } from "../core/signal";
import { getMarker } from "./parts";

export class MdMarker extends HTMLElement {
  #disposers: Array<() => void> = [];

  connectedCallback(): void {
    const id = this.getAttribute("sym");
    if (!id) return;
    const marker = getMarker(id);
    if (!marker) return;

    this.style.borderRadius = "2px";
    this.style.transition = "background-color 120ms ease-out";
    this.style.cursor = "default";

    this.#disposers.push(
      effect(() => { this.style.color = marker.color.value ?? ""; }),
      effect(() => {
        const hl    = marker.highlighted.value;
        const color = marker.color.value;
        this.style.backgroundColor = hl && color ? `${color}22` : "";
      }),
    );

    const on  = (): void => { marker.highlighted.value = true; };
    const off = (): void => { marker.highlighted.value = false; };
    this.addEventListener("mouseenter", on);
    this.addEventListener("mouseleave", off);
    this.#disposers.push(() => {
      this.removeEventListener("mouseenter", on);
      this.removeEventListener("mouseleave", off);
    });
  }

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers.length = 0;
  }

  static define(): void {
    customElements.define("md-marker", this);
  }
}
