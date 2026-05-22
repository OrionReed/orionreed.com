// lateral.test.ts — gated.

import { describe, expect, it } from "vitest";
import { gated, num, signal } from "../index";

describe("gated(s, when)", () => {
  it("accepts writes when predicate is true", () => {
    const target = num(0);
    const open = signal(true);
    const g = gated(target, open);
    g.value = 5;
    expect(target.value).toBe(5);
  });

  it("drops writes when predicate is false", () => {
    const target = num(0);
    const open = signal(false);
    const g = gated(target, open);
    g.value = 5;
    expect(target.value).toBe(0); // dropped
  });

  it("toggles dynamically", () => {
    const target = num(0);
    const open = signal(true);
    const g = gated(target, open);
    g.value = 5;
    expect(target.value).toBe(5);
    open.value = false;
    g.value = 99;
    expect(target.value).toBe(5); // unchanged
    open.value = true;
    g.value = 42;
    expect(target.value).toBe(42);
  });
});
