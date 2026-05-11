// HTML attributes mapped to reactive Signals on a custom element. The
// decorated field IS the signal — pass it to animations, computeds,
// or `forEach` sources directly.
//
//   @attr.str()      declare width: Signal<string | undefined>;
//   @attr.str("a")   declare mode:  Signal<string>;          // default "a"
//   @attr.num(4)     declare cells: Signal<number>;          // default 4
//   @attr.bool()     declare flag:  Signal<boolean>;         // default false
//
// `attr.bool` is always `Signal<boolean>` since HTML boolean attrs
// are presence-based.

import { signal, type Signal } from "./core";

type AttrType = "string" | "number" | "boolean";

const SIGNALS = Symbol("attrSignals");

interface AttrCarrier {
  [SIGNALS]?: Map<string, Signal<unknown>>;
}

interface AttrCtor {
  _attributes?: string[];
  _attrTypes?: Record<string, AttrType>;
  _attrDefaults?: Record<string, unknown>;
}

function coerce(
  raw: string | null,
  type: AttrType,
  default_: unknown,
): unknown {
  if (type === "boolean") {
    if (raw !== null) return true;
    return default_ === undefined ? false : default_;
  }
  if (type === "number") {
    return raw === null ? default_ : Number(raw);
  }
  return raw === null ? default_ : raw;
}

function bagOf(instance: object): Map<string, Signal<unknown>> {
  const carrier = instance as AttrCarrier;
  let bag = carrier[SIGNALS];
  if (!bag) {
    bag = new Map();
    carrier[SIGNALS] = bag;
  }
  return bag;
}

function register(
  target: object,
  propertyKey: string,
  type: AttrType,
  default_: unknown,
): void {
  const ctor = target.constructor as AttrCtor;
  if (!ctor._attributes) ctor._attributes = [];
  if (!ctor._attributes.includes(propertyKey)) ctor._attributes.push(propertyKey);
  if (!ctor._attrTypes) ctor._attrTypes = {};
  ctor._attrTypes[propertyKey] = type;
  if (default_ !== undefined) {
    if (!ctor._attrDefaults) ctor._attrDefaults = {};
    ctor._attrDefaults[propertyKey] = default_;
  }

  Object.defineProperty(target, propertyKey, {
    get(this: HTMLElement) {
      const bag = bagOf(this);
      let sig = bag.get(propertyKey);
      if (!sig) {
        sig = signal(coerce(this.getAttribute(propertyKey), type, default_));
        bag.set(propertyKey, sig);
      }
      return sig;
    },
    enumerable: true,
    configurable: true,
  });
}

// ── Factories ───────────────────────────────────────────────────────

function str(): PropertyDecorator;
function str(default_: string): PropertyDecorator;
function str(default_?: string): PropertyDecorator {
  return (target, key) => register(target, key as string, "string", default_);
}

function num(): PropertyDecorator;
function num(default_: number): PropertyDecorator;
function num(default_?: number): PropertyDecorator {
  return (target, key) => register(target, key as string, "number", default_);
}

function bool(): PropertyDecorator;
function bool(default_: boolean): PropertyDecorator;
function bool(default_?: boolean): PropertyDecorator {
  return (target, key) => register(target, key as string, "boolean", default_);
}

export const attr = { str, num, bool };

// ── Plumbing for Diagram ────────────────────────────────────────────

/** Walk the prototype chain collecting `_attributes`. Used by
 *  `Diagram.observedAttributes` so subclasses see parent decls. */
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

/** Push a new HTML-attribute value into its signal, coerced by type.
 *  Lazy-creates the signal if not read yet. Called by
 *  `Diagram.attributeChangedCallback`. */
export function syncAttrSignal(
  instance: HTMLElement,
  name: string,
  raw: string | null,
): void {
  const ctor = instance.constructor as AttrCtor;
  const type = ctor._attrTypes?.[name];
  if (!type) return;
  const default_ = ctor._attrDefaults?.[name];
  const bag = bagOf(instance);
  const next = coerce(raw, type, default_);
  const sig = bag.get(name);
  if (sig) {
    sig.value = next;
  } else {
    bag.set(name, signal(next));
  }
}
