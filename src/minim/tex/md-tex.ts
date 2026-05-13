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
//      <md-tex sym="energy:v">v^2</md-tex>
//
// 3. Multi-symbol expression — full LaTeX with \sym{id}{content} macros,
//    matching the diagram-side tex`...\${part}...` pattern:
//
//      <md-tex>\dfrac{1}{2}\sym{energy:m}{m}\sym{energy:v}{v^2}</md-tex>
//
// In modes 2 and 3, the element subscribes to `marker.color` (text color)
// and `marker.highlighted` (background tint). Hovering sets
// `marker.highlighted = true`, which propagates to any diagram parts
// sharing the same registered marker — and vice versa.
//
// `\sym{id}{content}` is pre-processed before Temml: it becomes
// `\class{minim-sym-ID}{content}` in the LaTeX source. After rendering,
// the element queries for those class names and wires signal effects +
// hover listeners per element.

import temml from "temml";
import { effect } from "../core/signal";
import { getMarker, type Marker } from "./parts";

// Matches \sym{registry-id}{latex-content}. The id may contain any
// character except `}` (colons, hyphens etc. are all fine in registry ids).
const SYM_RE = /\\sym\{([^}]+)\}\{([^}]*)\}/g;

// Encode a registry id as a safe CSS class name. Colons, slashes, etc.
// are replaced with underscores so the class is valid in querySelectorAll.
const symClass = (id: string): string =>
  `minim-sym-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

function applyMarkerStyles(el: HTMLElement): void {
  el.style.borderRadius = "2px";
  el.style.transition = "background-color 120ms ease-out";
  el.style.cursor = "default";
}

export class MdTex extends HTMLElement {
  #disposers: Array<() => void> = [];

  connectedCallback(): void {
    const singleId = this.getAttribute("sym");
    const src = this.textContent?.trim() ?? "";

    if (singleId) {
      // ── Mode 2: single-symbol ────────────────────────────────────────
      this.innerHTML = temml.renderToString(src, { throwOnError: false, trust: true });
      const marker = getMarker(singleId);
      if (marker) {
        applyMarkerStyles(this as unknown as HTMLElement);
        this.#wireEl(this as unknown as HTMLElement, marker);
      }
      return;
    }

    // ── Modes 1 & 3: full expression ────────────────────────────────────
    // Pre-process \sym{id}{content} → \class{minim-sym-ID}{content}.
    const symIds = new Map<string, string>(); // cssClass → registryId
    const processedSrc = src.replace(SYM_RE, (_, id: string, content: string) => {
      const cls = symClass(id);
      symIds.set(cls, id);
      return `\\class{${cls}}{${content}}`;
    });

    this.innerHTML = temml.renderToString(processedSrc, { throwOnError: false, trust: true });

    // ── Mode 3: wire each \sym occurrence ───────────────────────────────
    for (const [cls, id] of symIds) {
      const marker = getMarker(id);
      if (!marker) continue;
      const els = Array.from(this.querySelectorAll<HTMLElement>(`.${cls}`));
      for (const el of els) {
        applyMarkerStyles(el);
        this.#wireEl(el, marker);
      }
    }
  }

  /** Wire color + highlighted effects and hover listeners to `el`. */
  #wireEl(el: HTMLElement, marker: Marker): void {
    this.#disposers.push(
      effect(() => { el.style.color = marker.color.value ?? ""; }),
      effect(() => {
        const hl = marker.highlighted.value;
        const color = marker.color.value;
        el.style.backgroundColor = hl && color ? `${color}22` : "";
      }),
    );
    const on  = (): void => { marker.highlighted.value = true; };
    const off = (): void => { marker.highlighted.value = false; };
    el.addEventListener("mouseenter", on);
    el.addEventListener("mouseleave", off);
    this.#disposers.push(() => {
      el.removeEventListener("mouseenter", on);
      el.removeEventListener("mouseleave", off);
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
