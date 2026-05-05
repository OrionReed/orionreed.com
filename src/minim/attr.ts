// HTML attributes mapped to reactive Signals on a custom element.
//
// Three terse decorators, one per coerce-type. Specify a default to
// guarantee the field is always defined (the field type drops
// `| undefined` accordingly):
//
//   @attr.str()             declare width:  Signal<string | undefined>;
//   @attr.str("auto")       declare layout: Signal<string>;
//   @attr.num()             declare chunks: Signal<number | undefined>;
//   @attr.num(4)            declare cells:  Signal<number>;
//   @attr.bool()            declare flag:   Signal<boolean>;          // default false
//   @attr.bool(true)        declare on:     Signal<boolean>;          // default true
//
// HTML boolean attributes are presence-based — `<el flag>` is true,
// absence is false. There's no "missing vs unset" distinction, so
// `attr.bool` always produces `Signal<boolean>`.
//
// The decorated field IS the signal — animations, computeds, and
// `forEach` sources can take it directly. `Diagram.attributeChanged-
// Callback` calls `syncAttrSignal` to push new values into the
// signal, so attribute mutations propagate without rebuilding.

import { signal, type Signal } from "./signal";

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

/** Push the new HTML-attribute value into the corresponding signal,
 *  coercing per the declared type and falling back to the registered
 *  default if the attribute was removed. Lazy-creates the signal if
 *  it hasn't been read yet. Called by `Diagram.attributeChangedCallback`. */
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
