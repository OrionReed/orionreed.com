// Custom-element scaffold + Scene. Subclasses override `setup(scene)`.
// Shapes are persistent and patch via signal reactivity — no per-frame
// rebuild, no `render()` hook.

import { Anim } from "./anim";
import { makeScene, type Scene } from "./scene";
import { Shape, SVG_NS } from "./shape";

export const css = String.raw;

export class Diagram extends HTMLElement {
  protected shadow: ShadowRoot;
  protected anim = new Anim();
  protected svg!: SVGSVGElement;
  protected scene!: Scene;

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

  protected setup(_scene: Scene): void {}

  connectedCallback(): void {
    this.anim.stop();
    if (!this.svg) this.mountSvg();
    const root = new Shape();
    this.svg.replaceChildren(root.el);
    this.scene = makeScene(this.svg, root);
    this.setup(this.scene);
  }

  disconnectedCallback(): void {
    this.anim.stop();
    this.scene?.root.dispose();
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

  /** Combine Diagram base styles with subclass styles. Cached per
   *  subclass — assumes single-level inheritance from Diagram. */
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
