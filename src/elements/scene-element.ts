import { BaseElement, css } from "./base-element";
import { Padding, Scene } from "./draw";

/**
 * Base class for elements whose body is a Scene-rendered SVG diagram.
 * Subclasses just override `draw(scene)` (and optionally `scenePadding()`)
 * — all the shadow DOM wrapper, CSS, and SVG-mounting boilerplate is
 * handled here.
 *
 * Subclasses can set their own `static styles` to add to the shared
 * CSS (e.g. to override `--scene-max-width`); BaseElement walks the
 * prototype chain so subclass styles are combined with these base
 * styles automatically.
 */
export abstract class SceneElement extends BaseElement {
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

  /** Populate the scene with the diagram's content. Called on each render. */
  protected abstract draw(scene: Scene): void;

  /** Override to set scene padding. Default `20` on all sides. */
  protected scenePadding(): Padding {
    return 20;
  }

  protected render(): void {
    const scene = new Scene({ padding: this.scenePadding() });
    this.draw(scene);
    this.shadow.innerHTML = `
      <div class="scene-container">
        <div class="scene-vis"><svg></svg></div>
      </div>
    `;
    scene.render(this.shadow.querySelector("svg") as SVGSVGElement);
  }
}
