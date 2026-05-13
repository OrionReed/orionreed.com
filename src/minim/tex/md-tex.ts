// Inline math custom element with optional prose-linking.
//
// Three usage modes:
//
// 1. Pure math — no linking, just Temml rendering:
//
//      <md-tex>a^2 + b^2 = c^2</md-tex>
//
// 2. Single-symbol linking — text content is LaTeX for one symbol:
//
//      <md-tex sym="post:v">v^2</md-tex>
//
// 3. Multi-symbol expression — full LaTeX with \sym{id}{content} macros,
//    matching the diagram-side tex`...${part}...` pattern:
//
//      <md-tex>\dfrac{1}{2}\sym{post:m}{m}\sym{post:v}{v^2}</md-tex>
//
// In modes 2 and 3, `hover()` binds each element's hover into the Marker
// so simultaneous hovers from prose + diagram are counted correctly.
// Effects read `marker.active` (OR of all bound locals) and `marker.color`.

import temml from "temml";
import { effect, hover, getMarker, type Marker } from "@minim/core";

const SYM_RE = /\\sym\{([^}]+)\}\{([^}]*)\}/g;
const symClass = (id: string): string =>
  `minim-sym-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

export class MdTex extends HTMLElement {
  #disposers: Array<() => void> = [];

  connectedCallback(): void {
    const singleId = this.getAttribute("sym");
    const src = this.textContent?.trim() ?? "";

    if (singleId) {
      // Mode 2: single-symbol
      this.innerHTML = temml.renderToString(src, { throwOnError: false, trust: true });
      const m = getMarker(singleId);
      if (m) this.#wire(this as unknown as HTMLElement, m);
      return;
    }

    // Modes 1 & 3: full expression — pre-process \sym{id}{content}
    const symIds = new Map<string, string>(); // cssClass → registryId
    const processedSrc = src.replace(SYM_RE, (_, id: string, content: string) => {
      const cls = symClass(id);
      symIds.set(cls, id);
      return `\\class{${cls}}{${content}}`;
    });

    this.innerHTML = temml.renderToString(processedSrc, { throwOnError: false, trust: true });

    for (const [cls, id] of symIds) {
      const m = getMarker(id);
      if (!m) continue;
      for (const el of this.querySelectorAll<HTMLElement>(`.${cls}`))
        this.#wire(el, m);
    }
  }

  #wire(el: HTMLElement, m: Marker): void {
    el.style.borderRadius = "2px";
    el.style.transition = "background-color 120ms ease-out";
    el.style.cursor = "default";
    this.#disposers.push(
      hover(el, m),
      effect(() => { el.style.color = m.color.value ?? ""; }),
      effect(() => {
        const color = m.color.value;
        el.style.backgroundColor =
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
    customElements.define("md-tex", this);
  }
}
