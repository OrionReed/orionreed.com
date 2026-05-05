// Tiny decorator that maps a class field to a typed HTML attribute.
// Subclasses register attributes via `@attr()` on a field; the resulting
// getter reads `this.getAttribute(name)` on demand and coerces by type.
//
// The static `observedAttributes` getter on a class extending HTMLElement
// must read from `_attributes` (populated by the decorator) for the
// browser's `attributeChangedCallback` to fire. Both `Diagram` and v1's
// `BaseElement` wire this up.

export function attr(options: { type?: "string" | "number" | "boolean" } = {}) {
  return function <T extends { constructor: unknown }>(
    target: T,
    propertyKey: string,
  ) {
    const ctor = target.constructor as { _attributes?: string[] };
    if (!ctor._attributes) ctor._attributes = [];
    ctor._attributes.push(propertyKey);

    Object.defineProperty(target, propertyKey, {
      get(this: HTMLElement) {
        const value = this.getAttribute(propertyKey);
        if (options.type === "boolean") return value !== null;
        if (options.type === "number") return value ? Number(value) : undefined;
        return value;
      },
      enumerable: true,
      configurable: true,
    });
  };
}

/** Aggregates `_attributes` arrays across the prototype chain so subclass
 *  registrations include those declared on parent classes. Use as the
 *  body of a class's `static get observedAttributes()`. */
export function observedAttributesOf(ctor: Function): string[] {
  const acc: string[] = [];
  let c: any = ctor;
  while (c && c !== HTMLElement && c !== Object) {
    if (Object.prototype.hasOwnProperty.call(c, "_attributes") && c._attributes) {
      for (const a of c._attributes) if (!acc.includes(a)) acc.push(a);
    }
    c = Object.getPrototypeOf(c);
  }
  return acc;
}
