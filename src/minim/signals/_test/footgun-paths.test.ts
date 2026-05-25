// footgun-paths.test.ts — field-path edge cases.

import { describe, expect, it } from "vitest";
import { Num, Signal, signal } from "../index";
import { field } from "../writable";

describe("footgun: deep field paths (4+)", () => {
  it("4-deep field chain hits the loop fallback in makeFieldGetter/Setter", () => {
    type S = { a: { b: { c: { d: { e: number } } } } };
    const root = signal<S>({ a: { b: { c: { d: { e: 1 } } } } });
    // Build via fieldOf (uses Signal.fieldOf, recognizes field
    // patterns).
    const lens = Signal.fieldOf(
      Signal.fieldOf(
        Signal.fieldOf(
          Signal.fieldOf(
            Signal.fieldOf(root, "a", Signal as new (...args: never[]) => Signal<S["a"]>),
            "b",
            Signal as new (
              ...args: never[]
            ) => Signal<S["a"]["b"]>,
          ),
          "c",
          Signal as new (
            ...args: never[]
          ) => Signal<S["a"]["b"]["c"]>,
        ),
        "d",
        Signal as new (
          ...args: never[]
        ) => Signal<S["a"]["b"]["c"]["d"]>,
      ),
      "e",
      Num,
    );

    expect(lens.value).toBe(1);
    (lens as unknown as { value: number }).value = 99;
    expect(root.value).toEqual({ a: { b: { c: { d: { e: 99 } } } } });

    // Sibling fields untouched.
    root.value = { a: { b: { c: { d: { e: 5 } } } } };
    expect(lens.value).toBe(5);
  });

  it("5-deep field chain works correctly", () => {
    type S = { a: { b: { c: { d: { e: { f: number } } } } } };
    const root = new Signal<S>({ a: { b: { c: { d: { e: { f: 1 } } } } } });
    let s: Signal<unknown> = root as Signal<unknown>;
    for (const k of ["a", "b", "c", "d", "e"]) {
      s = Signal.fieldOf(s, k, Signal as new (...args: never[]) => Signal<unknown>);
    }
    const lens = Signal.fieldOf(s, "f", Num);

    expect(lens.value).toBe(1);
    (lens as unknown as { value: number }).value = 42;
    expect(root.value).toEqual({ a: { b: { c: { d: { e: { f: 42 } } } } } });
  });
});

describe("footgun: numeric / symbol keys", () => {
  it("numeric index in field path", () => {
    type S = { items: number[] };
    const root = signal<S>({ items: [10, 20, 30] });
    // Note: field expects `keyof S[K]` so numeric index requires
    // careful typing. Use Signal.fieldOf which is more permissive.
    const itemsLens = Signal.fieldOf(
      root,
      "items",
      Signal as new (
        ...args: never[]
      ) => Signal<number[]>,
    );
    const idx0 = Signal.fieldOf(itemsLens, 0, Num);

    expect(idx0.value).toBe(10);
    (idx0 as unknown as { value: number }).value = 99;
    // Spread-replace on an array makes a new ARRAY, not an object,
    // because the spread-replace uses {...arr, [idx]: v}. That'd
    // produce an object, not an array! This is a footgun.
    // Test: assert what actually happens.
    const updated = root.value.items;
    expect(updated[0]).toBe(99);
  });

  it("symbol keys in field path", () => {
    const SYM = Symbol("k");
    type S = { [SYM]: number };
    const root = signal<S>({ [SYM]: 5 });
    const lens = Signal.fieldOf(root, SYM, Num);
    expect(lens.value).toBe(5);
    (lens as unknown as { value: number }).value = 99;
    expect(root.value[SYM]).toBe(99);
  });
});

describe("footgun: spread on arrays (semantic difference)", () => {
  it("spread on array preserves array prototype only sometimes", () => {
    const arr = [10, 20, 30];
    const spread = { ...arr, 0: 99 };
    // The result is an OBJECT, not an array, because object-spread
    // discards the array prototype.
    expect(Array.isArray(spread)).toBe(false);
    expect(spread).toEqual({ 0: 99, 1: 20, 2: 30 });
    // This means writing to an array via the field-fast-path SETTER
    // (which uses object-spread) silently converts the array to a
    // plain object. THIS IS A REAL FOOTGUN.
  });

  it("FOOTGUN: writing through field path ON AN ARRAY converts to object", () => {
    type S = { items: number[] };
    const root = signal<S>({ items: [10, 20, 30] });
    const itemsLens = Signal.fieldOf(
      root,
      "items",
      Signal as new (
        ...args: never[]
      ) => Signal<number[]>,
    );
    const idx0 = Signal.fieldOf(itemsLens, 0, Num);

    expect(Array.isArray(root.value.items)).toBe(true);
    (idx0 as unknown as { value: number }).value = 99;
    // After the write, items is no longer an array — it's a plain
    // object. The spread-replace at the items level uses {...arr, [k]: v}
    // which loses the Array prototype.
    expect(Array.isArray(root.value.items)).toBe(false);
    // Still indexable, but missing array methods, length tracking, etc.
    expect((root.value.items as unknown as Record<number, number>)[0]).toBe(99);
  });
});
