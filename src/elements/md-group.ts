import { BaseElement, css } from "./base-element";

export class MdGroup extends BaseElement {
  static styles = css`
    :host {
      display: flex;
      gap: 2rem;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
    }
  `;

  protected render(): void {
    this.shadow.innerHTML = `<slot></slot>`;
  }
}
