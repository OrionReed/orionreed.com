import { Anim } from "./anim";

export class BaseElement extends HTMLElement {
  protected shadow: ShadowRoot;
  protected anim = new Anim();
  private static styleSheets = new Map<string, CSSStyleSheet>();
  static styles?: string;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.initializeStyles();
  }

  connectedCallback(): void {
    this.anim.stop();
    this.render();
  }

  disconnectedCallback(): void {
    this.anim.stop();
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
    customElements.define(this.tagName, this);
  }

  private initializeStyles(): void {
    const constructor = this.constructor as typeof BaseElement;
    const className = constructor.name;

    if (!BaseElement.styleSheets.has(className)) {
      // Walk the prototype chain and collect each class's OWN `static
      // styles` (base classes first, subclasses last), so subclass styles
      // override base styles via the cascade. Lets a subclass extend a
      // styled base class without manually concatenating CSS.
      const chain: string[] = [];
      let proto: any = constructor;
      while (proto && proto !== HTMLElement && proto !== Object) {
        if (
          Object.prototype.hasOwnProperty.call(proto, "styles") &&
          proto.styles
        ) {
          chain.unshift(proto.styles);
        }
        proto = Object.getPrototypeOf(proto);
      }
      if (chain.length > 0) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(chain.join("\n"));
        BaseElement.styleSheets.set(className, sheet);
      }
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
