// options.test.ts — custom equality + watched/unwatched lifecycle hooks.

import { describe, expect, it, vi } from "vitest";
import { Signal, derive, effect, readNow, reader, signal } from "../index";

describe("custom equality", () => {
  it("structural equals suppresses no-op writes", () => {
    const eq = (a: { x: number }, b: { x: number }) => a.x === b.x;
    const s = new Signal({ x: 1 }, { equals: eq });
    const fn = vi.fn(() => {
      void s.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    (s as Signal<{ x: number }>).value = { x: 1 }; // structurally equal → no fire
    expect(fn).toHaveBeenCalledTimes(1);
    (s as Signal<{ x: number }>).value = { x: 2 };
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("equals gates computed recompute propagation", () => {
    const a = signal(2);
    // Bucket by tens; many distinct `a` map to the same view, so the
    // derived value-equality must stop downstream effects from refiring.
    const bucket = derive(a, (v) => Math.floor(v / 10));
    bucket._equals = (x, y) => x === y;
    const fn = vi.fn(() => {
      void bucket.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    a.value = 5; // still bucket 0 → downstream effect must NOT refire
    expect(fn).toHaveBeenCalledTimes(1);
    a.value = 15; // bucket 1 → refire
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("watched / unwatched lifecycle", () => {
  it("fires watched on first sub, unwatched on last detach", () => {
    const watched = vi.fn();
    const unwatched = vi.fn();
    const s = signal(0, { watched, unwatched });
    expect(watched).not.toHaveBeenCalled();

    const stop1 = effect(() => {
      void s.value;
    });
    expect(watched).toHaveBeenCalledTimes(1);

    // Second subscriber does NOT re-fire watched.
    const stop2 = effect(() => {
      void s.value;
    });
    expect(watched).toHaveBeenCalledTimes(1);

    stop1();
    expect(unwatched).not.toHaveBeenCalled(); // still one sub
    stop2();
    expect(unwatched).toHaveBeenCalledTimes(1);
  });

  it("re-subscribing after full detach fires watched again", () => {
    const watched = vi.fn();
    const unwatched = vi.fn();
    const s = signal(0, { watched, unwatched });
    const stop = effect(() => {
      void s.value;
    });
    stop();
    expect(unwatched).toHaveBeenCalledTimes(1);
    effect(() => {
      void s.value;
    });
    expect(watched).toHaveBeenCalledTimes(2);
  });
});

// Concrete subclass — `from`/`pin` are typed for value-class ctors
// (fixed `T`), not the generic base `Signal<T>`.
class NumCell extends Signal<number> {
  constructor(v = 0) {
    super(v);
  }
}

describe("consumer-layer lifts", () => {
  it("pin reads constant + absorbs writes", () => {
    const locked = NumCell.pin(100);
    expect(locked.value).toBe(100);
    locked.value = 7; // absorbed
    expect(locked.value).toBe(100);
  });

  it("from: literal → seed, signal → tracked view, instance → identity", () => {
    const seed = NumCell.from(5);
    expect(seed.value).toBe(5);
    (seed as Signal<number>).value = 6;
    expect(seed.value).toBe(6);

    const src = signal(2);
    const view = NumCell.from(src);
    expect(view.value).toBe(2);
    src.value = 9;
    expect(view.value).toBe(9);

    expect(NumCell.from(view)).toBe(view); // instance → identity
  });

  it("readNow / reader unwrap Val<T>", () => {
    const s = signal(3);
    expect(readNow(s)).toBe(3);
    expect(readNow(42)).toBe(42);
    const r = reader(s);
    expect(r()).toBe(3);
    s.value = 4;
    expect(r()).toBe(4);
    expect(reader(7)()).toBe(7);
  });
});
