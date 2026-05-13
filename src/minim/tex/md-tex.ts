// Inline math custom element with optional prose-linking.
//
// Usage in markdown (raw HTML passthrough):
//
//      <md-tex>a^2 + b^2 = c^2</md-tex>
//
// With a registered marker (hover highlights linked diagram parts):
//
//      <md-tex sym="energy:v">v^2</md-tex>
//
// The element renders its text content as MathML via Temml on connect.
// If `sym` is present and `getMarker(sym)` resolves, the element:
//   - derives its text color from `marker.color` (identity color alphabet)
//   - applies a tinted background when `marker.highlighted` is true
//   - sets `marker.highlighted = true` on mouseenter / false on mouseleave
//
// Both directions are live: hovering the element highlights the diagram,
// and the diagram (or its animation) highlighting also highlights this element.
//
// Author setup (post inline script or module-level in the demo element):
//
//      import { parts } from "./parts";
//      const { m, v } = parts("m", "v");
//      m.color.value = "#d97706";
//      m.register("energy:m");
//      v.register("energy:v");

import temml from "temml";
import { effect } from "../core/signal";
import { getMarker } from "./parts";

export class MdTex extends HTMLElement {
  #disposers: Array<() => void> = [];

  connectedCallback(): void {
    const src = this.textContent?.trim() ?? "";
    if (src) {
      this.innerHTML = temml.renderToString(src, {
        throwOnError: false,
        trust: true,
      });
    }

    const id = this.getAttribute("sym");
    if (!id) return;
    const marker = getMarker(id);
    if (!marker) return;

    this.style.display = "inline-block";
    this.style.borderRadius = "2px";
    this.style.transition = "background-color 120ms ease-out";

    this.#disposers.push(
      effect(() => {
        this.style.color = marker.color.value ?? "";
      }),
      effect(() => {
        const hl = marker.highlighted.value;
        const color = marker.color.value;
        // Tint using the marker's own color at ~13% alpha so the
        // background matches the symbol identity rather than a fixed yellow.
        this.style.backgroundColor = hl && color ? `${color}22` : "";
      }),
    );

    const on = (): void => {
      marker.highlighted.value = true;
    };
    const off = (): void => {
      marker.highlighted.value = false;
    };
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
    customElements.define("md-tex", this);
  }
}
