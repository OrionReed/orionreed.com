// Custom-element scaffold. Subclasses override `scene(s)` to build
// the graph; signals drive updates. Owns the SVG element, the
// viewBox (`view`/`fit`), and the host CSS sizing (`--d-w`/`--d-h`).

import { Anim, effect, toSig, type Val } from "@minim/core";
import {
  Shape,
  SVG_NS,
  mount,
  ensureArrowMarker,
  type Mount,
} from "@minim/shapes";
import { Box as BoxStruct, box, type Boxlike } from "@minim/values";
import { observedAttributesOf, syncAttrSignal } from "./attr";
import type { Marker } from "@minim/tex";
// (other web/ files: relative imports stay local to keep the package self-contained)

export const css = String.raw;

export type Padding =
  | number
  | { top?: number; right?: number; bottom?: number; left?: number };

function resolvePadding(p?: Padding) {
  if (p === undefined || p === 0)
    return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof p === "number") return { top: p, right: p, bottom: p, left: p };
  return {
    top: p.top ?? 0,
    right: p.right ?? 0,
    bottom: p.bottom ?? 0,
    left: p.left ?? 0,
  };
}

export class Diagram extends HTMLElement {
  static get observedAttributes(): string[] {
    return observedAttributesOf(this);
  }

  attributeChangedCallback(
    name: string,
    oldVal: string | null,
    newVal: string | null,
  ): void {
    if (oldVal === newVal) return;
    syncAttrSignal(this, name, newVal);
  }

  protected shadow: ShadowRoot;
  protected anim = new Anim();
  protected svg!: SVGSVGElement;
  /** Scene-graph root. All user-mounted shapes are children of this. */
  protected root!: Shape;
  /** Callable mount handle passed into `scene(s)`. `s(shape)` adds to root. */
  protected s!: Mount;

  // Per-instance marker registry. Cleared and repopulated on each
  // connectedCallback so `<md-tex for="id">` always sees fresh markers.
  #markers = new Map<string, Marker>();

  /** Register a marker under `id` for this diagram instance. Call in
   *  `scene()` so prose elements with `for="this-id"` can resolve it. */
  registerMarker(id: string, m: Marker): void {
    this.#markers.set(id, m);
  }

  /** Look up a marker registered on this instance. */
  getMarker(id: string): Marker | undefined {
    return this.#markers.get(id);
  }

  // Viewport state. `#viewSet` flips on the first explicit `view()`/`fit()`
  // call; `connectedCallback` auto-fits if it's still false.
  #viewSet = false;
  #viewSig = signal0Box();
  #viewBox = BoxStruct.derived(() => this.#viewSig.value);

  private static styleSheets = new Map<string, CSSStyleSheet>();
  static styles = css`
    :host {
      display: block;
      margin: 1rem auto;
      width: 100%;
      max-width: calc(var(--d-w, 600) * 1px);
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
  `;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.initializeStyles();
  }

  /** Build the scene graph. Runs once per element-connect; signals
   *  handle dynamic behavior. Override in subclasses. */
  protected scene(_s: Mount): void {}

  connectedCallback(): void {
    if (!this.svg) this.mountSvg();
    this.anim.stop();
    this.root?.dispose();
    this.#viewSet = false;
    this.#markers.clear();
    this.root = new Shape();
    this.svg.replaceChildren(this.root.el);
    ensureArrowMarker(this.svg);
    this.s = mount(this.root);
    this.scene(this.s);
    if (!this.#viewSet) this.fit();
  }

  disconnectedCallback(): void {
    this.anim.stop();
    this.root?.dispose();
  }

  /** Set the SVG viewBox to `(0, 0, w, h)` (reactive in either input).
   *  First call wins; subsequent calls (and the auto-fit fallback) are
   *  no-ops. Returns a Reactive `Box` for layout use (`view.w.value`,
   *  `view.center`, etc.). */
  view(w: Val<number>, h: Val<number>): Boxlike {
    if (this.#viewSet) return this.#viewBox;
    const ws = toSig(w);
    const hs = toSig(h);
    effect(() => this.setViewBox(0, 0, ws.value, hs.value));
    this.#viewSet = true;
    return this.#viewBox;
  }

  /** Auto-fit viewBox to the root's bounds + optional padding. Called
   *  automatically after `scene()` when `view()` wasn't invoked. */
  fit(padding?: Padding): Boxlike {
    if (this.#viewSet) return this.#viewBox;
    const p = resolvePadding(padding);
    const b = this.root.box.value;
    this.setViewBox(
      b.x - p.left,
      b.y - p.top,
      b.w + p.left + p.right,
      b.h + p.top + p.bottom,
    );
    this.#viewSet = true;
    return this.#viewBox;
  }

  static get tagName(): string {
    return this.name
      .replace(/([A-Z])/g, "-$1")
      .toLowerCase()
      .slice(1);
  }

  static define(): void {
    customElements.define(this.tagName, this);
  }

  private setViewBox(x: number, y: number, w: number, h: number): void {
    this.#viewSig.value = box(x, y, w, h);
    this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.svg.setAttribute("width", String(w));
    this.svg.setAttribute("height", String(h));
    // Drive host sizing from viewBox: `:host` reads `--d-w` to set
    // max-width. Authors can override per-element via `style="--d-w: N"`.
    this.style.setProperty("--d-w", String(w));
    this.style.setProperty("--d-h", String(h));
  }

  private mountSvg(): void {
    this.svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    this.shadow.appendChild(this.svg);
  }

  /** Combine base + subclass styles. Cached per subclass. */
  private initializeStyles(): void {
    const ctor = this.constructor as typeof Diagram;
    const cacheKey = ctor.name;
    if (!Diagram.styleSheets.has(cacheKey)) {
      const baseStyles = Diagram.styles ?? "";
      const ownStyles = ctor === Diagram ? "" : (ctor.styles ?? "");
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(baseStyles + "\n" + ownStyles);
      Diagram.styleSheets.set(cacheKey, sheet);
    }
    this.shadow.adoptedStyleSheets = [Diagram.styleSheets.get(cacheKey)!];
  }
}

// Helper: a fresh writable Box-valued signal seeded with the zero box.
function signal0Box() {
  return BoxStruct.signal(box(0, 0, 0, 0));
}
