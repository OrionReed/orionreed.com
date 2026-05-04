import { BaseElement, css } from "../elements/base-element";
import { Scene } from "./scene";
import { Shape, SVG_NS } from "./shape";
import type { Signal } from "./signal";

/**
 * Option-B base class. The subclass owns scene construction: it
 * overrides `setup(scene)` and builds the scene graph there. The base
 * provides:
 *   - shadow DOM with a mounted `<svg>`
 *   - a fresh `Scene` rooted at a `<g>` inside the SVG
 *   - `this.anim` (inherited) and `this.tween()` for animation
 *
 * No `draw()` hook, no per-frame rebuild — shapes are persistent and
 * patch themselves via signal reactivity.
 */
export abstract class SceneElement extends BaseElement {
  protected svg!: SVGSVGElement;
  protected scene!: Scene;

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

  protected abstract setup(scene: Scene): void;

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.svg) this.mountSvg();
    const root = new Shape();
    this.svg.replaceChildren(root.el);
    this.scene = new Scene(this.svg, root);
    this.setup(this.scene);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.scene?.root.dispose();
  }

  /**
   * Tween a numeric signal from its current value to `target` over `ms`.
   * Routed through `this.anim` so it cancels with the component.
   */
  protected tween(
    sig: Signal<number>,
    target: number,
    ms: number,
    ease: (t: number) => number = (t) => t,
  ): Promise<void> {
    const start = sig.peek();
    return this.anim.tween(ms, (t) => {
      sig.value = start + (target - start) * ease(t);
    });
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
}
