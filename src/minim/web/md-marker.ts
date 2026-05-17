// Prose-linking element for plain (non-math) text.
//
// Same signal wiring as <md-tex sym="...">, but renders no math — the
// text content stays in the prose font. Use for full words or phrases;
// use <md-tex> for symbols that should render in the math font.
//
//      The <md-marker for="d" sym="ball">ball</md-marker> has kinetic energy
//      <md-tex for="d" sym="v">v^2</md-tex>.
//
// `for` names the diagram element's id. Falls back to global registry
// if absent (transitional — prefer the scoped path).

import {effect} from "@minim/signals";
import {hover, getMarker as getGlobalMarker, type Marker} from "@minim/tex";

type MarkerHost = { getMarker?: (id: string) => Marker | undefined };

function resolveMarker(id: string, forId: string | null): Marker | undefined {
  if (forId) {
    const el = document.getElementById(forId) as MarkerHost | null;
    return el?.getMarker?.(id);
  }
  return getGlobalMarker(id);
}

export class MdMarker extends HTMLElement {
  #disposers: Array<() => void> = [];

  connectedCallback(): void {
    const id = this.getAttribute("sym");
    if (!id) return;
    const forId = this.getAttribute("for");
    const m = resolveMarker(id, forId);
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
