import { BaseElement, css } from "./base-element";
import { Padding, Scene, SceneSize } from "./draw";

// Base class for diagrams: subclasses override `draw(scene)` (and
// optionally `scenePadding()` / `sceneSize()`); shadow DOM and SVG
// mounting are handled.
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

  protected abstract draw(scene: Scene): void;

  protected scenePadding(): Padding {
    return 20;
  }

  /**
   * Override to lock the scene to a fixed coordinate system. Returning
   * undefined (the default) preserves the auto-fit behavior — viewBox
   * grows to wrap whatever is drawn, plus padding. Useful for animated
   * diagrams where shapes appear and disappear and you don't want the
   * viewBox to jitter.
   */
  protected sceneSize(): SceneSize | undefined {
    return undefined;
  }

  protected render(): void {
    const scene = new Scene({
      padding: this.scenePadding(),
      size: this.sceneSize(),
    });
    this.draw(scene);
    // Build the container once; subsequent renders only rewrite the SVG.
    let svg = this.shadow.querySelector("svg") as SVGSVGElement | null;
    if (!svg) {
      this.shadow.innerHTML = `
        <div class="scene-container">
          <div class="scene-vis"><svg></svg></div>
        </div>
      `;
      svg = this.shadow.querySelector("svg") as SVGSVGElement;
    }
    scene.render(svg);
  }
}
