// Diagram = a custom-element scaffold + a `Scene`. Subclasses override
// `setup(scene)` and build their scene graph there. The base provides:
//   - shadow DOM with a mounted `<svg>`
//   - per-class cached stylesheet (Diagram base styles + subclass styles)
//   - a fresh `Scene` rooted at a `<g>` inside the SVG
//   - `this.anim` — drive animations via `this.anim.loop(function*() { ... })`
//
// No `render()` hook, no per-frame rebuild — shapes are persistent and
// patch themselves via signal reactivity.

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

  /** Build the scene graph. Override in subclasses; default is no-op. */
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

  /** Combine Diagram's base styles with the subclass's own static
   *  `styles`. No deeper inheritance: we expect subclasses to extend
   *  Diagram directly, not stack intermediate classes that contribute
   *  styles. Cached per subclass so repeated instances share one sheet. */
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
