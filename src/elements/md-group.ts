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

    @media (max-width: 767px) {
      :host {
        gap: 0.5rem;
        margin-bottom: 2rem;
      }
    }
  `;

  protected render(): void {
    this.shadow.innerHTML = `<slot></slot>`;
  }
}
