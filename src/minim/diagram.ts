// Custom-element scaffold. Subclasses override `scene(s)` to build
// the graph; signal reactivity drives all updates.

import { Anim, EventBus } from "./core";
import { Shape, SVG_NS, makeScene, type Scene } from "./scene";
import { observedAttributesOf, syncAttrSignal } from "./attr";
import { ensureArrowMarker } from "./shapes/connect";

export const css = String.raw;

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
  /** Named pub/sub for cross-cutting events inside the diagram. Keys
   *  are strings; subscribers and emitters never need to share a
   *  reference — just a name. */
  protected bus = new EventBus();
  protected svg!: SVGSVGElement;
  /** The Scene built in `scene(s)` — accessible from event handlers
   *  and lifecycle hooks. Same handle that's passed to `scene(s)`. */
  protected s!: Scene;

  private static styleSheets = new Map<string, CSSStyleSheet>();
  static styles = css`
    :host {
      display: block;
      margin: 1rem 0;
    }
    .scene-container {
      padding: 1rem;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .scene-vis {
      width: 100%;
      max-width: var(--scene-max-width, 600px);
    }
    .scene-vis svg {
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

  /** Build the scene graph. Override in subclasses. Runs once per
   *  element-connect; reactivity handles dynamic behavior. */
  protected scene(_s: Scene): void {}

  connectedCallback(): void {
    if (!this.svg) this.mountSvg();
    this.anim.stop();
    this.s?.root.dispose();
    const root = new Shape();
    this.svg.replaceChildren(root.el);
    ensureArrowMarker(this.svg);
    this.s = makeScene(this.svg, root);
    this.scene(this.s);
    if (this.s._viewPending) this.s.fit();
  }

  disconnectedCallback(): void {
    this.anim.stop();
    this.s?.root.dispose();
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

  private mountSvg(): void {
    this.svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    const container = document.createElement("div");
    container.className = "scene-container";
    const vis = document.createElement("div");
    vis.className = "scene-vis";
    vis.appendChild(this.svg);
    container.appendChild(vis);
    this.shadow.appendChild(container);
  }

  /** Combine base + subclass styles, cached per subclass. */
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
