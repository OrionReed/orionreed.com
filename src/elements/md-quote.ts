import { BaseElement, attr, css } from "./base-element";

export class MdQuote extends BaseElement {
  @attr() source?: string;
  @attr() href?: string;

  static styles = css`
    :host {
      display: block;
      margin: 3rem 0;
    }

    .quote-container {
      margin: 0;
      padding: 1.5rem;
      padding-top: 1rem;
      padding-bottom: 1rem;
      font-family: "New CM", monospace;
      font-size: 1.1em;
      line-height: 1.6;
      color: var(--text-primary, inherit);
      text-align: justify;
      border: 1px solid rgba(var(--border-color-rgb, 200, 200, 200), 0.3);
      border-radius: 8px;
      box-shadow: 0 0 8px rgba(0, 0, 0, 0.05);
      background: var(--background-subtle, rgba(255, 255, 255, 0.02));
    }

    /* Add more horizontal space on larger screens */
    @media (min-width: 768px) {
      .quote-container {
        margin: 1.5rem 3rem 1.5rem 3rem;
        padding: 1.5rem;
        padding-top: 1rem;
        padding-bottom: 1rem;
      }
    }

    .quote-text {
      margin-bottom: 0.5rem;
    }

    .quote-source {
      font-family: "New CM", monospace;
      font-style: normal;
      font-size: 0.9em;
      color: var(--text-primary, inherit);
      text-align: right;
      opacity: 0.8;
      margin-top: 0.5rem;
      text-align: center;
    }

    .quote-source::before {
      content: "— ";
    }

    .quote-source a {
      color: inherit;
      text-decoration: none;
      border-bottom: 1px solid currentColor;
      transition: border-bottom-style 0.2s ease;
    }

    .quote-source a:hover {
      border-bottom-style: solid;
    }
  `;

  protected render(): void {
    const sourceElement = this.source
      ? this.href
        ? `<a href="${this.href}" target="_blank" rel="noopener noreferrer">${this.source}</a>`
        : this.source
      : "";

    this.shadow.innerHTML = `
      <div class="quote-container">
        <div class="quote-text">
          <slot></slot>
        </div>
      </div>
      ${sourceElement ? `<div class="quote-source">${sourceElement}</div>` : ""}
    `;
  }
}
