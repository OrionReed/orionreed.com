// engine.test.ts — core reactive primitives.

import { describe, it, expect } from "vitest";
import {
  Signal, Computed, Lens,
  signal, computed, lens, effect, batch, untracked,
  isSignal, isComputed, isLens,
} from "../index";

describe("Signal — writable source", () => {
  it("read / write via .value", () => {
    const s = signal(1);
    expect(s.value).toBe(1);
    s.value = 2;
    expect(s.value).toBe(2);
  });

  it("notifies effects", () => {
    const s = signal(1);
    let seen = 0;
    effect(() => { seen = s.value });
    expect(seen).toBe(1);
    s.value = 5;
    expect(seen).toBe(5);
  });

  it("equality dedup via ===", () => {
    const s = signal(1);
    let runs = 0;
    effect(() => { void s.value; runs++ });
    expect(runs).toBe(1);
    s.value = 1;
    expect(runs).toBe(1);
  });

  it("custom equals via opts", () => {
    const s = signal({ a: 1 }, { equals: (x, y) => x.a === y.a });
    let runs = 0;
    effect(() => { void s.value; runs++ });
    s.value = { a: 1 };
    expect(runs).toBe(1);
  });

  it("set(v) is chainable & severs binding", () => {
    const src = signal(0);
    const dst = signal(0);
    dst.bind(src);
    src.value = 5;
    expect(dst.value).toBe(5);
    dst.set(99);
    src.value = 10;
    expect(dst.value).toBe(99);  // binding severed
  });

  it("peek does not track", () => {
    const s = signal(1);
    let runs = 0;
    effect(() => { void s.peek(); runs++ });
    expect(runs).toBe(1);
    s.value = 2;
    expect(runs).toBe(1);
  });
});

describe("Computed — read-only derived", () => {
  it("computes lazily, caches, recomputes on dep change", () => {
    const a = signal(2);
    let comps = 0;
    const c = computed(() => { comps++; return a.value * 10 });
    expect(c.value).toBe(20);
    expect(c.value).toBe(20);  // cached
    expect(comps).toBe(1);
    a.value = 3;
    expect(c.value).toBe(30);
    expect(comps).toBe(2);
  });

  it("rejects write at runtime (Node base throws)", () => {
    const c = computed(() => 1);
    expect(() => { (c as unknown as { value: number }).value = 2 }).toThrow();
  });

  it("chained computed", () => {
    const a = signal(1);
    const b = computed(() => a.value + 1);
    const c = computed(() => b.value * 10);
    expect(c.value).toBe(20);
    a.value = 5;
    expect(c.value).toBe(60);
  });

  it("cycle detection", () => {
    const a = signal(1);
    const c: Computed<number> = computed(() => a.value + c.value);
    expect(() => c.value).toThrow(/Cyclic/);
  });
});

describe("Lens — writable derived", () => {
  it("read via getter, write via setter", () => {
    const src = signal({ x: 1, y: 2 });
    const lx = lens(
      () => src.value.x,
      (v) => { src.value = { ...src.peek(), x: v } },
    );
    expect(lx.value).toBe(1);
    lx.value = 99;
    expect(src.value).toEqual({ x: 99, y: 2 });
  });

  it("write through lens triggers downstream effects", () => {
    const src = signal({ x: 1, y: 2 });
    const lx = lens(() => src.value.x, (v) => { src.value = { ...src.peek(), x: v } });
    let seen = 0;
    effect(() => { seen = src.value.x });
    expect(seen).toBe(1);
    lx.value = 7;
    expect(seen).toBe(7);
  });
});

describe("Effect", () => {
  it("disposer stops further runs", () => {
    const s = signal(1);
    let runs = 0;
    const stop = effect(() => { void s.value; runs++ });
    s.value = 2;
    expect(runs).toBe(2);
    stop();
    s.value = 3;
    expect(runs).toBe(2);
  });

  it("cleanup callback runs before next iteration and on dispose", () => {
    const s = signal(1);
    const seen: string[] = [];
    const stop = effect(() => {
      const v = s.value;
      seen.push(`run:${v}`);
      return () => seen.push(`cleanup:${v}`);
    });
    s.value = 2;
    s.value = 3;
    stop();
    expect(seen).toEqual(["run:1", "cleanup:1", "run:2", "cleanup:2", "run:3", "cleanup:3"]);
  });

  it("batch coalesces writes", () => {
    const a = signal(1);
    const b = signal(2);
    let runs = 0;
    effect(() => { void a.value; void b.value; runs++ });
    expect(runs).toBe(1);
    batch(() => { a.value = 10; b.value = 20 });
    expect(runs).toBe(2);
  });

  it("untracked read does not register dep", () => {
    const a = signal(1);
    const b = signal(2);
    let runs = 0;
    effect(() => { void a.value; untracked(() => { void b.value }); runs++ });
    a.value = 3;
    expect(runs).toBe(2);
    b.value = 5;
    expect(runs).toBe(2);
  });
});

describe("Type predicates", () => {
  it("distinguish the three primitives", () => {
    const s = signal(1);
    const c = computed(() => 1);
    const l = lens(() => 1, () => {});
    expect(isSignal(s)).toBe(true);
    expect(isComputed(s)).toBe(false);
    expect(isLens(s)).toBe(false);
    expect(isComputed(c)).toBe(true);
    expect(isLens(l)).toBe(true);
    expect(s).toBeInstanceOf(Signal);
    expect(c).toBeInstanceOf(Computed);
    expect(l).toBeInstanceOf(Lens);
  });
});
