export class BaseElement extends HTMLElement {
  protected shadow: ShadowRoot;
  private static styleSheets = new Map<string, CSSStyleSheet>();
  static styles?: string;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.initializeStyles();
  }

  connectedCallback(): void {
    this.render();
  }

  static get tagName(): string {
    return this.name
      .replace(/([A-Z])/g, "-$1")
      .toLowerCase()
      .slice(1);
  }

  static get observedAttributes(): string[] {
    return (this as any)._attributes || [];
  }

  static define(): void {
    customElements.define(
      this.tagName,
      this as unknown as CustomElementConstructor
    );
  }

  private initializeStyles(): void {
    const constructor = this.constructor as typeof BaseElement;
    const className = constructor.name;

    // Create stylesheet from static styles if not already created
    if (constructor.styles && !BaseElement.styleSheets.has(className)) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(constructor.styles);
      BaseElement.styleSheets.set(className, sheet);
    }

    const styleSheet = BaseElement.styleSheets.get(className);
    if (styleSheet) {
      this.shadow.adoptedStyleSheets = [styleSheet];
    }
  }

  attributeChangedCallback(
    _name: string,
    oldValue: string,
    newValue: string
  ): void {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  protected render(): void {
    // Override in subclasses
  }
}

// Decorator to define attributes on custom elements
export function attr(options: { type?: "string" | "number" | "boolean" } = {}) {
  return function <T extends { constructor: any }>(
    target: T,
    propertyKey: string
  ) {
    const constructor = target.constructor;

    // Initialize attributes array if it doesn't exist
    if (!constructor._attributes) {
      constructor._attributes = [];
    }

    // Add this attribute to the list
    constructor._attributes.push(propertyKey);

    // Create getter for the attribute
    Object.defineProperty(target, propertyKey, {
      get(this: HTMLElement) {
        const value = this.getAttribute(propertyKey);

        if (options.type === "boolean") {
          return value !== null;
        } else if (options.type === "number") {
          return value ? Number(value) : undefined;
        }

        return value;
      },
      enumerable: true,
      configurable: true,
    });
  };
}

export const css = String.raw;
