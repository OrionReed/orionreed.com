import { BaseElement, attr, css } from "./base-element";

export class MdQuote extends BaseElement {
  @attr() source?: string;
  static styles = css`
    :host {
      display: block;
      margin: 2rem 0;
    }

    .quote-container {
      border-left: 4px solid var(--border-color);
      padding-left: 1.5rem;
      margin: 1.5rem 0;
      font-family: "New CM", monospace;
      font-style: italic;
      font-size: 1.1em;
      line-height: 1.6;
      color: var(--text-secondary);
    }

    .quote-text {
      margin-bottom: 0.5rem;
    }

    .quote-source {
      font-family: "New CM", monospace;
      font-style: normal;
      font-size: 0.9em;
      color: var(--text-secondary);
      text-align: right;
      opacity: 0.8;
    }

    .quote-source::before {
      content: "— ";
    }
  `;

  protected render(): void {
    this.shadow.innerHTML = `
      <div class="quote-container">
        <div class="quote-text">
          <slot></slot>
        </div>
        ${this.source ? `<div class="quote-source">${this.source}</div>` : ""}
      </div>
    `;
  }
}
